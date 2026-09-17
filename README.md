# Cerveau de drosophile — connectome navigable et modèle exécutable

Le **cerveau entier d'une mouche du vinaigre**, en 3D dans le navigateur : 138 639 neurones
à leur vraie position anatomique, le modèle neuronal qui va avec, et de quoi lancer ses
propres expériences.

C'est le modèle repris par **Eon Systems** pour sa démo de « mouche incarnée » de mars 2026,
remis à plat, vérifié, et rendu explorable.

---

## Ce que c'est, en une minute

| Brique | Origine |
|---|---|
| **Le câblage** — 138 639 neurones, 15 091 983 connexions, 54,5 M de synapses | connectome **FlyWire** v783, Dorkenwald et al., *Nature* 2024 |
| **Le signe** — chaque neurone est excitateur ou inhibiteur | prédiction de neurotransmetteur, Eckstein et al. |
| **Les positions 3D et les types cellulaires** | annotations de Schlegel et al. 2024 |
| **La dynamique** — intègre-et-tire à fuite (LIF) | **Shiu et al.**, *Nature* 2024 |
| **L'implémentation de référence** | [eonsystemspbc/fly-brain](https://github.com/eonsystemspbc/fly-brain) |

Tous les neurones sont **identiques** : seul le câblage les différencie. Il n'y a
**qu'un seul paramètre libre** dans tout le système — 0,275 mV par synapse, calibré une
fois pour toutes. Tout le reste sort de l'anatomie.

**Ce que le modèle n'est pas** : pas de plasticité, pas d'apprentissage, pas de
neuromodulation, pas d'états internes. Aucun souvenir d'aucune mouche n'est dedans.
Ce n'est pas un « upload » : c'est un plan de câblage mis sous tension.

---

## Ce que l'application permet

- **Naviguer** dans le volume : les deux lobes optiques, le cerveau central, les entrées
  sensorielles, chacun à sa place.
- **Rejouer sept expériences** précalculées et regarder le signal se propager, neurone par
  neurone, milliseconde par milliseconde.
- **Lancer ses propres stimulations en direct** : le modèle LIF tourne dans le navigateur
  (Web Worker), à ~0,4–1× le temps réel selon la machine.
- **Cliquer un neurone** : type cellulaire, neurotransmetteur, côté, lien vers FlyWire Codex,
  et ses partenaires synaptiques les plus forts, tracés en 3D.
- **Éteindre une population** (silencing) et voir ce qui disparaît en aval.

---

## Les résultats, et pourquoi ils comptent

Simulations de 1 s, graphe complet, graine fixée. `Hz` = taux du neurone descendant nommé.

| Expérience | Spikes | Neurones actifs | Sortie motrice | Lecture |
|---|---:|---:|---|---|
| **Repos** (rien) | 0 | 0 | — | le modèle est **silencieux** sans entrée : pas d'activité spontanée |
| **Sucre** (23 GRN, 200 Hz) | 17 485 | 412 | MN9 95 / 67 Hz | la trompe se déploie → **manger** |
| **Amer** (42 GRN, 200 Hz) | 12 489 | 138 | — | voie aversive, MN9 muet |
| **Sucre + amer** | 21 630 | 319 | **MN9 à 0** | l'amer **supprime totalement** la réponse alimentaire |
| **LC4** (looming, 200 Hz) | 38 603 | 656 | Giant Fiber 139 / 130 Hz | objet qui fonce → **fuite** |
| **JO** (antenne, 300 Hz) | 83 572 | 890 | aDN1 53 Hz | vibration → **toilettage** |
| **Or56a** (géosmine, 250 Hz) | 459 173 | 8 393 | DNa02 47 Hz | odeur aversive → **virage** |

La ligne **sucre + amer** est le résultat phare de Shiu et al. : la suppression du
comportement alimentaire par l'amer **émerge du câblage seul**, elle n'a été programmée
nulle part.

À noter aussi : sur une stimulation sucrée, **412 neurones sur 138 639** s'activent. Le
modèle n'est jamais « allumé » en entier — on regarde une voie précise s'illuminer.

---

## Validation

Le simulateur de ce dépôt (`pipeline/lif.py`, numpy) est une **réimplémentation
indépendante**, écrite en suivant pas à pas la référence PyTorch d'Eon
(`code/run_pytorch.py`), elle-même validée chez eux contre Brian2 CPU.

Contrôle sur l'expérience de référence d'Eon — *Sugar GRNs (200 Hz)*, 21 neurones, 1 s, 1 essai :

| | spikes | neurones actifs |
|---|---:|---:|
| **Référence Eon** (Brian2 CPU, médiane de 5 tours) | 16 708 | 388 |
| **Ce dépôt** (graines 0 / 1 / 2) | 16 508 / 17 582 / 16 954 | 400 / 402 / 413 |

L'écart reste dans la dispersion d'essai à essai du modèle lui-même (l'entrée est un
processus de Poisson). Reproduire : `python pipeline/validate.py`.

---

## Reproduire les données

```bash
pip install -r pipeline/requirements.txt
./pipeline/fetch_data.sh          # annotations FlyWire + dépôt d'Eon
python pipeline/build_atlas.py    # -> web/data/positions.bin, attrs.bin, atlas.json…
python pipeline/run_experiments.py # -> web/data/sims/*.bin
python pipeline/build_edges.py    # -> web/data/graph.bin
python pipeline/validate.py       # contrôle contre les chiffres publiés d'Eon
```

Servir l'application : `python -m http.server 8099 -d web`, puis <http://localhost:8099>.

---

## Créer sa propre expérience

Tout passe par `pipeline/neuron_sets.py` et `pipeline/run_experiments.py`.

```python
from lif import Connectome, simulate

steps, neurons = simulate(
    conn,                                   # le connectome
    [(sucre_idx, 200.0), (amer_idx, 150.0)],# groupes stimulés (indices, Hz)
    duration_s=1.0,
    silenced=interneurone_idx,              # extinction, pour tester la nécessité
    seed=0,
)
```

Les cinq protocoles qui marchent bien avec ce modèle :

1. **Dose-réponse** — balayer la fréquence de stimulation, tracer la réponse d'un descendant.
2. **Compétition** — deux entrées antagonistes, mesurer la suppression.
3. **Lésion** — répéter en éteignant un interneurone candidat : la sortie disparaît-elle ?
4. **Criblage** — un type cellulaire à la fois, classer par effet.
5. **Latéralisation** — stimuler un seul côté, vérifier la préférence controlatérale.

Pièges à connaître :

- **Les IDs dépendent de la version du connectome** : seulement 106 220 IDs sont communs
  entre v630 et v783. Un ID venu d'ailleurs peut ne pas exister ici.
- **Stimuler n'est pas physiologique** : l'entrée de Poisson force la décharge et annule le
  réfractaire. C'est de l'optogénétique, pas un stimulus naturel.
- **Toujours plusieurs essais** (`n_run` ≥ 20) : l'entrée est stochastique.
- Nouveaux IDs de neurones : [FlyWire Codex](https://codex.flywire.ai), recherche par type
  cellulaire, neurotransmetteur ou hémisphère.

---

## Structure

```
pipeline/            reconstruction des données (Python)
  lif.py               le simulateur LIF — le cœur, 190 lignes
  neuron_sets.py       populations sensorielles et neurones descendants nommés
  build_atlas.py       annotations + connectome -> binaires 3D
  run_experiments.py   lance les expériences -> trains de spikes
  build_edges.py       graphe élagué pour le navigateur + mesure du coût de l'élagage
  validate.py          contrôle contre les chiffres publiés d'Eon
web/                 l'application (statique, sans étape de build)
  js/scene.js          rendu Three.js du nuage de points
  js/sim-worker.js     le même modèle LIF, en JavaScript, dans un Web Worker
  js/app.js            interface, lecture temporelle, sélection
  data/                binaires générés (20 Mo)
```

Le graphe expédié au navigateur est élagué à `|synapses| ≥ 5` : 2 700 513 connexions,
62,7 % du poids synaptique, 16,8 Mo. Coût mesuré sur l'expérience sucre : **91 % des
neurones actifs et 85 % des spikes conservés**. Les expériences précalculées, elles,
utilisent le **graphe complet**.

---

## Sources

- Connectome : [FlyWire](https://flywire.ai) · Dorkenwald et al., *Nature* 2024
- Modèle LIF : [Shiu et al., *Nature* 2024](https://www.nature.com/articles/s41586-024-07763-9)
- Annotations : [Schlegel et al. 2024](https://github.com/flyconnectome/flywire_annotations)
- Implémentation de référence : [eonsystemspbc/fly-brain](https://github.com/eonsystemspbc/fly-brain)
- Démo « mouche incarnée » : [Eon Systems](https://eon.systems/updates/embodied-brain-emulation) ·
  la lecture critique : [Carboncopies](https://carboncopies.org/Blog/Posts/FruitFlyNotUploaded/Post/)

Le code de Shiu et al. repris dans `pipeline/` est sous licence MIT en amont ;
Three.js (`web/vendor/`) est sous licence MIT.
