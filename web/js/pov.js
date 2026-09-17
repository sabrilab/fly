// Ce que voit la mouche.
//
// Un œil de drosophile, c'est ~750 facettes (ommatidies) par côté, un champ
// pratiquement sphérique une fois les deux yeux réunis, et une cadence de
// 200 à 400 images par seconde — cinq fois la nôtre. On rend donc la scène
// depuis sa tête, en très grand angle, à très basse résolution, puis on
// reconstitue la trame hexagonale des facettes.
//
// La couleur est corrigée : la mouche voit l'ultraviolet, le bleu et le vert,
// mais elle est presque aveugle au rouge — d'où l'image bleutée.
import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const QUAD_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float uCells;     // nombre de facettes en largeur
  uniform float uBarrel;    // déformation, pour évoquer le très grand angle
  uniform float uAspect;
  uniform float uGain;
  varying vec2 vUv;

  // centre de la facette hexagonale la plus proche
  vec4 hexNear(vec2 p) {
    vec2 s = vec2(1.0, 1.7320508);
    vec2 hC = floor(p / s) + 0.5;
    vec2 off = p / s - hC;
    vec2 a = off * s;
    vec2 b = (off - sign(off) * 0.5) * s;
    return dot(a, a) < dot(b, b) ? vec4(a, hC) : vec4(b, hC + sign(off) * 0.5);
  }

  void main() {
    // grand angle : on écarte le centre pour simuler une projection quasi sphérique
    vec2 c = vUv - 0.5;
    float r2 = dot(c, c);
    vec2 uv = c * (1.0 - uBarrel * r2) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.03, 0.035, 0.045, 1.0); return;
    }

    // trame des ommatidies
    vec2 p = vec2(uv.x * uAspect, uv.y) * uCells;
    vec4 h = hexNear(p);
    vec2 centre = (h.zw * vec2(1.0, 1.7320508)) / uCells;
    vec2 sampleUv = vec2(centre.x / uAspect, centre.y);
    vec3 col = texture2D(uTex, clamp(sampleUv, 0.001, 0.999)).rgb;

    // réponse spectrale : sensible à l'UV/bleu/vert, presque aveugle au rouge
    float lum = dot(col, vec3(0.16, 0.52, 0.32));
    vec3 eye = vec3(lum * 0.42 + col.r * 0.10, lum * 0.92 + col.g * 0.22, lum * 0.78 + col.b * 0.55);
    // un œil composé est bien plus sensible que notre écran : on relève fortement
    // les basses lumières, comme le fait sa rétine dans la pénombre
    eye = pow(clamp(eye * uGain, 0.0, 1.0), vec3(0.62));

    // le bord sombre entre deux facettes
    float d = length(h.xy);
    float seam = smoothstep(0.50, 0.40, d);
    eye *= 0.52 + 0.48 * seam;

    // vignettage : le champ s'assombrit vers les bords
    eye *= 1.0 - smoothstep(0.17, 0.27, r2) * 0.42;
    gl_FragColor = vec4(eye, 1.0);
  }
`;

export class PovView {
  constructor(width = 176, height = 112) {
    this.w = width; this.h = height;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: true, stencilBuffer: false,
    });
    // très grand angle : le champ réel d'une mouche est presque sphérique
    this.camera = new THREE.PerspectiveCamera(104, width / height, 60, 90000);
    // la mouche regarde vers −z : c'est déjà l'orientation par défaut d'une caméra
    this.camera.position.set(0, 60, -420);          // juste devant la tête, à hauteur des yeux

    this.overlay = new THREE.Scene();
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.uniforms = {
      uTex: { value: this.target.texture },
      uCells: { value: 34 },
      uBarrel: { value: 0.34 },
      uAspect: { value: width / height },
      uGain: { value: 7.5 },
    };
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: QUAD_VERT,
                                 fragmentShader: QUAD_FRAG, depthTest: false, depthWrite: false }),
    );
    this.quad.frustumCulled = false;
    this.overlay.add(this.quad);
    this.enabled = false;
  }

  /** Accroche l'œil à la mouche. */
  attachTo(group) { if (this.camera.parent !== group) group.add(this.camera); }
  detach() { if (this.camera.parent) this.camera.parent.remove(this.camera); }

  setResolution(cells) { this.uniforms.uCells.value = cells; }

  /**
   * Rend la vue de la mouche puis l'affiche dans un rectangle de l'écran.
   * rect = { x, y, w, h } en pixels, origine en bas à gauche.
   */
  render(renderer, scene, rect, hide = []) {
    if (!this.enabled) return;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });

    const aspect = rect.w / rect.h;
    if (Math.abs(this.camera.aspect - aspect) > 0.01) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.uniforms.uAspect.value = aspect;
    }
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prevTarget);

    hide.forEach((o, i) => { o.visible = vis[i]; });

    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h);   // en pixels CSS
    renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
    renderer.render(this.overlay, this.ortho);
    renderer.setScissorTest(false);
    const size = new THREE.Vector2();
    renderer.getSize(size);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = prevAuto;
  }
}
