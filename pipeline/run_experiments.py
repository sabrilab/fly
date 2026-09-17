"""
Lance les experiences et exporte les trains de spikes pour le viewer 3D.

Format binaire par experience (little-endian) :
  frames.bin  : uint32[nFrames+1]  offsets des spikes par trame de 1 ms
  neurons.bin : uint32[nSpikes]    index du neurone, trie par trame
  steps.bin   : uint16[nSpikes]    pas exact (0,1 ms) du spike
Tout est concatene dans un seul fichier <cle>.bin, les offsets sont dans index.json.
"""
import json, sys, time
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lif import Connectome, simulate
import neuron_sets as NS

EON = Path('/home/user/eonsystemspbc/fly-brain')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'web' / 'data' / 'sims'
OUT.mkdir(parents=True, exist_ok=True)

DURATION = 1.0
FRAME_MS = 1.0
STEPS_PER_FRAME = int(FRAME_MS / 0.1)

EXPERIMENTS = [
    ('rest',         'Repos (aucune stimulation)', [], 'Le modele est silencieux sans entree : pas d activite spontanee.'),
    ('sugar',        'Sucre',        [('sugar', 200)],  'GRN sucre du labelle. Voie attractive -> MN9, le motoneurone de la trompe.'),
    ('bitter',       'Amer',         [('bitter', 200)], 'GRN amers. Voie aversive.'),
    ('sugar_bitter', 'Sucre + amer', [('sugar', 200), ('bitter', 200)], 'Competition : l amer doit supprimer la reponse alimentaire au sucre.'),
    ('p9',           'P9 (marche avant)', [('p9', 100)], 'Commande descendante de marche, injectee directement.'),
    ('lc4',          'LC4 (looming)',[('lc4', 200)],   'Objet qui fonce : voie visuelle de fuite -> Giant Fiber.'),
    ('jo',           'Organe de Johnston', [('jo', 300)], 'Vibration antennaire -> toilettage -> aDN1.'),
    ('or56a',        'Or56a (geosmine)', [('or56a', 250)], 'Odeur aversive innee.'),
]


def main():
    print('chargement du connectome...')
    comp = pd.read_csv(EON / 'data/2025_Completeness_783.csv', index_col=0)
    flyid2i = {fid: i for i, fid in enumerate(comp.index)}
    n = len(comp)
    con = pd.read_parquet(EON / 'data/2025_Connectivity_783.parquet',
                          columns=['Presynaptic_Index', 'Postsynaptic_Index',
                                   'Excitatory x Connectivity'])
    conn = Connectome.from_edges(
        n,
        con['Presynaptic_Index'].to_numpy(np.int64),
        con['Postsynaptic_Index'].to_numpy(np.int32),
        con['Excitatory x Connectivity'].to_numpy(np.float32),
    )
    print(f'  {n:,} neurones, {conn.nnz():,} connexions')

    def to_idx(ids):
        return np.array([flyid2i[f] for f in ids if f in flyid2i], dtype=np.int64)

    readout_idx = {name: flyid2i[fid] for fid, name, _ in NS.READOUTS if fid in flyid2i}
    index = {'duration': DURATION, 'frameMs': FRAME_MS,
             'nFrames': int(DURATION * 1000 / FRAME_MS), 'experiments': []}

    for key, label, stims, note in EXPERIMENTS:
        groups, stim_meta = [], []
        for inp_key, hz in stims:
            spec = NS.INPUTS[inp_key]
            idx = to_idx(spec['ids'])
            groups.append((idx, float(hz)))
            stim_meta.append({'key': inp_key, 'name': spec['name'], 'hz': hz,
                              'modality': spec['modality'], 'n': int(len(idx)),
                              'indices': idx.tolist()})

        t0 = time.time()
        steps, neurons = simulate(conn, groups, duration_s=DURATION, seed=0)
        elapsed = time.time() - t0

        order = np.argsort(steps, kind='stable')
        steps, neurons = steps[order], neurons[order]
        frame_of = (steps // STEPS_PER_FRAME).astype(np.int64)
        n_frames = index['nFrames']
        offsets = np.zeros(n_frames + 1, dtype=np.uint32)
        np.cumsum(np.bincount(frame_of, minlength=n_frames), out=offsets[1:])

        blob = (offsets.tobytes() + neurons.astype(np.uint32).tobytes()
                + steps.astype(np.uint16).tobytes())
        (OUT / f'{key}.bin').write_bytes(blob)

        active, counts = np.unique(neurons, return_counts=True)
        top = np.argsort(-counts)[:40]
        rates = {name: int((neurons == i).sum()) for name, i in readout_idx.items()}
        rates = {k: v for k, v in rates.items() if v}

        index['experiments'].append({
            'key': key, 'label': label, 'note': note, 'stim': stim_meta,
            'nSpikes': int(len(steps)), 'nActive': int(len(active)),
            'bytes': {'frames': int(offsets.nbytes), 'neurons': int(len(steps) * 4),
                      'steps': int(len(steps) * 2)},
            'readouts': rates,
            'top': [{'i': int(active[t]), 'n': int(counts[t])} for t in top],
        })
        rd = ', '.join(f'{k} {v} Hz' for k, v in sorted(rates.items(), key=lambda x: -x[1])[:5])
        print(f'  {key:14s} {len(steps):>8,} spikes | {len(active):>5} actifs | '
              f'{elapsed:5.1f} s | {rd}')

    index['readoutIndices'] = readout_idx
    index['inputs'] = {k: {'name': v['name'], 'hz': v['hz'], 'modality': v['modality'],
                           'indices': to_idx(v['ids']).tolist()}
                       for k, v in NS.INPUTS.items()}
    (OUT / 'index.json').write_text(json.dumps(index, ensure_ascii=False))
    total = sum(f.stat().st_size for f in OUT.iterdir())
    print(f'\n  total simulations : {total/1e6:.2f} Mo')


if __name__ == '__main__':
    main()
