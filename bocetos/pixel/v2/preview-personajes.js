/* Catálogo de personajes para revisar con render.mjs.
   Uso: T=0 node render.mjs out.png 520 520 3 PREVIEW_PJ personajes.js preview-personajes.js
   (9 conjuntos, uno por fila; PJ_FILAS=[...] en un módulo extra elige filas) */
const PJ_TRAJES = [
  { skc: '#f7d2a8', hcc: '#5b3a29', hair: 'peinado', top: { t: 'traje', c: '#4a4d55', in: '#f2f2f2', tie: '#c8333a' }, leg: { t: 'pantalon', c: '#3f424a' }, shoe: { c: '#24242a', sole: '#18181c' }, watch: 1 },
  { skc: '#fbd9bd', hcc: '#6a3a22', hair: 'alto', top: { t: 'campera', c: '#d23a33', in: '#5aa0e6' }, leg: { t: 'pantalon', c: '#55565e' }, shoe: { c: '#d23a33', sole: '#f2f2f2' } },
  { skc: '#e0a878', hcc: '#b0462e', hair: 'corto', glasses: 1, top: { t: 'polo', c: '#5c5f66' }, leg: { t: 'pantalon', c: '#253a72' }, shoe: { c: '#c8622e', sole: '#7a3a1c' }, watch: 1 },
  { skc: '#b9784c', hcc: '#2b1d16', hair: 'pelado', band: '#f0a830', top: { t: 'remera', c: '#2bb39a' }, leg: { t: 'short', c: '#f08a2a' }, shoe: { c: '#2bb39a', sole: '#f2f2f2' }, sock: 1 },
  { skc: '#f5c9a0', hcc: '#4a2a1a', hair: 'bob', top: { t: 'camisa', c: '#f2f2f2', tie: null }, leg: { t: 'pollera', c: '#55585f' }, shoe: { c: '#24242a', sole: '#18181c' } },
  { skc: '#fbd9bd', hcc: '#e8c35a', hair: 'largo', top: { t: 'vestido', c: '#7fb2ea' }, leg: { t: 'nada' }, shoe: { c: '#7fb2ea', sole: '#f2f2f2' }, sock: 1 },
  { skc: '#e0a878', hcc: '#e8c35a', hair: 'coletas', top: { t: 'jardinero', c: '#2c3f78', in: '#f2f2f2' }, leg: { t: 'pantalon', c: '#2c3f78' }, shoe: { c: '#c8622e', sole: '#7a3a1c' } },
  { skc: '#8a5434', hcc: '#1c1c22', hair: 'cola', cap: '#f0d04a', top: { t: 'musculosa', c: '#f0952a' }, leg: { t: 'short', c: '#2ba59a' }, shoe: { c: '#f0952a', sole: '#f2f2f2' }, sock: 1 },
  { skc: '#f7d2a8', hcc: '#cfc6bb', hair: 'rodete', glasses: 1, top: { t: 'buzo', c: '#7a5aa8', in: '#f2f2f2' }, leg: { t: 'pantalon', c: '#3d4262' }, shoe: { c: '#e8e8ec', sole: '#b8b8c0' } },
];
function PREVIEW_PJ(g, N, t) {
  const CW = 22, RH = 56;
  const cols = [];
  cols.push(['se', false, false, 'quieto', 0]);
  cols.push(['ne', false, false, 'quieto', 0]);
  for (let i = 0; i < 6; i++) cols.push(['se', false, false, 'caminar', i]);
  for (let i = 0; i < 6; i++) cols.push(['ne', false, false, 'caminar', i]);
  ['tipear', 'pensar', 'error', 'dormir'].forEach(s => cols.push(['se', true, false, s, 0]));
  cols.push(['ne', true, false, 'tipear', 0]);
  cols.push(['se', false, false, 'hablar', 0]);
  cols.push(['se', false, false, 'tablet', 0]);
  cols.push(['se', false, true, 'quieto', 0]);
  cols.push(['ne', false, true, 'caminar', 2]);
  const filas = (typeof PJ_FILAS !== 'undefined') ? PJ_FILAS : PJ_TRAJES.map((_, i) => i);
  filas.forEach((ci, r) => { const c = PJ_TRAJES[ci];
    const base = 8 + RH * (r + 1) - 6;
    g.fillStyle = '#d6cfc4'; g.fillRect(0, base, cols.length * CW + 8, 1);
    cols.forEach(([pose, sit, flip, st, f0], i) => {
      const ax = 14 + i * CW, tt = st === 'caminar' ? f0 : t;
      g.fillStyle = '#cfc8bc'; g.fillRect(ax - 6, base - 1, 12, 1);
      if (sit) {
        // asiento simple de referencia
        g.fillStyle = '#9aa0b0'; g.fillRect(ax - 6, base - 11, 12, 2); g.fillStyle = '#6a7080'; g.fillRect(ax - 1, base - 9, 2, 8);
        drawChar(g, ax, base - 11, c, pose, true, flip, tt, st);
      } else drawChar(g, ax, base, c, pose, false, flip, tt, st);
    });
  });
}
