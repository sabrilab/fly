import * as THREE from 'three';
import { BrainScene } from './scene.js';
import { loadAtlas, loadSim, loadGraph, incomingOf, outgoingOf } from './data.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString('fr-FR');
const SLOT = ['#3987e5', '#d95926', '#199e70', '#6b6a64'];

let D, scene, sim = null, simMeta = null, graph = null, worker = null;
let picked = -1, playing = false, frame = 0, acc = 0, live = null;
let glowList = new Int32Array(200000), glowCount = 0;

// ───────────────────────────────── chargement ─────────────────────────────────
const stepEl = $('#loader-step'), fillEl = $('#loader-fill');
const step = (msg, p) => { stepEl.textContent = msg; fillEl.style.width = (p * 100) + '%'; };

(async function boot() {
  try {
    D = await loadAtlas(step);
    step('mise en place de la scène 3D…', 0.8);
    scene = new BrainScene($('#view'), D);
    buildModes(); buildLegend(); buildExperiments(); buildReadouts(); buildLive();
    wireUI();
    await selectExperiment('sugar');
    step('prêt', 1);
    setTimeout(() => { $('#loader').classList.add('done'); }, 260);
    setTimeout(() => $('#hint').classList.add('fade'), 9000);
    tick();
  } catch (err) {
    stepEl.textContent = 'Erreur : ' + err.message;
    stepEl.style.color = '#e66767';
    console.error(err);
  }
})();

// ───────────────────────────────── modes de couleur ────────────────────────────
// Trois catégories vives au plus par mode (palette validée all-pairs), le reste neutre.
let MODES = {}, mode = 'anatomy', hidden = new Set();

function buildModes() {
  const n = D.n, A = D.atlas;
  const fam = (name) => D.famNames.indexOf(name);
  const lower = (arr) => arr.map((s) => (s || '').toLowerCase());
  const ntNames = lower(A.neurotransmitter), sideNames = lower(A.side);

  const mk = (labels, fn) => {
    const cat = new Uint8Array(n);
    for (let i = 0; i < n; i++) cat[i] = fn(i);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) counts[cat[i]]++;
    return { cat, legend: labels.map((l, k) => ({ label: l, color: SLOT[k], count: counts[k], k })) };
  };

  const OPTIC = fam('optic'), CENTRAL = fam('central'), SENS = fam('sensory'),
        VIS = fam('visual'), ASC = fam('ascending'), DESC = fam('descending'), MOT = fam('motor');

  MODES.anatomy = mk(
    ['Lobes optiques', 'Cerveau central', 'Entrées sensorielles', 'Autres (projections, DN, moteurs)'],
    (i) => { const f = D.famOf[i];
      return f === OPTIC ? 0 : f === CENTRAL ? 1 : f === SENS ? 2 : 3; });

  MODES.pathway = mk(
    ['Entrées sensorielles', 'Descendants → vers le corps', 'Moteurs et endocrines', 'Reste du cerveau'],
    (i) => { const f = D.famOf[i];
      return f === SENS ? 0 : f === DESC ? 1 : f === MOT ? 2 : 3; });

  MODES.nt = mk(
    ['Excitateur (acétylcholine)', 'Inhibiteur (GABA, glutamate)', 'Modulateur (dopamine, sérotonine…)', 'Non déterminé'],
    (i) => { const s = ntNames[D.nt[i]] || '';
      if (s.includes('acetyl')) return 0;
      if (s.includes('gaba') || s.includes('glutam')) return 1;
      if (s) return 2;
      return 3; });

  MODES.side = mk(['Gauche', 'Droite', 'Ligne médiane', 'Non déterminé'],
    (i) => { const s = sideNames[D.side[i]] || '';
      return s === 'left' ? 0 : s === 'right' ? 1 : s === 'center' ? 2 : 3; });

  applyMode('anatomy');
}

function applyMode(name) {
  mode = name; hidden.clear();
  const m = MODES[name];
  const rgb = SLOT.map((hex) => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ]);
  const colors = new Float32Array(D.n * 3);
  for (let i = 0; i < D.n; i++) {
    const c = rgb[m.cat[i]];
    colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
  }
  scene.setColors(colors);
  applyVisibility();
  buildLegend();
}

function applyVisibility() {
  const cat = MODES[mode].cat, vis = new Float32Array(D.n);
  for (let i = 0; i < D.n; i++) vis[i] = hidden.has(cat[i]) ? 0 : 1;
  scene.setVisible(vis);
}

function buildLegend() {
  const el = $('#legend'); el.innerHTML = '';
  for (const e of MODES[mode].legend) {
    const b = document.createElement('button');
    b.className = hidden.has(e.k) ? 'off' : '';
    b.innerHTML = '<i class="dot" style="background:' + e.color + '"></i>' +
                  '<span class="lbl">' + e.label + '</span>' +
                  '<span class="cnt">' + fmt(e.count) + '</span>';
    b.onclick = () => { hidden.has(e.k) ? hidden.delete(e.k) : hidden.add(e.k);
                        applyVisibility(); buildLegend(); };
    el.appendChild(b);
  }
}

// ───────────────────────────────── expériences ─────────────────────────────────
function buildExperiments() {
  const sel = $('#exp-select');
  for (const e of D.sims.experiments) {
    const o = document.createElement('option');
    o.value = e.key;
    o.textContent = e.label + '  —  ' + fmt(e.nSpikes) + ' spikes, ' + e.nActive + ' neurones';
    sel.appendChild(o);
  }
  sel.onchange = () => selectExperiment(sel.value);
  $('#t-total').textContent = (D.sims.duration * 1000) + ' ms';
}

let expMeta = null, readoutSpikes = null, rasterImage = null;

async function selectExperiment(key) {
  stopLive();
  expMeta = D.sims.experiments.find((e) => e.key === key);
  $('#exp-select').value = key;
  $('#exp-note').textContent = expMeta.note;
  sim = await loadSim(key, D.sims.nFrames);
  simMeta = D.sims;

  // spikes par neurone de sortie, pour les tuiles de droite
  const want = new Map(Object.entries(D.sims.readoutIndices).map(([nm, i]) => [i, nm]));
  readoutSpikes = new Map();
  for (const nm of want.values()) readoutSpikes.set(nm, []);
  for (let s = 0; s < sim.nSpikes; s++) {
    const nm = want.get(sim.neurons[s]);
    if (nm !== undefined) readoutSpikes.get(nm).push(Math.floor(sim.steps[s] / 10));
  }

  drawRaster();
  gotoFrame(0, true);
  setPlaying(false);
}

// ───────────────────────────────── raster ─────────────────────────────────
function drawRaster() {
  const cv = $('#raster');
  const w = cv.clientWidth || 310, h = 132;
  cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round(h * devicePixelRatio);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#1c1c1f'; ctx.fillRect(0, 0, W, H);
  if (!sim.nSpikes) {
    ctx.fillStyle = '#6e6e70';
    ctx.font = (12 * devicePixelRatio) + 'px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('aucune activité — le modèle est silencieux au repos', W / 2, H / 2);
    rasterImage = ctx.getImageData(0, 0, W, H);
    return;
  }
  // rang de chaque neurone actif = ordre de première décharge
  const first = new Map();
  for (let s = 0; s < sim.nSpikes; s++) {
    const i = sim.neurons[s];
    if (!first.has(i)) first.set(i, sim.steps[s]);
  }
  const order = [...first.entries()].sort((a, b) => a[1] - b[1]);
  const rank = new Map(order.map(([i], r) => [i, r]));
  const nA = order.length;

  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  const nFrames = D.sims.nFrames;
  for (let s = 0; s < sim.nSpikes; s++) {
    const x = Math.min(W - 1, Math.floor((sim.steps[s] / (nFrames * 10)) * W));
    const y = Math.min(H - 1, Math.floor((rank.get(sim.neurons[s]) / nA) * H));
    const o = (y * W + x) * 4;
    px[o] = Math.min(255, px[o] + 120);
    px[o + 1] = Math.min(255, px[o + 1] + 86);
    px[o + 2] = Math.min(255, px[o + 2] + 40);
    px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  rasterImage = ctx.getImageData(0, 0, W, H);
}

function drawRasterCursor(f) {
  const cv = $('#raster');
  if (!rasterImage) return;
  const ctx = cv.getContext('2d');
  ctx.putImageData(rasterImage, 0, 0);
  const x = (f / D.sims.nFrames) * cv.width;
  ctx.fillStyle = 'rgba(242,242,240,.55)';
  ctx.fillRect(x, 0, Math.max(1, devicePixelRatio), cv.height);
}

// ───────────────────────────────── lecture ─────────────────────────────────
function clearGlow() {
  const act = scene.activity;
  for (let k = 0; k < glowCount; k++) act[glowList[k]] = 0;
  glowCount = 0;
  scene.commitActivity();
}

function addGlow(i) {
  const act = scene.activity;
  if (act[i] === 0 && glowCount < glowList.length) glowList[glowCount++] = i;
  act[i] = 1;
}

function decayGlow(factor) {
  const act = scene.activity;
  let w = 0;
  for (let k = 0; k < glowCount; k++) {
    const i = glowList[k];
    const v = act[i] * factor;
    if (v < 0.012) { act[i] = 0; } else { act[i] = v; glowList[w++] = i; }
  }
  glowCount = w;
}

function advanceFrame() {
  decayGlow($('#trail').checked ? 0.90 : 0.0);
  const a = sim.frames[frame], b = sim.frames[frame + 1];
  for (let s = a; s < b; s++) addGlow(sim.neurons[s]);
  frame++;
}

function gotoFrame(f, rebuild) {
  frame = Math.max(0, Math.min(D.sims.nFrames, f));
  if (rebuild) {
    clearGlow();
    const back = $('#trail').checked ? 26 : 1;
    for (let k = Math.max(0, frame - back); k < frame; k++) {
      decayGlow(0.90);
      const a = sim.frames[k], b = sim.frames[k + 1];
      for (let s = a; s < b; s++) addGlow(sim.neurons[s]);
    }
  }
  scene.commitActivity();
  $('#time').value = frame;
  $('#t-read').textContent = frame + ' ms';
  drawRasterCursor(frame);
  updateReadouts();
}

function setPlaying(v) {
  playing = v;
  $('#btn-play').textContent = v ? '❙❙ Pause' : '▶ Lecture';
  if (v && frame >= D.sims.nFrames) gotoFrame(0, true);
}

// ───────────────────────────────── sorties motrices ────────────────────────────
// Regroupees par fonction, les plus parlantes d'abord. Le fond des cellules suit
// une rampe sequentielle d'une seule teinte (0 -> taux maximal).
const RO_GROUPS = [
  { label: 'MN9',         role: 'trompe — manger',       members: ['MN9_left', 'MN9_right'],              short: ['G', 'D'] },
  { label: 'Giant Fiber', role: 'fuite',                 members: ['GiantFiber_1', 'GiantFiber_2'],       short: ['1', '2'] },
  { label: 'aDN1',        role: 'toilettage antennaire', members: ['aDN1_left', 'aDN1_right'],            short: ['G', 'D'] },
  { label: 'P9',          role: 'marche avant',          members: ['P9_left', 'P9_right'],                short: ['G', 'D'] },
  { label: 'P9_oDN1',     role: 'vitesse avant',         members: ['P9_oDN1_left', 'P9_oDN1_right'],      short: ['G', 'D'] },
  { label: 'DNa01',       role: 'virage',                members: ['DNa01_left', 'DNa01_right'],          short: ['G', 'D'] },
  { label: 'DNa02',       role: 'virage',                members: ['DNa02_left', 'DNa02_right'],          short: ['G', 'D'] },
  { label: 'MDN',         role: 'marche arrière',        members: ['MDN_1', 'MDN_2', 'MDN_3', 'MDN_4'],   short: ['1', '2', '3', '4'] },
];
const RAMP = ['#7a3a14', '#b8621f', '#eb9b3a', '#ffd79a'];
const RATE_MAX = 160;

function buildReadouts() {
  const el = $('#readouts'); el.innerHTML = '';
  for (const g of RO_GROUPS) {
    const d = document.createElement('div');
    d.className = 'rg'; d.dataset.group = g.label;
    d.innerHTML = '<div class="rg-head"><b>' + g.label + '</b><span>' + g.role + '</span><em>Hz</em></div>' +
      '<div class="rg-cells">' + g.members.map((m, k) =>
        '<button class="rc" data-name="' + m + '" title="' + m + '"><i>' + g.short[k] + '</i><b>0</b></button>'
      ).join('') + '</div>';
    el.appendChild(d);
  }
  el.querySelectorAll('.rc').forEach((b) => {
    b.onclick = () => {
      const i = D.sims.readoutIndices[b.dataset.name];
      if (i !== undefined) selectNeuron(i, true);
    };
  });
}

const WINDOW_MS = 100;
function rateAt(name) {
  const arr = readoutSpikes && readoutSpikes.get(name);
  if (!arr || !arr.length) return 0;
  let c = 0;
  for (let k = arr.length - 1; k >= 0; k--) {
    const f = arr[k];
    if (f > frame) continue;
    if (f < frame - WINDOW_MS) break;
    c++;
  }
  return Math.round((c * 1000) / WINDOW_MS);
}

function paintReadouts(getRate) {
  for (const g of RO_GROUPS) {
    const box = document.querySelector('.rg[data-group="' + CSS.escape(g.label) + '"]');
    if (!box) continue;
    let any = 0;
    for (const m of g.members) {
      const cell = box.querySelector('.rc[data-name="' + m + '"]');
      if (!cell) continue;
      const hz = getRate(m);
      any = Math.max(any, hz);
      cell.querySelector('b').textContent = hz;
      const t = Math.min(1, hz / RATE_MAX);
      cell.classList.toggle('on', hz > 0);
      cell.style.background = hz > 0
        ? RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
        : '';
      cell.style.borderColor = hz > 0 ? 'transparent' : '';
    }
    box.classList.toggle('live', any > 0);
  }
}

function updateReadouts() { if (readoutSpikes) paintReadouts(rateAt); }

// ───────────────────────────────── sélection ─────────────────────────────────
async function selectNeuron(i, fly) {
  picked = i;
  scene.select(i);
  if (fly) {
    const p = new THREE.Vector3(D.positions[i * 3], D.positions[i * 3 + 1], D.positions[i * 3 + 2]);
    scene.flyTo(p, 480);
  }
  const A = D.atlas;
  const typeName = A.cellType[D.typeCodes[i]] || '';
  const sc = A.superClass[D.superClass[i]] || '—';
  const cc = A.cellClass[D.cellClass[i]] || '—';
  const nt = A.neurotransmitter[D.nt[i]] || '—';
  const side = A.side[D.side[i]] || '—';
  const id = D.ids[i].toString();
  const known = Object.entries(D.sims.readoutIndices).find(([, idx]) => idx === i);

  $('#picked').className = 'picked';
  $('#picked').innerHTML =
    '<div class="title">' + (known ? known[0] : (typeName || 'neurone ' + i)) + '</div>' +
    '<div class="sub">' + (known ? typeName + ' · ' : '') + sc + (cc ? ' · ' + cc : '') + '</div>' +
    '<dl>' +
      '<dt>ID FlyWire</dt><dd><a href="https://codex.flywire.ai/app/cell_details?root_id=' + id +
        '" target="_blank" rel="noopener">' + id + '</a></dd>' +
      '<dt>Neurotransmetteur</dt><dd>' + nt + '</dd>' +
      '<dt>Côté</dt><dd>' + side + '</dd>' +
      '<dt>Index modèle</dt><dd>' + i + '</dd>' +
    '</dl>';

  const cEl = $('#picked-conn');
  cEl.innerHTML = '<p class="note">chargement du graphe synaptique…</p>';
  const g = await ensureGraph();
  const out = outgoingOf(g, i, 18);
  const inc = incomingOf(g, i, 18);
  scene.showConnections(i, out.concat(inc));

  const isMotor = (D.atlas.superClass[D.superClass[i]] || '') === 'motor';
  const list = (items, title, empty) => {
    if (!items.length) return '<h4>' + title + '</h4><p class="note">' + empty + '</p>';
    return '<h4>' + title + '</h4><ul>' + items.map(([j, w]) => {
      const nm = D.atlas.cellType[D.typeCodes[j]] || ('#' + j);
      return '<li data-i="' + j + '"><i class="sgn ' + (w >= 0 ? 'exc' : 'inh') + '"></i>' +
             '<span>' + nm + '</span><span class="w">' + (w >= 0 ? '+' : '') + w + '</span></li>';
    }).join('') + '</ul>';
  };
  const emptyOut = isMotor
    ? 'aucune dans le cerveau — c’est un motoneurone, son axone sort vers le corps. '
      + 'C’est exactement pourquoi le modèle a besoin d’une interface motrice externe.'
    : 'aucune au-dessus du seuil d’affichage (5 synapses).';
  cEl.innerHTML = list(out, 'Cibles (sortant)', emptyOut) +
    list(inc, 'Sources (entrant)', 'aucune au-dessus du seuil d’affichage (5 synapses).') +
    '<p class="note" style="margin-top:10px">Orange = excitateur, bleu = inhibiteur. ' +
    'Le nombre est le compte de synapses.</p>';
  cEl.querySelectorAll('li').forEach((li) => {
    li.onclick = () => selectNeuron(+li.dataset.i, true);
  });
}

async function ensureGraph() {
  if (graph) return graph;
  const note = $('#prune-note');
  graph = await loadGraph(D.graphMeta, (got, total) => {
    if (total) note.textContent = 'graphe : ' + Math.round((got / total) * 100) + ' %';
  });
  note.textContent = fmt(D.graphMeta.nnz) + ' connexions, ' +
    Math.round(D.graphMeta.weightFraction * 100) + ' % du poids synaptique';
  return graph;
}

// ───────────────────────────────── recherche ─────────────────────────────────
let typeIndex = null;
function buildTypeIndex() {
  typeIndex = new Map();
  for (let i = 0; i < D.n; i++) {
    const c = D.typeCodes[i];
    if (!c) continue;
    let a = typeIndex.get(c);
    if (!a) typeIndex.set(c, a = []);
    a.push(i);
  }
}

function doSearch(q) {
  const el = $('#search-results');
  q = q.trim().toLowerCase();
  if (q.length < 2) { el.innerHTML = ''; return; }
  if (!typeIndex) buildTypeIndex();
  const names = D.atlas.cellType;
  const hits = [];
  for (let c = 1; c < names.length && hits.length < 60; c++) {
    if (names[c].toLowerCase().includes(q)) {
      const arr = typeIndex.get(c);
      if (arr) hits.push([names[c], arr]);
    }
  }
  hits.sort((a, b) => a[0].length - b[0].length);
  el.innerHTML = hits.slice(0, 40).map(([nm, arr], k) =>
    '<button data-k="' + k + '"><span>' + nm + '</span><span class="n">' + arr.length + '</span></button>').join('')
    || '<p class="note">aucun type ne correspond.</p>';
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const [, arr] = hits[+b.dataset.k];
      clearGlow();
      for (const i of arr) addGlow(i);
      scene.commitActivity();
      selectNeuron(arr[0], true);
    };
  });
}

// ───────────────────────────────── simulation live ─────────────────────────────
function buildLive() {
  const sel = $('#live-input'), sil = $('#live-silence');
  for (const [k, v] of Object.entries(D.sims.inputs)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.name + ' (' + v.indices.length + ' neurones)';
    sel.appendChild(o);
    const o2 = o.cloneNode(true); sil.appendChild(o2);
  }
  sel.value = 'sugar';
  sel.onchange = () => { $('#live-hz').value = D.sims.inputs[sel.value].hz; };
  $('#prune-note').textContent = fmt(D.graphMeta.nnz) + ' connexions (non chargé)';
}

async function startLive() {
  const key = $('#live-input').value;
  const hz = Math.max(1, +$('#live-hz').value || 200);
  const silKey = $('#live-silence').value;
  const btn = $('#btn-live');
  btn.disabled = true; btn.textContent = 'chargement du graphe…';

  const g = await ensureGraph();
  if (!worker) {
    worker = new Worker('./js/sim-worker.js', { type: 'module' });
    worker.onmessage = onWorker;
    worker.postMessage({ type: 'graph', indptr: g.indptr.buffer.slice(g.indptr.byteOffset, g.indptr.byteOffset + g.indptr.byteLength),
                         indices: g.indices.buffer.slice(g.indices.byteOffset, g.indices.byteOffset + g.indices.byteLength),
                         weights: g.weights.buffer.slice(g.weights.byteOffset, g.weights.byteOffset + g.weights.byteLength) });
  }
  setPlaying(false);
  clearGlow();
  live = { queue: [], frames: 0, spikes: 0, hist: new Map() };
  for (const nm of Object.keys(D.sims.readoutIndices)) live.hist.set(nm, []);
  live.byIndex = new Map(Object.entries(D.sims.readoutIndices).map(([nm, i]) => [i, nm]));
  worker.postMessage({ type: 'start', stim: D.sims.inputs[key].indices, hz,
                       silence: silKey ? D.sims.inputs[silKey].indices : [] });
  btn.disabled = false; btn.textContent = '▶ Lancer la simulation';
  $('#btn-live-stop').disabled = false;
  $('#live-stats').innerHTML = 'démarrage…';
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'frames') {
    if (!live) return;
    for (const f of m.frames) live.queue.push(f);
    live.spikes = m.total;
    live.step = m.step;
    live.awake = m.awake;
    live.rate = m.rate;
  }
}

function stopLive() {
  if (worker) worker.postMessage({ type: 'stop' });
  live = null;
  $('#btn-live-stop').disabled = true;
}

// ───────────────────────────────── boucle ─────────────────────────────────
let last = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (live) {
    // consomme jusqu'à 12 trames par image pour rester fluide
    let k = 0;
    while (live.queue.length && k < 20) {
      decayGlow($('#trail').checked ? 0.90 : 0.0);
      for (const i of live.queue.shift()) {
        addGlow(i);
        const nm = live.byIndex.get(i);
        if (nm !== undefined) live.hist.get(nm).push(live.frames);
      }
      live.frames++; k++;
    }
    if (k) {
      worker.postMessage({ type: 'ack', count: k });
      live.wall = (live.wall || 0) + dt;
      scene.commitActivity();
      paintReadouts((nm) => {
        const arr = live.hist.get(nm) || [];
        let c = 0;
        for (let j = arr.length - 1; j >= 0 && arr[j] >= live.frames - WINDOW_MS; j--) c++;
        return Math.round((c * 1000) / WINDOW_MS);
      });
      $('#live-stats').innerHTML =
        '<b>' + live.frames + '</b> ms simulées · <b>' + fmt(live.spikes) + '</b> spikes · ' +
        '<b>' + fmt(live.awake || 0) + '</b> neurones éveillés<br>' +
        'vitesse : <b>' + (live.wall ? (live.frames / 1000 / live.wall).toFixed(2) : '—') +
        '×</b> le temps réel';
    }
  } else if (playing && sim) {
    const speed = +$('#speed').value;
    acc += dt * 1000 * speed;
    let guard = 0;
    while (acc >= 1 && frame < D.sims.nFrames && guard++ < 64) { advanceFrame(); acc -= 1; }
    scene.commitActivity();
    $('#time').value = frame;
    $('#t-read').textContent = frame + ' ms';
    drawRasterCursor(frame);
    updateReadouts();
    if (frame >= D.sims.nFrames) setPlaying(false);
  }

  scene.render(dt);
}

// ───────────────────────────────── interface ─────────────────────────────────
function wireUI() {
  $('#topstats').innerHTML =
    '<span><b>' + fmt(D.n) + '</b> neurones</span>' +
    '<span><b>' + fmt(D.graphMeta.fullNnz) + '</b> connexions</span>' +
    '<span><b>1</b> paramètre libre</span>';

  $('#colormode').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#colormode button').forEach((x) => x.classList.toggle('on', x === b));
    applyMode(b.dataset.mode);
  };
  document.querySelector('.views').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view === 'spin') {
      scene.controls.autoRotate = !scene.controls.autoRotate;
      b.classList.toggle('on', scene.controls.autoRotate);
    } else scene.setView(b.dataset.view);
  };
  $('#ptsize').oninput = (e) => scene.setPointSize(+e.target.value);
  $('#ptalpha').oninput = (e) => scene.setAlpha(+e.target.value);

  $('#btn-play').onclick = () => { stopLive(); setPlaying(!playing); };
  $('#btn-restart').onclick = () => { stopLive(); gotoFrame(0, true); };
  $('#time').oninput = (e) => { stopLive(); setPlaying(false); gotoFrame(+e.target.value, true); };
  $('#trail').onchange = () => gotoFrame(frame, true);

  $('#btn-live').onclick = startLive;
  $('#btn-live-stop').onclick = () => { stopLive(); $('#live-stats').innerHTML = 'arrêtée.'; };

  $('#search').oninput = (e) => doSearch(e.target.value);

  const canvas = $('#view');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5 || e.button !== 0) return;
    const i = scene.pick(e.clientX, e.clientY);
    if (i >= 0) selectNeuron(i, false);
    else { scene.select(-1); scene.hideConnections(); }
  });

  const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  let tipRaf = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (tipRaf) return;
    tipRaf = requestAnimationFrame(() => {
      tipRaf = 0;
      const i = scene.pick(e.clientX, e.clientY, 9);
      if (i < 0) { tip.classList.remove('on'); return; }
      const nm = D.atlas.cellType[D.typeCodes[i]] ||
                 D.atlas.superClass[D.superClass[i]] || 'neurone';
      tip.textContent = nm;
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
      tip.classList.add('on');
    });
  });

  $('#btn-about').onclick = () => $('#about').showModal();
  const mobile = matchMedia('(max-width: 820px)');
  $('#toggle-left').onclick = () => {
    const p = $('#left');
    if (mobile.matches) p.classList.toggle('open');
    else { p.classList.toggle('hide'); $('#toggle-left').classList.toggle('closed'); }
  };
  $('#toggle-right').onclick = () => {
    const p = $('#right');
    if (mobile.matches) p.classList.toggle('open');
    else { p.classList.toggle('hide'); $('#toggle-right').classList.toggle('closed'); }
  };

  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); stopLive(); setPlaying(!playing); }
    if (e.key === 'r') { stopLive(); gotoFrame(0, true); }
  });
  addEventListener('resize', () => { if (sim) drawRaster(); });
}
