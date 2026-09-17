"""
Exporte le graphe synaptique pour le navigateur, et mesure le cout de l'elagage.

Le graphe complet (15,1 M de connexions) pese ~91 Mo : trop pour une page web.
On expedie un graphe elague au seuil |synapses| >= SEUIL, et on quantifie
honnetement ce que l'on perd en relancant l'experience "sucre" dessus.

Format : CSR indexe par neurone PREsynaptique
  indptr  uint32[N+1] | indices uint32[nnz] | weights int16[nnz]
"""
import json, sys, time
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lif import Connectome, simulate
import neuron_sets as NS

EON = Path('/home/user/eonsystemspbc/fly-brain')
OUT = Path(__file__).resolve().parent.parent / 'web' / 'data'
SEUIL = 5


def main():
    comp = pd.read_csv(EON / 'data/2025_Completeness_783.csv', index_col=0)
    flyid2i = {fid: i for i, fid in enumerate(comp.index)}
    n = len(comp)
    con = pd.read_parquet(EON / 'data/2025_Connectivity_783.parquet',
                          columns=['Presynaptic_Index', 'Postsynaptic_Index',
                                   'Excitatory x Connectivity'])
    pre = con['Presynaptic_Index'].to_numpy(np.int64)
    post = con['Postsynaptic_Index'].to_numpy(np.int32)
    w = con['Excitatory x Connectivity'].to_numpy(np.float32)
    del con

    full = Connectome.from_edges(n, pre, post, w)
    keep = np.abs(w) >= SEUIL
    pruned = Connectome.from_edges(n, pre[keep], post[keep], w[keep])
    print(f'graphe complet : {full.nnz():,} connexions')
    print(f'graphe elague  : {pruned.nnz():,} connexions  (|syn| >= {SEUIL}, '
          f'{100*np.abs(w[keep]).sum()/np.abs(w).sum():.1f} % du poids synaptique)')

    # --- cout de l'elagage, mesure sur l'experience sucre ---------------------
    idx = np.array([flyid2i[f] for f in NS.SUGAR_GRNS], dtype=np.int64)
    res = {}
    for label, c in (('complet', full), ('elague', pruned)):
        t0 = time.time()
        s, nu = simulate(c, [(idx, 200.0)], duration_s=1.0, seed=0)
        res[label] = (len(s), len(np.unique(nu)))
        print(f'  sucre 200 Hz / {label:8s} : {len(s):>7,} spikes, '
              f'{len(np.unique(nu)):>4} actifs  ({time.time()-t0:.1f} s)')
    a, b = res['complet'], res['elague']
    print(f'  -> le graphe elague conserve {100*b[1]/a[1]:.0f} % des neurones actifs, '
          f'{100*b[0]/a[0]:.0f} % des spikes')

    # --- ecriture ------------------------------------------------------------
    blob = (pruned.indptr.astype(np.uint32).tobytes()
            + pruned.indices.astype(np.uint32).tobytes()
            + np.clip(pruned.weights, -32768, 32767).astype(np.int16).tobytes())
    (OUT / 'graph.bin').write_bytes(blob)

    deg_out = np.diff(pruned.indptr)
    deg_in = np.bincount(pruned.indices, minlength=n)
    meta = {
        'n': n, 'nnz': int(pruned.nnz()), 'threshold': SEUIL,
        'fullNnz': int(full.nnz()),
        'weightFraction': round(float(np.abs(w[keep]).sum() / np.abs(w).sum()), 4),
        'offsets': {'indptr': 0, 'indices': int((n + 1) * 4),
                    'weights': int((n + 1) * 4 + pruned.nnz() * 4)},
        'fidelity': {'fullSpikes': a[0], 'fullActive': a[1],
                     'prunedSpikes': b[0], 'prunedActive': b[1]},
        'degree': {'maxOut': int(deg_out.max()), 'maxIn': int(deg_in.max()),
                   'meanOut': round(float(deg_out.mean()), 1)},
    }
    (OUT / 'graph.json').write_text(json.dumps(meta))
    print(f'\n  graph.bin : {(OUT/"graph.bin").stat().st_size/1e6:.1f} Mo')


if __name__ == '__main__':
    main()
