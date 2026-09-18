// Détection de l'appareil, en un seul endroit.
// Sur téléphone on allège : moins de pixels à remplir, moins de décor, et pas de
// survol (le pointage parcourt les 138 639 points, c'est trop cher au doigt).
export const COARSE = typeof matchMedia !== 'undefined'
  && matchMedia('(pointer: coarse)').matches;
export const SMALL = typeof innerWidth !== 'undefined' && innerWidth < 900;
export const MOBILE = COARSE || SMALL;

export const QUALITY = {
  pixelRatio: MOBILE ? 1.5 : 2,      // l'écran d'un iPhone est à 3x : inutile ici
  stems: MOBILE ? 320 : 900,
  rocks: MOBILE ? 14 : 22,
  povSize: MOBILE ? [128, 82] : [176, 112],
  bodyDoubleSided: !MOBILE,          // moitié moins de remplissage sur mobile
  hover: !COARSE,
};
