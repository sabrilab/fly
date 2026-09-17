#!/usr/bin/env bash
# Récupère les données sources nécessaires à la reconstruction des binaires web.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw

# 1. Annotations FlyWire v783 (Schlegel et al. 2024) : coordonnées 3D, types cellulaires.
if [ ! -f raw/annotations.tsv ]; then
  echo "→ annotations FlyWire (31 Mo)…"
  curl -fsSL -o raw/annotations.tsv \
    "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv"
fi

# 2. Connectome et liste de neurones, depuis le dépôt d'Eon Systems.
if [ ! -d raw/fly-brain ]; then
  echo "→ dépôt eonsystemspbc/fly-brain (≈ 190 Mo)…"
  git clone --depth 1 https://github.com/eonsystemspbc/fly-brain raw/fly-brain
fi

# 3. Corps de mouche : modèle MuJoCo de DeepMind / HHMI Janelia.
if [ ! -d raw/flybody ]; then
  echo "→ dépôt eonsystemspbc/flybody (≈ 160 Mo, maillages du corps)…"
  git clone --depth 1 https://github.com/eonsystemspbc/flybody raw/flybody
fi

echo "OK. Lancez ensuite :"
echo "  python build_atlas.py && python run_experiments.py && python build_edges.py"
echo "  python build_body.py raw/flybody/flybody/fruitfly/assets"
