/* Personajes pixel de la oficina (v2). Sin cara, proporción realista, por capas recoloreables.
   drawChar(g, ax, ay, c, pose, sit, flip, t, state)
   - Solo usa g.fillStyle + g.fillRect con enteros.
   - Ancla parado: punto del piso entre los pies (abajo al centro). Sentado: punto del asiento bajo la cadera.
   - pose 'se' = de frente en diagonal (mira abajo-derecha), 'ne' = de espalda (mira arriba-derecha). flip espeja.
   - Luz desde arriba a la izquierda. Sin contorno negro: los bordes son el tono oscuro del mismo color.
   Se dibuja primero en una grilla local (x de -24 a 23, y de -56 a 23 respecto del ancla) y después se vuelca
   por tramos horizontales, así espejar es gratis. */
(function (root) {
  const BW = 48, BH = 80, BX = 24, BY = 56;
  let buf = null, OX = 0, OY = 0;
  const shade = (h, k) => {
    const n = parseInt(h.slice(1, 7), 16), r = n >> 16, g = n >> 8 & 255, b = n & 255;
    const f = v => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))));
    return '#' + [f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('');
  };
  // tres o cuatro tonos de un color: L claro (lado de la luz), M base, D sombra, X sombra fuerte
  const T3 = h => ({ L: shade(h, 1.22), M: h, D: shade(h, .76), X: shade(h, .58) });
  const P = (x, y, c) => { x += OX; y += OY; const i = x + BX, j = y + BY; if (c && i >= 0 && i < BW && j >= 0 && j < BH) buf[j * BW + i] = c; };
  const R = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) P(x + i, y + j, c); };
  // mapa ASCII: columna 0 = x -7. Las letras de "atrás" solo se pintan en la capa de atrás.
  const BACK = 'BN';
  const MAP = (m, pal, capa) => {
    const y0 = m[0];
    for (let j = 1; j < m.length; j++) { const s = m[j]; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === '.' || ch === ' ') continue; const atras = BACK.includes(ch); if ((capa === 'atras') !== atras) continue; P(i - 7, y0 + j - 1, pal[ch]); } }
  };

  /* ---------------- cabezas y peinados ---------------- */
  const CAB = {
    se: [-42,
      '....wwssss....',
      '...wssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '....ssssssk...',
      '......sssk....',
      '......kkk.....'],
    ne: [-42,
      '....ssssss....',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...sssssssk...',
      '...kkkkkkkk...',
      '....kkkkkk....',
      '......kkk.....',
      '......kkk.....'],
  };
  const PELO = {
    se: {
      corto: [-43,
        '.....hLLh.....',
        '...hhLLLLhh...',
        '..dhhhhhhhhh..',
        '..dhhhhhhd.h..',
        '..dhhk........',
        '..ddhs........',
        '...ddk........',
        '...x..........'],
      peinado: [-43,
        '....hLLLhh....',
        '...hLLLhhhhh..',
        '..dhhhhhhhhd..',
        '..dhhhhhhhd...',
        '..dhhk........',
        '..ddhs........',
        '...ddk........',
        '...x..........'],
      alto: [-46,
        '......h.......',
        '.....hL.h.....',
        '....hLLhhh....',
        '...hLLLhhhh...',
        '...hLLhhhhhh..',
        '..dhhhhhhhhd..',
        '..dhhhhhd.h...',
        '..dhhk........',
        '..ddhs........',
        '...ddk........'],
      bob: [-43,
        '....hhLLhh....',
        '...hLLLLhhhh..',
        '..hLhhhhhhhhd.',
        '..hhhhhhhhhhd.',
        '..hhhh....hhd.',
        '..hhhh.....hd.',
        '..hhhh.....hd.',
        '..dhhh.....hd.',
        '..dddh.....dd.',
        '...dd.........'],
      largo: [-43,
        '....hhLLhh....',
        '...hLLLLhhhh..',
        '..hLhhhhhhhhd.',
        '..hhhhhhhhhd..',
        '.hhhhh.....hd.',
        '.hhhhh.....hd.',
        '.hhhhh.....hd.',
        '.hhhhd.....hd.',
        '.hhhhd.....hd.',
        '.hhhdN.....hd.',
        '.hhhdN......d.',
        '.Nhhd.........',
        '.Nhdd.........',
        '.Ndd..........',
        '..N...........'],
      coletas: [-43,
        '.....hLLh.....',
        '...hhLLLLhh...',
        '..dhhhhhhhhh..',
        '..dhhhhhhh.h..',
        '.tdhhk.....t..',
        'hhdhhs.....hd.',
        'hLddhk.....hd.',
        'hhh.d......dd.',
        'hhd.........d.',
        'dh............',
        '.d............'],
      cola: [-43,
        '.....hLLh.....',
        '...hhLLLLhh...',
        '..dhhhhhhhh...',
        '.tdhhhhhhh....',
        'hhdhhk........',
        'hLd.hs........',
        'hhd..k........',
        'hd............',
        'hd............',
        'dd............',
        '.d............'],
      rodete: [-46,
        '...hLLh.......',
        '..hLhhhd......',
        '..dhhhdd......',
        '...ttLLhh.....',
        '...hLLLLhhh...',
        '..dhhhhhhhhh..',
        '..dhhhhhhh....',
        '..dhhk........',
        '..ddhs........',
        '...ddk........'],
      pelado: [-42,
        '....wwwsss....',
        '...wwssssss...',
        '...wsssssss...',
        '...h..........',
        '...dk.........',
        '...ds.........',
        '...dk.........'],
    },
    ne: {
      corto: [-43,
        '.....hLLh.....',
        '...hLLLhhh....',
        '..hLhhhhhhd...',
        '..hhhhhhhhd...',
        '..hhhhhhhdk...',
        '..dhhhhhhsk...',
        '..dhhhhhdkk...',
        '...ddddd......'],
      peinado: [-43,
        '....hLLLh.....',
        '...hLLhhhhd...',
        '..hLhhhhhhhd..',
        '..hhhhhhhhd...',
        '..hhhhhhhdk...',
        '..dhhhhhhsk...',
        '..ddhhhhdkk...',
        '...xdddd......'],
      alto: [-46,
        '.....h........',
        '....hLh.h.....',
        '....hLLhhh....',
        '...hLLLhhhh...',
        '...hLLhhhhh...',
        '..hLhhhhhhd...',
        '..hhhhhhhhd...',
        '..hhhhhhhdk...',
        '..dhhhhhhsk...',
        '..dhhhhhdkk...',
        '...ddddd......'],
      bob: [-43,
        '....hhLLh.....',
        '...hLLLhhhh...',
        '..hLhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhd...',
        '..dhhhhhhhd...',
        '...dddddddd...'],
      largo: [-43,
        '....hhLLh.....',
        '...hLLLhhhh...',
        '..hLhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhhd..',
        '..hhhhhhhhd...',
        '..hhhhhhhhd...',
        '..hhhhhhhhd...',
        '..dhhhhhhhd...',
        '...dhhhhhd....',
        '....ddddd.....'],
      coletas: [-43,
        '.....hLLh.....',
        '...hLLLhhh....',
        '..hLhhhhhhd...',
        '..hhhhhhhhd...',
        '.thhhhhhhdkt..',
        'hhdhhhhhhskhd.',
        'hLdhhhhhdkkhd.',
        'hh.ddddd...dd.',
        'hd..........d.',
        'dh............',
        '.d............'],
      cola: [-43,
        '.....hLLh.....',
        '...hLLLhhh....',
        '..hLhhhhhhd...',
        '..hhhhhhhhd...',
        '..hhhhhhhdk...',
        '..dhhhhhhsk...',
        '..dhhhhhdkk...',
        '...ddhhd......',
        '.....hd.......',
        '.....hd.......',
        '.....dd.......',
        '......d.......'],
      rodete: [-46,
        '.....hLLh.....',
        '....hLhhhd....',
        '....dhhhdd....',
        '.....tttt.....',
        '...hLLLhhh....',
        '..hLhhhhhhd...',
        '..hhhhhhhhd...',
        '..hhhhhhhdk...',
        '..dhhhhhhsk...',
        '..dhhhhhdkk...',
        '...ddddd......'],
      pelado: [-42,
        '....wwsss.....',
        '...wwssssss...',
        '...wsssssss...',
        '..........k...',
        '.........sk...',
        '.........kk...'],
    },
  };

  /* ---------------- brazos ----------------
     Un brazo es una polilínea gruesa (2 px): hombro S, codo E, muñeca W, punta de la mano H.
     Unidades a lo largo del brazo: brazo 0..6, antebrazo 6..9.5, mano 9.5..11. */
  function brazo(pts, cfg, lejos) {
    const U = [0, 6, 9.5, 11];
    for (let s = 0; s < 3; s++) {
      const [x0, y0] = pts[s], [x1, y1] = pts[s + 1], n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      const hor = Math.abs(x1 - x0) > Math.abs(y1 - y0);
      for (let i = (s ? 1 : 0); i <= n; i++) {
        const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
        const u = U[s] + (U[s + 1] - U[s]) * i / n;
        let T = u < cfg.manga - 1 ? cfg.tela : u < cfg.manga ? cfg.puno : cfg.piel;
        if (cfg.reloj && u >= 9 && u < 9.5) T = cfg.reloj;
        const a = lejos ? T.D : T.M, b = lejos ? T.X : T.D;
        if (hor) { P(x, y, a); P(x + 1, y, a); P(x, y + 1, b); P(x + 1, y + 1, b); }
        else { P(x, y, a); P(x, y + 1, a); P(x + 1, y, b); P(x + 1, y + 1, b); }
        if (s === 2 && i === n) { // nudillos
          const k = lejos ? cfg.piel.X : cfg.piel.D;
          if (hor) P(x1 > x0 ? x + 1 : x, y + 1, k); else P(x + 1, y1 > y0 ? y + 1 : y, k);
        }
      }
    }
  }

  // caminata: 6 cuadros. dx del pie (hacia adelante +), levantado, y sube/baja del cuerpo
  const PASO = { dx: [2, 1, 0, -2, -1, 1], kn: [1, 1, 0, -1, 1, 2], up: [0, 0, 0, 1, 2, 1], bob: [0, 0, -1, 0, 0, -1] };

  function drawChar(g, ax, ay, c, pose, sit, flip, t, state) {
    buf = new Array(BW * BH).fill(null); OX = 0; OY = 0;
    t = t | 0;
    const back = pose === 'ne';
    const SENT = ['tipear', 'pensar', 'error', 'dormir'];
    if (back && state === 'pensar') state = 'tipear';
    if (sit && !SENT.includes(state)) state = 'reposo';
    if (!sit && SENT.includes(state)) state = 'quieto';
    if (!sit && !['quieto', 'caminar', 'hablar', 'tablet'].includes(state)) state = 'quieto';

    const top = c.top || { t: 'remera', c: '#888888' }, leg = c.leg || { t: 'pantalon', c: '#555555' };
    const tt = top.t, lt = leg.t;
    const sk = T3(c.skc), hc = T3(c.hcc), tc = T3(top.c), inn = T3(top.in || '#f2f2f2');
    const lc = T3(leg.c || top.c), sh = T3((c.shoe && c.shoe.c) || '#2a2a30');
    const sole = (c.shoe && c.shoe.sole) || shade(sh.M, .6), soleD = shade(sole, .8);
    const sock = T3('#f0f0f2'), tie = top.tie ? T3(top.tie) : null;
    const cinto = T3(shade(sh.M, .8));
    const pal = { L: hc.L, h: hc.M, d: hc.D, x: hc.X, B: hc.M, N: hc.D, s: sk.M, k: sk.D, w: sk.L, t: c.band || '#d8505e' };

    const vestido = tt === 'vestido';
    const pantalon = (lt === 'pantalon' || lt === 'short') && !vestido;
    const metida = ['polo', 'camisa'].includes(tt) && pantalon; // remera metida en el pantalón con cinto
    const largaManga = ['camisa', 'campera', 'traje', 'buzo'].includes(tt);
    const manga = largaManga ? 9.5 : tt === 'musculosa' ? 0 : tt === 'vestido' ? 2 : 4;
    const telaManga = tt === 'jardinero' ? inn : tc;
    const puno = tt === 'traje' ? inn : tt === 'camisa' ? tc : (tt === 'buzo' || tt === 'campera') ? { M: tc.D, D: tc.X, X: tc.X, L: tc.M } : { M: telaManga.D, D: telaManga.X, X: telaManga.X };
    const cfgB = { tela: telaManga, puno, piel: sk, manga, reloj: null };
    const relojT = { M: '#2c2c34', D: '#1c1c22', X: '#1c1c22' };

    /* --- animación --- */
    const caminar = state === 'caminar' && !sit;
    const f = ((t % 6) + 6) % 6;
    const bob = caminar ? PASO.bob[f] : 0;
    let resp = 0, cabX = 0, cabY = 0, sacX = 0;
    if (state === 'quieto' || state === 'reposo' || state === 'tablet') resp = Math.floor(t / 6) % 2;
    if (state === 'dormir') { const k = [0, 1, 2, 1][Math.floor(t / 8) % 4]; cabY = k; cabX = k === 2 ? 1 : 0; }
    if (state === 'error') sacX = [0, 1, 0, -1][t % 4];
    if (state === 'tipear' || state === 'hablar') resp = 0;
    cabY += resp;

    const UY = sit ? 17 : bob; // desplazamiento del cuerpo de arriba

    /* --- brazos según estado --- */
    const near = back ? 5 : -7, farX = back ? -7 : 5; // columna izquierda de cada brazo colgando
    let A; // {n:[S,E,W,H], f:[...], on:'b'|'f'|'h', of:...}
    const colg = (x, sw) => [[x, -31], [x + Math.round(sw / 3), -26], [x + Math.round(sw * .7), -22], [x + sw, -20]];
    if (state === 'caminar') {
      const dN = PASO.dx[(f + 3) % 6], dF = PASO.dx[f]; // contrabalanceo: brazo cercano con la pierna lejana
      A = { n: colg(near, dN), f: colg(farX, dF), on: 'f', of: 'b' };
    } else if (!back) {
      const tk = t % 2;
      switch (state) {
        case 'tipear': A = { n: [[-7, -31], [-7, -25], [0, -24 - tk], [2, -24 - tk]], f: [[5, -31], [5, -25], [8, -25 + tk], [10, -25 + tk]], on: 'f', of: 'f' }; break;
        case 'dormir': A = { n: [[-7, -31], [-7, -25], [0, -25], [2, -25]], f: [[5, -31], [5, -25], [8, -26], [10, -26]], on: 'f', of: 'f' }; break;
        case 'reposo': A = { n: [[-7, -31], [-7, -25], [-2, -22], [0, -22]], f: [[5, -31], [5, -25], [7, -22], [8, -21]], on: 'f', of: 'f' }; break;
        case 'pensar': A = { n: [[-7, -31], [-7, -25], [0, -24], [2, -24]], f: [[5, -31], [6, -25], [4, -31], [3, -33]], on: 'f', of: 'h' }; break;
        case 'error': A = { n: [[-7, -31], [-9, -34], [-7, -38], [-5, -40]], f: [[5, -31], [7, -34], [6, -38], [4, -40]], on: 'h', of: 'h' }; break;
        case 'hablar': {
          const p = Math.floor(t / 3) % 4, a = [0, -1, -2, -1][p], b = [-1, 0, 1, 0][p];
          A = { n: [[-7, -31], [-7, -25], [-2, -27 + a], [0, -28 + a]], f: [[5, -31], [6, -25], [9, -28 + b], [10, -30 + b]], on: 'f', of: 'f' }; break;
        }
        case 'tablet': {
          const tap = Math.floor(t / 4) % 3 === 0 ? -1 : 0;
          A = { n: [[-7, -31], [-7, -25], [-2, -25 + tap], [0, -26 + tap]], f: [[5, -31], [5, -25], [4, -26], [3, -27]], on: 'f', of: 'b' }; break;
        }
        default: A = { n: colg(near, 0), f: colg(farX, 0), on: 'f', of: 'b' };
      }
    } else {
      const tk = t % 2;
      switch (state) {
        case 'tipear': A = { n: [[5, -31], [6, -25], [7, -26 - tk], [8, -26 - tk]], f: [[-7, -31], [-7, -25], [-4, -26 + tk], [-3, -27 + tk]], on: 'f', of: 'b' }; break;
        case 'dormir': A = { n: [[5, -31], [6, -25], [7, -26], [8, -26]], f: [[-7, -31], [-7, -25], [-4, -26], [-3, -27]], on: 'f', of: 'b' }; break;
        case 'reposo': A = { n: [[5, -31], [5, -25], [6, -22], [7, -21]], f: [[-7, -31], [-7, -25], [-5, -22], [-4, -21]], on: 'f', of: 'b' }; break;
        case 'error': A = { n: [[5, -31], [7, -34], [6, -38], [4, -40]], f: [[-7, -31], [-9, -34], [-7, -38], [-5, -40]], on: 'h', of: 'h' }; break;
        case 'hablar': {
          const p = Math.floor(t / 3) % 4, b = [-1, 0, 1, 0][p];
          A = { n: [[5, -31], [6, -25], [9, -28 + b], [10, -30 + b]], f: [[-7, -31], [-7, -25], [-4, -26], [-3, -27]], on: 'f', of: 'b' }; break;
        }
        case 'tablet': A = { n: [[5, -31], [5, -25], [5, -27], [4, -28]], f: [[-7, -31], [-7, -25], [-4, -26], [-3, -27]], on: 'f', of: 'b' }; break;
        default: A = { n: colg(near, 0), f: colg(farX, 0), on: 'f', of: 'b' };
      }
    }
    const reloj = c.watch ? relojT : null;
    const dibBrazo = (cual, capa) => {
      if (cual === 'n' && A.on !== capa) return; if (cual === 'f' && A.of !== capa) return;
      OX = sacX; OY = UY;
      brazo(A[cual], Object.assign({}, cfgB, { reloj: cual === 'n' ? reloj : null }), cual === 'f');
      OX = 0; OY = 0;
    };

    /* ================= PIERNAS ================= */
    const hipY = -21 + bob;
    const tonoPierna = (y, yHip) => {
      if (vestido || lt === 'nada' || lt === 'pollera') return sk;
      if (lt === 'short') return y <= yHip + 6 ? lc : sk;
      return lc;
    };
    function pierna(x0, dx, kn, lift, dyp, lejos, izq) {
      const pie = -3 - lift + dyp + (lejos ? -1 : 0); // primera fila del zapato
      const ank = pie - 1, y0 = hipY + 2, yk = y0 + 7; // rodilla
      for (let y = y0; y <= ank; y++) {
        const xo = y <= yk ? Math.round(kn * (y - y0) / 7) : Math.round(kn + (dx - kn) * (y - yk) / Math.max(1, ank - yk));
        const abajo = y > hipY + 9;
        let x = x0 + xo, w = 4;
        if (abajo) { w = 3; if (izq) { } else x += 1; }
        const T = tonoPierna(y, hipY);
        let a = lejos ? T.D : T.M, l = lejos ? T.M : T.L, d = lejos ? T.X : T.D;
        if (c.sock && T === sk && y >= ank - 1) { a = lejos ? sock.D : sock.M; l = a; d = lejos ? sock.X : sock.D; }
        R(x, y, w, 1, a); P(x, y, l); P(x + w - 1, y, d);
        if (lt === 'short' && T === lc && y === hipY + 6) R(x, y, w, 1, lc.D);
        if (lt === 'pantalon' && !vestido && y === ank) R(x, y, w, 1, lejos ? lc.X : lc.D);
        if (T === sk && y === hipY + 9 && !lejos) P(x + 1, y, sk.L); // rodilla
      }
      // zapato (la punta mira a la derecha)
      const xs = x0 + dx + (izq ? 0 : 1), S = lejos ? { L: sh.M, M: sh.D, D: sh.X } : sh;
      if (!back) {
        R(xs, pie, 3, 1, S.M); P(xs, pie, S.L);
        R(xs, pie + 1, 5, 1, S.M); P(xs + 4, pie + 1, S.L); P(xs, pie + 1, S.D);
        R(xs, pie + 2, 5, 1, lejos ? soleD : sole);
      } else {
        R(xs, pie, 3, 1, S.M); P(xs + 2, pie, S.D);
        R(xs, pie + 1, 4, 1, S.M); P(xs, pie + 1, S.L); P(xs + 3, pie + 1, S.D);
        R(xs, pie + 2, 4, 1, lejos ? soleD : sole); P(xs + 3, pie + 2, soleD);
      }
    }

    function piernasParado() {
      // pierna cercana: izquierda en se, derecha en ne
      const fb = (f + 3) % 6, Q = (k, i) => caminar ? PASO[k][i] : 0;
      const per = d => (back ? -1 : 1) * Math.sign(d) * Math.floor(Math.abs(d) / 2);
      if (!back) { pierna(0, Q('dx', fb), Q('kn', fb), Q('up', fb), per(Q('dx', fb)), true, false); pierna(-4, Q('dx', f), Q('kn', f), Q('up', f), per(Q('dx', f)), false, true); }
      else { pierna(-4, Q('dx', fb), Q('kn', fb), Q('up', fb), per(Q('dx', fb)), true, true); pierna(0, Q('dx', f), Q('kn', f), Q('up', f), per(Q('dx', f)), false, false); }
      // cadera
      if (pantalon) {
        R(-4, hipY, 8, 3, lc.M); P(-4, hipY, lc.L); P(-4, hipY + 1, lc.L); R(3, hipY, 1, 3, lc.D);
        P(-1, hipY + 2, lc.D); P(0, hipY + 2, lc.D);
        if (back) { P(-3, hipY + 1, lc.D); P(-2, hipY + 1, lc.D); P(1, hipY + 1, lc.D); P(2, hipY + 1, lc.D); }
        else { P(-1, hipY + 1, lc.D); }
      } else if (lt !== 'pollera' && !vestido) {
        R(-4, hipY, 8, 3, sk.M); R(3, hipY, 1, 3, sk.D);
      }
      if (metida || (tt === 'traje' && pantalon && false)) cinturon(hipY);
      if (lt === 'pollera' || vestido) pollera(hipY, vestido ? tc : lc);
    }
    function cinturon(y) {
      R(-5, y, 10, 1, cinto.M); P(4, y, cinto.D);
      if (!back) { P(0, y, '#e2c46a'); P(1, y, '#b8963e'); } else { P(-3, y, cinto.D); P(2, y, cinto.D); }
    }
    function pollera(y0, T) {
      const H = sit ? 0 : 9;
      for (let j = 0; j < H; j++) {
        const e = Math.floor(j / 3), x = -5 - e, w = 10 + 2 * e, y = y0 + j;
        R(x, y, w, 1, T.M); P(x, y, T.L); P(x + w - 1, y, T.D); P(x + w - 2, y, T.D);
        if (j > 3) { P(-2 - (j > 6 ? 1 : 0), y, T.D); P(2 + (j > 6 ? 1 : 0), y, T.D); }
        if (j === H - 1) { R(x, y, w, 1, T.D); P(x, y, T.M); }
      }
    }

    function piernasSentado() {
      const lapT = vestido ? tc : lt === 'pollera' ? lc : (lt === 'nada' ? sk : lc);
      const canT = (pantalon && lt === 'pantalon') ? lc : sk;
      if (back) {
        // de espalda: la silla tapa casi todo; asoman la cadera y el muslo cercano
        R(-4, -4, 8, 3, lapT.M); R(3, -4, 1, 3, lapT.D); P(-4, -4, lapT.L);
        if (pantalon) { P(-3, -3, lapT.D); P(-2, -3, lapT.D); P(1, -3, lapT.D); P(2, -3, lapT.D); }
        R(4, -4, 2, 2, lapT.D); R(4, -2, 2, 1, lapT.X);
        if (metida) cinturon(-4);
        return;
      }
      // muslo lejano (derecha, un poco más arriba) y canilla lejana
      const shin = (x, y0, y1, lejos) => {
        for (let y = y0; y <= y1; y++) {
          let T = canT; if (lt === 'short') T = sk;
          let a = lejos ? T.D : T.M, l = lejos ? T.M : T.L, d = lejos ? T.X : T.D;
          if (c.sock && T === sk && y >= y1 - 1) { a = lejos ? sock.D : sock.M; l = a; d = lejos ? sock.X : sock.D; }
          if (T === lc && y === y1) { a = l = d = lejos ? lc.X : lc.D; }
          R(x, y, 3, 1, a); P(x, y, l); P(x + 2, y, d);
        }
      };
      const zap = (x, y, lejos) => {
        const S = lejos ? { L: sh.M, M: sh.D, D: sh.X } : sh;
        R(x, y, 3, 1, S.M); P(x, y, S.L); R(x, y + 1, 5, 1, S.M); P(x + 4, y + 1, S.L); R(x, y + 2, 5, 1, lejos ? soleD : sole);
      };
      shin(7, -2, 5, true); zap(7, 6, true);
      const muslo = (x0, x1, y, lejos) => {
        const T = lapT;
        R(x0, y, x1 - x0 + 1, 1, lejos ? T.M : T.L);
        R(x0, y + 1, x1 - x0 + 1, 1, lejos ? T.D : T.M);
        R(x0, y + 2, x1 - x0 + 1, 1, lejos ? T.X : T.D);
        P(x1 + 1, y + 1, lejos ? T.X : T.D);
      };
      muslo(-2, 8, -4, true);
      shin(4, -1, 6, false); zap(4, 7, false);
      muslo(-4, 6, -3, false);
      if (lt === 'short' && !vestido) { R(4, -3, 3, 3, sk.M); P(6, -1, sk.D); R(4, -3, 1, 3, lc.D); P(5, -3, sk.L); }
      if (lt === 'pollera' || vestido) { const T = lapT; R(4, -3, 2, 3, T.M); R(6, -3, 1, 3, T.D); R(4, -1, 3, 1, T.D); P(4, -3, T.L); }
      if (metida) cinturon(-4);
    }

    /* ================= TORSO ================= */
    function torso() {
      OX = sacX; OY = UY;
      const T = tt === 'jardinero' ? inn : tc;
      const bot = (tt === 'polo' || tt === 'camisa') && pantalon ? -22 : tt === 'traje' ? -19 : -20;
      for (let y = -32; y <= bot; y++) {
        const x = (y === -32 || y > -27) ? -4 : -5, w = y === -32 || y > -27 ? 8 : 10;
        R(x, y, w, 1, T.M); P(x, y, T.L); P(x + w - 1, y, T.D);
      }
      R(-4, bot, 8, 1, T.D); P(-4, bot, T.M);
      if (!back) torsoFrente(T, bot); else torsoEspalda(T, bot);
      OX = 0; OY = 0;
    }
    function corbata(x, y0, y1) {
      if (!tie) return;
      P(x, y0, tie.M); P(x + 1, y0, tie.D);
      for (let y = y0 + 1; y <= y1; y++) { P(x, y, tie.M); if (y > y0 + 2) P(x + 1, y, tie.D); }
      P(x, y0 + 1, tie.L);
    }
    function torsoFrente(T, bot) {
      const S = sk;
      switch (tt) {
        case 'remera':
          R(-1, -32, 2, 1, S.D); P(-2, -32, T.D); P(1, -32, T.D); R(-1, -31, 2, 1, T.D);
          P(-4, -27, T.D); break;
        case 'polo':
          R(-1, -32, 2, 1, S.D); P(-2, -32, T.L); P(-3, -32, T.L); P(1, -32, T.L); P(2, -32, T.L); P(-2, -31, T.L); P(1, -31, T.L);
          R(-1, -31, 2, 1, T.D); P(0, -30, T.D); P(0, -29, T.D); P(-1, -30, T.L); break;
        case 'camisa':
          R(-1, -32, 2, 1, S.D); P(-2, -32, T.L); P(1, -32, T.L); P(-2, -31, T.L); P(1, -31, T.L);
          for (let y = -30; y <= bot; y += 2) P(0, y, T.D);
          if (tie) corbata(-1, -31, -25); break;
        case 'traje': {
          // camisa en V con solapas
          const V = [[-32, -2, 4], [-31, -2, 4], [-30, -1, 2], [-29, -1, 2], [-28, -1, 2], [-27, 0, 1]];
          for (const [y, x, w] of V) R(x, y, w, 1, inn.M);
          R(-1, -32, 2, 1, S.D);
          P(-3, -32, T.L); P(-3, -31, T.L); P(-2, -30, T.L); P(-2, -29, T.L); P(-2, -28, T.L); P(-1, -27, T.L); P(-1, -26, T.L);
          P(2, -32, T.D); P(2, -31, T.D); P(1, -30, T.D); P(1, -29, T.D); P(1, -28, T.D); P(1, -27, T.X);
          if (tie) { P(-1, -31, tie.M); P(0, -31, tie.D); for (let y = -30; y <= -27; y++) P(0, y, y > -29 ? tie.D : tie.M); P(-1, -30, tie.L); }
          P(0, -25, T.X); P(0, -23, T.X);
          P(-4, -23, T.D); P(-3, -23, T.D); P(2, -23, T.X); P(3, -23, T.X);
          R(-5, -20, 10, 1, T.D); P(0, -20, T.X); P(0, -19, T.X); P(1, -19, T.X);
          break;
        }
        case 'campera':
          R(-2, -32, 4, 13, inn.M); R(-2, -32, 1, 13, inn.L); R(1, -32, 1, 13, inn.D);
          R(-1, -32, 2, 1, S.D);
          R(-3, -33, 1, 3, T.L); R(2, -33, 1, 3, T.D); R(-3, -30, 1, 11, T.M); R(2, -30, 1, 11, T.D);
          P(-4, -33, T.M); P(3, -33, T.D);
          R(-5, -21, 10, 2, T.D); R(-2, -21, 4, 2, inn.D);
          P(-4, -25, T.D); P(3, -25, T.X);
          break;
        case 'vestido':
          R(-2, -32, 4, 1, S.M); R(-1, -31, 2, 1, S.D); P(-2, -32, S.L);
          R(-5, -25, 10, 1, T.D); P(1, -25, T.L);
          break;
        case 'jardinero':
          R(-1, -32, 2, 1, S.D); P(-2, -32, T.D); P(1, -32, T.D);
          R(-4, -28, 8, 9, tc.M); P(-4, -28, tc.L); R(3, -28, 1, 9, tc.D);
          R(-4, -32, 1, 4, tc.M); R(2, -32, 1, 4, tc.D);
          P(-4, -28, '#e2c46a'); P(2, -28, '#e2c46a');
          R(-2, -26, 4, 1, tc.D); R(-2, -25, 1, 2, tc.D); R(1, -25, 1, 2, tc.D);
          R(-5, -20, 10, 1, tc.D);
          break;
        case 'musculosa':
          R(-4, -32, 2, 1, S.M); R(2, -32, 2, 1, S.D); R(-1, -32, 2, 3, S.M); P(-1, -30, S.D); P(0, -30, S.D);
          R(-5, -32, 1, 4, S.M); R(4, -32, 1, 4, S.D); P(-5, -32, null);
          break;
        case 'buzo':
          R(-3, -33, 6, 2, T.D); R(-2, -33, 4, 1, T.M); R(-1, -32, 2, 1, S.D); P(-1, -33, T.X); P(0, -33, T.X);
          R(-1, -31, 1, 3, T.L); R(1, -31, 1, 3, T.L); P(-1, -28, inn.L); P(1, -28, inn.L);
          R(-3, -25, 6, 1, T.D); P(-3, -24, T.D); P(2, -24, T.D); R(-2, -24, 4, 3, T.M);
          R(-5, -21, 10, 2, T.D); for (let x = -4; x < 5; x += 2) P(x, -21, T.X);
          break;
      }
    }
    function torsoEspalda(T, bot) {
      const S = sk;
      switch (tt) {
        case 'remera': R(-2, -32, 4, 1, T.D); break;
        case 'polo': R(-3, -32, 6, 1, T.L); R(-3, -31, 6, 1, T.D); break;
        case 'camisa': R(-2, -32, 4, 1, T.L); R(-4, -29, 8, 1, T.D); for (let y = -28; y <= bot; y++) P(-1, y, T.D); break;
        case 'traje':
          R(-2, -33, 4, 1, inn.M); R(-3, -32, 6, 1, T.L); for (let y = -30; y <= -19; y++) P(-1, y, T.D);
          R(-5, -20, 10, 1, T.D); P(-1, -20, T.X); P(-1, -19, T.X); P(0, -19, T.D); break;
        case 'campera': R(-3, -33, 6, 2, T.D); R(-3, -33, 6, 1, T.M); R(-5, -21, 10, 2, T.D); R(-4, -28, 8, 1, T.D); break;
        case 'vestido': R(-2, -32, 4, 1, S.D); R(-5, -25, 10, 1, T.D); for (let y = -31; y <= -26; y++) P(-1, y, T.D); break;
        case 'jardinero':
          R(-3, -32, 1, 6, tc.M); R(1, -32, 1, 6, tc.D); P(-2, -27, tc.M); P(0, -27, tc.D);
          R(-5, -25, 10, 6, tc.M); P(-5, -25, tc.L); R(4, -25, 1, 6, tc.D); R(-5, -20, 10, 1, tc.D);
          P(-2, -27, '#e2c46a'); P(0, -27, '#e2c46a'); break;
        case 'musculosa':
          R(-4, -32, 8, 1, S.M); R(2, -32, 2, 1, S.D); R(-2, -31, 4, 2, S.M); P(1, -30, S.D);
          R(-5, -32, 1, 4, S.M); R(4, -32, 1, 4, S.D); break;
        case 'buzo':
          R(-3, -33, 6, 6, T.D); R(-2, -33, 4, 1, T.M); R(-2, -32, 4, 3, T.X); P(-3, -27, T.M); P(2, -27, T.D); R(-2, -28, 4, 1, T.D);
          R(-5, -21, 10, 2, T.D); for (let x = -4; x < 5; x += 2) P(x, -21, T.X);
          break;
      }
    }

    /* ================= CABEZA ================= */
    function cabeza(capa) {
      OX = sacX + cabX; OY = UY + cabY;
      const estilo = PELO[pose][c.hair] ? c.hair : 'corto';
      if (capa === 'atras') { MAP(PELO[pose][estilo], pal, 'atras'); OX = 0; OY = 0; return; }
      MAP(CAB[pose], pal, 'frente');
      MAP(PELO[pose][estilo], pal, 'frente');
      if (c.band) { R(-5, -40, 9, 1, c.band); P(3, -40, shade(c.band, .76)); P(-5, -40, shade(c.band, .76)); if (estilo === 'pelado') R(-4, -40, 8, 1, c.band); }
      if (c.cap) {
        const K = T3(c.cap);
        R(-3, -44, 6, 1, K.M); R(-4, -43, 8, 2, K.M); R(-5, -41, 9, 1, K.M); P(-3, -44, K.L); R(-3, -43, 2, 1, K.L); R(3, -43, 1, 3, K.D);
        if (!back) { R(1, -40, 5, 1, K.D); P(5, -40, K.X); P(0, -44, K.D); }
        else { R(3, -41, 3, 1, K.D); P(-1, -44, K.D); }
      }
      if (c.glasses) {
        if (!back) { P(-1, -38, '#3a3a44'); P(0, -38, '#cfe6f0'); P(1, -38, '#3a3a44'); P(2, -38, '#a8cede'); P(3, -38, '#3a3a44'); }
        else { P(2, -38, '#2b2b33'); P(3, -38, '#2b2b33'); }
      }
      OX = 0; OY = 0;
    }

    function tablet() {
      if (state !== 'tablet') return;
      OX = 0; OY = UY;
      if (!back) {
        const fr = '#2a2c34', sc = '#5fc0e4', scL = '#a8e4f6';
        for (let j = 0; j < 5; j++) { const x = -3 + (j >> 1); R(x, -29 + j, 8, 1, fr); if (j > 0 && j < 4) { R(x + 1, -29 + j, 6, 1, sc); } }
        P(-1, -28, scL); P(0, -28, scL); P(2, -27, scL);
        P(1 + ((t >> 2) % 3), -26, '#ffffff');
      } else {
        R(4, -29, 4, 1, '#3a3d48'); R(4, -28, 4, 1, '#2a2c34'); P(7, -28, '#5fc0e4');
      }
      OX = 0; OY = 0;
    }

    /* ================= ORDEN DE PINTADO ================= */
    cabeza('atras');
    dibBrazo('f', 'b');
    if (sit) piernasSentado(); else piernasParado();
    torso();
    dibBrazo('n', 'b');
    if (!back) { dibBrazo('f', 'f'); tablet(); dibBrazo('n', 'f'); }
    else { tablet(); dibBrazo('f', 'f'); dibBrazo('n', 'f'); }
    cabeza('frente');
    dibBrazo('f', 'h'); dibBrazo('n', 'h');

    /* ================= VOLCADO ================= */
    for (let j = 0; j < BH; j++) {
      let i = 0;
      while (i < BW) {
        const col = buf[j * BW + i]; if (!col) { i++; continue; }
        let k = i + 1; while (k < BW && buf[j * BW + k] === col) k++;
        const x0 = i - BX, x1 = k - 1 - BX;
        g.fillStyle = col;
        g.fillRect(flip ? ax - 1 - x1 : ax + x0, ay + j - BY, k - i, 1);
        i = k;
      }
    }
  }
  drawChar.ALTO = 43;
  drawChar.ALTO_SENTADO = 26;
  drawChar.shade = shade;
  root.drawChar = drawChar;
})(typeof window !== 'undefined' ? window : globalThis);
