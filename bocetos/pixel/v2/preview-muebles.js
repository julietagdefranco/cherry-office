/* Catálogo de muebles para revisar con render.mjs (tres láminas + una de paredes).
   Uso: T=0 node render.mjs out.png <ancho> <alto> <escala> PREVIEW_MU1 muebles.js preview-muebles.js */
const DIRS = ['+y', '+x', '-y', '-x'];

/* acomoda los objetos en filas sobre un piso de baldosas claras y los dibuja atrás→adelante */
function catalogo(g, N, X0, Y0, filas, extra) {
  let yy = .3, xm = 0;
  for (const fila of filas) { let x = .3, dm = 0; for (const it of fila) { x += it.w + (it.gap ?? .45); dm = Math.max(dm, it.d); } xm = Math.max(xm, x); yy += dm + .7; }
  const X = Math.ceil(xm), Y = Math.ceil(yy);
  N.OX = Y * 30 + 20; N.OY = 110;
  console.log('piso', X, Y, 'tamaño', (X + Y) * 30 + 40, (X + Y) * 15 + 150);
  for (let i = 0; i < X; i++) for (let j = 0; j < Y; j++) {
    N.quad(i, j, i + 1, j + 1, (i + j) % 2 ? '#d8cfc2' : '#e1d9cd');
  }
  for (let i = 0; i <= X; i++) N.L(N.iso(i, 0), N.iso(i, Y), '#cfc5b7');
  for (let j = 0; j <= Y; j++) N.L(N.iso(0, j), N.iso(X, j), '#cfc5b7');
  const items = [];
  let y = .3;
  for (const fila of filas) {
    let x = .3, dmax = 0;
    for (const it of fila) { items.push({ x, y, ...it }); x += it.w + (it.gap ?? .45); dmax = Math.max(dmax, it.d); }
    y += dmax + .7;
  }
  if (extra) extra(items);
  items.sort((a, b) => (a.x + a.w / 2 + a.y + a.d / 2) - (b.x + b.w / 2 + b.y + b.d / 2));
  for (const it of items) it.f(it.x, it.y);
}
const H = (nombre, o) => M.huellaDe(nombre, o);
const item = (nombre, o) => { const h = H(nombre, o); return { w: h.w, d: h.d, f: (x, y) => M[nombre](x, y, o) }; };
const refs = (N) => ({ w: 1, d: 1, f: (x, y) => { N.box(x, y, 1, 1, 0, 1, { t: '#f0e0e8', l: '#e3c9d6', r: '#c9a9b9', o: '#b08098' }); N.box(x + .45, y + .45, .06, .06, 1, 16, { t: '#ff5a5a', l: '#e33', r: '#b22' }); } });

/* lámina 1: trabajo y asientos */
function PREVIEW_MU1(g, N, t) {
  const luz = +(globalThis.LUZ || 0);
  const puesto = { w: 1.1, d: 2.2, f: (x, y) => {
    M.sillaOficina(x + .35, y, { mira: '+y' });
    M.escritorioDoble(x, y + .5, {
      atras: () => {
        M.tecladoMouse(x + .3, y + .62, { mira: '-y' });
        M.monitor(x + .1, y + .9, { mira: '-y', estado: 'trabajando', t, luz });
        M.monitor(x + .55, y + .9, { mira: '-y', estado: 'error', t, luz });
        M.taza(x + .95, y + .7, { t });
      },
      adelante: () => {
        M.monitor(x + .5, y + 1.15, { mira: '+y', estado: 'pensando', t, luz });
        M.papeles(x + .08, y + 1.3, {});
        M.tecladoMouse(x + .5, y + 1.45, { mira: '+y' });
      },
    });
    M.sillaOficina(x + .35, y + 1.75, { mira: '-y', color: '#5a4f7a' });
  } };
  const despacho = { w: 1.6, d: 1.2, f: (x, y) => {
    M.escritorioL(x, y, { mira: '+y' });
    M.notebook(x + .4, y + .25, { mira: '+y', estado: 'herramienta', t, luz });
    M.lamparaEscritorio(x + .1, y + .1, { luz: 1 });
    M.taza(x + 1.3, y + .9, { color: '#e2574c', t });
    M.monitor(x + 1.12, y + .2, { mira: '+y', estado: 'trabajando', t, luz });
  } };
  catalogo(g, N, 15, 13, [
    [puesto, item('escritorioDoble', { mira: '+x', patas: 'madera', color: '#9db88f' }), despacho, item('escritorioL', { mira: '+x' }), refs(N)],
    DIRS.map(m => item('escritorio', { mira: m })).concat([item('impresora', { mira: '+y' }), item('impresora', { mira: '+x' })]),
    ['trabajando', 'pensando', 'herramienta', 'error', 'inactivo'].map(e => ({ ...item('monitor', { mira: '+y', estado: e, t, luz, z: 0 }), gap: .15 }))
      .concat(['-y', '+x', '-x'].map(m => ({ ...item('monitor', { mira: m, estado: 'trabajando', t, z: 0 }), gap: .15 })))
      .concat(DIRS.slice(0, 3).map(m => item('notebook', { mira: m, estado: 'trabajando', t, z: 0 })))
      .concat([item('tecladoMouse', { z: 0 }), item('papeles', { z: 0 }), item('taza', { z: 0, t }), item('lamparaEscritorio', { z: 0, luz: 0 })]),
    DIRS.map(m => item('sillaOficina', { mira: m })).concat(DIRS.map(m => item('sillaVisita', { mira: m }))).concat([item('banqueta', {}), item('banqueta', { color: '#4a80c6' }), item('puff', {}), item('puff', { color: '#9c88c0' })]),
    DIRS.map(m => item('sillon2', { mira: m })).concat([item('sillon1', { mira: '+y', color: '#b4574a' }), item('sillon1', { mira: '+x', color: '#4fa08a' })]),
  ]);
}

/* lámina 2: mesas, guardado, cocina y juegos */
function PREVIEW_MU2(g, N, t) {
  const luz = +(globalThis.LUZ || 0);
  const cocina = { w: 2.0, d: .55, f: (x, y) => {
    M.mesada(x, y, {});
    M.cafetera(x + .1, y + .15, { t });
    M.microondas(x + .4, y + .1, {});
    M.taza(x + .95, y + .4, { z: 9 });
  } };
  catalogo(g, N, 15, 13, [
    DIRS.map(m => item('biblioteca', { mira: m })).concat([item('heladera', {}), item('heladera', { mira: '+x' }), item('expendedora', { luz }), item('expendedora', { mira: '+x', luz }), item('expendedora', { mira: '-y', luz })]),
    DIRS.map(m => item('arcade', { mira: m, t, luz })).concat([item('dispensador', {}), item('dispensador', { mira: '+x' }), item('archivero', {}), item('archivero', { mira: '+x' }), item('impresora', { mira: '-x' })]),
    [cocina, item('mesada', { mira: '+x', w: 1.5 }), item('mostrador', { mira: '+y' }), item('mostrador', { mira: '-y' }), item('mostrador', { mira: '+x' })],
    [item('mesaReunion', {}), item('mesaAlta', {}), item('mesaLectura', {}), item('muebleBajo', {}), item('muebleBajo', { mira: '+x' }), item('tacho', {}), item('tacho', { color: '#4fb176' })],
    [item('pingpong', {}), item('pingpong', { mira: '+x' }), item('mesaRatona', {}), item('mesaRatona', { mira: '+x' })].concat([item('cafetera', { z: 0, t }), item('cafetera', { z: 0, mira: '+x' }), item('microondas', { z: 0 }), item('microondas', { z: 0, mira: '+x' })]),
  ]);
}

/* lámina 3: deco y objetos de pared en un rincón */
function PREVIEW_MU3(g, N, t) {
  const luz = +(globalThis.LUZ || 0), X = 13, Y = 9, WH = 30;
  N.OX = Y * 30 + 20; N.OY = 150;
  N.poly([N.iso(0, 0), N.iso(X, 0), N.up(N.iso(X, 0), WH), N.up(N.iso(0, 0), WH)], '#efe6d6');
  N.poly([N.iso(0, 0), N.iso(0, Y), N.up(N.iso(0, Y), WH), N.up(N.iso(0, 0), WH)], '#ddd1bd');
  N.panelX(0, X, 0, 0, 1.6, '#b99a78'); N.panelY(0, Y, 0, 0, 1.6, '#a58763');
  for (let i = 0; i < X; i++) for (let j = 0; j < Y; j++) N.quad(i, j, i + 1, j + 1, (i + j) % 2 ? '#d8cfc2' : '#e1d9cd');
  // pared x (fondo): todos los objetos
  M.pared.puerta('x', .4, 0, 0, {});
  M.pared.pizarra('x', 1.6, 0, 10, {});
  M.pared.reloj('x', 3.3, 0, 21, {});
  M.pared.corcho('x', 4.0, 0, 10, {});
  M.pared.cuadro('x', 5.3, 0, 11, { color: '#e58a3a' });
  M.pared.tv('x', 6.1, 0, 10, { t, luz });
  M.pared.puertaVidrio('x', 7.5, 0, 0, {});
  M.pared.puerta('x', 9.1, 0, 0, { abierta: true });
  M.pared.cuadro('x', 10.4, 0, 9, { color: '#7fb3d9', w: .7, h: 8 });
  M.pared.reloj('x', 11.4, 0, 14, { r: .15 });
  // pared y (izquierda)
  M.pared.puerta('y', .4, 0, 0, {});
  M.pared.pizarra('y', 1.6, 0, 10, { w: 1.2 });
  M.pared.reloj('y', 3.1, 0, 21, {});
  M.pared.corcho('y', 3.8, 0, 10, { w: .8 });
  M.pared.cuadro('y', 4.8, 0, 11, { color: '#9c88c0' });
  M.pared.tv('y', 5.6, 0, 10, { t, luz });
  M.pared.puertaVidrio('y', 7.0, 0, 0, { w: 1.0 });
  M.pared.puerta('y', 8.1, 0, 0, { abierta: true, w: .8 });
  M.alfombra(2.2, 2.0, 6.2, 4.6, { color: '#5b7fc0' });
  M.alfombra(7.0, 2.0, 10.0, 4.6, { color: '#9c7bc0' });
  M.alfombra(2.2, 5.6, 5.4, 8.6, { color: '#5ea06a' });
  M.felpudo(7.6, .4, {});
  M.felpudo(.4, 7.2, { mira: '+x' });
  const objs = [
    [2.5, 2.4, () => M.planta(2.5, 2.4, { tipo: 'chica' })],
    [3.2, 2.3, () => M.planta(3.2, 2.3, { tipo: 'mediana' })],
    [4.1, 2.2, () => M.planta(4.1, 2.2, { tipo: 'alta' })],
    [5.1, 2.2, () => M.lamparaPie(5.1, 2.2, { luz })],
    [7.4, 2.4, () => M.tvPie(7.4, 2.4, { mira: '+y', t, luz })],
    [8.8, 2.4, () => M.tvPie(8.8, 2.4, { mira: '+x', t, luz })],
    [3.0, 3.6, () => M.lamparaColgante(3.0, 3.6, { luz, zTecho: 34 })],
    [4.5, 3.6, () => M.lamparaColgante(4.5, 3.6, { luz: 1, zTecho: 34 })],
    [7.5, 3.6, () => M.mesaRatona(7.5, 3.6, {})],
    [2.6, 6.0, () => M.planta(2.6, 6.0, { tipo: 'alta', maceta: '#c7744a' })],
    [3.6, 6.1, () => M.planta(3.6, 6.1, { tipo: 'mediana', maceta: '#3a3c46' })],
    [4.4, 6.2, () => M.planta(4.4, 6.2, { tipo: 'chica', maceta: '#f2efe9' })],
    [6.0, 6.0, () => refs(N).f(6.0, 6.0)],
    [8.0, 6.0, () => M.lamparaPie(8.0, 6.0, { luz: 1 })],
    [9.0, 6.0, () => M.sillon1(9.0, 6.0, { mira: '-x', color: '#6c8ebf' })],
  ];
  objs.sort((a, b) => a[0] + a[1] - b[0] - b[1]).forEach(o => o[2]());
}

/* lámina 4: las cuatro direcciones de los objetos con frente que no entraron completos arriba */
function PREVIEW_MU4(g, N, t) {
  const luz = +(globalThis.LUZ || 0), cuatro = (n, o) => DIRS.map(m => item(n, { ...(o || {}), mira: m, t, luz }));
  catalogo(g, N, 0, 0, [
    cuatro('escritorioL').concat(cuatro('heladera')),
    cuatro('mostrador').concat(cuatro('expendedora')),
    cuatro('mesada', { w: 1.2 }).concat(cuatro('dispensador'), cuatro('archivero')),
    cuatro('muebleBajo').concat(cuatro('tvPie'), cuatro('sillon1', { color: '#4fa08a' })),
    cuatro('impresora').concat(cuatro('mesaRatona'), cuatro('notebook', { z: 0, estado: 'herramienta' })),
    cuatro('cafetera', { z: 0 }).concat(cuatro('microondas', { z: 0 }), cuatro('tecladoMouse', { z: 0 }), cuatro('papeles', { z: 0 }), cuatro('felpudo')),
  ]);
}
