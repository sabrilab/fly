"""
Valide le simulateur numpy contre les resultats publies par Eon Systems.

Cible : banc d'essai d'Eon, experience "Sugar GRNs (200 Hz)", t_run = 1 s,
n_run = 1, backend Brian2 CPU (la verite terrain de leur depot) ->
mediane sur 5 tours : 16 708 spikes, 387,5 neurones actifs.
"""
import sys, time
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lif import Connectome, simulate
from neuron_sets import SUGAR_GRNS_BENCH

EON = Path('/home/user/eonsystemspbc/fly-brain')

print('chargement du connectome...')
t0 = time.time()
comp = pd.read_csv(EON / 'data/2025_Completeness_783.csv', index_col=0)
flyid2i = {fid: i for i, fid in enumerate(comp.index)}
con = pd.read_parquet(EON / 'data/2025_Connectivity_783.parquet',
                      columns=['Presynaptic_Index', 'Postsynaptic_Index',
                               'Excitatory x Connectivity'])
conn = Connectome.from_edges(
    len(comp),
    con['Presynaptic_Index'].to_numpy(np.int64),
    con['Postsynaptic_Index'].to_numpy(np.int32),
    con['Excitatory x Connectivity'].to_numpy(np.float32),
)
print(f'  {conn.n:,} neurones, {conn.nnz():,} connexions  ({time.time()-t0:.1f} s)')

idx = np.array([flyid2i[f] for f in SUGAR_GRNS_BENCH], dtype=np.int64)
print(f'\nstimulation : {len(idx)} GRN sucre @ 200 Hz, 1 s\n')

for seed in range(3):
    t0 = time.time()
    steps, neurons = simulate(conn, [(idx, 200.0)], duration_s=1.0, seed=seed)
    dt = time.time() - t0
    print(f'  graine {seed} : {len(steps):>7,} spikes | '
          f'{len(np.unique(neurons)):>4} neurones actifs | {dt:6.1f} s')

print('\n  reference Eon (Brian2 CPU, mediane 5 tours) :  16,708 spikes |  388 neurones actifs')
