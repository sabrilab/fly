// Bac à sable : on ferme la boucle entre le monde et le cerveau, et on raconte
// ce qui s'y passe.
//
// À chaque instant :
//   1. le monde est converti en taux de stimulation (world.sense)
//   2. ces taux partent au cerveau LIF qui tourne dans le Web Worker
//   3. les décharges reviennent, on en tire les taux des neurones descendants
//   4. ces taux pilotent le corps (motor) et le déplacement (world.actuate)
//
// Le temps du monde avance au rythme du cerveau : une milliseconde simulée dans
// le connectome = une milliseconde dans l'arène. Comme le cerveau tourne moins
// vite que le temps réel, tout se déroule au ralenti — ce qui tombe bien, c'est
// à peu près ainsi qu'une mouche nous perçoit.
import * as THREE from 'three';

const WINDOW_MS = 60;            // fenêtre de lecture des taux, côté descendants
const SENSE_EVERY = 8;           // on réévalue les sens toutes les 8 ms de cerveau

export class Sandbox {
  constructor({ world, motor, pov, readoutIndices }) {
    this.world = world;
    this.motor = motor;
    this.pov = pov;
    this.readoutIndices = readoutIndices;
    this.byIndex = new Map(Object.entries(readoutIndices).map(([nm, i]) => [i, nm]));
    this.hist = new Map();
    for (const nm of Object.keys(readoutIndices)) this.hist.set(nm, []);
    this.brainMs = 0;
    this.sinceSense = 0;
    this.lastRates = {};
    this.dn = {};
    this.queue = [];
    this.active = false;
    this.spikes = 0;
    this.awake = 0;
    this.wall = 0;
    this.reaction = null;        // temps de réaction mesuré, en ms de cerveau
    this.loomStart = null;
    this.narration = { line: '', sub: '', tone: 'calm', emoji: '', at: 0 };
  }

  reset() {
    for (const [, a] of this.hist) a.length = 0;
    this.brainMs = 0; this.sinceSense = 0; this.queue.length = 0;
    this.spikes = 0; this.wall = 0; this.reaction = null; this.loomStart = null;
  }

  pushFrames(frames, meta) {
    for (const f of frames) this.queue.push(f);
    this.spikes = meta.total; this.awake = meta.awake;
  }

  /** Taux de décharge d'un neurone descendant, sur la fenêtre glissante. */
  rateOf(name) {
    const a = this.hist.get(name);
    if (!a || !a.length) return 0;
    let c = 0;
    for (let k = a.length - 1; k >= 0 && a[k] >= this.brainMs - WINDOW_MS; k--) c++;
    return Math.round((c * 1000) / WINDOW_MS);
  }

  /**
   * Consomme jusqu'à `budget` millisecondes de cerveau et fait avancer le monde
   * d'autant. Retourne le nombre de ms consommées.
   */
  step(budget, onFrame) {
    let used = 0;
    while (this.queue.length && used < budget) {
      const fired = this.queue.shift();
      this.brainMs++;
      used++;
      if (onFrame) onFrame(fired);
      for (const i of fired) {
        const nm = this.byIndex.get(i);
        if (nm !== undefined) this.hist.get(nm).push(this.brainMs);
      }

      // taux des descendants, puis corps et déplacement
      for (const nm of this.hist.keys()) this.dn[nm] = this.rateOf(nm);
      this.world.actuate(this.dn, 1);
      this.world.step(1);

      this.sinceSense++;
      if (this.sinceSense >= SENSE_EVERY) {
        this.sinceSense = 0;
        this.lastRates = this.world.sense(SENSE_EVERY);
        this.measureReaction();
        if (this.onRates) this.onRates(this.lastRates);
      }
    }
    // purge de l'historique
    for (const [, a] of this.hist) {
      while (a.length && a[0] < this.brainMs - 400) a.shift();
    }
    return used;
  }

  /** Mesure le délai entre le début de l'expansion visuelle et la fibre géante. */
  measureReaction() {
    const loom = Math.max(this.lastRates.lc4L || 0, this.lastRates.lc4R || 0);
    const gf = Math.max(this.dn.GiantFiber_1 || 0, this.dn.GiantFiber_2 || 0);
    // le chronomètre ne part que si l'expansion commence alors que la fibre géante
    // est encore silencieuse — sinon on mesurerait zéro
    if (loom > 30 && gf < 8 && this.loomStart === null) this.loomStart = this.brainMs;
    if (loom < 8) this.loomStart = null;
    if (gf > 25 && this.loomStart !== null && this.brainMs > this.loomStart) {
      this.reaction = this.brainMs - this.loomStart;
      this.loomStart = null;
    }
  }

  // ───────────────────────── ce que fait son cerveau ─────────────────────────
  /**
   * La bulle ne raconte pas ce que la mouche « pense » — elle n'a rien à penser.
   * Elle dit ce que fait son cerveau : quels capteurs s'allument, quels neurones
   * descendants répondent, et à quelle intensité.
   */
  narrate() {
    const s = this.lastRates, d = this.dn;
    const w = this.world;
    const mx = (...n) => Math.max(...n.map((k) => d[k] || 0));
    const gf = mx('GiantFiber_1', 'GiantFiber_2');
    const mn9 = mx('MN9_left', 'MN9_right');
    const adn = mx('aDN1_left', 'aDN1_right');
    const dna = mx('DNa01_left', 'DNa01_right', 'DNa02_left', 'DNa02_right');
    const p9 = mx('P9_left', 'P9_right', 'P9_oDN1_left', 'P9_oDN1_right');
    const loom = Math.max(s.lc4L || 0, s.lc4R || 0);
    const loomSide = (s.lc4L || 0) > (s.lc4R || 0) ? 'à ma gauche' : 'à ma droite';
    const sugar = Math.max(s.sugarL || 0, s.sugarR || 0);
    const bitter = Math.max(s.bitterL || 0, s.bitterR || 0);
    const jo = Math.max(s.joL || 0, s.joR || 0);
    // Les émojis ne sont pas des émotions — elle n'en a pas. Ce sont des raccourcis
    // pour lire d'un coup d'œil l'état de son cerveau.
    const set = (line, sub, tone, emoji) =>
      { this.narration = { line, sub, tone, emoji, at: performance.now() }; };

    if (w.airborne && w.flightT > 0) {
      set('Je suis en l’air.',
          'vol : je zigzague, c’est ce qui me rend difficile à attraper' +
          (this.reaction !== null ? ` · réaction mesurée : ${this.reaction} ms` : ''), 'alarm', '🪽');
    } else if (gf > 30) {
      set('Ma fibre géante vient de partir.',
          `Giant Fiber ${Math.round(gf)} Hz — le neurone le plus rapide de ma tête. Je décolle.`,
          'alarm', '⚡');
    } else if (loom > 60) {
      set(`Quelque chose grossit ${loomSide}.`,
          `mes LC4 déchargent à ${Math.round(loom)} Hz — ce sont des détecteurs d’expansion, ` +
          'pas de distance', 'alarm', '👁️');
    } else if (jo > 120 && adn > 12) {
      set('On me touche l’antenne.',
          `organe de Johnston à ${Math.round(jo)} Hz → aDN1 à ${Math.round(adn)} Hz : je me nettoie`,
          'busy', '🧼');
    } else if (jo > 120) {
      set('Je sens l’air bouger.',
          `organe de Johnston à ${Math.round(jo)} Hz — je perçois les variations de pression ` +
          'avant même de voir quoi que ce soit', 'busy', '🌬️');
    } else if (bitter > 40) {
      if (mn9 < 12) {
        set('C’est amer. Je n’avale pas.',
            `MN9 est retombé à ${Math.round(mn9)} Hz. Ce blocage n’est écrit nulle part : ` +
            'il sort de mon câblage', 'busy', '🤢');
      } else {
        set('Il y a du sucre, mais aussi de l’amer.',
            `les deux voies se disputent : MN9 n’arrive qu’à ${Math.round(mn9)} Hz au lieu de 100`,
            'busy', '😖');
      }
    } else if (mn9 > 10) {
      set('Du sucre.', `MN9 à ${Math.round(mn9)} Hz : ma trompe se déploie`, 'good', '🍯');
    } else if (sugar > 30) {
      set('Ma patte touche quelque chose de sucré.',
          `${Math.round(sugar)} Hz sur mes capteurs gustatifs, le signal monte`, 'good', '👅');
    } else if ((s.or56a || 0) > 40) {
      set('Ça sent le moisi.',
          `Or56a à ${Math.round(s.or56a)} Hz → DNa02 à ${Math.round(dna)} Hz : je m’écarte`,
          'busy', '🤧');
    } else if (w._bumped > 0) {
      set('Je bute contre quelque chose.',
          'rien dans mon cerveau ne me dit qu’il y a un obstacle : je n’ai pas de vision ' +
          'exploitable dans ce modèle, je le découvre en le touchant', 'busy', '🪨');
    } else if (dna > 12 && p9 > 8) {
      set('Je tourne en marchant.',
          `DNa à ${Math.round(dna)} Hz, P9 à ${Math.round(p9)} Hz`, 'calm', '↩️');
    } else if (p9 > 8) {
      set('J’avance.', `P9 à ${Math.round(p9)} Hz — marche en trépied alterné`, 'calm', '🚶');
    } else if (w.airborne) {
      set('Je retombe.', 'les ailes ne portent plus, j’atterris', 'busy', '🪂');
    } else if (this.spikes === 0 || (!p9 && !mn9 && !adn && !gf)) {
      set('Rien n’entre. Je ne fais rien.',
          'mon cerveau n’a aucune activité spontanée : sans stimulus, il est parfaitement muet',
          'quiet', '😴');
    }
    return this.narration;
  }

  /** Les capacités de la mouche, et laquelle est en train de servir. */
  capabilities() {
    const s = this.lastRates, d = this.dn, w = this.world;
    const mx = (...n) => Math.max(...n.map((k) => d[k] || 0));
    return [
      { key: 'vision', label: 'Vision à 360°',
        detail: '~750 facettes par œil, champ quasi sphérique',
        on: Math.max(s.lc4L || 0, s.lc4R || 0) > 20 },
      { key: 'time', label: 'Temps ralenti',
        detail: '200 à 400 images/s — cinq fois notre cadence',
        on: true },
      { key: 'reflex', label: 'Réflexe ultra-rapide',
        detail: this.reaction !== null ? `mesuré ici : ${this.reaction} ms` : 'de 20 à 200 ms chez l’animal',
        on: mx('GiantFiber_1', 'GiantFiber_2') > 25 },
      { key: 'air', label: 'Pression de l’air',
        detail: 'l’organe de Johnston sent le souffle qui précède',
        on: Math.max(s.joL || 0, s.joR || 0) > 100 },
      { key: 'flight', label: 'Agilité de vol',
        detail: '200 battements/s — trop rapide pour être affiché',
        on: w.airborne },
      { key: 'evade', label: 'Fuite imprévisible',
        detail: 'elle biaise sa trajectoire au lieu de fuir en ligne droite',
        on: w.airborne && w.flightT > 0 },
    ];
  }
}

/** Sépare une population de neurones en moitié gauche et moitié droite. */
export function splitBySide(indices, sideCodes, sideNames) {
  const L = [], R = [];
  const left = sideNames.findIndex((s) => (s || '').toLowerCase() === 'left');
  for (const i of indices) (sideCodes[i] === left ? L : R).push(i);
  return { L, R };
}
