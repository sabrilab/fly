// Corps de mouche : modèle MuJoCo de DeepMind / HHMI Janelia (flybody),
// issu d'un scan par microtomographie à rayons X. 67 segments, 102 articulations.
//
// Recalage avec le cerveau — déduit de repères anatomiques, pas ajusté à l'œil :
//   repère du corps    +x = avant,   +y = gauche,  +z = dorsal
//   repère du cerveau  +x = droite,  +y = dorsal,  +z = postérieur
// (côté : neurones annotés « left » à x = −206 µm, « right » à +208 µm ;
//  antérieur : Or56a, dont les somas sont dans l'antenne, à z = −149 µm)
// d'où  scène = (−corps_y, corps_z, −corps_x) + décalage tête→cerveau.
import * as THREE from 'three';

const HEAD_OFFSET = [-25.5, 16.5, 726];   // µm, aligne le centre de la tête sur celui du cerveau

const VERT = /* glsl */`
  varying vec3 vN; varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

// Coque sombre translucide : le corps se lit par son bord (Fresnel), pas par sa masse,
// ce qui laisse voir le cerveau à travers.
const FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform vec3  uRim;
  uniform float uBase;
  uniform float uRimGain;
  uniform float uOpacity;
  varying vec3 vN; varying vec3 vView;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vView)));
    float rim = pow(clamp(f, 0.0, 1.0), 2.2);
    float a = (uBase + uRimGain * rim) * uOpacity;
    vec3 c = mix(uColor, uRim, rim * 0.85);
    gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  }
`;

const TINTS = {
  body: { color: 0x1a1a1e, rim: 0x8e8e96, base: 0.055, rimGain: 0.62 },
  eye:  { color: 0x2a1512, rim: 0xc07060, base: 0.10,  rimGain: 0.70 },
  wing: { color: 0x16181c, rim: 0x6f8296, base: 0.025, rimGain: 0.34 },
};

export class FlyBody {
  constructor(meta, buffer) {
    this.meta = meta;
    this.joints = new Map();
    this.materials = [];
    this.root = new THREE.Group();
    this.root.name = 'flybody';

    // corps → scène (matrice écrite en lignes)
    const [tx, ty, tz] = HEAD_OFFSET;
    this.root.matrixAutoUpdate = false;
    this.root.matrix.set(
      0, -1, 0, tx,
      0, 0, 1, ty,
      -1, 0, 0, tz,
      0, 0, 0, 1,
    );

    const nv = meta.nVerts;
    const quant = new Int16Array(buffer, meta.offsets.verts, nv * 3);
    const indices = new Uint32Array(buffer, meta.offsets.indices,
      (buffer.byteLength - meta.offsets.indices) / 4);

    const nodes = [];
    for (const b of meta.bodies) {
      const g = new THREE.Group();
      g.name = b.name;
      g.position.set(b.pos[0], b.pos[1], b.pos[2]);
      g.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      (b.parent >= 0 ? nodes[b.parent].tip : this.root).add(g);

      // chaîne d'articulations : chacune tourne autour de son axe, en son point
      let tip = g;
      for (const j of b.joints) {
        const outer = new THREE.Group();
        outer.position.set(j.pos[0], j.pos[1], j.pos[2]);
        const inner = new THREE.Group();
        inner.position.set(-j.pos[0], -j.pos[1], -j.pos[2]);
        outer.add(inner);
        tip.add(outer);
        tip = inner;
        const axis = new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize();
        const rec = { node: outer, axis, range: j.range, ref: j.ref || 0, angle: 0 };
        this.joints.set(j.name, rec);
        this.setJoint(j.name, rec.ref);   // pose de repos : le springref MuJoCo
      }

      for (const pi of b.parts) {
        const p = meta.parts[pi];
        const pos = new Float32Array(p.vCount * 3);
        for (let k = 0; k < p.vCount; k++) {
          for (let c = 0; c < 3; c++) {
            pos[k * 3 + c] = p.min[c] + (quant[(p.vOff + k) * 3 + c] / 32760) * p.span[c];
          }
        }
        const idx = new Uint32Array(p.iCount);
        for (let k = 0; k < p.iCount; k++) idx[k] = indices[p.iOff + k] - p.vOff;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeVertexNormals();

        const t = TINTS[p.tint] || TINTS.body;
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(t.color) },
            uRim: { value: new THREE.Color(t.rim) },
            uBase: { value: t.base },
            uRimGain: { value: t.rimGain },
            uOpacity: { value: 1 },
          },
          vertexShader: VERT, fragmentShader: FRAG,
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          blending: THREE.NormalBlending,
        });
        this.materials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3;          // après le cerveau : le corps le voile, sans le masquer
        mesh.frustumCulled = false;
        tip.add(mesh);
      }
      nodes.push({ group: g, tip });
    }
    this.nodes = nodes;
  }

  setJoint(name, angle) {
    const j = this.joints.get(name);
    if (!j) return;
    const a = Math.max(j.range[0], Math.min(j.range[1], angle));
    j.angle = a;
    j.node.quaternion.setFromAxisAngle(j.axis, a);
  }

  getJoint(name) { const j = this.joints.get(name); return j ? j.angle : 0; }
  hasJoint(name) { return this.joints.has(name); }
  resetPose() { for (const [n, j] of this.joints) this.setJoint(n, j.ref); }

  setOpacity(v) {
    this.root.visible = v > 0.001;
    for (const m of this.materials) m.uniforms.uOpacity.value = v;
  }
}

export async function loadBody(base = './data/') {
  const [meta, buf] = await Promise.all([
    fetch(base + 'body.json').then((r) => r.json()),
    fetch(base + 'body.bin').then((r) => r.arrayBuffer()),
  ]);
  return new FlyBody(meta, buf);
}
