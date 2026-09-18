// Vision continue : on branche l'œil de la mouche sur son propre cerveau.
//
// Jusqu'ici ses 77 530 neurones visuels ne recevaient rien — plus de la moitié de
// sa tête était éteinte, et elle n'était vivante que lorsqu'on lui envoyait une
// menace. Une vraie mouche, elle, a en permanence le monde qui défile sur ses yeux.
//
// Ce module lit l'image rendue depuis sa tête et en injecte la VARIATION de
// contraste dans les cellules L1 et L2 de la lamina — le tout premier étage du
// traitement visuel, celui qui reçoit directement des photorécepteurs et qui code
// justement les changements de luminance. Toute la suite de la cascade tourne
// ensuite pour de vrai sur le connectome : médulla, T4/T5 (détecteurs de mouvement
// directionnels), lobula, neurones LC, puis descendants.
//
// APPROXIMATION ASSUMÉE : la rétinotopie. Le lobe optique est organisé en carte du
// champ visuel, mais l'atlas ne donne pas la direction regardée par chaque neurone.
// On la reconstruit depuis sa position anatomique dans le lobe : l'axe antéro-
// postérieur donne l'azimut, l'axe dorso-ventral l'élévation. C'est grossier, mais
// c'est ordonné et continu — ce qui suffit pour que le mouvement de l'image
// produise un vrai signal de mouvement dans T4/T5.

const LAMINA_TYPES = ['L1', 'L2'];     // voies ON et OFF du système de mouvement

export class Vision {
  /**
   * D        : l'atlas chargé
   * cols,rows: résolution de l'échantillonnage de l'œil
   */
  constructor(D, cols = 28, rows = 18) {
    this.cols = cols; this.rows = rows;
    this.nCells = cols * rows;
    this.prev = new Float32Array(this.nCells);
    this.curr = new Float32Array(this.nCells);
    this.ready = false;

    const wanted = new Set(LAMINA_TYPES.map((t) => D.atlas.cellType.indexOf(t)).filter((i) => i > 0));
    const leftCode = D.atlas.side.findIndex((s) => (s || '').toLowerCase() === 'left');

    const idx = [], cell = [], sides = [];
    const P = D.positions;
    // emprise de chaque lobe, pour normaliser la carte rétinotopique
    const ext = { '-1': { zmin: 1e9, zmax: -1e9, ymin: 1e9, ymax: -1e9 },
                  '1': { zmin: 1e9, zmax: -1e9, ymin: 1e9, ymax: -1e9 } };
    const members = [];
    for (let i = 0; i < D.n; i++) {
      if (!wanted.has(D.typeCodes[i])) continue;
      const s = D.side[i] === leftCode ? -1 : 1;
      members.push([i, s]);
      const e = ext[s];
      const y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (z < e.zmin) e.zmin = z; if (z > e.zmax) e.zmax = z;
      if (y < e.ymin) e.ymin = y; if (y > e.ymax) e.ymax = y;
    }
    for (const [i, s] of members) {
      const e = ext[s];
      const y = P[i * 3 + 1], z = P[i * 3 + 2];
      // azimut : 0 au centre du champ, 1 sur le côté ; élévation : 0 en bas, 1 en haut
      const az = Math.min(1, Math.max(0, (z - e.zmin) / Math.max(1, e.zmax - e.zmin)));
      const el = Math.min(1, Math.max(0, (y - e.ymin) / Math.max(1, e.ymax - e.ymin)));
      const u = 0.5 + s * (0.06 + 0.44 * az);
      const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor((1 - el) * rows)));
      idx.push(i); cell.push(r * cols + c); sides.push(s);
    }
    this.idx = Uint32Array.from(idx);
    this.cell = Uint32Array.from(cell);
    this.rate = new Float32Array(idx.length);
    this.count = idx.length;
  }

  /** Sous-échantillonne : une fraction des cellules de lamina seulement. */
  setFraction(f) {
    this.fraction = Math.max(0, Math.min(1, f));
  }

  /**
   * Lit l'image de l'œil et en déduit le taux de décharge de chaque cellule.
   * gain : intensité globale (0 = vision coupée).
   */
  update(renderer, target, gain) {
    const w = target.width, h = target.height;
    if (!this.pixels || this.pixels.length !== w * h * 4) {
      this.pixels = new Uint8Array(w * h * 4);
    }
    try {
      renderer.readRenderTargetPixels(target, 0, 0, w, h, this.pixels);
    } catch (e) { return null; }

    // moyenne de luminance par cellule de la grille
    const { cols, rows, nCells } = this;
    const acc = this.curr;
    acc.fill(0);
    const cnt = this._cnt || (this._cnt = new Int32Array(nCells));
    cnt.fill(0);
    const px = this.pixels;
    for (let y = 0; y < h; y++) {
      const r = Math.min(rows - 1, ((h - 1 - y) * rows / h) | 0);
      for (let x = 0; x < w; x++) {
        const c = Math.min(cols - 1, (x * cols / w) | 0);
        const o = (y * w + x) * 4;
        acc[r * cols + c] += px[o] * 0.3 + px[o + 1] * 0.5 + px[o + 2] * 0.2;
        cnt[r * cols + c]++;
      }
    }
    for (let k = 0; k < nCells; k++) acc[k] = cnt[k] ? acc[k] / cnt[k] / 255 : 0;

    if (!this.ready) { this.prev.set(acc); this.ready = true; return null; }

    // Les cellules L1/L2 codent la VARIATION de luminance, pas son niveau.
    // C'est ce qui rend le signal proportionnel au mouvement de l'image.
    const rate = this.rate, cell = this.cell, prev = this.prev;
    const base = 3 * gain;                 // léger fond : l'œil n'est jamais au repos
    for (let k = 0; k < rate.length; k++) {
      const c = cell[k];
      const d = Math.abs(acc[c] - prev[c]);
      rate[k] = base + gain * Math.min(120, d * 900);
    }
    prev.set(acc);
    return rate;
  }
}
