import * as THREE from 'three';
import { BrainScene } from './scene.js';
import { loadAtlas, loadSim, loadGraph, incomingOf, outgoingOf } from './data.js';
import { loadBody } from './fly-body.js';
import { MotorController, BEHAVIOURS } from './motor.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString('fr-FR');
const SLOT = ['#3987e5', '#d95926', '#199e70', '#6b6a64'];

let D, scene, body = null, motor = null;
let sim = null, graph = null, worker = null;
let picked = -1, playing = false, frame = 0, acc = 0, live = null;
let glowList = new Int32Array(200000), glowCount = 0;
let viewMode = 'fly';

// ───────────────────────────────── chargement ─────────────────────────────────
const stepEl = $('#loader-step'), fillEl = $('#loader-fill');
const step = (msg, p) => { stepEl.textContent = msg; fillEl.style.width = (p * 100) + '%'; };

(async function boot() {
  try {
    D = await loadAtlas(step);
    step('mise en place de la scène 3D…', 0.72);
    scene = new BrainScene($('#view'), D);
    step('corps de la mouche (scan aux rayons X)…', 0.82);
    body = await loadBody();
    scene.scene.add(body.root);
    motor = new MotorController(body);
    window.__scene = scene; window.__body = body; window.__motor = motor;
    buildModes(); buildLegend(); buildExperiments(); buildReadouts(); buildLive(); buildStory();
    wireUI();
    await selectExperiment('sugar');
    setViewMode('fly', true);
    step('prêt', 1);
    setTimeout(() => $('#loader').classList.add('done'), 260);
    setTimeout(() => $('#hint').classList.add('fade'), 9000);
    if (!localStorage.getItem('tourSeen')) setTimeout(() => startTour(), 1100);
    tick();
  } catch (err) {
    stepEl.textContent = 'Erreur : ' + err.message;
    stepEl.style.color = '#e66767';
    console.error(err);
  }
})();

// ───────────────────────────── échelle : mouche / tête / cerveau ──────────────
const VIEWS = {
  fly:   { pos: [3400, 1900, -3400], target: [0, -320, 820], op: 1.0,  size: 1.9 },
  head:  { pos: [880, 430, -1020],   target: [0, -60, -60],  op: 1.0,  size: 2.1 },
  brain: { pos: [0, 55, 1180],       target: [0, 0, 0],      op: 0.18, size: 1.9 },
};

function setViewMode(name, instant) {
  viewMode = name;
  const v = VIEWS[name];
  document.querySelectorAll('#viewmode button')
    .forEach((b) => b.classList.toggle('on', b.dataset.vm === name));
  scene.flyToPose(v.pos, v.target, instant);
  $('#bodyop').value = v.op;
  body.setOpacity(v.op);
  scene.setPointSize(v.size);
  $('#ptsize').value = v.size;
}

// ───────────────────────────────── modes de couleur ────────────────────────────
// Trois catégories vives au plus par mode (palette validée), le reste neutre.
let MODES = {}, mode = 'anatomy', hidden = new Set();

const MODE_NOTES = {
  anatomy: 'Où sont les neurones. Plus de la moitié du cerveau ne sert qu’à voir.',
  pathway: 'À quoi ils servent. Les entrées arrivent d’un côté, les ordres pour le corps repartent de l’autre.',
  nt: 'Ce qu’ils disent. Chaque neurone ne sait faire qu’une chose : exciter, ou freiner.',
  side: 'Le cerveau est symétrique : un exemplaire de presque chaque neurone à gauche et à droite.',
};

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
        DESC = fam('descending'), MOT = fam('motor');

  MODES.anatomy = mk(
    ['Pour voir (lobes optiques)', 'Le reste du cerveau', 'Les sens (goût, odeur, toucher)', 'Autres'],
    (i) => { const f = D.famOf[i];
      return f === OPTIC ? 0 : f === CENTRAL ? 1 : f === SENS ? 2 : 3; });

  MODES.pathway = mk(
    ['Entrées : ce que la mouche perçoit', 'Sorties : les ordres vers le corps', 'Muscles et hormones', 'Traitement interne'],
    (i) => { const f = D.famOf[i];
      return f === SENS ? 0 : f === DESC ? 1 : f === MOT ? 2 : 3; });

  MODES.nt = mk(
    ['Excitent (acétylcholine)', 'Freinent (GABA, glutamate)', 'Modulent (dopamine, sérotonine…)', 'Non déterminé'],
    (i) => { const s = ntNames[D.nt[i]] || '';
      if (s.includes('acetyl')) return 0;
      if (s.includes('gaba') || s.includes('glutam')) return 1;
      if (s) return 2;
      return 3; });

  MODES.side = mk(['Moitié gauche', 'Moitié droite', 'Au milieu', 'Non déterminé'],
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
  $('#mode-note').textContent = MODE_NOTES[name] || '';
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
    b.title = 'Cliquer pour masquer ce groupe';
    b.onclick = () => { hidden.has(e.k) ? hidden.delete(e.k) : hidden.add(e.k);
                        applyVisibility(); buildLegend(); };
    el.appendChild(b);
  }
}

// ───────────────────────────────── expériences ─────────────────────────────────
// Ce que chaque expérience raconte, en français simple.
const STORIES = {
  rest: 'Rien n’entre, rien ne sort. Ce modèle n’a aucune activité de fond : sans stimulus, il reste parfaitement muet. C’est déjà une information — un vrai cerveau, lui, bruisse en permanence.',
  sugar: 'La mouche pose une patte sur du sucre. 23 neurones du goût s’allument, le signal traverse le cerveau et arrive à <b>MN9</b> : la trompe se déploie. La mouche mange.',
  bitter: 'La mouche touche quelque chose d’amer. Une voie s’allume aussi — mais elle ne va pas à MN9. Rien ne se déploie.',
  sugar_bitter: 'Sucre <b>et</b> amer en même temps. L’amer éteint complètement la réponse au sucre : MN9 reste muet. Personne n’a programmé ce blocage. Il sort du câblage, tout seul.',
  p9: 'On appuie directement sur la commande de marche, sans passer par les sens. C’est un raccourci de laboratoire, pas une situation naturelle.',
  lc4: 'Quelque chose fonce sur la mouche. Les détecteurs d’objet qui grossit s’allument et réveillent la <b>fibre géante</b>, le neurone le plus rapide du cerveau : fuite immédiate.',
  jo: 'On fait vibrer l’antenne, comme un grain de poussière qui s’y pose. Le signal remonte jusqu’à <b>aDN1</b> : la mouche se toilette.',
  or56a: 'Une odeur de moisi — la géosmine, que la mouche déteste d’instinct. Le cerveau s’agite beaucoup et les neurones de virage s’allument : elle s’éloigne.',
};

function buildExperiments() {
  const sel = $('#exp-select');
  const LABELS = {
    rest: 'Rien — le cerveau au repos', sugar: 'Du sucre', bitter: 'De l’amer',
    sugar_bitter: 'Du sucre ET de l’amer', p9: 'Ordre de marche (direct)',
    lc4: 'Un objet qui fonce', jo: 'Une vibration sur l’antenne', or56a: 'Une odeur repoussante',
  };
  for (const e of D.sims.experiments) {
    const o = document.createElement('option');
    o.value = e.key;
    o.textContent = (LABELS[e.key] || e.label) + '  ·  ' + fmt(e.nSpikes) + ' décharges';
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
  $('#exp-note').innerHTML = expMeta.stim.length
    ? 'On allume ' + expMeta.stim.map((s) => '<b>' + s.n + '</b> neurones (' + s.name +
        ') à ' + s.hz + ' fois par seconde').join(', puis ') + '.'
    : 'On n’allume rien du tout.';
  sim = await loadSim(key, D.sims.nFrames);
  if (motor) motor.reset();

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
  updateStory();
}

// ───────────────────────────────── raster ─────────────────────────────────
function drawRaster() {
  const cv = $('#raster');
  const w = cv.clientWidth || 310, h = 132;
  cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round(h * devicePixelRatio);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#1c1c1f'; ctx.fillRect(0, 0, W, H);
  if (!sim.nSpikes) {
    ctx.fillStyle = '#6e6e70';
    ctx.font = (12 * devicePixelRatio) + 'px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('aucune activité — le cerveau est muet', W / 2, H / 2);
    rasterImage = ctx.getImageData(0, 0, W, H);
    return;
  }
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
  const ctx = cv.getContext('2d', { willReadFrequently: true });
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

// ───────────────────────────── ordres envoyés au corps ────────────────────────
const RO_GROUPS = [
  { label: 'MN9',         role: 'déploie la trompe · manger',   members: ['MN9_left', 'MN9_right'],            short: ['G', 'D'] },
  { label: 'Giant Fiber', role: 'déclenche le saut · fuir',     members: ['GiantFiber_1', 'GiantFiber_2'],     short: ['1', '2'] },
  { label: 'aDN1',        role: 'frotte les antennes · se toiletter', members: ['aDN1_left', 'aDN1_right'],    short: ['G', 'D'] },
  { label: 'P9',          role: 'lance la marche · avancer',    members: ['P9_left', 'P9_right'],              short: ['G', 'D'] },
  { label: 'P9_oDN1',     role: 'règle la vitesse',             members: ['P9_oDN1_left', 'P9_oDN1_right'],    short: ['G', 'D'] },
  { label: 'DNa01',       role: 'fait tourner',                 members: ['DNa01_left', 'DNa01_right'],        short: ['G', 'D'] },
  { label: 'DNa02',       role: 'fait tourner',                 members: ['DNa02_left', 'DNa02_right'],        short: ['G', 'D'] },
  { label: 'MDN',         role: 'inverse la marche · reculer',  members: ['MDN_1', 'MDN_2', 'MDN_3', 'MDN_4'], short: ['1', '2', '3', '4'] },
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

let currentRates = {};
function paintReadouts(getRate) {
  currentRates = {};
  for (const g of RO_GROUPS) {
    const box = document.querySelector('.rg[data-group="' + CSS.escape(g.label) + '"]');
    if (!box) continue;
    let any = 0;
    for (const m of g.members) {
      const cell = box.querySelector('.rc[data-name="' + m + '"]');
      if (!cell) continue;
      const hz = getRate(m);
      currentRates[m] = hz;
      any = Math.max(any, hz);
      cell.querySelector('b').textContent = hz;
      const t = Math.min(1, hz / RATE_MAX);
      cell.classList.toggle('on', hz > 0);
      cell.style.background = hz > 0 ? RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))] : '';
      cell.style.borderColor = hz > 0 ? 'transparent' : '';
    }
    box.classList.toggle('live', any > 0);
  }
}
function updateReadouts() { if (readoutSpikes) paintReadouts(rateAt); }

// ───────────────────────────────── récit ─────────────────────────────────
function buildStory() {
  $('#story').innerHTML =
    '<p class="lead" id="story-lead"></p>' +
    '<div class="chips" id="story-chips"></div>' +
    '<div class="meter"><i id="story-meter"></i></div>' +
    '<p class="legend-hint" id="story-count"></p>';
}

function updateStory() {
  const key = expMeta ? expMeta.key : 'rest';
  $('#story-lead').innerHTML = live ? 'Simulation en direct dans votre navigateur.'
                                    : (STORIES[key] || '');
  const acts = motor ? motor.activeList(0.05) : [];
  const set = new Set(acts.map((a) => a.key));
  $('#story-chips').innerHTML = BEHAVIOURS.map((b) =>
    '<span class="chip' + (set.has(b.key) ? ' on' : '') + '" title="' + b.detail + '">' +
    '<i></i>' + b.label + '</span>').join('');

  const nActive = glowCount;
  $('#story-meter').style.width = Math.min(100, (nActive / 900) * 100) + '%';
  $('#story-count').innerHTML = nActive
    ? '<b>' + fmt(nActive) + '</b> neurones actifs sur ' + fmt(D.n) +
      ' — le cerveau n’est jamais allumé en entier, seule la voie concernée s’éclaire.'
    : '<span class="quiet">aucun neurone actif.</span>';

  const bar = $('#behaviour');
  if (acts.length) {
    const top = acts[0];
    bar.innerHTML = '<span class="dot"></span><b>' + top.label + '</b> <em>· ' + top.detail + '</em>';
    bar.classList.add('on');
  } else { bar.classList.remove('on'); bar.textContent = ''; }
  bar.classList.toggle('shifted', !$('#tour').hidden);
}

// ───────────────────────────────── sélection ─────────────────────────────────
async function selectNeuron(i, fly) {
  picked = i;
  scene.select(i);
  if (fly) {
    if (viewMode === 'fly') setViewMode('brain');
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
      '<dt>Fiche FlyWire</dt><dd><a href="https://codex.flywire.ai/app/cell_details?root_id=' + id +
        '" target="_blank" rel="noopener">' + id + '</a></dd>' +
      '<dt>Signal chimique</dt><dd>' + nt + '</dd>' +
      '<dt>Côté</dt><dd>' + side + '</dd>' +
    '</dl>';

  const cEl = $('#picked-conn');
  cEl.innerHTML = '<p class="note">chargement des connexions…</p>';
  const g = await ensureGraph();
  const out = outgoingOf(g, i, 18);
  const inc = incomingOf(g, i, 18);
  scene.showConnections(i, out.concat(inc));

  const isMotor = (A.superClass[D.superClass[i]] || '') === 'motor';
  const list = (items, title, empty) => {
    if (!items.length) return '<h4>' + title + '</h4><p class="note">' + empty + '</p>';
    return '<h4>' + title + '</h4><ul>' + items.map(([j, w]) => {
      const nm = A.cellType[D.typeCodes[j]] || ('#' + j);
      return '<li data-i="' + j + '"><i class="sgn ' + (w >= 0 ? 'exc' : 'inh') + '"></i>' +
             '<span>' + nm + '</span><span class="w">' + (w >= 0 ? '+' : '') + w + '</span></li>';
    }).join('') + '</ul>';
  };
  const emptyOut = isMotor
    ? 'aucune dans le cerveau — c’est un motoneurone, son câble sort vers le corps. C’est précisément pour ça que le modèle a besoin d’une interface motrice extérieure.'
    : 'aucune au-dessus du seuil d’affichage.';
  cEl.innerHTML = list(out, 'À qui il parle', emptyOut) +
    list(inc, 'Qui lui parle', 'aucune au-dessus du seuil d’affichage.') +
    '<p class="note" style="margin-top:10px">Orange = excite, bleu = freine. Le nombre est la ' +
    'quantité de contacts. Cliquez pour suivre la chaîne.</p>';
  cEl.querySelectorAll('li').forEach((li) => { li.onclick = () => selectNeuron(+li.dataset.i, true); });
}

async function ensureGraph() {
  if (graph) return graph;
  const note = $('#prune-note');
  graph = await loadGraph(D.graphMeta, (got, total) => {
    if (total) note.textContent = 'chargement du réseau : ' + Math.round((got / total) * 100) + ' %';
  });
  note.innerHTML = 'Réseau utilisé en direct : ' + fmt(D.graphMeta.nnz) + ' connexions, ' +
    'soit ' + Math.round(D.graphMeta.weightFraction * 100) + ' % du câblage total. ' +
    'Mesuré : ' + Math.round(100 * D.graphMeta.fidelity.prunedActive / D.graphMeta.fidelity.fullActive) +
    ' % des neurones actifs sont conservés. Les expériences enregistrées, elles, utilisent le réseau complet.';
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
  const NAMES = { sugar: 'Du sucre', bitter: 'De l’amer', jo: 'Une vibration sur l’antenne',
                  lc4: 'Un objet qui fonce', or56a: 'Une odeur repoussante', p9: 'L’ordre de marche' };
  for (const [k, v] of Object.entries(D.sims.inputs)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = (NAMES[k] || v.name) + ' (' + v.indices.length + ' neurones)';
    sel.appendChild(o);
    sil.appendChild(o.cloneNode(true));
  }
  sel.value = 'sugar';
  sel.onchange = () => { $('#live-hz').value = D.sims.inputs[sel.value].hz; };
  $('#prune-note').textContent = 'Réseau de ' + fmt(D.graphMeta.nnz) + ' connexions, chargé au premier lancement.';
}

async function startLive() {
  const key = $('#live-input').value;
  const hz = Math.max(1, +$('#live-hz').value || 200);
  const silKey = $('#live-silence').value;
  const btn = $('#btn-live');
  btn.disabled = true; btn.textContent = 'chargement…';
  const g = await ensureGraph();
  if (!worker) {
    worker = new Worker('./js/sim-worker.js', { type: 'module' });
    worker.onmessage = onWorker;
    const cut = (a) => a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength);
    worker.postMessage({ type: 'graph', indptr: cut(g.indptr), indices: cut(g.indices), weights: cut(g.weights) });
  }
  setPlaying(false);
  clearGlow();
  live = { queue: [], frames: 0, spikes: 0, hist: new Map(), wall: 0 };
  for (const nm of Object.keys(D.sims.readoutIndices)) live.hist.set(nm, []);
  live.byIndex = new Map(Object.entries(D.sims.readoutIndices).map(([nm, i]) => [i, nm]));
  worker.postMessage({ type: 'start', stim: D.sims.inputs[key].indices, hz,
                       silence: silKey ? D.sims.inputs[silKey].indices : [] });
  btn.disabled = false; btn.textContent = '▶ Lancer';
  $('#btn-live-stop').disabled = false;
  $('#live-stats').innerHTML = 'démarrage…';
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'frames' && live) {
    for (const f of m.frames) live.queue.push(f);
    live.spikes = m.total; live.awake = m.awake;
  }
}

function stopLive() {
  if (worker) worker.postMessage({ type: 'stop' });
  live = null;
  $('#btn-live-stop').disabled = true;
}

// ───────────────────────────────── visite guidée ─────────────────────────────
const TOUR = [
  { t: 'Voici une mouche.',
    b: 'Trois millimètres. Son cerveau tient dans sa tête et compte <b>138 639 neurones</b> — moins qu’une tête d’épingle. Chaque point lumineux est un vrai neurone, à sa vraie place. Le corps gris est un scan aux rayons X du même animal.',
    do: () => { setViewMode('fly'); selectExperiment('rest'); } },
  { t: 'Ce cerveau a été cartographié pour de bon.',
    b: 'Une mouche a été découpée en milliers de tranches et photographiée au microscope électronique. Des milliers de personnes ont reconstruit chaque neurone à la main. On connaît aujourd’hui les <b>15 millions de connexions</b> entre eux.',
    do: () => setViewMode('head') },
  { t: 'Plus de la moitié sert uniquement à voir.',
    b: 'Les deux gros blocs bleus sont les yeux vus de l’intérieur : <b>77 530 neurones sur 138 639</b>. Ce qui reste — l’orange — fait tout le reste : sentir, goûter, se souvenir, décider, marcher.',
    do: () => { setViewMode('brain'); applyMode('anatomy'); } },
  { t: 'Au repos, ce cerveau ne fait rien.',
    b: 'Pas une décharge. Dans ce modèle il n’y a aucune activité de fond : tant qu’on ne lui présente rien, il reste muet. Un vrai cerveau, lui, bruisse en permanence — c’est l’une des simplifications du modèle.',
    do: () => { selectExperiment('rest'); setPlaying(true); } },
  { t: 'Donnons-lui du sucre.',
    b: 'On allume les <b>23 neurones du goût sucré</b>, ceux des pattes et de la bouche. Regardez le signal se propager de proche en proche. Rien d’autre n’a été programmé : le trajet est uniquement dicté par le câblage.',
    do: async () => { setViewMode('brain'); await selectExperiment('sugar'); setPlaying(true); } },
  { t: 'Le signal arrive, la trompe se déploie.',
    b: 'Au bout de la chaîne il y a <b>MN9</b>, le neurone qui commande la trompe. Il se met à décharger à 90 fois par seconde, et la mouche mange. Nous ne lui avons montré que du sucre.',
    do: async () => { setViewMode('fly'); await selectExperiment('sugar'); gotoFrame(430, true); setPlaying(true); } },
  { t: 'Maintenant, ajoutons de l’amer.',
    b: 'Mêmes neurones du sucre, plus ceux de l’amer. <b>MN9 s’éteint complètement</b> : la mouche refuse de manger. Ce blocage n’a été écrit nulle part — il découle du seul plan de câblage. C’est le résultat qui a rendu ce modèle crédible.',
    do: async () => { await selectExperiment('sugar_bitter'); setPlaying(true); } },
  { t: 'Et voici la limite, qu’il faut voir aussi.',
    b: 'Le cerveau ne commande pas les muscles. Il n’allume que quelques <b>neurones descendants</b>, et chacun déclenche ici une animation écrite à la main. La démo « mouche incarnée » d’Eon Systems fait exactement pareil : <b>7 neurones</b> branchés sur des contrôleurs pré-entraînés, là où une vraie mouche en a plus de 1 300.',
    do: () => { setViewMode('fly'); } },
  { t: 'À vous.',
    b: 'Changez d’expérience, cliquez sur n’importe quel neurone pour voir à qui il parle, ou lancez votre propre stimulation : le modèle tourne pour de vrai dans votre navigateur.',
    do: () => { setViewMode('brain'); } },
];
let tourIdx = -1;

function startTour() { tourIdx = -1; $('#tour').hidden = false; nextTour(1); }
function closeTour() { $('#tour').hidden = true; localStorage.setItem('tourSeen', '1'); }
async function nextTour(dir) {
  tourIdx = Math.max(0, Math.min(TOUR.length - 1, tourIdx + dir));
  const s = TOUR[tourIdx];
  $('#tour-step').textContent = 'Étape ' + (tourIdx + 1) + ' sur ' + TOUR.length;
  $('#tour-title').textContent = s.t;
  $('#tour-body').innerHTML = s.b;
  $('#tour-fill').style.width = ((tourIdx + 1) / TOUR.length * 100) + '%';
  $('#tour-prev').disabled = tourIdx === 0;
  $('#tour-next').textContent = tourIdx === TOUR.length - 1 ? 'Terminer' : 'Suivant ›';
  try { await s.do(); } catch (e) { console.error(e); }
}

// ───────────────────────────────── boucle ─────────────────────────────────
let last = performance.now(), storyClock = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (live) {
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
      live.wall += dt;
      scene.commitActivity();
      paintReadouts((nm) => {
        const arr = live.hist.get(nm) || [];
        let c = 0;
        for (let j = arr.length - 1; j >= 0 && arr[j] >= live.frames - WINDOW_MS; j--) c++;
        return Math.round((c * 1000) / WINDOW_MS);
      });
      $('#live-stats').innerHTML =
        '<b>' + live.frames + '</b> ms de cerveau simulées · <b>' + fmt(live.spikes) + '</b> décharges · ' +
        '<b>' + fmt(live.awake || 0) + '</b> neurones éveillés<br>vitesse : <b>' +
        (live.wall ? (live.frames / 1000 / live.wall).toFixed(2) : '—') + '×</b> le temps réel';
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

  if (motor) { motor.enabled = $('#animate').checked; motor.update(currentRates, dt); }

  storyClock += dt;
  if (storyClock > 0.12) { storyClock = 0; updateStory(); }

  scene.render(dt);
}

// ───────────────────────────────── interface ─────────────────────────────────
function wireUI() {
  $('#topstats').innerHTML =
    '<span><b>' + fmt(D.n) + '</b> neurones</span>' +
    '<span><b>' + fmt(D.graphMeta.fullNnz) + '</b> connexions</span>' +
    '<span><b>1</b> seul réglage libre</span>';

  $('#viewmode').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setViewMode(b.dataset.vm);
  };
  $('#bodyop').oninput = (e) => body.setOpacity(+e.target.value);

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

  $('#btn-tour').onclick = () => startTour();
  $('#tour-next').onclick = () => (tourIdx === TOUR.length - 1 ? closeTour() : nextTour(1));
  $('#tour-prev').onclick = () => nextTour(-1);
  $('#tour-close').onclick = closeTour;

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
      tip.textContent = D.atlas.cellType[D.typeCodes[i]] ||
                        D.atlas.superClass[D.superClass[i]] || 'neurone';
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
    if (!$('#tour').hidden) {
      if (e.key === 'ArrowRight') nextTour(1);
      if (e.key === 'ArrowLeft') nextTour(-1);
      if (e.key === 'Escape') closeTour();
    }
  });
  addEventListener('resize', () => { if (sim) drawRaster(); });
}
