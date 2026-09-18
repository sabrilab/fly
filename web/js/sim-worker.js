// Simulateur LIF dans le navigateur — miroir exact de pipeline/lif.py.
// Le réseau est presque toujours silencieux : on ne met à jour que l'ensemble
// « éveillé » (neurones dont l'état s'écarte du repos), d'où un gain ~100x.

const DT = 0.1;                    // ms
const V_REST = -52, V_TH = -45, V_RESET = -52;
const TAU_MEM = 20, TAU_SYN = 5;
const T_RFC = 2.2, T_DELAY = 1.8;
const W_SYN = 0.275, F_POI = 250;

const DECAY = 1 - DT / TAU_SYN;    // 0.98
const K_MEM = DT / TAU_MEM;        // 0.005
const STEPS_DELAY = Math.round(T_DELAY / DT);   // 18
const BUF = STEPS_DELAY + 1;                    // 19
const RFC_STEPS = Math.round(T_RFC / DT);       // 22
const QUIET_LIMIT = 26;            // > BUF : garantit qu'aucune entrée retardée n'est perdue
const STEPS_PER_FRAME = 10;        // une trame = 1 ms

let G = null;          // { indptr, indices, weights }
let S = null;          // état
let running = false;
let pending = 0;       // trames envoyées non acquittées

function init(msg) {
  const n = G.indptr.length - 1;
  // msg.pops : { clé: [indices…] }. Chaque population a son taux, réglable en direct.
  const pops = msg.pops || { main: msg.stim || [] };
  const all = [];
  for (const k in pops) for (const i of pops[k]) all.push(i);
  const popIdx = Int32Array.from(new Set(all));
  // rétine : chaque cellule de lamina a son propre taux, mis à jour image par image
  const retina = msg.retina ? new Uint32Array(msg.retina) : new Uint32Array(0);
  const stim = Int32Array.from(new Set([...all, ...retina]));
  const silenced = new Uint8Array(n);
  for (const i of msg.silence || []) silenced[i] = 1;

  const rfcSteps = new Int32Array(n).fill(RFC_STEPS);
  const isStim = new Uint8Array(n);
  for (const i of stim) { rfcSteps[i] = 0; isStim[i] = 1; }

  S = {
    n, stim, silenced, isStim, rfcSteps, pops, popIdx, retina,
    prob: (msg.hz || 0) * (DT / 1000),
    probs: new Float32Array(n),          // probabilité par neurone et par pas
    v: new Float32Array(n).fill(V_REST),
    g: new Float32Array(n),
    refrac: Int32Array.from(rfcSteps),
    spikes: new Uint8Array(n),
    delay: new Float32Array(BUF * n),
    rec: new Float32Array(n),
    touched: new Int32Array(n), nTouched: 0,
    awake: new Int32Array(n), nAwake: 0,
    isAwake: new Uint8Array(n),
    quiet: new Int32Array(n),
    head: 0, step: 0,
    firedBuf: new Int32Array(n),
    totalSpikes: 0,
    t0: performance.now(),
    watch: Int32Array.from(msg.watch || []),   // neurones dont on veut le compte de décharges
  };
  S.watchHits = new Int32Array(S.watch.length);
  S.watchOf = new Int32Array(n).fill(-1);
  S.watch.forEach((idx, k) => { S.watchOf[idx] = k; });
  setRates(msg.rates || (msg.hz ? Object.fromEntries(Object.keys(pops).map((k) => [k, msg.hz])) : {}));
  for (const i of stim) wake(i);
}

/** Met à jour les taux des populations, sans toucher à la rétine (ensembles disjoints). */
function setRates(rates) {
  if (!S) return;
  for (let k = 0; k < S.popIdx.length; k++) S.probs[S.popIdx[k]] = 0;
  for (const k in S.pops) {
    const hz = rates[k] || 0;
    if (hz <= 0) continue;
    const p = hz * (DT / 1000);
    for (const i of S.pops[k]) S.probs[i] = Math.max(S.probs[i], p);
  }
}

/** Taux par neurone de lamina, déduits de l'image de son œil. */
function setRetina(rates) {
  if (!S || !S.retina.length) return;
  const k0 = DT / 1000, ret = S.retina, probs = S.probs;
  const n = Math.min(ret.length, rates.length);
  for (let k = 0; k < n; k++) probs[ret[k]] = rates[k] * k0;
}

function wake(i) {
  if (!S.isAwake[i]) { S.isAwake[i] = 1; S.awake[S.nAwake++] = i; }
  S.quiet[i] = 0;
}

function stepOnce() {
  const { n, v, g, refrac, spikes, delay, rec, rfcSteps, isStim, silenced } = S;
  const { indptr, indices, weights } = G;
  const slotBase = S.head * n;

  // --- 1. propagation des spikes du pas précédent (creuse) ---
  for (let t = 0; t < S.nTouched; t++) rec[S.touched[t]] = 0;
  S.nTouched = 0;
  for (let f = 0; f < S.nFired; f++) {
    const pre = S.firedBuf[f];
    if (silenced[pre]) continue;
    for (let k = indptr[pre], end = indptr[pre + 1]; k < end; k++) {
      const j = indices[k];
      if (silenced[j]) continue;
      if (rec[j] === 0) S.touched[S.nTouched++] = j;
      rec[j] += weights[k] * W_SYN;
      wake(j);
    }
  }

  // --- 2. stimulation de Poisson (optogénétique virtuelle) ---
  const amp = W_SYN * F_POI, probs = S.probs;
  for (let s = 0; s < S.stim.length; s++) {
    const i = S.stim[s];
    if (probs[i] > 0 && Math.random() < probs[i]) v[i] += amp;
  }

  // --- 3. mise à jour de l'ensemble éveillé ---
  let nFired = 0, write = 0;
  for (let a = 0; a < S.nAwake; a++) {
    const i = S.awake[a];
    const sp = spikes[i];
    const r = sp ? 0 : refrac[i] + 1;
    refrac[i] = r;
    const gOld = g[i];
    const gNew = gOld * DECAY + (r >= rfcSteps[i] ? delay[slotBase + i] : 0);
    delay[slotBase + i] = rec[i];

    let vv = v[i] + K_MEM * (gOld - (v[i] - V_REST));
    let fired = 0;
    if (vv > V_TH) { vv = V_RESET; fired = 1; }
    v[i] = vv;
    g[i] = fired ? 0 : gNew;
    spikes[i] = fired;
    if (fired) {
      S.firedBuf[nFired++] = i; S.quiet[i] = 0;
      const w = S.watchOf[i];
      if (w >= 0) S.watchHits[w]++;
    }

    // le neurone reste-t-il éveillé ?
    const idle = !fired && Math.abs(vv - V_REST) < 1e-3 && Math.abs(g[i]) < 1e-4
                 && rec[i] === 0 && !isStim[i];
    S.quiet[i] = idle ? S.quiet[i] + 1 : 0;
    if (S.quiet[i] > QUIET_LIMIT) { S.isAwake[i] = 0; }
    else { S.awake[write++] = i; }
  }
  S.nAwake = write;
  S.nFired = nFired;
  S.totalSpikes += nFired;
  S.head = (S.head + 1) % BUF;
  S.step++;
}

function loop() {
  if (!running) return;
  if (pending > 140) { setTimeout(loop, 6); return; }

  const budgetEnd = performance.now() + 15;   // ms de CPU par tranche
  let frames = 0;
  const out = [];
  while (running && performance.now() < budgetEnd && frames < 64) {
    const fired = [];
    for (let s = 0; s < STEPS_PER_FRAME; s++) {
      stepOnce();
      for (let f = 0; f < S.nFired; f++) fired.push(S.firedBuf[f]);
    }
    out.push(Uint32Array.from(fired));
    frames++;
  }
  if (out.length) {
    pending += out.length;
    const elapsed = (performance.now() - S.t0) / 1000;
    const hits = S.watchHits.slice();
    S.watchHits.fill(0);
    postMessage({
      type: 'frames', frames: out, step: S.step,
      awake: S.nAwake, total: S.totalSpikes, watch: hits, ms: out.length,
      rate: S.step * DT / 1000 / Math.max(1e-6, elapsed),   // s simulée / s réelle
    });
  }
  setTimeout(loop, 0);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'graph') {
    G = { indptr: new Uint32Array(m.indptr), indices: new Uint32Array(m.indices),
          weights: new Int16Array(m.weights) };
    postMessage({ type: 'ready', n: G.indptr.length - 1, nnz: G.indices.length });
  } else if (m.type === 'start') {
    init(m); running = true; pending = 0; S.nFired = 0; loop();
  } else if (m.type === 'rates') {
    setRates(m.rates);
  } else if (m.type === 'retina') {
    setRetina(new Float32Array(m.rates));
  } else if (m.type === 'ack') {
    pending = Math.max(0, pending - m.count);
  } else if (m.type === 'stop') {
    running = false;
  }
};
