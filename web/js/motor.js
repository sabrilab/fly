// Contrôleur moteur : relie l'activité des neurones descendants aux articulations.
//
// ─────────────────────────────────────────────────────────────────────────────
// HONNÊTETÉ INTELLECTUELLE — à lire avant de croire ce qu'on voit à l'écran.
// Le cerveau simulé ne produit PAS ces mouvements. Il produit un taux de
// décharge sur une poignée de neurones descendants ; chaque taux déclenche ici
// une animation écrite à la main. C'est exactement ce que fait la démo « mouche
// incarnée » d'Eon Systems, qui branche 7 neurones descendants sur des
// contrôleurs pré-entraînés, là où une vraie mouche en possède plus de 1 300.
// La mouche marche en place, comme une mouche attachée sur une bille dans une
// vraie expérience de laboratoire.
// ─────────────────────────────────────────────────────────────────────────────

const LEGS = ['T1_left', 'T1_right', 'T2_left', 'T2_right', 'T3_left', 'T3_right'];
// trépied alterné : trois pattes au sol pendant que les trois autres avancent
const TRIPOD = { T1_left: 0, T2_right: 0, T3_left: 0, T1_right: 0.5, T2_left: 0.5, T3_right: 0.5 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** Comportements : chaque entrée dit quels neurones l'allument et ce qu'elle fait. */
export const BEHAVIOURS = [
  { key: 'feed',  label: 'Manger',          neurons: ['MN9_left', 'MN9_right'],
    detail: 'MN9 déploie la trompe' },
  { key: 'groom', label: 'Se toiletter',    neurons: ['aDN1_left', 'aDN1_right'],
    detail: 'aDN1 fait passer les pattes avant sur les antennes' },
  { key: 'walk',  label: 'Avancer',         neurons: ['P9_left', 'P9_right', 'P9_oDN1_left', 'P9_oDN1_right'],
    detail: 'P9 lance la marche en trépied alterné' },
  { key: 'turn',  label: 'Tourner',         neurons: ['DNa01_left', 'DNa01_right', 'DNa02_left', 'DNa02_right'],
    detail: 'DNa01 et DNa02 déséquilibrent le pas à gauche ou à droite' },
  { key: 'back',  label: 'Reculer',         neurons: ['MDN_1', 'MDN_2', 'MDN_3', 'MDN_4'],
    detail: 'MDN inverse le sens de la marche' },
  { key: 'escape',label: 'Fuir',            neurons: ['GiantFiber_1', 'GiantFiber_2'],
    detail: 'La fibre géante déclenche le saut et l’ouverture des ailes' },
];

const FULL_RATE = 70;       // Hz considéré comme une activation pleine

export class MotorController {
  constructor(bodyModel) {
    this.body = bodyModel;
    this.act = {};                       // activation lissée par comportement
    for (const b of BEHAVIOURS) this.act[b.key] = 0;
    this.turnBias = 0;                   // −1 = gauche, +1 = droite
    this.phase = 0;                      // phase du cycle de marche
    this.t = 0;
    this.escapeEnv = 0;
    this.enabled = true;
    this.flight = null;      // { airborne, wingPhase } fourni par le bac à sable
    this.ref = new Map();
    for (const [name, j] of bodyModel.joints) this.ref.set(name, j.ref);
  }

  /** Remet tout à zéro : activations, phase de marche, enveloppe de fuite. */
  reset() {
    for (const b of BEHAVIOURS) this.act[b.key] = 0;
    this.turnBias = 0; this.escapeEnv = 0; this.phase = 0;
    this.body.resetPose();
  }

  /** Positionne une articulation entre sa pose de repos et une cible, par un facteur 0..1. */
  to(name, target, amount) {
    if (!this.body.hasJoint(name)) return;
    const r = this.ref.get(name) || 0;
    this.body.setJoint(name, lerp(r, target, clamp(amount, 0, 1)));
  }

  /** rates : { nomDuNeurone: Hz }. dt en secondes. */
  update(rates, dt) {
    this.t += dt;
    const get = (n) => (rates && rates[n]) || 0;

    // activation par comportement : moyenne des neurones concernés, lissée
    for (const b of BEHAVIOURS) {
      const raw = clamp(Math.max(...b.neurons.map(get)) / FULL_RATE, 0, 1);
      const k = b.key === 'escape' ? 0.45 : 0.12;      // la fuite est brutale
      this.act[b.key] += (raw - this.act[b.key]) * clamp(dt / 0.12 * k * 8, 0, 1);
    }

    // biais de virage : différence gauche/droite des neurones de virage
    const L = Math.max(get('DNa01_left'), get('DNa02_left'));
    const R = Math.max(get('DNa01_right'), get('DNa02_right'));
    const bias = (R - L) / FULL_RATE;
    this.turnBias += (clamp(bias, -1, 1) - this.turnBias) * clamp(dt * 3, 0, 1);

    if (!this.enabled) return;

    const a = this.act;
    const idle = 1 - clamp(a.walk + a.back + a.escape, 0, 1);

    this.pose(a, idle, dt);
  }

  pose(a, idle, dt) {
    const t = this.t;

    // ── respiration de l'abdomen et micro-mouvements : la mouche a l'air vivante ──
    const breath = Math.sin(t * 2.3) * 0.5 + 0.5;
    this.to('abdomen', -0.05 - 0.05 * breath, 1);
    this.to('abdomen_2', -0.03 - 0.03 * breath, 1);
    for (const s of ['left', 'right']) {
      this.to('antenna_' + s, 0.06 * Math.sin(t * 1.7 + (s === 'left' ? 0 : 1.1)), idle);
    }

    // ── MANGER : déploiement rythmique de la trompe ──────────────────────────
    if (a.feed > 0.01) {
      const pump = 0.62 + 0.38 * Math.sin(t * 11);      // pompage ~2 Hz réel, accéléré ici
      const e = a.feed * pump;
      this.to('rostrum', -1.15, e);
      this.to('haustellum', -1.45, e);
      this.to('labrum_left', 0.5, e);
      this.to('labrum_right', 0.5, e);
      this.to('head', 0.22, a.feed * 0.7);              // la tête plonge vers la goutte
    } else {
      this.to('rostrum', this.ref.get('rostrum'), 1);
      this.to('haustellum', this.ref.get('haustellum'), 1);
      this.to('head', 0, 1);
    }

    // ── EN VOL : les ailes battent et les pattes se replient ────────────────
    // Une vraie mouche bat des ailes 200 fois par seconde. Même au ralenti, c'est
    // trop rapide pour un écran : on affiche un battement lisible, pas le vrai.
    if (this.flight && this.flight.airborne) {
      const beat = Math.sin(this.flight.wingPhase * 6.0);
      for (const s of ['left', 'right']) {
        this.to('wing_yaw_' + s, -0.45, 1);
        this.to('wing_roll_' + s, -0.15 + 0.85 * beat, 1);
        this.to('wing_pitch_' + s, 0.45 + 0.75 * beat, 1);
        for (const seg of ['T1', 'T2', 'T3']) {
          const leg = seg + '_' + s;
          this.to('coxa_' + leg, 0.15, 0.8);
          this.to('femur_' + leg, 1.35, 0.8);
          this.to('tibia_' + leg, -1.15, 0.8);
        }
      }
      return;
    }

    // ── FUIR : les ailes s'ouvrent, les pattes arrière détendent ─────────────
    this.escapeEnv = Math.max(this.escapeEnv * Math.exp(-dt * 2.2), a.escape);
    const esc = this.escapeEnv;
    for (const s of ['left', 'right']) {
      this.to('wing_yaw_' + s, -0.55, esc);     // ouverture nette mais lisible à l'écran
      this.to('wing_roll_' + s, -0.35, esc);
      this.to('wing_pitch_' + s, 0.9, esc);
    }
    if (esc > 0.02) {
      for (const s of ['left', 'right']) {
        this.to('coxa_T3_' + s, 1.25, esc);
        this.to('femur_T3_' + s, 1.7, esc);
        this.to('tibia_T3_' + s, 1.1, esc);
      }
    }

    // ── MARCHER / RECULER : trépied alterné ─────────────────────────────────
    const gait = clamp(a.walk + a.back, 0, 1);
    const dir = a.back > a.walk ? -1 : 1;
    if (gait > 0.01) this.phase += dt * (2.6 + 5.4 * gait) * dir;

    for (const leg of LEGS) {
      const isLeft = leg.endsWith('left');
      const seg = leg.slice(0, 2);                       // T1 / T2 / T3
      // le virage raccourcit le pas du côté intérieur
      const side = isLeft ? -1 : 1;
      const turnScale = clamp(1 - side * this.turnBias * 0.85 * clamp(a.turn * 1.4, 0, 1), 0.15, 1.6);
      const amp = gait * turnScale;
      if (amp < 0.01) {
        if (esc < 0.02 && seg !== 'T3') this.restLeg(leg);
        continue;
      }
      const ph = (this.phase + TRIPOD[leg]) * Math.PI * 2;
      const swing = Math.sin(ph);                        // avant / arrière
      const lift = Math.max(0, Math.sin(ph + Math.PI / 2));// hauteur pendant le retour

      const base = seg === 'T1' ? 0.55 : seg === 'T2' ? 0.3 : 0.45;
      this.to('coxa_' + leg, base + 0.55 * swing, amp);
      this.to('coxa_abduct_' + leg, 0.16 * swing * (isLeft ? 1 : -1), amp * 0.7);
      this.to('femur_' + leg, (this.ref.get('femur_' + leg) || 0) + 0.85 * lift, amp);
      this.to('tibia_' + leg, (this.ref.get('tibia_' + leg) || 0) - 0.55 * lift, amp);
      this.to('tarsus_' + leg, (this.ref.get('tarsus_' + leg) || 0) + 0.3 * lift, amp * 0.6);
    }

    // ── TOURNER : la tête et l'abdomen accompagnent le virage ───────────────
    const turn = clamp(a.turn, 0, 1) * this.turnBias;
    this.to('head_abduct', -0.18 * turn, 1);
    this.to('abdomen_abduct', 0.09 * turn, 1);

    // ── SE TOILETTER : les pattes avant balaient les antennes ───────────────
    if (a.groom > 0.01) {
      const sweep = Math.sin(t * 9);
      for (const s of ['left', 'right']) {
        const leg = 'T1_' + s;
        this.to('coxa_' + leg, 1.45, a.groom);
        this.to('coxa_abduct_' + leg, (s === 'left' ? -0.5 : 0.5) + 0.2 * sweep, a.groom);
        this.to('femur_' + leg, 1.85, a.groom);
        this.to('tibia_' + leg, -0.2 + 0.55 * sweep, a.groom);
        this.to('antenna_' + s, -0.12 + 0.18 * sweep, a.groom);
      }
    }
  }

  restLeg(leg) {
    for (const p of ['coxa_', 'coxa_abduct_', 'femur_', 'tibia_', 'tarsus_']) {
      const n = p + leg;
      if (this.body.hasJoint(n)) this.to(n, this.ref.get(n) || 0, 1);
    }
  }

  /** Comportements actifs, pour l'affichage. */
  activeList(threshold = 0.06) {
    return BEHAVIOURS.filter((b) => this.act[b.key] > threshold)
      .map((b) => ({ ...b, level: this.act[b.key] }))
      .sort((x, y) => y.level - x.level);
  }
}
