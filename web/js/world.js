// Bac à sable : un petit monde, et la mouche qui y vit.
//
// La boucle est fermée pour de vrai :
//   monde → neurones sensoriels → cerveau LIF (Web Worker) → neurones descendants → corps → monde
//
// Ce qui vient de la biologie, et ce qui est ajouté à la main :
//   • VIENT DU CERVEAU : quel neurone descendant décharge, et à quelle intensité.
//     La latéralisation aussi — on stimule séparément les capteurs gauches et droits,
//     et l'asymétrie de la réponse motrice sort du connectome, pas d'une règle écrite.
//   • AJOUTÉ À LA MAIN : la traduction d'un taux de décharge en vitesse, en angle
//     de virage ou en impulsion de saut. C'est la limite, la même que chez Eon.
import * as THREE from 'three';

// Le monde est en micromètres, comme le cerveau et le corps. La mouche fait 3 mm.
export const ARENA = 46000;          // 46 mm de côté
const GROUND_FADE = 0.55;

// Vitesses réelles de Drosophila, converties en µm par milliseconde.
const WALK_MAX = 22;                 // 22 mm/s
const TURN_MAX = 0.0090;             // ≈ 515 °/s
const JUMP_V   = 150;                // 0,15 m/s à la détente
const HOVER_Y  = 5200;               // altitude de croisière, ≈ 5 mm
const FLIGHT_V = 320;                // 0,32 m/s en vol
const GRAVITY  = 9.81e-3 * 1000;     // µm/ms²

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

export class World {
  constructor(flyGroup) {
    this.group = new THREE.Group();
    this.flyGroup = flyGroup;
    this.foods = [];
    this.threats = [];
    this.dust = [];
    this.odor = null;
    this.groundY = -1250;

    // état de la mouche
    this.pos = new THREE.Vector3(0, 0, 0);     // au sol
    this.yaw = 0;                              // 0 = regarde vers −z
    this.vel = new THREE.Vector3();
    this.airborne = false;
    this.flightT = 0;
    this.roll = 0; this.pitch = 0;
    this.wingPhase = 0;
    this.lastLoom = new Map();
    this.explore = 0.35;                       // pulsion d'exploration ajoutée (voir plus bas)
    this.events = [];

    this.buildScenery();
    this.buildGround();
  }

  // ─────────────────────────────── décor ───────────────────────────────
  buildScenery() {
    // ciel : un dégradé très sombre, pour que l'horizon existe dans sa vision
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(ARENA * 1.5, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        uniforms: { uTop: { value: new THREE.Color(0x070810) },
                    uBot: { value: new THREE.Color(0x151b26) } },
        vertexShader: 'varying float vY; void main(){ vY = normalize(position).y;' +
          ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uTop; uniform vec3 uBot; varying float vY;' +
          ' void main(){ gl_FragColor = vec4(mix(uBot, uTop, smoothstep(-0.1, 0.55, vY)), 1.0); }',
      }),
    );
    sky.renderOrder = -3;
    this.sky = sky;
    this.group.add(sky);

    // sol plein : légèrement plus clair que le ciel, sinon elle ne voit pas l'horizon
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA * 0.78, 48),
      new THREE.MeshBasicMaterial({ color: 0x1c212b }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = -2;
    this.disc = disc;
    this.group.add(disc);

    // brins d'herbe : des repères verticaux. Ils donnent du relief à la scène et,
    // surtout, un défilement visible dans sa vision quand elle avance.
    const stems = new THREE.Group();
    for (let i = 0; i < 130; i++) {
      const h = rnd(1800, 6200);
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(rnd(60, 150), rnd(120, 260), h, 5, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x2a333d, transparent: true, opacity: 0.88,
                                      side: THREE.DoubleSide }),
      );
      const a = rnd(0, Math.PI * 2), d = rnd(9500, ARENA * 0.46);
      m.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
      m.rotation.z = rnd(-0.22, 0.22);
      stems.add(m);
    }
    this.stems = stems;
    this.group.add(stems);
  }

  buildGround() {
    const g = new THREE.BufferGeometry();
    const pts = [], cols = [];
    const N = 24, s = ARENA / 2, step = ARENA / N;
    for (let i = 0; i <= N; i++) {
      const u = -s + i * step;
      for (const [a, b] of [[[u, -s], [u, s]], [[-s, u], [s, u]]]) {
        pts.push(a[0], 0, a[1], b[0], 0, b[1]);
        for (let k = 0; k < 2; k++) {
          const d = Math.hypot(k ? b[0] : a[0], k ? b[1] : a[1]) / s;
          const f = Math.max(0, 1 - d * GROUND_FADE) * 0.42;
          cols.push(f * 0.62, f * 0.66, f * 0.78);
        }
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    grid.position.y = this.groundY;
    grid.renderOrder = -1;
    this.grid = grid;
    this.group.add(grid);
  }

  setGroundY(y) {
    this.groundY = y;
    this.grid.position.y = y;
    this.disc.position.y = y - 12;
    this.sky.position.y = y;
    this.stems.position.y = y;
    this.refreshHeights();
  }

  refreshHeights() {
    for (const f of this.foods) f.mesh.position.y = this.groundY + f.r * 0.6;
  }

  // ─────────────────────────────── objets ───────────────────────────────
  addFood(x, z, type = 'sugar') {
    const r = type === 'sugar' ? 1400 : 1250;
    const color = type === 'sugar' ? 0xeb9b3a : 0x2f7a52;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    mesh.position.set(x, this.groundY + r * 0.6, z);
    mesh.scale.y = 0.62;
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.55, 16, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.10,
                                    side: THREE.BackSide, depthWrite: false }),
    );
    mesh.add(halo);
    this.group.add(mesh);
    const f = { mesh, r, type, x, z, eaten: 0 };
    this.foods.push(f);
    return f;
  }

  /** Une menace fonce sur la mouche depuis un côté. */
  launchThreat(angle) {
    const a = angle !== undefined ? angle : rnd(0, Math.PI * 2);
    const d = 26000;
    const r = 3400;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 22, 16),
      new THREE.MeshBasicMaterial({ color: 0x14100f, transparent: true, opacity: 0.92 }),
    );
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.08, 22, 16),
      new THREE.MeshBasicMaterial({ color: 0xe34948, transparent: true, opacity: 0.20,
                                    side: THREE.BackSide, depthWrite: false }),
    );
    mesh.add(rim);
    const from = new THREE.Vector3(
      this.pos.x + Math.cos(a) * d, this.groundY + 6200, this.pos.z + Math.sin(a) * d);
    mesh.position.copy(from);
    this.group.add(mesh);
    // on vise légèrement à côté : la menace frôle la mouche au lieu de la percuter
    const target = this.pos.clone().setY(this.groundY + 700)
      .add(new THREE.Vector3(rnd(-1800, 1800), 0, rnd(-1800, 1800)));
    const dir = target.clone().sub(from).normalize();
    const t = { mesh, r, vel: dir.multiplyScalar(19), life: 3200, hit: false };
    this.threats.push(t);
    this.events.push({ t: 'threat', at: performance.now() });
    return t;
  }

  /** Pose une goutte juste sous les pattes de la mouche. */
  dropUnderFly(type = 'sugar') {
    const f = this.forward;
    return this.addFood(this.pos.x + f.x * 1600, this.pos.z + f.z * 1600, type);
  }

  /** Un grain de poussière se pose sur une antenne. */
  puffDust() {
    const side = Math.random() < 0.5 ? -1 : 1;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(220, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xc3c2b7, transparent: true, opacity: 0.8 }),
    );
    this.group.add(mesh);
    this.dust.push({ mesh, side, life: 1400, stuck: 900 });
  }

  setOdor(on) {
    if (on && !this.odor) {
      const r = 11000;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x199e70, transparent: true, opacity: 0.055,
                                      side: THREE.BackSide, depthWrite: false }),
      );
      const a = rnd(0, Math.PI * 2);
      mesh.position.set(Math.cos(a) * 12000, this.groundY + r * 0.55, Math.sin(a) * 12000);
      this.group.add(mesh);
      this.odor = { mesh, r };
    } else if (!on && this.odor) {
      this.group.remove(this.odor.mesh);
      this.odor = null;
    }
  }

  clear() {
    for (const f of this.foods) this.group.remove(f.mesh);
    for (const t of this.threats) this.group.remove(t.mesh);
    for (const d of this.dust) this.group.remove(d.mesh);
    this.foods = []; this.threats = []; this.dust = [];
    this.setOdor(false);
    this.pos.set(0, 0, 0); this.vel.set(0, 0, 0);
    this.yaw = 0; this.airborne = false; this.flightT = 0;
    this.roll = 0; this.pitch = 0;
    this.lastLoom.clear();
  }

  // ─────────────────── repères de la mouche dans le monde ────────────────
  get forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  get right() { return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  /** Position de la tête (les antennes et les yeux sont là). */
  headPos() {
    return this.pos.clone()
      .add(this.forward.multiplyScalar(1100))
      .add(new THREE.Vector3(0, this.groundY + 900 + (this.pos.y - this.groundY), 0));
  }

  /** Position des pattes avant et de la trompe, pour le contact gustatif. */
  mouthPos() {
    return this.pos.clone()
      .add(this.forward.multiplyScalar(1500))
      .setY(this.groundY + 260 + (this.pos.y - this.groundY));
  }

  // ─────────────────────────────── les sens ───────────────────────────────
  /**
   * Traduit l'état du monde en taux de stimulation, population par population.
   * Gauche et droite sont séparées : l'asymétrie que produit ensuite le
   * connectome n'est écrite nulle part ici.
   */
  sense(dtMs) {
    const r = { sugarL: 0, sugarR: 0, bitterL: 0, bitterR: 0,
                lc4L: 0, lc4R: 0, joL: 0, joR: 0, or56a: 0, p9: 0 };
    const head = this.headPos(), mouth = this.mouthPos();

    // ── GOÛT : contact d'une patte ou de la trompe avec une goutte ──────────
    for (const f of this.foods) {
      const d = Math.hypot(f.x - mouth.x, f.z - mouth.z);
      if (d < f.r + 900 && !this.airborne) {
        const side = this.sideOf(new THREE.Vector3(f.x, mouth.y, f.z));
        const hz = 200 * clamp(1 - d / (f.r + 900), 0, 1);
        if (f.type === 'sugar') {
          r.sugarL = Math.max(r.sugarL, hz * (side < 0 ? 1 : 0.55));
          r.sugarR = Math.max(r.sugarR, hz * (side > 0 ? 1 : 0.55));
          f.eaten = Math.min(1, f.eaten + dtMs * 0.00022);
        } else {
          r.bitterL = Math.max(r.bitterL, hz * (side < 0 ? 1 : 0.55));
          r.bitterR = Math.max(r.bitterR, hz * (side > 0 ? 1 : 0.55));
        }
      }
    }

    // ── VISION : looming. LC4 répond à la VITESSE D'EXPANSION angulaire ─────
    // θ = 2·atan(R/d) ; ce qui compte biologiquement est dθ/dt, pas la distance.
    for (const t of this.threats) {
      const v = t.mesh.position.clone().sub(head);
      const d = Math.max(t.r * 1.1, v.length());
      const theta = 2 * Math.atan(t.r / d);
      const prev = this.lastLoom.get(t) ?? theta;
      const dTheta = (theta - prev) / Math.max(1e-3, dtMs / 1000);   // rad/s
      this.lastLoom.set(t, theta);
      if (dTheta > 0.02) {
        const hz = clamp(dTheta * 210, 0, 280);
        const side = this.sideOf(t.mesh.position);
        // œil composé : champ de 360°, donc les deux yeux voient, mais inégalement
        r.lc4L = Math.max(r.lc4L, hz * (side < 0 ? 1 : 0.35));
        r.lc4R = Math.max(r.lc4R, hz * (side > 0 ? 1 : 0.35));
      }
      // ── PRESSION DE L'AIR : l'organe de Johnston sent le souffle qui précède ──
      if (d < 14000) {
        const push = clamp((14000 - d) / 14000, 0, 1) * clamp(t.vel.length() / 26, 0, 1);
        const side = this.sideOf(t.mesh.position);
        r.joL = Math.max(r.joL, 300 * push * (side < 0 ? 1 : 0.5));
        r.joR = Math.max(r.joR, 300 * push * (side > 0 ? 1 : 0.5));
      }
    }

    // ── TOUCHER : un grain de poussière collé sur une antenne ───────────────
    for (const dd of this.dust) {
      if (dd.stuck > 0) {
        if (dd.side < 0) r.joL = Math.max(r.joL, 150);
        else r.joR = Math.max(r.joR, 150);
      }
    }

    // ── ODORAT : concentration au niveau des antennes ───────────────────────
    if (this.odor) {
      const d = head.distanceTo(this.odor.mesh.position);
      if (d < this.odor.r) r.or56a = 250 * clamp(1 - d / this.odor.r, 0, 1);
    }

    // ── PULSION D'EXPLORATION (ajoutée, pas biologique) ─────────────────────
    // Le modèle n'a aucune activité spontanée : sans cette impulsion, la mouche
    // resterait parfaitement immobile pour toujours. C'est une de ses limites.
    r.p9 = this.explore * 100;
    return r;
  }

  /** −1 si l'objet est à gauche de la mouche, +1 s'il est à droite. */
  sideOf(worldPos) {
    const v = worldPos.clone().sub(this.pos).setY(0);
    return Math.sign(v.dot(this.right)) || 1;
  }

  // ───────────────────────── des neurones au mouvement ─────────────────────
  /**
   * dn : taux de décharge des neurones descendants (Hz).
   * Seule cette fonction traduit des décharges en mouvement — c'est la partie
   * écrite à la main, celle que le cerveau ne calcule pas.
   */
  actuate(dn, dtMs) {
    const g = (n) => dn[n] || 0;
    const FULL = 70;
    const fwd = clamp(Math.max(g('P9_left'), g('P9_right'),
                               g('P9_oDN1_left'), g('P9_oDN1_right')) / FULL, 0, 1.4);
    const back = clamp(Math.max(g('MDN_1'), g('MDN_2'), g('MDN_3'), g('MDN_4')) / FULL, 0, 1);
    const turnL = Math.max(g('DNa01_left'), g('DNa02_left')) / FULL;
    const turnR = Math.max(g('DNa01_right'), g('DNa02_right')) / FULL;
    const gf = Math.max(g('GiantFiber_1'), g('GiantFiber_2'));

    // virage : la différence gauche/droite vient du connectome, pas d'ici
    const turn = clamp(turnR - turnL, -1, 1);
    this.yaw += turn * TURN_MAX * dtMs;

    // ── décollage : la fibre géante déclenche le saut ──────────────────────
    if (gf > 28 && !this.airborne) {
      this.airborne = true;
      this.flightT = 620;
      const away = this.escapeDirection();
      this.vel.set(away.x * FLIGHT_V * 0.55, JUMP_V, away.z * FLIGHT_V * 0.55);
      this.events.push({ t: 'takeoff', at: performance.now() });
    }

    if (this.airborne) {
      this.flightT -= dtMs;
      if (this.flightT > 0) {
        // les ailes ne compensent pas seulement la gravité : elles asservissent
        // l'altitude autour de ~5 mm, sinon la mouche partirait à l'infini
        const err = HOVER_Y - this.pos.y;
        const lift = GRAVITY + clamp(err * 0.0016 - this.vel.y * 0.055, -0.9, 1.5);
        this.vel.y += lift * dtMs;
        // trajectoire imprévisible : la mouche zigzague pendant la fuite, ce qui la
        // rend très difficile à intercepter
        const jitter = Math.sin(performance.now() * 0.011) + 0.4 * Math.sin(performance.now() * 0.029);
        this.yaw += jitter * TURN_MAX * dtMs * 0.55;
        const f = this.forward.multiplyScalar(FLIGHT_V);
        const k = clamp(dtMs / 180, 0, 1);
        this.vel.x += (f.x - this.vel.x) * k;
        this.vel.z += (f.z - this.vel.z) * k;
        this.roll += (jitter * 0.45 - this.roll) * clamp(dtMs / 90, 0, 1);
        this.pitch += (-0.30 - this.pitch) * clamp(dtMs / 140, 0, 1);
      } else {
        this.roll += (0 - this.roll) * clamp(dtMs / 180, 0, 1);
        this.pitch += (0.18 - this.pitch) * clamp(dtMs / 180, 0, 1);
      }
      this.vel.y -= GRAVITY * dtMs;
      this.pos.addScaledVector(this.vel, dtMs);
      this.wingPhase += dtMs * 0.05;
      if (this.pos.y <= 0 && this.vel.y < 0) {
        this.pos.y = 0; this.vel.set(0, 0, 0);
        this.airborne = false; this.roll = 0; this.pitch = 0;
        this.events.push({ t: 'land', at: performance.now() });
      }
    } else {
      // ── marche au sol ────────────────────────────────────────────────────
      const speed = (fwd - back) * WALK_MAX;      // µm/ms
      const f = this.forward;
      this.pos.x += f.x * speed * dtMs;
      this.pos.z += f.z * speed * dtMs;
      if (fwd > 0.05 || back > 0.05) this.wingPhase = 0;
      this.pos.y = 0;
      this.roll += (0 - this.roll) * clamp(dtMs / 120, 0, 1);
      this.pitch += (0 - this.pitch) * clamp(dtMs / 120, 0, 1);
    }

    // on reste dans l'arène
    const lim = ARENA / 2 - 2500;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
      this.yaw += Math.PI * 0.012 * dtMs * 0.1;   // longe le bord
    }

    this.applyPose();
    return { fwd, back, turn, gf, airborne: this.airborne };
  }

  /** Direction opposée à la menace la plus proche — la fuite « intelligente ». */
  escapeDirection() {
    let best = null, bd = Infinity;
    for (const t of this.threats) {
      const d = t.mesh.position.distanceTo(this.pos);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return this.forward;
    const away = this.pos.clone().sub(best.mesh.position).setY(0).normalize();
    // une vraie mouche ne fuit pas pile à l'opposé : elle biaise de 20 à 60°, ce qui
    // la rend imprévisible pour un prédateur qui anticiperait la ligne droite
    const a = Math.atan2(away.z, away.x) + rnd(-0.9, 0.9);
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    this.yaw = Math.atan2(-dir.x, -dir.z);      // avant = (−sin yaw, −cos yaw)
    return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  }

  applyPose() {
    this.flyGroup.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.flyGroup.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }

  // ─────────────────────────────── physique ───────────────────────────────
  step(dtMs) {
    for (let i = this.threats.length - 1; i >= 0; i--) {
      const t = this.threats[i];
      t.mesh.position.addScaledVector(t.vel, dtMs);
      t.life -= dtMs;
      const d = t.mesh.position.distanceTo(this.pos);
      if (d < t.r + 900 && !t.hit) { t.hit = true; this.events.push({ t: 'hit', at: performance.now() }); }
      if (t.life <= 0 || t.mesh.position.y < this.groundY - 2000) {
        this.group.remove(t.mesh); this.threats.splice(i, 1); this.lastLoom.delete(t);
      }
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.stuck -= dtMs; d.life -= dtMs;
      const h = this.headPos();
      d.mesh.position.set(h.x + this.right.x * 380 * d.side, h.y + 260,
                          h.z + this.right.z * 380 * d.side);
      if (d.life <= 0) { this.group.remove(d.mesh); this.dust.splice(i, 1); }
    }
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      if (f.eaten > 0) {
        const k = 1 - f.eaten;
        f.mesh.scale.set(k, k * 0.62, k);
        f.mesh.material.opacity = 0.55 * k;
        if (f.eaten >= 0.999) { this.group.remove(f.mesh); this.foods.splice(i, 1); }
      }
    }
  }

  /** Événements récents, pour l'affichage. */
  drainEvents() { const e = this.events; this.events = []; return e; }
}
