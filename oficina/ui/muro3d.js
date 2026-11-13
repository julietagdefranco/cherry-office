/* Muro de entregables (E3, docs/plan-entregables.md): tablero de corcho de ladrillos en la recepción, con las últimas
   entregas como hojas clavadas (chincheta roja = sin revisar) y un cartel arriba con cuántas faltan revisar.
   Lo arma App.Oficina3D en cada construir() (se carga después de oficina3d.js y se usa de forma perezosa).
   Una sola textura para el corcho y otra para el cartel: al actualizar se redibujan los canvas (sin mallas nuevas ni
   sombras recalculadas). El picking traduce el punto del rayo sobre el corcho a la hoja que hay ahí. */
window.App = window.App || {};
App.Muro3D = (function () {
  'use strict';
  var COLS = 4, FILAS = 2, MAX = COLS * FILAS;
  var ANCHO = 5.2, ALTO = 3.0, MARCO = 0.3;            // corcho visible y borde de madera (en studs)
  var CW = 1024, CH = Math.round(CW * ALTO / ANCHO);   // canvas del corcho
  var FUENTE = 'Poppins, "Helvetica Neue", Arial, sans-serif';

  /* geometría de la grilla de hojas en coordenadas del canvas */
  var PAD_X = 34, PAD_Y = 30, GAP_X = 26, GAP_Y = 30;
  var HW = (CW - 2 * PAD_X - (COLS - 1) * GAP_X) / COLS, HH = (CH - 2 * PAD_Y - (FILAS - 1) * GAP_Y) / FILAS;
  function rectHoja(i) {
    var c = i % COLS, f = Math.floor(i / COLS);
    return { x: PAD_X + c * (HW + GAP_X), y: PAD_Y + f * (HH + GAP_Y), w: HW, h: HH };
  }

  function construir(I) {
    var T = I.T, P = I.P, pl = I.plano;
    var g = new T.Group();
    /* lugar: parado en la recepción, a la izquierda del camino central (pasilloX), delante de la planta del fondo */
    var cx = 1 + ANCHO / 2 + MARCO + 0.2, cz = Math.min(6.5, Math.max(4, pl.D - 14));
    var y0 = I.PLACA, piso = 1.1;                      // el tablero arranca a 1.1 del piso, sobre dos patas
    g.position.set(cx, 0, cz);

    var madera = P.plastico(I.MADERA), gris = P.plastico(I.GRIS_OSCURO);
    /* patas: columnas 1x1 de madera sobre una placa 1x2 gris */
    [-ANCHO / 2 + 0.6, ANCHO / 2 - 0.6].forEach(function (x) {
      var base = new T.Mesh(I.geoBloque(1, 2, I.PLACA), gris); base.position.set(x, y0, 0.2); base.castShadow = true; g.add(base);
      var pata = new T.Mesh(I.geoBloque(1, 1, piso + 0.4), madera); pata.position.set(x, y0 + I.PLACA, 0.2); pata.castShadow = true; g.add(pata);
    });
    /* tablero: inclinado hacia atrás para que se lea desde la cámara de maqueta */
    var tab = new T.Group();
    tab.position.set(0, y0 + piso, 0);
    tab.rotation.x = -0.22;
    g.add(tab);
    /* geoBloque(w, d, h) crece en y desde 0; rotado -90° en x queda parado: y en [-d/2, d/2], z en [-h, 0] */
    var altoM = ALTO + 2 * MARCO;
    var marco = new T.Mesh(I.geoBloque(ANCHO + 2 * MARCO, altoM, 0.4), madera);
    marco.rotation.x = -Math.PI / 2; marco.position.set(0, altoM / 2, 0.4);         // frente en z = 0.4
    marco.castShadow = true; tab.add(marco);
    var cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
    var tex = new T.CanvasTexture(cv); if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
    var corcho = new T.Mesh(new T.PlaneGeometry(ANCHO, ALTO), new T.MeshBasicMaterial({ map: tex, toneMapped: false }));
    corcho.position.set(0, MARCO + ALTO / 2, 0.42); tab.add(corcho);
    /* cartel arriba: placa negra con el número sin revisar */
    var cartelW = 3.2, cartelH = 0.8;
    var yCartel = altoM + 0.25 + (cartelH + 0.2) / 2;
    var caja = new T.Mesh(I.geoBloque(cartelW + 0.2, cartelH + 0.2, 0.3), P.plastico(I.NEGRO));
    caja.rotation.x = -Math.PI / 2; caja.position.set(0, yCartel, 0.35); caja.castShadow = true; tab.add(caja);
    var cv2 = document.createElement('canvas'); cv2.width = 512; cv2.height = Math.round(512 * cartelH / cartelW);
    var tex2 = new T.CanvasTexture(cv2); if (T.sRGBEncoding) tex2.encoding = T.sRGBEncoding; tex2.anisotropy = 4;
    var cartel = new T.Mesh(new T.PlaneGeometry(cartelW, cartelH), new T.MeshBasicMaterial({ map: tex2, toneMapped: false }));
    cartel.position.set(0, yCartel, 0.37); tab.add(cartel);
    /* soportes del cartel */
    [-1, 1].forEach(function (s) {
      var m = new T.Mesh(I.geoBloque(0.4, 0.4, 0.5), madera); m.position.set(s * 1.1, altoM - 0.05, 0.2); tab.add(m);
    });

    g.updateMatrixWorld(true);
    var cajaMundo = new T.Box3().setFromObject(g);
    var estado = { entregas: [], n: 0, agentes: {} };

    function dibujar() {
      var x = cv.getContext('2d');
      /* corcho: base tostada con motas */
      x.fillStyle = '#c99a62'; x.fillRect(0, 0, CW, CH);
      var s = 7;
      for (var k = 0; k < 900; k++) {
        s = (s * 9301 + 49297) % 233280;
        var px = (s / 233280) * CW; s = (s * 9301 + 49297) % 233280;
        var py = (s / 233280) * CH;
        x.fillStyle = k % 3 ? 'rgba(120,80,40,0.22)' : 'rgba(240,210,160,0.25)';
        x.fillRect(px, py, 3, 3);
      }
      estado.entregas.slice(0, MAX).forEach(function (e, i) { hoja(x, e, rectHoja(i), i); });
      if (!estado.entregas.length) {
        x.fillStyle = 'rgba(60,40,20,0.55)'; x.font = '600 44px ' + FUENTE; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText('Todavía no hay entregas', CW / 2, CH / 2);
      }
      tex.needsUpdate = true;
      /* cartel */
      var y = cv2.getContext('2d'), w = cv2.width, h = cv2.height, n = estado.n;
      y.fillStyle = '#2a2b2e'; y.fillRect(0, 0, w, h);
      y.textAlign = 'center'; y.textBaseline = 'middle';
      if (n > 0) {
        y.fillStyle = '#f5cd2f'; y.font = '700 58px ' + FUENTE;
        y.fillText(n === 1 ? '1 sin revisar' : n + ' sin revisar', w / 2, h / 2 + 3);
      } else {
        y.fillStyle = '#5d6166'; y.font = '600 50px ' + FUENTE;      // apagado
        y.fillText('Todo revisado', w / 2, h / 2 + 3);
      }
      tex2.needsUpdate = true;
    }

    function hoja(x, e, r, i) {
      var sin = e.estado === 'sin_revisar', vieja = e.estado === 'cambios';
      var ag = estado.agentes[e.agente], color = ag ? ag.color : (e.origen === 'reunion' ? '#0a5fb4' : '#6b7078');
      x.save();
      x.translate(r.x + r.w / 2, r.y + r.h / 2);
      x.rotate(((i * 37) % 7 - 3) * 0.012);            // un poco torcidas, como clavadas a mano
      var w = r.w, h = r.h;
      x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(-w / 2 + 5, -h / 2 + 7, w, h);
      x.fillStyle = vieja ? '#d9d6cf' : sin ? '#fbfaf6' : '#ecebe4'; x.fillRect(-w / 2, -h / 2, w, h);
      /* franja de color del agente (o azul de reunión) con la inicial / ícono de acta */
      x.fillStyle = color; x.fillRect(-w / 2, -h / 2, w, 46);
      x.fillStyle = '#ffffff'; x.font = '700 30px ' + FUENTE; x.textAlign = 'left'; x.textBaseline = 'middle';
      if (e.origen === 'reunion' && !ag) {
        /* acta: hojita con renglones */
        x.fillRect(-w / 2 + 14, -h / 2 + 9, 22, 28);
        x.fillStyle = color; for (var l = 0; l < 3; l++) x.fillRect(-w / 2 + 18, -h / 2 + 15 + l * 7, 14, 3);
        x.fillStyle = '#ffffff'; x.fillText('Acta', -w / 2 + 46, -h / 2 + 24);
      } else {
        var nombre = ag ? ag.nombre : (e.agente || '?');
        x.beginPath(); x.arc(-w / 2 + 26, -h / 2 + 23, 15, 0, Math.PI * 2); x.fill();
        x.fillStyle = color; x.font = '700 20px ' + FUENTE; x.textAlign = 'center';
        x.fillText(nombre.charAt(0).toUpperCase(), -w / 2 + 26, -h / 2 + 24);
        x.fillStyle = '#ffffff'; x.font = '600 22px ' + FUENTE; x.textAlign = 'left';
        x.fillText(recortar(x, nombre, w - 70), -w / 2 + 48, -h / 2 + 24);
      }
      /* título en hasta 4 renglones */
      x.fillStyle = sin ? '#2a2b2e' : '#6b7078'; x.font = '600 25px ' + FUENTE; x.textAlign = 'left'; x.textBaseline = 'top';
      var lineas = renglones(x, (e.titulo || 'Entrega').replace(/^Acta:\s*/, ''), w - 26, 4);
      lineas.forEach(function (t, k) { x.fillText(t, -w / 2 + 13, -h / 2 + 58 + k * 30); });
      /* pie: estado */
      x.font = '500 19px ' + FUENTE; x.textBaseline = 'alphabetic';
      x.fillStyle = sin ? '#c91a09' : '#8d9296';
      x.fillText(sin ? 'Sin revisar' : vieja ? 'Con cambios pedidos' : 'Revisada ✓', -w / 2 + 13, h / 2 - 12);
      /* chincheta: roja si falta revisar, gris si no */
      x.beginPath(); x.arc(0, -h / 2 + 4, sin ? 13 : 9, 0, Math.PI * 2);
      x.fillStyle = sin ? '#c91a09' : '#a3a7aa'; x.fill();
      x.beginPath(); x.arc(-4, -h / 2, sin ? 4 : 3, 0, Math.PI * 2); x.fillStyle = 'rgba(255,255,255,0.6)'; x.fill();
      x.restore();
    }

    function recortar(x, t, max) {
      if (x.measureText(t).width <= max) return t;
      while (t.length > 1 && x.measureText(t + '…').width > max) t = t.slice(0, -1);
      return t + '…';
    }
    function renglones(x, t, max, n) {
      var pal = t.split(/\s+/), out = [], cur = '';
      for (var i = 0; i < pal.length; i++) {
        var p = cur ? cur + ' ' + pal[i] : pal[i];
        if (x.measureText(p).width <= max) { cur = p; continue; }
        if (cur) out.push(cur); cur = pal[i];
        if (out.length === n) break;
      }
      if (out.length < n && cur) out.push(cur);
      if (out.length > n) out.length = n;
      var usado = out.join(' ').split(/\s+/).length;
      if (usado < pal.length) out[out.length - 1] = recortar(x, out[out.length - 1] + '…', max).replace(/……$/, '…');
      return out.map(function (l) { return recortar(x, l, max); });
    }

    /* raycaster de oficina3d -> {tipo, id?, dist} | null */
    function pick(ray) {
      var hits = ray.intersectObject(corcho, false);
      if (hits.length && hits[0].uv) {
        var u = hits[0].uv.x * CW, v = (1 - hits[0].uv.y) * CH;
        for (var i = 0; i < Math.min(MAX, estado.entregas.length); i++) {
          var r = rectHoja(i);
          if (u >= r.x && u <= r.x + r.w && v >= r.y && v <= r.y + r.h) return { tipo: 'entrega', id: estado.entregas[i].id, dist: hits[0].distance };
        }
        return { tipo: 'entregables', dist: hits[0].distance };
      }
      var p = new I.T.Vector3();
      if (ray.ray.intersectBox(cajaMundo, p)) return { tipo: 'entregables', dist: p.distanceTo(ray.ray.origin) };
      return null;
    }

    function texto(h) {
      if (!h) return '';
      if (h.tipo === 'entregables') {
        return 'Clic: ver entregables' + (estado.n ? ' (' + estado.n + ' sin revisar)' : '');
      }
      var e = estado.entregas.filter(function (x) { return x.id === h.id; })[0];
      if (!e) return 'Clic: ver la entrega';
      var ag = estado.agentes[e.agente];
      return 'Clic: abrir «' + (e.titulo || 'Entrega') + '» · ' + (ag ? ag.nombre : e.origen === 'reunion' ? 'Reunión' : (e.agente || '—')) +
        ' · ' + (e.estado === 'sin_revisar' ? 'sin revisar' : e.estado === 'cambios' ? 'con cambios pedidos' : 'revisada');
    }

    function actualizar(entregas, n, agentes) {
      estado.entregas = (entregas || []).slice(0, MAX);
      estado.n = Math.max(0, n | 0);
      if (agentes) estado.agentes = agentes;
      dibujar();
    }

    dibujar();
    return { grupo: g, caja: cajaMundo, centro: new T.Vector3(cx, 0, cz), pick: pick, texto: texto, actualizar: actualizar };
  }

  return { construir: construir, MAX: MAX };
})();
