// Chargement des données binaires de l'atlas et des simulations.

const BASE = './data/';

async function fetchBuf(path, onBytes) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error('Échec du chargement : ' + path + ' (' + res.status + ')');
  if (!onBytes || !res.body) return res.arrayBuffer();
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

const fetchJson = (p) => fetch(BASE + p).then((r) => r.json());

/** Regroupe les 10 super-classes FlyWire en familles lisibles. */
export const FAMILIES = {
  optic: 'optic',
  central: 'central',
  sensory: 'sensory', sensory_ascending: 'sensory',
  visual_projection: 'visual', visual_centrifugal: 'visual',
  ascending: 'ascending',
  descending: 'descending',
  motor: 'motor', endocrine: 'motor',
};

export async function loadAtlas(step) {
  step('métadonnées de l’atlas…', 0.02);
  const atlas = await fetchJson('atlas.json');
  const n = atlas.n;

  step('positions des 138 639 neurones…', 0.1);
  const positions = new Float32Array(await fetchBuf('positions.bin'));
  step('types cellulaires et annotations…', 0.34);
  const attrs = new Uint8Array(await fetchBuf('attrs.bin'));
  const typeCodes = new Uint16Array(await fetchBuf('types.bin'));
  const ids = new BigUint64Array(await fetchBuf('ids.bin'));

  step('expériences précalculées…', 0.55);
  const sims = await fetchJson('sims/index.json');
  const graphMeta = await fetchJson('graph.json');

  // attrs est entrelacé : superClass, side, nt, cellClass
  const superClass = new Uint8Array(n);
  const side = new Uint8Array(n);
  const nt = new Uint8Array(n);
  const cellClass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    superClass[i] = attrs[i * 4];
    side[i] = attrs[i * 4 + 1];
    nt[i] = attrs[i * 4 + 2];
    cellClass[i] = attrs[i * 4 + 3];
  }

  // famille par neurone
  const famNames = ['optic', 'central', 'sensory', 'visual', 'ascending', 'descending', 'motor', 'other'];
  const famOf = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const name = atlas.superClass[superClass[i]] || '';
    const f = FAMILIES[name];
    famOf[i] = f ? famNames.indexOf(f) : 7;
  }

  return { n, positions, ids, superClass, side, nt, cellClass, typeCodes,
           famOf, famNames, atlas, sims, graphMeta };
}

/** Trains de spikes d'une expérience précalculée. */
export async function loadSim(key, nFrames) {
  const buf = await fetchBuf('sims/' + key + '.bin');
  const frames = new Uint32Array(buf, 0, nFrames + 1);
  const nSpikes = frames[nFrames];
  const neurons = new Uint32Array(buf, (nFrames + 1) * 4, nSpikes);
  const steps = new Uint16Array(buf, (nFrames + 1) * 4 + nSpikes * 4, nSpikes);
  return { frames, neurons, steps, nSpikes };
}

/** Graphe synaptique élagué (CSR par neurone présynaptique). Volumineux : à la demande. */
let graphPromise = null;
export function loadGraph(meta, onProgress) {
  if (!graphPromise) {
    graphPromise = fetchBuf('graph.bin', onProgress).then((buf) => ({
      indptr:  new Uint32Array(buf, meta.offsets.indptr, meta.n + 1),
      indices: new Uint32Array(buf, meta.offsets.indices, meta.nnz),
      weights: new Int16Array(buf, meta.offsets.weights, meta.nnz),
      buffer: buf,
    }));
  }
  return graphPromise;
}

/** Partenaires entrants d'un neurone : balayage du CSR (≈ 2,7 M d'arêtes, quelques ms). */
export function incomingOf(graph, target, limit = 24) {
  const { indptr, indices, weights } = graph;
  const found = [];
  for (let pre = 0, n = indptr.length - 1; pre < n; pre++) {
    for (let k = indptr[pre], end = indptr[pre + 1]; k < end; k++) {
      if (indices[k] === target) { found.push([pre, weights[k]]); break; }
    }
  }
  found.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return found.slice(0, limit);
}

export function outgoingOf(graph, source, limit = 24) {
  const { indptr, indices, weights } = graph;
  const out = [];
  for (let k = indptr[source], end = indptr[source + 1]; k < end; k++) {
    out.push([indices[k], weights[k]]);
  }
  out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return out.slice(0, limit);
}
