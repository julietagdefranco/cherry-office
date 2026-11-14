/* Bandeja de entregables: una bandeja de papeles sobre tu escritorio, en el despacho de Dirección. Cada entrega sin
   revisar es una hoja de la pila (con una franja del color de quien la hizo, la más nueva arriba); cuántas faltan lo
   dice una etiqueta que pone oficina3d.js. Reemplaza al corcho que estaba en la recepción.
   Lo arma App.Oficina3D en cada construir() (se carga después de oficina3d.js y se usa de forma perezosa).
   Las mallas se crean una sola vez: al actualizar solo se muestran u ocultan hojas y se les cambia el color. */
window.App = window.App || {};
App.Bandeja3D = (function () {
  'use strict';
  var MAX = 10;                                        // hojas visibles como mucho (la pila no crece más)
  var HW = 2.2, HD = 1.5, HOJA = 0.14;                 // hoja (en studs)

  /* I: {T, P, geoBloque, PLACA, x, y (tope del escritorio), z, GRIS_OSCURO} */
  function construir(I) {
    var T = I.T, P = I.P;
    var g = new T.Group();
    g.position.set(I.x, I.y, I.z);
    var gris = P.plastico(I.GRIS_OSCURO);

    /* bandeja: placa 3x2 con bordes bajos; el lado abierto mira a la cámara, así se ve la pila */
    var base = new T.Mesh(I.geoBloque(3, 2, I.PLACA * 0.5), gris); base.position.set(0, 0, 0); base.castShadow = true; g.add(base);
    [[-1.4, 0, 0.2, 2], [1.4, 0, 0.2, 2], [0, -0.9, 3, 0.2]].forEach(function (b) {
      var m = new T.Mesh(I.geoBloque(b[2], b[3], I.PLACA * 1.3), gris);
      m.position.set(b[0], 0, b[1]); m.castShadow = true; g.add(m);
    });

    /* hojas: blancas, un poco torcidas, con una franja del color de quien la hizo en el borde que mira a la cámara */
    var blanco = P.plastico('#fbfaf6'), hojas = [];
    for (var i = 0; i < MAX; i++) {
      var hg = new T.Group();
      hg.position.set(((i * 37) % 5 - 2) * 0.03, I.PLACA * 0.5 + i * HOJA, 0.05 + ((i * 13) % 3 - 1) * 0.03);
      hg.rotation.y = ((i * 29) % 7 - 3) * 0.035;
      var hoja = new T.Mesh(I.geoBloque(HW, HD, HOJA), blanco); hg.add(hoja);
      var mat = new T.MeshStandardMaterial({ color: '#6b7078', roughness: 0.6 });
      var franja = new T.Mesh(I.geoBloque(HW, 0.4, HOJA * 1.1), mat); franja.position.set(0, 0, HD / 2 - 0.2); hg.add(franja);
      hg.visible = false;
      g.add(hg); hojas.push({ g: hg, mat: mat, malla: hoja });
    }

    g.updateMatrixWorld(true);
    var cajaMundo = new T.Box3().setFromObject(g).expandByScalar(0.2);
    var estado = { pila: [], n: 0, agentes: {} };

    function colorDe(e) {
      var ag = e && estado.agentes[e.agente];
      return ag ? ag.color : (e && e.origen === 'reunion' ? '#0a5fb4' : '#6b7078');
    }

    /* la pila tiene una hoja por entrega sin revisar (hasta MAX); la de arriba es la más nueva */
    function actualizar(entregas, n, agentes) {
      if (agentes) estado.agentes = agentes;
      estado.n = Math.max(0, n | 0);
      var sin = (entregas || []).filter(function (e) { return e.estado === 'sin_revisar'; });
      var alto = Math.min(MAX, estado.n);
      estado.pila = [];
      for (var i = 0; i < MAX; i++) {
        var visible = i < alto;
        hojas[i].g.visible = visible;
        if (!visible) continue;
        var e = sin[alto - 1 - i] || null;                // de abajo hacia arriba: la de arriba es sin[0]
        hojas[i].mat.color.set(colorDe(e));
        estado.pila[i] = e;
      }
    }

    /* raycaster de oficina3d -> {tipo, id?, dist} | null */
    function pick(ray) {
      var p = new T.Vector3();
      if (!ray.ray.intersectBox(cajaMundo, p)) return null;
      var dist = p.distanceTo(ray.ray.origin);
      for (var i = MAX - 1; i >= 0; i--) {
        if (!hojas[i].g.visible) continue;
        var hits = ray.intersectObject(hojas[i].g, true);
        if (hits.length) {
          var e = estado.pila[i];
          return e ? { tipo: 'entrega', id: e.id, dist: hits[0].distance } : { tipo: 'entregables', dist: hits[0].distance };
        }
      }
      return { tipo: 'entregables', dist: dist };
    }

    function texto(h) {
      if (!h) return '';
      if (h.tipo === 'entregables') return 'Tu bandeja · ' + (estado.n ? estado.n + ' para revisar' : 'al día');
      var e = estado.pila.filter(function (x) { return x && x.id === h.id; })[0];
      if (!e) return 'Clic: ver la entrega';
      var ag = estado.agentes[e.agente];
      return 'Clic: abrir «' + (e.titulo || 'Entrega') + '» · ' + (ag ? ag.nombre : e.origen === 'reunion' ? 'Reunión' : (e.agente || '—'));
    }

    return { grupo: g, caja: cajaMundo, pick: pick, texto: texto, actualizar: actualizar };
  }

  return { construir: construir, MAX: MAX };
})();
