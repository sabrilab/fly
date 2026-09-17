// Scène Three.js : nuage de points des neurones, halo d'activité, connexions.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VERT = /* glsl */`
  attribute vec3  aColor;   // couleur catégorielle, calculée côté CPU
  attribute float aVis;     // 0 ou 1 : filtre de visibilité
  attribute float aAct;     // 0..1 : activité instantanée
  uniform float uSize;
  uniform float uScale;
  uniform float uActBoost;
  varying vec3  vColor;
  varying float vAct;
  varying float vVis;
  varying float vFog;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float s = uSize * (1.0 + uActBoost * aAct);
    float depth = max(1.0, -mv.z);
    gl_PointSize = max(1.0, s * uScale / depth);
    vColor = aColor;
    vAct = aAct;
    vVis = aVis;
    // indice de profondeur : le fond du volume s'estompe, le relief se lit
    vFog = 1.0 - clamp((depth - 420.0) / 1500.0, 0.0, 0.72);
  }
`;

// Couche de base : l'anatomie. Mélange normal, points fins et discrets.
const FRAG_BASE = /* glsl */`
  uniform float uAlpha;
  varying vec3 vColor; varying float vAct; varying float vVis; varying float vFog;
  void main() {
    if (vVis < 0.5) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float edge = smoothstep(0.25, 0.04, r2);
    gl_FragColor = vec4(vColor, uAlpha * edge * vFog);
  }
`;

// Couche de halo : uniquement les neurones qui déchargent. Mélange additif.
const FRAG_GLOW = /* glsl */`
  uniform vec3 uHot; uniform vec3 uWarm;
  varying vec3 vColor; varying float vAct; varying float vVis; varying float vFog;
  void main() {
    if (vVis < 0.5 || vAct < 0.01) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float core = smoothstep(0.25, 0.0, r2);
    vec3 c = mix(uWarm, uHot, vAct);
    gl_FragColor = vec4(c * (0.35 + 0.65 * vAct), core * vAct * (0.45 + 0.55 * vFog));
  }
`;

const RING_VERT = /* glsl */`
  uniform float uScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(14.0, 46.0 * uScale / max(1.0, -mv.z));
  }
`;
const RING_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uTime;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float pulse = 0.80 + 0.14 * sin(uTime * 3.4);
    float ring = smoothstep(0.06, 0.0, abs(r - pulse));
    if (ring < 0.02) discard;
    gl_FragColor = vec4(uColor, ring);
  }
`;

export class BrainScene {
  constructor(canvas, data) {
    this.data = data;
    this.n = data.n;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0c0c0d, 1);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 40000);
    this.camera.position.set(0, 55, 1180);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.62;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 14000;
    this.controls.autoRotateSpeed = 0.55;

    // ---- géométrie partagée ----
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    this.aColor = new THREE.BufferAttribute(new Float32Array(this.n * 3), 3);
    this.aVis   = new THREE.BufferAttribute(new Float32Array(this.n).fill(1), 1);
    this.aAct   = new THREE.BufferAttribute(new Float32Array(this.n), 1);
    this.aAct.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aVis.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aVis', this.aVis);
    g.setAttribute('aAct', this.aAct);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 700);
    this.geom = g;

    this.uniforms = {
      uSize:    { value: 1.9 },
      uScale:   { value: 600 },
      uAlpha:   { value: 0.34 },
      uActBoost:{ value: 0.0 },
      uHot:     { value: new THREE.Color(0xffd79a) },
      uWarm:    { value: new THREE.Color(0xb8621f) },
    };

    this.base = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG_BASE,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    }));
    this.base.frustumCulled = false;
    // tout ce qui appartient à la mouche vit dans ce groupe : dans le bac à sable,
    // c'est lui qu'on déplace, cerveau et corps ensemble
    this.flyGroup = new THREE.Group();
    this.flyGroup.name = 'fly';
    this.scene.add(this.flyGroup);
    this.flyGroup.add(this.base);

    const glowUniforms = Object.assign({}, this.uniforms, {
      uSize: { value: 3.0 }, uActBoost: { value: 2.6 },
    });
    this.glowUniforms = glowUniforms;
    this.glow = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: glowUniforms, vertexShader: VERT, fragmentShader: FRAG_GLOW,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    this.glow.frustumCulled = false;
    this.flyGroup.add(this.glow);

    // ---- connexions du neurone sélectionné ----
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 128), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6 * 128), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.flyGroup.add(this.lines);

    // ---- anneau de sélection ----
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.ringUniforms = { uScale: { value: 600 }, uTime: { value: 0 },
                          uColor: { value: new THREE.Color(0xf2f2f0) } };
    this.ring = new THREE.Points(rg, new THREE.ShaderMaterial({
      uniforms: this.ringUniforms, vertexShader: RING_VERT, fragmentShader: RING_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
    }));
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.flyGroup.add(this.ring);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.uniforms.uScale.value = scale;
    this.glowUniforms.uScale.value = scale;
    this.ringUniforms.uScale.value = scale;
    this._h = h; this._w = w;
  }

  setColors(colorArray) { this.aColor.array.set(colorArray); this.aColor.needsUpdate = true; }
  setVisible(visArray)  { this.aVis.array.set(visArray);     this.aVis.needsUpdate = true; }
  get activity() { return this.aAct.array; }
  commitActivity() { this.aAct.needsUpdate = true; }

  setPointSize(v) { this.uniforms.uSize.value = v; this.glowUniforms.uSize.value = v * 1.9 + 1.2; }
  setAlpha(v) { this.uniforms.uAlpha.value = v; }

  /** Renvoie l'index du neurone le plus proche du curseur, ou -1. */
  pick(clientX, clientY, radiusPx = 12) {
    const mx = (clientX / this._w) * 2 - 1;
    const my = -(clientY / this._h) * 2 + 1;
    this.camera.updateMatrixWorld();
    this.flyGroup.updateMatrixWorld();
    const m = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.flyGroup.matrixWorld).elements;
    const pos = this.data.positions, vis = this.aVis.array;
    const rx = (radiusPx / this._w) * 2, ry = (radiusPx / this._h) * 2;
    let best = -1, bestDepth = Infinity;
    for (let i = 0, j = 0; i < this.n; i++, j += 3) {
      if (vis[i] < 0.5) continue;
      const x = pos[j], y = pos[j + 1], z = pos[j + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) continue;
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      if (sx < mx - rx || sx > mx + rx) continue;
      const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      if (sy < my - ry || sy > my + ry) continue;
      const du = (sx - mx) / rx, dv = (sy - my) / ry;
      if (du * du + dv * dv > 1) continue;
      if (w < bestDepth) { bestDepth = w; best = i; }
    }
    return best;
  }

  select(i) {
    if (i < 0) { this.ring.visible = false; this.lines.visible = false; return; }
    const p = this.ring.geometry.attributes.position;
    p.array[0] = this.data.positions[i * 3];
    p.array[1] = this.data.positions[i * 3 + 1];
    p.array[2] = this.data.positions[i * 3 + 2];
    p.needsUpdate = true;
    this.ring.visible = true;
  }

  /** partners : [[index, poids], …]. excite = orange, inhibe = bleu. */
  showConnections(source, partners) {
    const n = partners.length;
    if (!n) { this.lines.visible = false; return; }
    const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
    const P = this.data.positions;
    const ox = P[source * 3], oy = P[source * 3 + 1], oz = P[source * 3 + 2];
    const exc = [0.851, 0.349, 0.149], inh = [0.224, 0.529, 0.898];
    for (let k = 0; k < n; k++) {
      const [j, w] = partners[k];
      pos[k * 6] = ox; pos[k * 6 + 1] = oy; pos[k * 6 + 2] = oz;
      pos[k * 6 + 3] = P[j * 3]; pos[k * 6 + 4] = P[j * 3 + 1]; pos[k * 6 + 5] = P[j * 3 + 2];
      const c = w >= 0 ? exc : inh;
      const a = Math.min(1, 0.32 + Math.abs(w) / 90);
      for (let s = 0; s < 2; s++) {
        col[k * 6 + s * 3] = c[0] * a; col[k * 6 + s * 3 + 1] = c[1] * a; col[k * 6 + s * 3 + 2] = c[2] * a;
      }
    }
    const g = this.lines.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setDrawRange(0, n * 2);
    this.lines.visible = true;
  }

  hideConnections() { this.lines.visible = false; }

  flyTo(target, distance) {
    this._fly = { from: this.controls.target.clone(), to: target.clone(),
                  fromPos: this.camera.position.clone(), dist: distance, t: 0 };
  }

  /** Va vers une pose de caméra donnée (position + cible). */
  flyToPose(pos, target, instant) {
    const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const t = new THREE.Vector3(target[0], target[1], target[2]);
    if (instant) {
      this.camera.position.copy(p);
      this.controls.target.copy(t);
      this.controls.update();
      this._fly = null;
      return;
    }
    this._fly = { from: this.controls.target.clone(), to: t,
                  fromPos: this.camera.position.clone(), toPos: p, t: 0 };
  }

  setView(name) {
    const d = 1180;
    const p = { front: [0, 40, d], top: [0, d, 1], side: [d, 40, 0], reset: [0, 55, 1180] }[name];
    if (!p) return;
    this._fly = { from: this.controls.target.clone(), to: new THREE.Vector3(0, 0, 0),
                  fromPos: this.camera.position.clone(),
                  toPos: new THREE.Vector3(p[0], p[1], p[2]), t: 0 };
  }

  /** Suit la mouche : la caméra reste derrière elle, en douceur. */
  follow(target, yaw, dist, height, dt, snap, fast) {
    this._followFast = fast;
    const wanted = new THREE.Vector3(
      target.x + Math.sin(yaw) * dist,
      target.y + height,
      target.z + Math.cos(yaw) * dist,
    );
    const look = new THREE.Vector3(target.x, target.y + 900, target.z);
    // en vol la mouche est rapide : la caméra doit se raidir pour ne pas la perdre
    const agile = this._followFast ? 7.5 : 2.6;
    const k = snap ? 1 : Math.min(1, dt * agile);
    this.camera.position.lerp(wanted, k);
    this.controls.target.lerp(look, snap ? 1 : Math.min(1, dt * agile * 1.8));
    this._fly = null;
  }

  render(dt) {
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + dt * 1.7);
      const e = 1 - Math.pow(1 - f.t, 3);
      this.controls.target.lerpVectors(f.from, f.to, e);
      if (f.toPos) this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
      else if (f.dist) {
        const dir = f.fromPos.clone().sub(f.from).normalize();
        this.camera.position.lerpVectors(f.fromPos, f.to.clone().add(dir.multiplyScalar(f.dist)), e);
      }
      if (f.t >= 1) this._fly = null;
    }
    this.ringUniforms.uTime.value += dt;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
