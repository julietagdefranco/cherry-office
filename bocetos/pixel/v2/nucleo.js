/* Núcleo de dibujo pixel de la oficina. Todo se pinta con fillRect, sin antialias.
   Mundo isométrico: x crece hacia abajo-derecha, y hacia abajo-izquierda.
   Una baldosa mide 24·S × 12·S px. Las alturas (z, h) van en "unidades" que se multiplican por S. */
(function (root) {
  const N = {};
  N.S = 2.5; N.OX = 0; N.OY = 0; N.g = null;
  const R = N.R = Math.round;
  N.iso = (x, y) => [N.OX + (x - y) * 12 * N.S, N.OY + (x + y) * 6 * N.S];
  N.up = (p, h) => [p[0], p[1] - h * N.S];
  N.rect = (x, y, w, h, c) => { N.g.fillStyle = c; N.g.fillRect(R(x), R(y), w, h); };
  N.px = (x, y, c) => { N.g.fillStyle = c; N.g.fillRect(R(x), R(y), 1, 1); };
  N.poly = (pts, c) => {
    const g = N.g; g.fillStyle = c; let a = Infinity, b = -Infinity;
    for (const p of pts) { a = Math.min(a, p[1]); b = Math.max(b, p[1]); }
    for (let y = Math.floor(a); y < Math.ceil(b); y++) {
      const yc = y + .5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        if ((p[1] <= yc && q[1] > yc) || (q[1] <= yc && p[1] > yc)) xs.push(p[0] + (yc - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
      }
      xs.sort((m, n) => m - n);
      for (let i = 0; i + 1 < xs.length; i += 2) { const x0 = R(xs[i]), x1 = R(xs[i + 1]); if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1); }
    }
  };
  N.line = (x0, y0, x1, y1, c) => {
    x0 = R(x0); y0 = R(y0); x1 = R(x1); y1 = R(y1); N.g.fillStyle = c;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
    for (let n = 0; n < 2000; n++) { N.g.fillRect(x0, y0, 1, 1); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  };
  N.L = (p, q, c) => N.line(p[0], p[1], q[0], q[1], c);
  /* rombo de piso entre (x0,y0) y (x1,y1), a altura z */
  N.quad = (x0, y0, x1, y1, c, z = 0) => N.poly([N.up(N.iso(x0, y0), z), N.up(N.iso(x1, y0), z), N.up(N.iso(x1, y1), z), N.up(N.iso(x0, y1), z)], c);
  /* caja: planta (x,y,w,d) en baldosas, base z y alto h en unidades.
     c = {t: tapa, l: cara de adelante-izquierda (y+d, la más clara), r: cara de adelante-derecha (x+w, la oscura), o: contorno opcional, hi: brillo del borde de la tapa opcional} */
  N.box = (x, y, w, d, z, h, c) => {
    const { iso, up, poly, L } = N, a = iso(x, y), b = iso(x + w, y), C = iso(x + w, y + d), D = iso(x, y + d);
    const T = [up(a, z + h), up(b, z + h), up(C, z + h), up(D, z + h)];
    poly([up(D, z), up(C, z), T[2], T[3]], c.l); poly([up(C, z), up(b, z), T[1], T[2]], c.r); poly(T, c.t);
    if (c.o) { L(T[0], T[1], c.o); L(T[0], T[3], c.o); L(T[1], up(b, z), c.o); L(T[3], up(D, z), c.o); L(up(D, z), up(C, z), c.o); L(up(C, z), up(b, z), c.o); L(T[2], up(C, z), c.o); }
    if (c.hi) { L(T[3], T[2], c.hi); L(T[2], T[1], c.hi); }
    return { a, b, C, D, T };
  };
  /* cara vertical plana sobre una pared o costado: a lo largo de x (en y fija) o de y (en x fija) */
  N.panelX = (x0, x1, y, z0, z1, c) => N.poly([N.up(N.iso(x0, y), z0), N.up(N.iso(x1, y), z0), N.up(N.iso(x1, y), z1), N.up(N.iso(x0, y), z1)], c);
  N.panelY = (y0, y1, x, z0, z1, c) => N.poly([N.up(N.iso(x, y0), z0), N.up(N.iso(x, y1), z0), N.up(N.iso(x, y1), z1), N.up(N.iso(x, y0), z1)], c);
  N.disc = (cx, cy, r, c) => { N.g.fillStyle = c; for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * .8) N.g.fillRect(R(cx) + x, R(cy) + y, 1, 1); };
  /* elipse achatada (plato, maceta vista de arriba) */
  N.ellipse = (cx, cy, rx, ry, c) => { N.g.fillStyle = c; for (let y = -ry; y <= ry; y++) { const w = R(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + .01)))); N.g.fillRect(R(cx) - w, R(cy) + y, w * 2 + 1, 1); } };
  N.dith = (cx, cy, rx, ry, c, al) => {
    const g = N.g, a0 = g.globalAlpha; g.globalAlpha = al; g.fillStyle = c; cx = R(cx); cy = R(cy);
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) { const d = (x * x) / (rx * rx) + (y * y) / (ry * ry); if (d <= 1 && (d < .72 || ((x + y) & 1) === 0)) g.fillRect(cx + x, cy + y, 1, 1); }
    g.globalAlpha = a0;
  };
  N.alpha = (a, fn) => { const a0 = N.g.globalAlpha; N.g.globalAlpha = a; fn(); N.g.globalAlpha = a0; };
  N.shade = (h, k) => {
    const n = parseInt(h.slice(1, 7), 16); const r = n >> 16, gg = n >> 8 & 255, b = n & 255;
    const f = v => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))));
    return '#' + [f(r), f(gg), f(b)].map(v => v.toString(16).padStart(2, '0')).join('');
  };
  /* tres tonos de un color para cajas: tapa clara, frente medio, costado oscuro */
  N.tonos = (h, o) => ({ t: N.shade(h, 1.12), l: h, r: N.shade(h, .78), o });
  N.rng = s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  N.OUT = '#2a1f2e';
  root.N = N;
})(typeof window !== 'undefined' ? window : globalThis);
