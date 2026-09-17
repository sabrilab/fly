"""
Construit l'atlas 3D des neurones du modele Eon / FlyWire v783.

Fusionne :
  - la liste des neurones du modele  (data/2025_Completeness_783.csv, cote Eon)
  - les annotations FlyWire de Schlegel et al. 2024 (coordonnees 3D, types)

Sort des binaires compacts consommes par le viewer Three.js.

Repere de sortie : micrometres, centre sur le centroide du cerveau.
  x = gauche-droite, y = dorsal(+)/ventral(-), z = anterieur-posterieur
"""
import json
import struct
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
EON = Path('/home/user/eonsystemspbc/fly-brain')
OUT = ROOT / 'web' / 'data'
OUT.mkdir(parents=True, exist_ok=True)

# FAFB v14 : coordonnees en voxels de 4 x 4 x 40 nm -> micrometres
VOXEL_NM = np.array([4.0, 4.0, 40.0])
NM_TO_UM = 1e-3


def main():
    comp = pd.read_csv(EON / 'data/2025_Completeness_783.csv', index_col=0)
    model_ids = comp.index.to_numpy(dtype=np.uint64)
    n = len(model_ids)
    print(f'neurones du modele : {n:,}')

    ann = pd.read_csv(
        ROOT / 'pipeline/raw/annotations.tsv', sep='\t', low_memory=False,
        usecols=['root_id', 'pos_x', 'pos_y', 'pos_z', 'soma_x', 'soma_y', 'soma_z',
                 'super_class', 'cell_class', 'cell_type', 'hemibrain_type',
                 'top_nt', 'side', 'nerve', 'flow'],
    )
    ann['root_id'] = ann['root_id'].astype(np.uint64)
    ann = ann.drop_duplicates(subset='root_id').set_index('root_id')
    print(f'annotations FlyWire : {len(ann):,}')

    matched = ann.reindex(model_ids)
    have = matched['pos_x'].notna().to_numpy()
    print(f'apparies : {have.sum():,} / {n:,}  ({100 * have.mean():.2f} %)')

    # --- positions : soma si disponible, sinon point de reference du neurone ---
    soma = matched[['soma_x', 'soma_y', 'soma_z']].to_numpy(dtype=np.float64)
    pos = matched[['pos_x', 'pos_y', 'pos_z']].to_numpy(dtype=np.float64)
    use_soma = np.isfinite(soma).all(axis=1)
    xyz = np.where(use_soma[:, None], soma, pos)
    print(f'position issue du soma : {use_soma.sum():,}, du point de reference : '
          f'{(have & ~use_soma).sum():,}')

    xyz = xyz * VOXEL_NM * NM_TO_UM  # -> micrometres

    # Les neurones sans annotation sont places au centroide puis marques.
    valid = np.isfinite(xyz).all(axis=1)
    centroid = xyz[valid].mean(axis=0)
    xyz[~valid] = centroid
    xyz -= centroid

    # y croit vers le ventral dans FAFB : on inverse pour que le dorsal soit en haut
    xyz[:, 1] *= -1.0

    extent = xyz[valid].max(axis=0) - xyz[valid].min(axis=0)
    print(f'emprise du cerveau (um) : x={extent[0]:.0f} y={extent[1]:.0f} z={extent[2]:.0f}')

    # --- attributs categoriels ---
    def encode(series, limit=None):
        vals = series.fillna('').astype(str).str.strip()
        counts = vals[vals != ''].value_counts()
        if limit is not None:
            counts = counts.head(limit)
        names = [''] + list(counts.index)
        lookup = {name: i for i, name in enumerate(names)}
        codes = vals.map(lambda v: lookup.get(v, 0)).to_numpy()
        return names, codes

    sc_names, sc_codes = encode(matched['super_class'])
    cc_names, cc_codes = encode(matched['cell_class'])
    nt_names, nt_codes = encode(matched['top_nt'])
    side_names, side_codes = encode(matched['side'])

    # cell_type : le vocabulaire est vaste, on garde un nom lisible par neurone
    ctype = matched['cell_type'].fillna('').astype(str)
    hbtype = matched['hemibrain_type'].fillna('').astype(str)
    label = ctype.where(ctype != '', hbtype).str.strip()
    ty_names, ty_codes = encode(label, limit=65000)
    print(f'super-classes : {len(sc_names) - 1} | classes : {len(cc_names) - 1} | '
          f'types nommes : {len(ty_names) - 1} | neurotransmetteurs : {len(nt_names) - 1}')

    # --- ecriture ---
    (OUT / 'positions.bin').write_bytes(xyz.astype(np.float32).tobytes())
    (OUT / 'ids.bin').write_bytes(model_ids.astype(np.uint64).tobytes())

    attrs = np.empty(n * 4, dtype=np.uint8)
    attrs[0::4] = np.clip(sc_codes, 0, 255)
    attrs[1::4] = np.clip(side_codes, 0, 255)
    attrs[2::4] = np.clip(nt_codes, 0, 255)
    attrs[3::4] = np.clip(cc_codes, 0, 255)
    (OUT / 'attrs.bin').write_bytes(attrs.tobytes())
    (OUT / 'types.bin').write_bytes(ty_codes.astype(np.uint16).tobytes())

    meta = {
        'n': int(n),
        'source': 'FlyWire v783 + annotations Schlegel et al. 2024',
        'units': 'micrometres, centre sur le centroide',
        'matched': int(have.sum()),
        'extent': [round(float(v), 1) for v in extent],
        'superClass': sc_names,
        'cellClass': cc_names,
        'neurotransmitter': nt_names,
        'side': side_names,
        'cellType': ty_names,
    }
    (OUT / 'atlas.json').write_text(json.dumps(meta, ensure_ascii=False))

    for f in ['positions.bin', 'ids.bin', 'attrs.bin', 'types.bin', 'atlas.json']:
        print(f'  {f:16s} {(OUT / f).stat().st_size / 1e6:8.2f} Mo')

    print('\nrepartition par super-classe :')
    for i, name in enumerate(sc_names):
        c = int((sc_codes == i).sum())
        if c:
            print(f'  {name or "(non annote)":24s} {c:>7,}')


if __name__ == '__main__':
    main()
