"""
Convertit le modele de corps de mouche de DeepMind / HHMI Janelia (flybody,
MuJoCo) en un format compact pour Three.js.

Source : eonsystemspbc/flybody -> flybody/fruitfly/assets/
  fruitfly.xml  arbre cinematique (67 segments, articulations nommees)
  *.obj         maillages issus d'un scan par microtomographie a rayons X

Sortie :
  web/data/body.bin   sommets quantifies (int16) + indices (uint32)
  web/data/body.json  hierarchie, articulations, description des parties

Unites : le modele MuJoCo est en centimetres (gravite 981 cm/s^2). On convertit
en micrometres pour partager le repere du cerveau.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1] if len(sys.argv) > 1
           else Path(__file__).resolve().parent / 'raw/flybody/flybody/fruitfly/assets')
OUT = ROOT / 'web' / 'data'

CM_TO_UM = 10_000.0
MESH_SCALE = 0.1              # <mesh scale="0.1 0.1 0.1"/> par defaut

# classes de teinte : on ne garde qu'une silhouette sombre, plus les yeux et les ailes
TINT = {None: 'body', 'body': 'body', 'lower': 'body', 'black': 'body',
        'ocelli': 'body', 'brown': 'body', 'red': 'eye', 'membrane': 'wing'}
SKIP_MATERIALS = {'bristle-brown'}     # soies : bruit visuel, beaucoup de triangles
SKIP_CLASSES = {'collision', 'adhesion-collision', 'collision-membrane'}


def quat_to_mat(q):
    """MuJoCo stocke (w, x, y, z)."""
    w, x, y, z = q
    n = np.sqrt(w * w + x * x + y * y + z * z)
    if n == 0:
        return np.eye(3)
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def quat_xyzw(q):
    w, x, y, z = q
    n = np.sqrt(w * w + x * x + y * y + z * z) or 1.0
    return [x / n, y / n, z / n, w / n]


def parse_vec(s, default, n=3):
    if not s:
        return np.array(default, dtype=np.float64)
    return np.array([float(v) for v in s.split()], dtype=np.float64)[:n]


def load_obj(path):
    verts, faces = [], []
    with open(path) as fh:
        for line in fh:
            if line.startswith('v '):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('f '):
                idx = [int(p.split('/')[0]) - 1 for p in line.split()[1:]]
                for k in range(1, len(idx) - 1):
                    faces.append((idx[0], idx[k], idx[k + 1]))
    return np.asarray(verts, np.float64), np.asarray(faces, np.int64)


def weld(v, f, tol=1e-5):
    """Soude les sommets dupliques : les OBJ sources sont des soupes de triangles."""
    key = np.round(v / tol).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return v[first], inv[f.reshape(-1)].reshape(-1, 3)


def build_defaults(root):
    """Résout l'héritage des classes <default> de MuJoCo.

    Un élément hérite des attributs de sa classe, elle-même de sa classe parente.
    Sans cela, axes, plages et poses de repos (springref) des pattes et des ailes
    sont perdus : presque toutes les articulations du modèle passent par une classe.
    """
    table = {}

    def walk(node, inherited):
        cls = node.get('class', 'main')
        merged = {k: dict(v) for k, v in inherited.items()}
        for child in node:
            if child.tag == 'default':
                continue
            merged.setdefault(child.tag, {}).update(child.attrib)
        table[cls] = merged
        for child in node.findall('default'):
            walk(child, merged)

    for d in root.findall('default'):
        walk(d, {})
    return table


def resolve(el, tag, defaults, cls):
    """Attributs effectifs = défauts de la classe, écrasés par ceux de l'élément."""
    out = dict(defaults.get(cls, {}).get(tag, {}))
    out.update(el.attrib)
    return out


def main():
    tree = ET.parse(SRC / 'fruitfly.xml')
    root = tree.getroot()
    defaults = build_defaults(root)

    mesh_file = {m.get('name'): m.get('file')
                 for m in root.iter('mesh') if m.get('file')}
    geom_material = {}   # rempli au vol

    cache = {}
    def mesh(name):
        if name not in cache:
            v, f = load_obj(SRC / mesh_file[name])
            v, f = weld(v * MESH_SCALE)  if False else weld(v * MESH_SCALE, f)
            cache[name] = (v, f)
        return cache[name]

    bodies, parts = [], []
    vert_chunks, idx_chunks = [], []
    n_verts_total = 0

    def add_part(name, tint, v, f):
        nonlocal n_verts_total
        lo, hi = v.min(axis=0), v.max(axis=0)
        span = np.maximum(hi - lo, 1e-9)
        q = np.round((v - lo) / span * 32760.0).astype(np.int16)
        parts.append({
            'name': name, 'tint': tint,
            'vOff': int(n_verts_total), 'vCount': int(len(v)),
            'iOff': int(sum(len(c) for c in idx_chunks)), 'iCount': int(len(f) * 3),
            'min': [round(float(x) * CM_TO_UM, 4) for x in lo],
            'span': [round(float(x) * CM_TO_UM, 6) for x in span],
        })
        vert_chunks.append(q)
        idx_chunks.append((f + n_verts_total).astype(np.uint32).reshape(-1))
        n_verts_total += len(v)
        return len(parts) - 1

    def walk(el, parent, childclass='main'):
        name = el.get('name') or f'body{len(bodies)}'
        childclass = el.get('childclass', childclass)
        node = {
            'name': name,
            'parent': parent,
            'pos': [round(float(x) * CM_TO_UM, 4) for x in parse_vec(el.get('pos'), [0, 0, 0])],
            'quat': [round(x, 6) for x in quat_xyzw(parse_vec(el.get('quat'), [1, 0, 0, 0], 4))],
            'joints': [],
            'parts': [],
        }
        for j in el.findall('joint'):
            if j.get('class') in SKIP_CLASSES:
                continue
            a = resolve(j, 'joint', defaults, j.get('class', childclass))
            rng = parse_vec(a.get('range'), [-3.15, 3.15], 2)
            node['joints'].append({
                'name': a.get('name') or (name + '_j' + str(len(node['joints']))),
                'axis': [round(float(x), 6) for x in parse_vec(a.get('axis'), [0, 0, 1])],
                'pos': [round(float(x) * CM_TO_UM, 4) for x in parse_vec(a.get('pos'), [0, 0, 0])],
                'range': [round(float(rng[0]), 5), round(float(rng[1]), 5)],
                'ref': round(float(a.get('springref') or 0.0), 5),
            })
        idx = len(bodies)
        bodies.append(node)

        groups = {}
        for g in el.findall('geom'):
            mname = g.get('mesh')
            if not mname or g.get('class') in SKIP_CLASSES:
                continue
            ga = resolve(g, 'geom', defaults, g.get('class', childclass))
            mat = ga.get('material')
            if mat in SKIP_MATERIALS or 'bristle' in mname:
                continue
            tint = TINT.get(mat, 'body')
            v, f = mesh(mname)
            R = quat_to_mat(parse_vec(g.get('quat'), [1, 0, 0, 0], 4))
            p = parse_vec(g.get('pos'), [0, 0, 0])
            vt = v @ R.T + p
            groups.setdefault(tint, []).append((vt, f))

        for tint, chunks in groups.items():
            off, vs, fs = 0, [], []
            for v, f in chunks:
                vs.append(v); fs.append(f + off); off += len(v)
            node['parts'].append(add_part(name + ':' + tint, tint,
                                          np.concatenate(vs), np.concatenate(fs)))

        for child in el.findall('body'):
            walk(child, idx, childclass)

    for b in root.find('worldbody').findall('body'):
        walk(b, -1, b.get('childclass', 'main'))

    verts = np.concatenate(vert_chunks)
    idxs = np.concatenate(idx_chunks)
    vbytes = verts.tobytes()
    pad = (-len(vbytes)) % 4          # les Uint32Array exigent un décalage multiple de 4
    blob = vbytes + b'\x00' * pad + idxs.tobytes()
    (OUT / 'body.bin').write_bytes(blob)

    meta = {
        'source': 'flybody (Google DeepMind + HHMI Janelia), modele MuJoCo du corps de Drosophila',
        'units': 'micrometres',
        'nBodies': len(bodies), 'nParts': len(parts),
        'nVerts': int(len(verts)), 'nTris': int(len(idxs) // 3),
        'offsets': {'verts': 0, 'indices': int(len(vbytes) + pad)},
        'bodies': bodies, 'parts': parts,
    }
    (OUT / 'body.json').write_text(json.dumps(meta, ensure_ascii=False))

    joints = sum(len(b['joints']) for b in bodies)
    posed = sum(1 for b in bodies for j in b['joints'] if j['ref'])
    axes = {tuple(j['axis']) for b in bodies for j in b['joints']}
    print(f'axes distincts : {len(axes)}   articulations avec pose de repos : {posed}')
    print(f'segments      : {len(bodies)}')
    print(f'articulations : {joints}')
    print(f'parties       : {len(parts)}')
    print(f'sommets       : {len(verts):,}   triangles : {len(idxs)//3:,}')
    print(f'body.bin      : {(OUT/"body.bin").stat().st_size/1e6:.2f} Mo')
    print(f'body.json     : {(OUT/"body.json").stat().st_size/1e6:.2f} Mo')

    # emprise du corps assemble, en micrometres (verification d'echelle)
    allmin = np.array([p['min'] for p in parts])
    allmax = allmin + np.array([p['span'] for p in parts]) * 32760.0 / 32760.0
    print(f'\ncontrole d echelle (parties, hors transformations de la hierarchie) :')
    print(f'  extension max d une partie : '
          f'{np.max(np.array([p["span"] for p in parts])):.0f} um')


if __name__ == '__main__':
    main()
