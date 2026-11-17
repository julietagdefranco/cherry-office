/* Oficina pixel v2: planta con salas, pasillo, paredes con puertas, muebles (M), personajes (drawChar) y caminatas.
   Necesita nucleo.js (N), muebles.js (M) y personajes.js (drawChar). Expone window.OFI para la interfaz. */
(() => {
const { R } = N;
const S = N.S, FX = 24, FY = 14, WH = 46, WHI = 13, WT = .2;
const OX = FY * 12 * S + 40, W = OX + FX * 12 * S + 40, OY = WH * S + 34, H = OY + (FX + FY) * 6 * S + 46;
N.OX = OX; N.OY = OY;
const world = document.createElement('canvas'); world.width = W; world.height = H;
const g = world.getContext('2d'); N.g = g;
const view = document.getElementById('view'), vc = view.getContext('2d'), stage = document.getElementById('stage');
const { iso, up, box, poly, px, rect, L, disc, dith, quad, shade } = N;
const rng = N.rng;

/* ---------- salas ---------- */
const SALAS = {
  A: { n: 'Producto', r: [0, 0, 7, 6], piso: 'madera', alf: '#6b8cb6', puerta: { x: 6.05, lado: 'S' } },
  R: { n: 'Sala de reuniones', r: [7, 0, 12, 6], piso: 'madera', alf: '#9c88c0', puerta: { x: 11.0, lado: 'S' } },
  C: { n: 'Ingeniería', r: [12, 0, 19, 6], piso: 'madera', alf: '#7cae8b', puerta: { x: 18.0, lado: 'S' } },
  D: { n: 'Dirección', r: [19, 0, 24, 6], piso: 'madera', alf: '#b08fb6', puerta: { x: 20.0, lado: 'S' } },
  B: { n: 'Contenido', r: [0, 7.6, 7, 14], piso: 'madera', alf: '#c78f7b', puerta: { x: 6.05, lado: 'N' } },
  E: { n: 'Recepción', r: [7, 7.6, 11, 14], piso: 'baldosa', alf: null, abierta: [7.3, 10.7] },
  J: { n: 'Juegos y café', r: [11, 7.6, 18, 14], piso: 'madera', alf: '#d9b86a', puerta: { x: 11.85, lado: 'N' } },
  L: { n: 'Despacho de Luis', r: [18, 7.6, 21, 14], piso: 'madera', alf: '#8fae9a', puerta: { x: 18.9, lado: 'N' } },
  K: { n: 'Biblioteca', r: [21, 7.6, 24, 14], piso: 'madera', alf: '#b39b7e', puerta: { x: 22.4, lado: 'N' } }
};
const PASILLO_Y = 6.8;
const CENT = {}; Object.entries(SALAS).forEach(([k, s]) => CENT[k] = [(s.r[0] + s.r[2]) / 2, (s.r[1] + s.r[3]) / 2]);

/* ---------- agentes (datos de ejemplo) ---------- */
const ST = {
  work: { l: 'Trabajando', c: '#5ccf7e', sc: '#9ff0b9', a: 'Redactando su entrega' }, think: { l: 'Pensando', c: '#f2c14e', sc: '#f9dd8f', a: 'Planeando el próximo paso' },
  tool: { l: 'Usando herramienta', c: '#5aa9f2', sc: '#b5dbff', a: '' }, error: { l: 'Error', c: '#f0564c', sc: '#ff8f86', a: 'Se trabó: necesita tu ayuda' },
  idle: { l: 'Inactivo', c: '#8f95a3', sc: '#2a2d3b', a: 'Sin tareas, descansando en el sillón' }, meet: { l: 'En reunión', c: '#b48ef2', sc: '#2a2d3b', a: 'En la reunión de planificación' },
  walk: { l: 'Caminando', c: '#7fc8c0', sc: '#2a2d3b', a: 'Va a buscar un café' }
};
const TOOLTXT = { bash: 'Corriendo comandos en bash', git: 'Subiendo cambios con git', pdf: 'Leyendo un PDF', sql: 'Consultando la base con SQL', web: 'Buscando en la web' };
const TEAMS = { A: { n: 'Producto' }, B: { n: 'Contenido' }, C: { n: 'Ingeniería' }, M: { n: 'Dirección' } };
const SKIN = ['#f7d2a8', '#d9a376', '#9d6b46', '#ffe1c4', '#6e4630'], HAIRC = ['#5b3a29', '#d4793a', '#2e2d3d', '#8b4532', '#ecca6e', '#cfc6bb'];
const SHIRT = ['#e2574c', '#4a80c6', '#f2b84b', '#4fb176', '#2bb39a', '#9c88c0'];
const AG = [['Ana', 'A', 'work', ''], ['Bruno', 'A', 'think', ''], ['Carla', 'A', 'tool', 'bash'], ['Diego', 'A', 'work', ''], ['Elena', 'A', 'idle', ''], ['Fede', 'A', 'tool', 'git'],
  ['Gala', 'B', 'tool', 'pdf'], ['Hugo', 'B', 'work', ''], ['Inés', 'B', 'error', ''], ['Juan', 'B', 'think', ''], ['Lola', 'B', 'work', ''], ['Mateo', 'B', 'tool', 'sql'],
  ['Nora', 'C', 'work', ''], ['Omar', 'C', 'tool', 'web'], ['Pía', 'C', 'think', ''], ['Rafa', 'C', 'work', ''],
  ['Sol', 'M', 'meet', ''], ['Tomás', 'M', 'meet', '']].map((a, i) => ({ n: a[0], t: a[1], s: a[2], tool: a[3], seed: i * 7 + 3 }));
const TOPS = ['traje', 'campera', 'polo', 'remera', 'vestido', 'jardinero', 'musculosa', 'camisa', 'buzo', 'polo', 'campera', 'traje'];
const HAIRS = ['corto', 'peinado', 'alto', 'bob', 'largo', 'coletas', 'cola', 'rodete', 'corto', 'bob', 'largo', 'pelado'];
const LEGC = ['#3d4262', '#2c3f78', '#4a4d55', '#6b5a44', '#253a72', '#55565e'];
const SHOE = [['#24242a', '#18181c'], ['#c8622e', '#7a3a1c'], ['#f2f2f2', '#c9ccd4'], ['#d23a33', '#f2f2f2']];
AG.forEach((a, i) => {
  const r = rng(a.seed * 13 + 5), pk = l => l[Math.floor(r() * l.length)];
  const tt = TOPS[i % TOPS.length], lt = tt === 'vestido' ? 'nada' : pk(['pantalon', 'pantalon', 'pantalon', 'short', 'pollera']);
  const sh = pk(SHOE);
  a.c = { skc: SKIN[i % SKIN.length], hcc: HAIRC[(i * 2) % HAIRC.length], hair: HAIRS[(i * 5) % HAIRS.length],
    top: { t: tt, c: tt === 'traje' ? pk(['#4a4d55', '#3d4262', '#5c4a3e']) : SHIRT[i % SHIRT.length], in: pk(['#f2f2f2', '#f2f2f2', '#dfe8f4']), tie: r() < .6 ? pk(['#c8333a', '#253a72']) : null },
    leg: { t: lt, c: pk(LEGC) }, shoe: { c: sh[0], sole: sh[1] }, sock: r() < .5 ? 1 : 0, watch: r() < .3 ? 1 : 0, glasses: 0 };
  if (r() < .1) a.c.cap = pk(['#f0d04a', '#e2574c', '#4a80c6']); else if (r() < .08) a.c.band = pk(['#f0a830', '#e2574c']);
});
const ag = n => AG.find(a => a.n === n);

/* ---------- utilidades de colocación ---------- */
const items = [];            // estáticos {d, f}
const hu = (n, o) => { if (M.huellaDe) { const h = M.huellaDe(n, o || {}); if (h) return h; } const h = (M.huella && M.huella[n]) || { w: 1, d: 1 }; return o && (o.mira === '+x' || o.mira === '-x') ? { w: h.d, d: h.w } : h; };
const ALTO_MU = { biblioteca: 22, heladera: 26, expendedora: 26, arcade: 22, dispensador: 16, lamparaPie: 22, tvPie: 20, mostrador: 13, mesada: 11, archivero: 13, muebleBajo: 10, escritorio: 12, escritorioDoble: 18, escritorioL: 16, mesaReunion: 10, sillon2: 10, sillon1: 10, impresora: 14, sillaVisita: 10, banqueta: 7, mesaAlta: 11 };
function put(n, x, y, o = {}, dd = 0) { const h = hu(n, o); const al = n === 'planta' ? ({ alta: 30, mediana: 20, chica: 10 }[o.tipo] || 20) : (ALTO_MU[n] || 10); items.push({ b: [x, y, x + h.w, y + h.d, al], d: x + h.w / 2 + y + h.d / 2 + dd, f: t => M[n] && M[n](x, y, Object.assign({ t, luz: LUZ }, o)) }); return h; }
function at(d, f, b) { items.push({ d, f, b }); }

/* ---------- paredes interiores ---------- */
/* parte [u0,u1] en tramos de hasta .5 baldosas, cortando exacto en los bordes de los huecos */
function tramos(u0, u1, huecos) { const cortes = [u0, u1]; huecos.forEach(([a, b]) => { cortes.push(a, b); }); for (let u = Math.ceil(u0 * 2) / 2; u < u1; u += .5) cortes.push(u);
  const cs = [...new Set(cortes.map(c => Math.round(c * 1000) / 1000))].filter(c => c >= u0 && c <= u1).sort((p, q) => p - q), out = [];
  for (let i = 0; i + 1 < cs.length; i++) { const a = cs[i], b = cs[i + 1], m = (a + b) / 2; if (b - a < .005) continue; if (huecos.some(([h0, h1]) => m > h0 && m < h1)) continue; out.push([a, b]); } return out; }
const ANCHO = { pizarra: 1.4, corcho: 1, cuadro: .5, reloj: .5, tv: 1 };
const PARED = { t: '#f6efe3', l: '#e8dcc8', r: '#d4c6ae' }, MARCO = { t: '#a3815f', l: '#8f6f51', r: '#7a5d43' };
function paredX(y, x0, x1, huecos, decor) {
  tramos(x0, x1, huecos).forEach(([x, xe]) => at((x + xe) / 2 + y + WT / 2, () => box(x, y, xe - x, WT, 0, WHI, PARED), [x, y, xe, y + WT, WHI]));
  huecos.forEach(([a, b]) => {
    at(a + y + WT / 2, () => box(a - .04, y, .04, WT + .03, 0, WHI - 2, MARCO), [a - .04, y, a, y + WT + .03, WHI]); at(b + y + WT / 2, () => box(b, y, .04, WT + .03, 0, WHI - 2, MARCO), [b, y, b + .04, y + WT + .03, WHI]);
  });
  (decor || []).forEach(([fn, u, z, o]) => at(u + (ANCHO[fn] || .6) + .3 + y + WT, t => M.pared && M.pared[fn] && M.pared[fn]('x', u, y + WT, z, Object.assign({ t, luz: LUZ }, o)), [u, y + WT, u + (ANCHO[fn] || .6), y + WT + .03, WHI]));
}
function paredY(x, y0, y1, huecos, decor) {
  tramos(y0, y1, huecos).forEach(([y, ye]) => at(x + WT / 2 + (y + ye) / 2, () => box(x, y, WT, ye - y, 0, WHI, PARED), [x, y, x + WT, ye, WHI]));
  (decor || []).forEach(([fn, u, z, o]) => at(x + WT + u + (ANCHO[fn] || .6) + .3, t => M.pared && M.pared[fn] && M.pared[fn]('y', u, x + WT, z, Object.assign({ t, luz: LUZ }, o)), [x + WT, u, x + WT + .03, u + (ANCHO[fn] || .6), WHI]));
}
const P = s => [SALAS[s].puerta.x - .45, SALAS[s].puerta.x + .45];
// pasillo: pared norte (fondo de las salas de atrás) y pared sur (fondo de las salas de adelante)
paredX(6 - WT, 0, FX, [P('A'), P('R'), P('C'), P('D')]);
paredX(7.6, 0, FX, [P('B'), SALAS.E.abierta, P('J'), P('L'), P('K')],
  [['corcho', 1.2, 4, {}], ['cuadro', 3.6, 5, { color: '#4a80c6' }], ['pizarra', 19.3, 3, {}]]);
// divisiones entre salas
paredY(7 - WT, 0, 6 - WT, [], []);
paredY(12 - WT, 0, 6 - WT, [], [['pizarra', 1.3, 3, {}]]);
paredY(19 - WT, 0, 6 - WT, [], [['cuadro', 1.6, 5, { color: '#9c88c0' }], ['tv', 3.3, 4.5, {}]]);
paredY(7, 7.6 + WT, FY, [], [['reloj', 9.3, 6, {}], ['cuadro', 10.6, 5, { color: '#e2574c' }]]);
paredY(11 - WT, 7.6 + WT, FY, [], []);
paredY(18 - WT, 7.6 + WT, FY, [], []);
paredY(21 - WT, 7.6 + WT, FY, [], [['cuadro', 9.5, 5, { color: '#4fb176' }]]);
// pared de la sala de reuniones con pizarra
paredY(7 - WT, 0, 0, [], [['pizarra', 1.2, 3, {}]]);

/* ---------- puestos de trabajo ---------- */
const PUESTOS = [];          // {a, x, y, mira, aisle}
function islaDoble(x, y, a1, a2) {
  // escritorio doble: una persona del lado norte (mira +y) y otra del lado sur (mira -y)
  const h = hu('escritorioDoble', {}); const cx = x + h.w / 2, taza = (x * 7 | 0) % 3 === 0;
  const EST = { work: 'trabajando', think: 'pensando', tool: 'herramienta', error: 'error', idle: 'inactivo' };
  put('escritorioDoble', x, y, {
    atras: t => { M.monitor(cx - .46, y + .3, { mira: '-y', estado: a1 ? EST[a1.s] : 'inactivo', t, luz: LUZ, seed: x * 3 }); M.tecladoMouse(cx - .45, y + .1, { mira: '-y' }); if (taza) M.taza(cx + .3, y + .2, { t }); },
    adelante: t => { M.monitor(cx + .04, y + h.d - .42, { mira: '+y', estado: a2 ? EST[a2.s] : 'inactivo', t, luz: LUZ, seed: x * 5 }); M.tecladoMouse(cx + .05, y + h.d - .24, { mira: '+y' }); if (!taza) M.papeles(cx - .4, y + h.d - .3, {}); }
  }, 0);
  const pN = { x: cx - .25, y: y - .38, mira: '+y' }, pS = { x: cx + .25, y: y + h.d + .38, mira: '-y' };
  [[pN, a1], [pS, a2]].forEach(([p, a]) => {
    const silla = () => M.sillaOficina && M.sillaOficina(p.x - .2, p.y - .2, { mira: p.mira });
    at(p.x + p.y + (p.mira === '+y' ? -.15 : .12), silla, [p.x - .2, p.y - .2, p.x + .2, p.y + .2, 10]);
    if (a) { Object.assign(a, { hx: p.x, hy: p.y, mira: p.mira, sit: true, x: p.x, y: p.y }); a.aisle = { x: p.x, y: p.mira === '+y' ? p.y - .6 : p.y + .6 }; PUESTOS.push(a); }
  });
}
const team = k => AG.filter(a => a.t === k);
const ta = team('A'), tb = team('B'), tc = team('C');
[1.0, 2.7, 4.4].forEach((x, i) => islaDoble(x, 2.3, ta[i * 2], ta[i * 2 + 1]));
[1.0, 2.7, 4.4].forEach((x, i) => islaDoble(x, 9.9, tb[i * 2], tb[i * 2 + 1]));
[13.0, 14.7, 16.4].forEach((x, i) => islaDoble(x, 2.3, tc[i * 2], tc[i * 2 + 1]));
SALAS.A.aisleY = 1.0; SALAS.B.aisleY = 8.6; SALAS.C.aisleY = 1.0;

/* ---------- muebles por sala ---------- */
// Producto
put('muebleBajo', .25, 4.4, { mira: '+x' }); put('planta', 5.8, .4, { tipo: 'alta' }); put('archivero', .25, .3, { mira: '+x' });
// Contenido
put('muebleBajo', .25, 12.2, { mira: '+x' }); put('planta', 5.2, 8.1, { tipo: 'alta' }); put('impresora', 5.5, 13.2, {}); put('planta', .4, 8.0, { tipo: 'mediana' });
// Ingeniería
put('planta', 17.95, .4, { tipo: 'alta' }); put('archivero', 12.3, 4.7, { mira: '+x' }); put('planta', 12.4, .4, { tipo: 'mediana' });
// Sala de reuniones
put('mesaReunion', 8.0, 2.1, { w: 3.0, d: 1.2 });
const SILLAS_R = [];
[8.4, 9.5, 10.6].forEach(x => { SILLAS_R.push({ x, y: 1.75, mira: '+y' }); SILLAS_R.push({ x, y: 3.65, mira: '-y' }); });
SILLAS_R.forEach(p => at(p.x + p.y + (p.mira === '+y' ? -.15 : .12), () => M.sillaOficina && M.sillaOficina(p.x - .2, p.y - .2, { mira: p.mira }), [p.x - .2, p.y - .2, p.x + .2, p.y + .2, 10]));
put('tvPie', 11.3, 2.4, { mira: '-x' }); put('planta', 7.4, .4, { tipo: 'alta' });
at(1000, t => { M.lamparaColgante && M.lamparaColgante(8.9, 2.6, { zTecho: WH - 4, luz: LUZ }); M.lamparaColgante && M.lamparaColgante(10.1, 2.6, { zTecho: WH - 4, luz: LUZ }); });
// Dirección
put('escritorioL', 20.4, 1.2, {}); at(21.3 + 1.0 - .15, () => M.sillaOficina && M.sillaOficina(21.1, .75, { mira: '+y' }), [21.1, .75, 21.5, 1.15, 10]);
put('sillaVisita', 20.7, 3.1, { mira: '-y' }); put('sillaVisita', 21.7, 3.1, { mira: '-y' });
put('muebleBajo', 19.25, 4.0, { mira: '+x' }); put('sillon1', 23.0, 4.3, { mira: '-x', color: '#7a5d8a' }); put('planta', 23.5, .4, { tipo: 'alta' }); put('lamparaPie', 23.4, 3.6, {});
// Recepción
put('mostrador', 8.0, 9.2, { mira: '+y' }); put('dispensador', 10.3, 8.0, {}); put('planta', 7.5, 8.0, { tipo: 'alta' });
put('sillaVisita', 7.5, 11.6, { mira: '+x' }); put('sillaVisita', 7.5, 12.3, { mira: '+x' }); put('planta', 9.5, 13.0, { tipo: 'mediana' });
at(1, () => M.felpudo && M.felpudo(8.3, 13.2, {}), [8.3, 13.2, 9.1, 13.7, .1]);
// Juegos y café
put('mesada', 12.5, 7.85, { w: 2.6, mira: '+y' });
at(40, t => M.cafetera && M.cafetera(12.8, 7.95, { t }), [12.8, 7.95, 13.02, 8.15, 18]);
at(40.1, t => M.microondas && M.microondas(14.1, 7.95, { t }), [14.1, 7.95, 14.52, 8.25, 16]);
put('heladera', 15.25, 7.85, {}); put('expendedora', 16.0, 7.85, {}); put('tacho', 16.8, 7.95, {});
put('mesaAlta', 12.4, 9.6, {}); put('banqueta', 12.1, 9.4, {}); put('banqueta', 13.0, 10.1, {});
put('mesaAlta', 14.3, 9.6, {}); put('banqueta', 14.0, 9.4, {}); put('banqueta', 14.9, 10.1, {});
put('sillon2', 14.2, 10.7, { mira: '+x', color: '#5d7fb3' }); put('mesaRatona', 15.3, 11.1, {});
put('pingpong', 11.7, 12.0, {}); put('arcade', 17.1, 8.0, { mira: '+y' }); put('puff', 16.9, 12.6, { color: '#9c88c0' }); put('puff', 16.4, 13.2, { color: '#4fb176' });
put('planta', 17.0, 13.3, { tipo: 'alta' }); put('planta', 11.3, 10.9, { tipo: 'mediana' });
// Despacho de Luis
put('escritorio', 18.7, 10.0, { mira: '+y' }); at(19.3 + 9.6 - .15, () => M.sillaOficina && M.sillaOficina(19.1, 9.35, { mira: '+y' }), [19.1, 9.35, 19.5, 9.75, 10]);
at(40, () => { M.notebook && M.notebook(19.0, 10.15, { mira: '-y' }); M.lamparaEscritorio && M.lamparaEscritorio(19.5, 10.1, { luz: LUZ }); }, [18.7, 10.0, 19.8, 10.6, 14]);
put('archivero', 20.2, 8.0, { mira: '+y' }); put('planta', 18.3, 13.3, { tipo: 'alta' }); put('sillaVisita', 19.0, 11.4, { mira: '-y' });
// Biblioteca
put('biblioteca', 21.4, 8.0, { mira: '+y' }); put('biblioteca', 22.5, 8.0, { mira: '+y' }); put('biblioteca', 23.25, 9.4, { mira: '-x' });
put('mesaLectura', 21.8, 10.6, {}); put('sillaVisita', 21.9, 10.1, { mira: '+y' }); put('sillaVisita', 22.6, 10.1, { mira: '+y' });
put('sillon1', 22.8, 12.6, { mira: '-y', color: '#a0644a' }); put('lamparaPie', 23.5, 12.3, {});

/* ---------- reunión y sillón ---------- */
const sol = ag('Sol'), tom = ag('Tomás');
Object.assign(sol, { hx: 8.4, hy: 1.75, mira: '+y', sit: true }); Object.assign(tom, { hx: 9.5, hy: 1.75, mira: '+y', sit: true });
const el = ag('Elena'); Object.assign(el, { hx: 14.6, hy: 11.5, mira: '+x', sit: true, sofa: true });
[sol, tom, el].forEach(a => { a.x = a.hx; a.y = a.hy; });

/* ---------- caminatas: algunos agentes van a buscar café y vuelven ---------- */
function puertaDe(k) { const s = SALAS[k]; if (s.abierta) return { x: (s.abierta[0] + s.abierta[1]) / 2, yIn: s.r[1] + .6, yOut: PASILLO_Y }; const p = s.puerta; return { x: p.x, yIn: p.lado === 'S' ? s.r[3] - .7 : s.r[1] + 1.2, yOut: PASILLO_Y }; }
function rutaEntre(a, kDesde, destino, kHasta) {
  const p1 = puertaDe(kDesde), p2 = puertaDe(kHasta), pts = [];
  if (a.aisle) pts.push(a.aisle);
  const ay = a.aisle ? a.aisle.y : a.hy;
  pts.push({ x: p1.x, y: ay }, { x: p1.x, y: p1.yIn }, { x: p1.x, y: p1.yOut }, { x: p2.x, y: p2.yOut }, { x: p2.x, y: p2.yIn }, { x: destino.x, y: p2.yIn }, destino);
  return pts;
}
const SALA_DE = { A: 'A', B: 'B', C: 'C' };
const CAFE = [{ x: 12.9, y: 9.25 }, { x: 14.8, y: 9.25 }, { x: 13.6, y: 10.4 }];
const CAMINANTES = [['Juan', 0, 0], ['Rafa', 1, 7], ['Diego', 2, 14]].map(([n, i, ofs]) => {
  const a = ag(n); a.walker = { i, ofs, ruta: null, k: 0, fase: 'sentado', hasta: (6 + ofs) * 1000 }; return a; });
const VEL = 1.5; // baldosas por segundo
function avanzar(a, dt, now) {
  const w = a.walker; if (!w) return;
  if (w.fase === 'sentado' && now > w.hasta) { w.ruta = rutaEntre(a, SALA_DE[a.t], CAFE[w.i], 'J'); w.k = 0; w.fase = 'ida'; a.sit = false; }
  else if (w.fase === 'cafe' && now > w.hasta) { const p1 = puertaDe('J'), p2 = puertaDe(SALA_DE[a.t]), ay = a.aisle.y;
    w.ruta = [{ x: a.x, y: p1.yIn }, { x: p1.x, y: p1.yIn }, { x: p1.x, y: p1.yOut }, { x: p2.x, y: p2.yOut }, { x: p2.x, y: p2.yIn }, { x: p2.x, y: ay }, a.aisle, { x: a.hx, y: a.hy }]; w.k = 0; w.fase = 'vuelta'; }
  if (w.fase === 'ida' || w.fase === 'vuelta') {
    let paso = VEL * dt;
    while (paso > 0 && w.k < w.ruta.length) {
      const q = w.ruta[w.k], dx = q.x - a.x, dy = q.y - a.y, dist = Math.hypot(dx, dy);
      if (dist < 1e-3) { w.k++; continue; }
      if (Math.abs(dx) > Math.abs(dy)) a.mira = dx > 0 ? '+x' : '-x'; else a.mira = dy > 0 ? '+y' : '-y';
      const m = Math.min(paso, dist); a.x += dx / dist * m; a.y += dy / dist * m; paso -= m;
    }
    if (w.k >= w.ruta.length) {
      if (w.fase === 'ida') { w.fase = 'cafe'; w.hasta = now + 7000; a.mira = '+x'; }
      else { w.fase = 'sentado'; w.hasta = now + 14000 + w.ofs * 900; a.x = a.hx; a.y = a.hy; a.mira = a.hmira; a.sit = true; }
    }
  }
}
AG.forEach(a => { a.hmira = a.mira; if (a.x == null) { a.x = a.hx || 0; a.y = a.hy || 0; } });

/* ---------- piso, paredes exteriores y ventanales (se cachea por momento del día) ---------- */
const MADERA = ['#d3a571', '#c4945f', '#ad7f4f', '#946a40'], BALDOSA = ['#d6d0c6', '#c8c1b5', '#e2ddd4'];
function pisoMadera(x0, y0, x1, y1) {
  quad(x0, y0, x1, y1, MADERA[1]);
  for (let y = y0; y <= y1 + .001; y += 1 / 3) L(iso(x0, y), iso(x1, y), MADERA[2]);
  const r = rng((x0 * 31 + y0 * 7) | 0);
  for (let y = y0, j = 0; y < y1 - .01; y += 1 / 3, j++) { for (let x = x0 + (j % 3) * .7; x < x1; x += 2.1) L(iso(x, y), iso(x, Math.min(y + 1 / 3, y1)), MADERA[3]);
    for (let k = 0; k < (x1 - x0) * 1.5; k++) { const p = iso(x0 + r() * (x1 - x0), y + r() / 3); px(p[0], p[1], r() < .5 ? MADERA[0] : MADERA[2]); } }
}
function pisoBaldosa(x0, y0, x1, y1) {
  quad(x0, y0, x1, y1, BALDOSA[0]);
  for (let x = Math.ceil(x0 * 2) / 2; x < x1; x += .5) L(iso(x, y0), iso(x, y1), BALDOSA[1]);
  for (let y = Math.ceil(y0 * 2) / 2; y < y1; y += .5) L(iso(x0, y), iso(x1, y), BALDOSA[1]);
}
function ventanal(Pf, u0, u1, s) {
  const F = FASE || { k: 'mediodia', sky: '#a6dcf0' }, r = rng(s * 37), MC = '#535a68';
  poly([Pf(u0, 9), Pf(u1, 9), Pf(u1, 41), Pf(u0, 41)], MC); poly([Pf(u0 + .05, 10), Pf(u1 - .05, 10), Pf(u1 - .05, 40), Pf(u0 + .05, 40)], F.sky);
  const BC = { noche: ['#1a2140', '#232b4e'], anochecer: ['#3a3466', '#463e72'], atardecer: ['#a06c78', '#b07e84'], amanecer: ['#b99bad', '#c6aab8'], tarde: ['#a9b2c2', '#98a3b6'] }[F.k] || ['#9db1ca', '#8aa0bd'];
  const lit = F.noche || F.k === 'anochecer' || F.k === 'atardecer';
  if (!lit) { for (let k = 0; k < 2; k++) { const c = Pf(u0 + .4 + r() * (u1 - u0 - .8), 33 + r() * 4); rect(c[0] - 4, c[1], 10, 1, '#ffffff'); rect(c[0] - 2, c[1] - 1, 5, 1, '#ffffff'); } }
  else if (F.noche) { for (let k = 0; k < 8; k++) { const c = Pf(u0 + .1 + r() * (u1 - u0 - .2), 30 + r() * 9); px(c[0], c[1], '#fff6c8'); } }
  for (let u = u0 + .05; u < u1 - .06;) {
    const w = .16 + r() * .3, h = 7 + r() * 18, ue = Math.min(u + w, u1 - .05), col = BC[(r() * 2) | 0];
    poly([Pf(u, 10), Pf(ue, 10), Pf(ue, 10 + h), Pf(u, 10 + h)], col);
    for (let z = 13; z < 8 + h; z += 3) for (let q = u + .04; q < ue - .03; q += .08) if (r() < (lit ? .35 : .18)) { const c = Pf(q, z); px(c[0], c[1], lit ? '#ffd77a' : shade(col, 1.18)); }
    u = ue + .015;
  }
  const TC = { noche: '#22382c', anochecer: '#33424a', atardecer: '#5e6a48', amanecer: '#7a8a6a' }[F.k] || '#6f9e64';
  for (let u = u0 + .12; u < u1 - .1; u += .15) { const c = Pf(u, 11 + r() * 2); disc(c[0], c[1], 2 + ((r() * 2) | 0), TC); }
  for (let u = u0 + 1.25; u < u1 - .3; u += 1.25) L(Pf(u, 9), Pf(u, 41), MC); L(Pf(u0, 29), Pf(u1, 29), MC); L(Pf(u0, 9), Pf(u1, 9), '#ece6db');
}
function drawFloor() {
  g.clearRect(0, 0, W, H);
  Object.values(SALAS).forEach(s => { const [x0, y0, x1, y1] = s.r; (s.piso === 'baldosa' ? pisoBaldosa : pisoMadera)(x0, y0, x1, y1); });
  pisoBaldosa(0, 6, FX, 7.6);
  Object.values(SALAS).forEach(s => { if (!s.alf) return; const [x0, y0, x1, y1] = s.r, m = .7;
    if (M.alfombra) M.alfombra(x0 + m, y0 + m, x1 - m, y1 - m, { color: s.alf }); else quad(x0 + m, y0 + m, x1 - m, y1 - m, s.alf); });
  // borde del piso
  L([iso(0, FY)[0], iso(0, FY)[1] + 1], [iso(FX, FY)[0], iso(FX, FY)[1] + 1], '#7a5a3c'); L([iso(FX, 0)[0], iso(FX, 0)[1] + 1], [iso(FX, FY)[0], iso(FX, FY)[1] + 1], '#7a5a3c');
  poly([iso(0, FY), iso(FX, FY), [iso(FX, FY)[0], iso(FX, FY)[1] + 6], [iso(0, FY)[0], iso(0, FY)[1] + 6]], '#8a6a4a');
  poly([iso(FX, 0), iso(FX, FY), [iso(FX, FY)[0], iso(FX, FY)[1] + 6], [iso(FX, 0)[0], iso(FX, 0)[1] + 6]], '#6f5238');
  // paredes exteriores
  const WALL = '#ece3d3', WALL_L = '#ddd2bf', CAP = '#f7f1e6', SK = '#8a7357', SKD = '#6f5b44';
  poly([iso(0, 0), iso(FX, 0), up(iso(FX, 0), WH), up(iso(0, 0), WH)], WALL);
  poly([iso(0, 0), iso(0, FY), up(iso(0, FY), WH), up(iso(0, 0), WH)], WALL_L);
  poly([iso(0, 0), iso(FX, 0), up(iso(FX, 0), 4), up(iso(0, 0), 4)], SK); poly([iso(0, 0), iso(0, FY), up(iso(0, FY), 4), up(iso(0, 0), 4)], SKD);
  const PB = (u, z) => up(iso(u, 0), z), PL = (u, z) => up(iso(0, u), z);
  [[PB, .4, 6.6, 1], [PB, 7.4, 11.6, 2], [PB, 12.4, 18.6, 3], [PB, 19.4, 23.6, 4], [PL, .4, 5.6, 5], [PL, 8.2, 13.6, 6]].forEach(([Pf, a, b, s]) => ventanal(Pf, a, b, s));
  poly([up(iso(0, 0), WH - 2), up(iso(FX, 0), WH - 2), up(iso(FX, 0), WH), up(iso(0, 0), WH)], CAP); poly([up(iso(0, 0), WH - 2), up(iso(0, FY), WH - 2), up(iso(0, FY), WH), up(iso(0, 0), WH)], CAP);
  L(iso(0, 0), up(iso(0, 0), WH), '#b5a78f');
  // haces de luz de día
  if (!FASE || !FASE.noche) N.alpha(.1, () => [[.4, 6.6], [7.4, 11.6], [12.4, 18.6], [19.4, 23.6]].forEach(([u0, u1]) => { for (let u = u0; u < u1 - .6; u += 1.6) poly([PB(u + .1, 12), PB(u + 1.2, 12), iso(u + 2.4, 3.2), iso(u + .9, 3.2)], '#fff3d0'); }));
}
const floors = {};
function floorFor(k) { if (floors[k]) return floors[k]; const cv = document.createElement('canvas'); cv.width = W; cv.height = H; drawFloor(); cv.getContext('2d').drawImage(world, 0, 0); floors[k] = cv; return cv; }

/* ---------- luz según la hora (para probar otra hora: #h19) ---------- */
let FASE = null, LUZ = 0;
const FASES = [
  { k: 'noche', desde: 0, tint: '#4a5185', glow: 1, sky: '#22305a', noche: true },
  { k: 'amanecer', desde: 5.5, tint: '#d6b2c6', glow: .5, sky: '#f4b8a8' },
  { k: 'manana', desde: 7.5, tint: '#fff4e4', glow: 0, sky: '#a6dcf0', polvo: true },
  { k: 'mediodia', desde: 11, tint: null, glow: 0, sky: '#a6dcf0', polvo: true },
  { k: 'tarde', desde: 16, tint: '#ffe4c0', glow: 0, sky: '#f6d49c', polvo: true },
  { k: 'atardecer', desde: 18.5, tint: '#e9aa8c', glow: .45, sky: '#f0906a' },
  { k: 'anochecer', desde: 20, tint: '#7c74aa', glow: .8, sky: '#4a3f7a' },
  { k: 'noche', desde: 21, tint: '#4a5185', glow: 1, sky: '#22305a', noche: true }];
function fase() { const m = location.hash.match(/^#h(\d{1,2})$/); const d = new Date(); const h = m ? +m[1] : d.getHours() + d.getMinutes() / 60; let f = FASES[0]; for (const x of FASES) if (h >= x.desde) f = x; return f; }

/* ---------- personajes en escena ---------- */
const SEAT = 4 * S, SEAT_SOFA = 3.5 * S;
const ESTADO = a => a.walker && a.walker.fase !== 'sentado' ? (a.walker.fase === 'cafe' ? 'quieto' : 'caminar')
  : ({ work: 'tipear', tool: 'tipear', think: 'pensar', error: 'error', idle: 'dormir', meet: 'quieto' }[a.s] || 'quieto');
function orient(m) { return { '+x': ['se', false], '+y': ['se', true], '-y': ['ne', false], '-x': ['ne', true] }[m] || ['se', false]; }
function drawAgent(a, t) {
  const [sx, sy] = iso(a.x, a.y); a.sx = R(sx); a.sy = R(sy);
  let st = ESTADO(a); const sit = a.sit && !(a.walker && a.walker.fase !== 'sentado');
  if (a.s === 'meet' && sit) st = 'pensar';
  if (sit && (a.mira === '-y' || a.mira === '-x') && st === 'pensar') st = 'tipear';
  const [pose, flip] = orient(a.mira);
  if (!sit) { g.fillStyle = 'rgba(40,25,30,.28)'; for (let y = -1; y <= 1; y++) { const w = y === 0 ? 8 : 6; g.fillRect(a.sx - w, a.sy + y, w * 2, 1); } }
  const seat = a.sofa ? SEAT_SOFA : SEAT, shake = st === 'error' && (t % 16) < 6 ? (t % 2 ? 1 : -1) : 0;
  const ay = sit ? a.sy - R(seat) : a.sy;
  drawChar(g, a.sx + shake, ay, a.c, pose, sit, flip, t + a.seed, st);
  a.top = sit ? ay - (drawChar.ALTO_SENTADO || 30) : ay - (drawChar.ALTO || 42);
}
const GLYPH = { B: ['##.', '#.#', '##.', '#.#', '##.'], A: ['.#.', '#.#', '###', '#.#', '#.#'], S: ['.##', '#..', '.#.', '..#', '##.'], H: ['#.#', '#.#', '###', '#.#', '#.#'], G: ['.##', '#..', '#.#', '#.#', '.##'],
  I: ['###', '.#.', '.#.', '.#.', '###'], T: ['###', '.#.', '.#.', '.#.', '.#.'], Q: ['.#.', '#.#', '#.#', '##.', '.##'], L: ['#..', '#..', '#..', '#..', '###'], W: ['#.#', '#.#', '#.#', '###', '#.#'],
  E: ['###', '#..', '##.', '#..', '###'], P: ['##.', '#.#', '##.', '#..', '#..'], D: ['##.', '#.#', '#.#', '#.#', '##.'], F: ['###', '#..', '##.', '#..', '#..'], Z: ['###', '..#', '.#.', '#..', '###'], '!': ['.#.', '.#.', '.#.', '...', '.#.'] };
function glyph(ch, x, y, c) { const f = GLYPH[ch]; if (!f) return; g.fillStyle = c; for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (f[r][k] === '#') g.fillRect(x + k, y + r, 1, 1); }
function rrect(x, y, w, h, f, o) { rect(x + 1, y, w - 2, h, o); rect(x, y + 1, w, h - 2, o); rect(x + 1, y + 1, w - 2, h - 2, f); }
let sel = null, hover = null, zone = null;
function statusUI(a, t, near) {
  const sx = a.sx, top = a.top, st = ST[a.s];
  if (a === sel || a === hover) { const c = a === sel ? '#ffcf5a' : '#ffffff', sy = a.sy; L([sx - 15, sy], [sx, sy - 7], c); L([sx, sy - 7], [sx + 15, sy], c); L([sx + 15, sy], [sx, sy + 7], c); L([sx, sy + 7], [sx - 15, sy], c); }
  if (a.walker && a.walker.fase !== 'sentado') return;
  if (!near) { if ((a.s === 'error' || a.s === 'think') && (t % 8) >= 5) return; const y = top - 6; rect(sx - 2, y - 1, 5, 3, N.OUT); rect(sx - 1, y - 2, 3, 5, N.OUT); rect(sx - 1, y - 1, 3, 3, st.c); px(sx - 1, y - 1, '#ffffff'); return; }
  if (a.s === 'think' || (a.s === 'meet' && a === sol && Math.floor(t / 20) % 2 === 0) || (a.s === 'meet' && a === tom && Math.floor(t / 20) % 2 === 1)) {
    const f = a.s === 'meet' ? '#eadfff' : '#ffffff', bx = sx + 5, by = top - 12; rect(sx + 3, top - 2, 2, 2, N.OUT); px(sx + 3, top - 2, f); rrect(bx, by, 11, 7, f, N.OUT);
    const n = 1 + ((t >> 1) % 3); for (let i = 0; i < n; i++) px(bx + 3 + i * 2, by + 3, a.s === 'meet' ? '#7b54c9' : N.OUT);
  }
  if (a.s === 'tool') { const tx = a.tool.toUpperCase(), w = tx.length * 4 + 3, bx = sx + 5, by = top - 12; rrect(bx, by, w, 9, '#ffffff', N.OUT); for (let i = 0; i < tx.length; i++) glyph(tx[i], bx + 2 + i * 4, by + 2, '#2f63b8'); }
  if (a.s === 'error') { const by = top - 13 - ((t >> 1) % 2); rrect(sx + 5, by, 7, 9, '#f0564c', N.OUT); glyph('!', sx + 7, by + 2, '#ffffff'); }
  if (a.s === 'idle') { for (let j = 0; j < 2; j++) { const ph = (t + j * 7) % 14; glyph('Z', sx + 6 + j * 4 + (ph > 7 ? 1 : 0), top - 2 - ph, j ? '#c9d1ff' : '#e6eaff'); } }
}

/* ---------- orden de dibujo: si dos cosas se superponen en pantalla, primero la que está detrás según su huella ---------- */
function caja(it) { const b = it.b, l = iso(b[0], b[3])[0], r = iso(b[2], b[1])[0], tp = iso(b[0], b[1])[1] - b[4] * S - 6, bt = iso(b[2], b[3])[1] + 2; return [l, tp, r, bt]; }
const solapa = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
const atras = (A, B) => A[2] <= B[0] + 1e-6 || A[3] <= B[1] + 1e-6;
function antes(A, B) { const ab = atras(A.b, B.b), ba = atras(B.b, A.b); if (ab && !ba) return true; if (ba && !ab) return false; return A.d < B.d; }
let EST = null;
function prepararEstaticos() {
  const L = items.filter(i => i.b); L.forEach((i, k) => { i.k = k; i.sb = caja(i); i.sal = []; i.ent0 = 0; });
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const A = L[i], B = L[j]; if (!solapa(A.sb, B.sb)) continue; if (antes(A, B)) { A.sal.push(j); B.ent0++; } else { B.sal.push(i); A.ent0++; } }
  EST = { L, sinCaja: items.filter(i => !i.b).sort((p, q) => p.d - q.d) };
}
function ordenar() {
  if (!EST) prepararEstaticos();
  const L = EST.L, n0 = L.length, ags = AG.map(a => ({ b: [a.x - .07, a.y - .07, a.x + .07, a.y + .07, 18], d: a.x + a.y, f: tt => drawAgent(a, tt) }));
  const todos = L.concat(ags), n = todos.length, ent = new Int32Array(n), extra = Array.from({ length: n }, () => []);
  for (let i = 0; i < n0; i++) ent[i] = L[i].ent0;
  ags.forEach((A, ai) => { const ia = n0 + ai; A.sb = caja(A);
    for (let j = 0; j < n; j++) { if (j === ia) continue; const B = todos[j]; if (j > ia || j < n0) { if (!solapa(A.sb, B.sb || caja(B))) continue; if (antes(A, B)) { extra[ia].push(j); ent[j]++; } else { extra[j].push(ia); ent[ia]++; } } } });
  // Kahn con montículo por d
  const heap = [], push = i => { heap.push(i); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (todos[heap[p]].d <= todos[heap[c]].d) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } },
    pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && todos[heap[l]].d < todos[heap[m]].d) m = l; if (r < heap.length && todos[heap[r]].d < todos[heap[m]].d) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  const hecho = new Uint8Array(n), out = [];
  for (let i = 0; i < n; i++) if (!ent[i]) push(i);
  while (out.length < n) {
    let i; if (heap.length) i = pop(); else { let m = -1; for (let k = 0; k < n; k++) if (!hecho[k] && (m < 0 || todos[k].d < todos[m].d)) m = k; i = m; }
    if (hecho[i]) continue; hecho[i] = 1; out.push(todos[i]);
    const sal = i < n0 ? L[i].sal.concat(extra[i]) : extra[i];
    for (const j of sal) if (!hecho[j] && --ent[j] === 0) push(j);
  }
  return out.concat(EST.sinCaja);
}

/* ---------- render ---------- */
let T = 0, NOW = 0, lastNow = 0;
function render(t) {
  FASE = fase(); LUZ = FASE.glow;
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, W, H);
  g.drawImage(floorFor(FASE.k), 0, 0);
  for (const it of ordenar()) it.f(t);
  const F = FASE;
  if (F.tint) { g.globalCompositeOperation = 'multiply'; g.fillStyle = F.tint; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.drawImage(floorFor(F.k), 0, 0); g.globalCompositeOperation = 'source-over'; }
  if (F.glow > 0) {
    g.globalCompositeOperation = 'lighter';
    Object.keys(CENT).forEach(k => { const p = iso(...CENT[k]); dith(p[0], p[1] + 6, 90, 45, '#ffcf8c', .08 * F.glow); dith(p[0], p[1] + 6, 56, 28, '#ffcf8c', .07 * F.glow); });
    PUESTOS.forEach(a => { if (a.s !== 'idle' && a.sit) dith(a.sx, a.sy - 30, 11, 11, ST[a.s].sc, .28 * F.glow); });
    g.globalCompositeOperation = 'source-over';
  }
  const near = cam.k >= (kFar + kNear) / 2;
  AG.slice().sort((p, q) => (p.x + p.y) - (q.x + q.y)).forEach(a => statusUI(a, t, near));
}

/* ---------- cámara, zoom y clic ---------- */
let kFar = 1, kNear = 3, cw = 0, ch = 0, dpr = 1, lastDx = 0, lastDy = 0;
const cam = { cx: W / 2, cy: H / 2, k: 1 }; let tween = null;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function targetFor(z) { if (!z || !CENT[z]) return { cx: W / 2, cy: H / 2 - 10, k: kFar }; const p = iso(...CENT[z]); return { cx: p[0], cy: p[1] - 24, k: kNear }; }
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3); const cssW = stage.clientWidth, cssH = stage.clientHeight || Math.round(cssW * .62);
  cw = view.width = Math.max(1, R(cssW * dpr)); ch = view.height = Math.max(1, R(cssH * dpr));
  kFar = Math.max(1, Math.min(Math.floor(cw / W), Math.floor(ch / H))); if (cw / W < 1 || ch / H < 1) kFar = 1;
  kNear = Math.max(kFar + 1, Math.floor(cw / 420));
  Object.assign(cam, targetFor(zone)); tween = null; present();
}
function go(z) { zone = z || null; const to = targetFor(zone);
  document.querySelectorAll('#zones button[data-z]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.z === (zone || ''))));
  if (reduce) { Object.assign(cam, to); tween = null; } else tween = { from: { ...cam }, to, t0: performance.now() }; }
function present() {
  vc.imageSmoothingEnabled = false; vc.fillStyle = getComputedStyle(document.body).getPropertyValue('--fondo').trim() || '#f2f0ec'; vc.fillRect(0, 0, cw, ch);
  // vista general: si la oficina no entra a 1×, se achica (solo en la vista general)
  const fit = Math.min(cw / W, ch / H), k = cam.k === kFar && fit < 1 ? fit : cam.k;
  lastDx = R(cw / 2 - cam.cx * k); lastDy = R(ch / 2 - cam.cy * k); lastK = k;
  vc.imageSmoothingEnabled = k < 1; vc.drawImage(world, lastDx, lastDy, W * k, H * k);
}
let lastK = 1, lastTick = 0;
function frame(now) {
  if (tween) { const p = Math.min(1, (now - tween.t0) / 650), e = 1 - Math.pow(1 - p, 3), f = tween.from, to = tween.to;
    cam.cx = f.cx + (to.cx - f.cx) * e; cam.cy = f.cy + (to.cy - f.cy) * e; cam.k = p < 1 ? Math.max(kFar, R(f.k + (to.k - f.k) * e)) : to.k; if (p >= 1) tween = null; }
  const dt = lastNow ? Math.min(.1, (now - lastNow) / 1000) : 0; lastNow = now;
  CAMINANTES.forEach(a => avanzar(a, dt, now));
  if (now - lastTick > 50) { lastTick = now; NOW = now; T = Math.floor(now / 125); render(T); }
  present(); requestAnimationFrame(frame);
}
function hit(e) { const r = view.getBoundingClientRect(); const x = ((e.clientX - r.left) * dpr - lastDx) / lastK, y = ((e.clientY - r.top) * dpr - lastDy) / lastK; let best = null;
  for (const a of AG) { if (x >= a.sx - 8 && x <= a.sx + 8 && y >= a.top && y <= a.sy + 1 && (!best || a.x + a.y > best.x + best.y)) best = a; } return best; }
const tip = document.getElementById('tip');
view.addEventListener('mousemove', e => { const a = hit(e); hover = a; view.style.cursor = a ? 'pointer' : 'default';
  if (a) { const r = stage.getBoundingClientRect(); tip.hidden = false; tip.textContent = a.n + ' · ' + (a.walker && a.walker.fase !== 'sentado' ? ST.walk.l : ST[a.s].l); tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; } else tip.hidden = true; });
view.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; });
function pick(a) { sel = a; const k = a.walker && a.walker.fase !== 'sentado' ? null : ({ A: 'A', B: 'B', C: 'C', M: 'R' }[a.t]); if (k) go(k); if (window.OFI && OFI.onPick) OFI.onPick(a); }
const kMax = () => kNear + 3;
function clampCam() { const k = lastK || cam.k, hw = cw / 2 / k, hh = ch / 2 / k; cam.cx = Math.max(Math.min(hw, W / 2), Math.min(Math.max(W - hw, W / 2), cam.cx)); cam.cy = Math.max(Math.min(hh, H / 2), Math.min(Math.max(H - hh, H / 2), cam.cy)); }
function zoomA(nk, pxx, pyy) { nk = Math.max(kFar, Math.min(kMax(), nk)); if (nk === cam.k) return; tween = null;
  const wx = (pxx - lastDx) / lastK, wy = (pyy - lastDy) / lastK; cam.k = nk; const k = nk; cam.cx = wx - (pxx - cw / 2) / k; cam.cy = wy - (pyy - ch / 2) / k;
  if (nk === kFar) { zone = null; Object.assign(cam, targetFor(null)); document.querySelectorAll('#zones button[data-z]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.z === ''))); }
  present(); clampCam(); present(); }
const devXY = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
let acum = 0;
view.addEventListener('wheel', e => { e.preventDefault(); acum += e.deltaY; if (Math.abs(acum) < 40) return; const [x, y] = devXY(e); zoomA(cam.k + (acum < 0 ? 1 : -1), x, y); acum = 0; }, { passive: false });
const ptrs = new Map(); let arr = null, movido = false, pinch = null;
view.addEventListener('pointerdown', e => { view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); movido = false;
  if (ptrs.size === 1) arr = { x: e.clientX, y: e.clientY, cx: cam.cx, cy: cam.cy };
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: cam.k }; arr = null; } });
view.addEventListener('pointermove', e => { if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = view.getBoundingClientRect();
    zoomA(Math.round(pinch.k * d / pinch.d), ((a[0] + b[0]) / 2 - r.left) * dpr, ((a[1] + b[1]) / 2 - r.top) * dpr); movido = true; return; }
  if (arr) { const dx = e.clientX - arr.x, dy = e.clientY - arr.y; if (Math.abs(dx) + Math.abs(dy) > 4) movido = true;
    if (movido && cam.k > kFar) { tween = null; cam.cx = arr.cx - dx * dpr / lastK; cam.cy = arr.cy - dy * dpr / lastK; clampCam(); present(); view.style.cursor = 'grabbing'; } } });
const soltar = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) { arr = null; view.style.cursor = 'default'; } };
view.addEventListener('pointerup', soltar); view.addEventListener('pointercancel', soltar);
view.style.touchAction = 'none';
view.addEventListener('click', e => { if (movido) { movido = false; return; } const a = hit(e); if (a) pick(a); });
document.querySelectorAll('#zones button[data-z]').forEach(b => b.addEventListener('click', () => { sel = null; go(b.dataset.z); }));
addEventListener('hashchange', () => render(T));
new ResizeObserver(resize).observe(stage);
resize(); render(0); requestAnimationFrame(frame);

window.OFI = { AG, ST, TEAMS, TOOLTXT, SALAS, drawChar: (...x) => drawChar(...x), ALTO: () => drawChar.ALTO || 42, go, resize, setSel: x => { sel = x; }, pickAgent: a => pick(a) };
})();
