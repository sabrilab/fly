# Pipeline de données

Reconstruit tous les binaires de `web/data/` depuis les sources publiques.

```bash
pip install -r requirements.txt
./fetch_data.sh
python build_atlas.py && python run_experiments.py && python build_edges.py
python validate.py
```

| Script | Entrée | Sortie |
|---|---|---|
| `build_atlas.py` | annotations FlyWire + liste de neurones | `positions.bin`, `attrs.bin`, `types.bin`, `ids.bin`, `atlas.json` |
| `run_experiments.py` | connectome complet | `sims/*.bin`, `sims/index.json` |
| `build_edges.py` | connectome complet | `graph.bin`, `graph.json` |
| `validate.py` | connectome complet | contrôle console contre les chiffres d'Eon |

`lif.py` est le simulateur. Il suit pas à pas `code/run_pytorch.py` du dépôt d'Eon :
même pas de temps (0,1 ms), même délai synaptique (18 pas), même portillonnage du
réfractaire sur l'entrée synaptique, même ordre de mise à jour (la membrane consomme
l'ancienne conductance). `web/js/sim-worker.js` en est la transposition JavaScript.
