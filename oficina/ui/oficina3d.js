/* Oficina 3D: maqueta de ladrillos generada a partir de la oficina (departamentos y agentes).
   Principios: se dibuja SOLO cuando algo cambia (cámara, caminatas, resaltado); todos los ladrillos, baldosas y
   studs van en mallas instanciadas (pocas llamadas de dibujo); el picking usa cajas, no la malla de las figuras. */
window.App = window.App || {};
App.Oficina3D = (function () {
  'use strict';
  var T = window.THREE, P = App.Piezas;
  var PLACA = 0.4, LADRILLO = 1.2, STUD_H = 0.18;
  var renderer, escena, cam, sol, cont, capa, cv;
  var mundo = null;                 // Group con todo lo construido (se reemplaza al reconstruir)
  var figuras = {};                 // id -> {obj, caja, asiento, rot, estado, camino, fase, etiqueta}
  var lugares = [];                 // [{tipo:'reunion'|'biblioteca', caja}]
  var etiquetas = [];               // [{el, p:Vector3}]
  var plano = null;                 // datos del armado (salas, pasillos, asientos de reunión)
  var animando = {};                // id -> true mientras camina, habla o trabaja en su escritorio
  var trabajo = {};                 // id -> {estado, herramienta, objetivo, tarea} (de /api/actividad; sobrevive a reconstruir)
  var pendiente = false, sombrasSucias = true, ultimo = 0, construyendo = 0, sombraAnim = false, soloLento = true;
  var hover = null, elegido = null, hablando = null;
  var orb = { az: 0.42, el: 0.78, d: 60, tx: 0, tz: 0, minD: 10, maxD: 200 };
  var cbAgente = function () {}, cbLugar = function () {}, cbHover = function () {};
  var ray = new T.Raycaster(), v2 = new T.Vector2(), v3 = new T.Vector3();
  var BLANCO = '#f4f4f1', GRIS_CLARO = '#a3a7aa', GRIS_OSCURO = '#5d6166', NEGRO = '#2a2b2e', MADERA = '#8b6d4c', TOSTADO = '#c9b58c';

  /* ---------------- geometrías (cacheadas) ---------------- */
  var geoCache = {};
  /* bloque con bisel: origen en el centro de la base; deja 0.01 de junta a cada lado, como las piezas reales */
  function geoBloque(w, d, h) {
    var k = 'b' + w + 'x' + d + 'x' + h;
    if (geoCache[k]) return geoCache[k];
    var b = 0.035, jw = w - 0.02, jd = d - 0.02;
    var s = new T.Shape();
    s.moveTo(-jw / 2 + b, -jd / 2 + b); s.lineTo(jw / 2 - b, -jd / 2 + b); s.lineTo(jw / 2 - b, jd / 2 - b); s.lineTo(-jw / 2 + b, jd / 2 - b); s.lineTo(-jw / 2 + b, -jd / 2 + b);
    var g = new T.ExtrudeGeometry(s, { depth: Math.max(0.001, h - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, b, 0);
    g.computeVertexNormals();
    geoCache[k] = g;
    return g;
  }
  function geoStud() {
    if (geoCache.stud) return geoCache.stud;
    var g = new T.CylinderGeometry(0.3, 0.3, STUD_H, 20, 1, false);
    g.translate(0, STUD_H / 2, 0);
    return (geoCache.stud = g);
  }
  function geoRedondo(r, h) {
    var k = 'r' + r + 'x' + h;
    if (geoCache[k]) return geoCache[k];
    var g = new T.CylinderGeometry(r, r, h, 24, 1, false); g.translate(0, h / 2, 0);
    return (geoCache[k] = g);
  }

  /* ---------------- lotes instanciados ---------------- */
  var matInst = null;
  function lote() { return { grupos: {} }; }
  function poner(L, geo, clave, x, y, z, hex, rotY) {
    var g = L.grupos[clave] || (L.grupos[clave] = { geo: geo, items: [] });
    g.items.push({ x: x, y: y, z: z, c: hex, r: rotY || 0 });
  }
  function ladrillo(L, w, d, h, x, y, z, hex, studs) {
    /* (x, z) = esquina mínima en studs; y = base */
    poner(L, geoBloque(w, d, h), 'b' + w + 'x' + d + 'x' + h, x + w / 2, y, z + d / 2, hex);
    if (studs) for (var i = 0; i < w; i++) for (var j = 0; j < d; j++) poner(L, geoStud(), 'stud', x + i + 0.5, y + h, z + j + 0.5, hex);
  }
  function cerrarLote(L, destino, material) {
    if (!matInst) matInst = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0 });
    var m4 = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), uno = new T.Vector3(1, 1, 1), c = new T.Color();
    Object.keys(L.grupos).forEach(function (k) {
      var g = L.grupos[k];
      var im = new T.InstancedMesh(g.geo, material || matInst, g.items.length);
      for (var i = 0; i < g.items.length; i++) {
        var it = g.items[i];
        q.setFromAxisAngle(up, it.r);
        m4.compose(new T.Vector3(it.x, it.y, it.z), q, uno);
        im.setMatrixAt(i, m4);
        im.setColorAt(i, c.set(it.c).convertSRGBToLinear());
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = !material; im.receiveShadow = true;
      destino.add(im);
    });
  }

  /* ---------------- utilidades de color ---------------- */
  function mezclar(a, b, t) { var x = new T.Color(a), y = new T.Color(b); return '#' + x.lerp(y, t).getHexString(); }

  /* ---------------- init ---------------- */
  function iniciar(contenedor) {
    cont = contenedor;
    try { renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); } catch (e) { return false; }
    P.prepararRenderer(renderer);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    cv = renderer.domElement; cv.className = 'lienzo3d';
    cont.appendChild(cv);
    capa = document.createElement('div'); capa.className = 'capa3d'; cont.appendChild(capa);
    escena = new T.Scene();
    escena.environment = P.entorno(renderer);
    escena.background = null;
    cam = new T.PerspectiveCamera(26, 1, 0.5, 2000);
    var hemi = new T.HemisphereLight(0xffffff, 0xd8d2c8, 0.35); escena.add(hemi);
    sol = new T.DirectionalLight(0xfff6ea, 2.4);
    sol.castShadow = true; sol.shadow.mapSize.set(2048, 2048); sol.shadow.bias = -0.0004; sol.shadow.normalBias = 0.02; sol.shadow.radius = 3;
    escena.add(sol, sol.target);
    /* mesa infinita debajo de la maqueta */
    var mesa = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.MeshStandardMaterial({ color: P.lineal('#e7e4de'), roughness: 0.9, metalness: 0 }));
    mesa.rotation.x = -Math.PI / 2; mesa.position.y = -0.21; mesa.receiveShadow = true; escena.add(mesa);
    eventos();
    if (window.ResizeObserver) new ResizeObserver(function () { medir(); }).observe(cont);
    window.addEventListener('resize', medir);
    medir();
    return true;
  }

  var tamW = 0, tamH = 0;
  function medir() {
    var w = Math.max(1, Math.floor(cont.clientWidth)), h = Math.max(1, Math.floor(cont.clientHeight));
    if (w === tamW && h === tamH) return;
    tamW = w; tamH = h;
    renderer.setSize(w, h, false);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cam.aspect = w / h; cam.updateProjectionMatrix();
    if (plano) encuadrar(false);
    pedir();
  }

  /* ---------------- render bajo demanda ---------------- */
  function pedir() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(cuadro);
  }
  function cuadro(t) {
    pendiente = false;
    var dt = ultimo ? Math.min(0.05, (t - ultimo) / 1000) : 0.016; ultimo = t;
    var hayAnim = false;
    sombraAnim = false; soloLento = true;
    for (var id in animando) { if (animar(id, dt)) hayAnim = true; else delete animando[id]; }
    if (camara(dt)) { hayAnim = true; soloLento = false; }
    posCam();
    /* las sombras solo se recalculan si algo se mueve de lugar (caminar), no por gestos sentados ni pantallas */
    if (sombrasSucias || sombraAnim) { renderer.shadowMap.needsUpdate = true; sombrasSucias = false; }
    renderer.render(escena, cam);
    for (var i = 0; i < etiquetas.length; i++) proyectar(etiquetas[i]);
    if (!hayAnim) { ultimo = 0; return; }
    /* gestos de trabajo a ~16 fps (no hace falta más y ahorra batería); caminatas y cámara a pleno */
    if (soloLento) setTimeout(pedir, 60); else pedir();
  }

  /* ---------------- cámara animada (enfocar) ---------------- */
  var vuelo = null;
  function camara(dt) {
    if (!vuelo) return false;
    vuelo.t = Math.min(1, vuelo.t + dt / vuelo.dur);
    var k = vuelo.t < 0.5 ? 2 * vuelo.t * vuelo.t : 1 - Math.pow(-2 * vuelo.t + 2, 2) / 2;
    orb.tx = vuelo.a.tx + (vuelo.b.tx - vuelo.a.tx) * k;
    orb.tz = vuelo.a.tz + (vuelo.b.tz - vuelo.a.tz) * k;
    orb.d = vuelo.a.d + (vuelo.b.d - vuelo.a.d) * k;
    if (vuelo.t >= 1) vuelo = null;
    return true;
  }
  function enfocar(x, z, d) {
    vuelo = { t: 0, dur: 0.7, a: { tx: orb.tx, tz: orb.tz, d: orb.d }, b: { tx: x, tz: z, d: lim(d || orb.minD * 1.6, orb.minD, orb.maxD) } };
    pedir();
  }
  function enfocarAgente(id) {
    var f = figuras[id]; if (!f) return false;
    enfocar(f.obj.position.x, f.obj.position.z + 1, orb.minD * 1.5);
    return true;
  }
  function enfocarLugar(tipo) {
    var l = lugares.filter(function (x) { return x.tipo === tipo; })[0];
    if (!l) return false;
    var c = l.caja.getCenter(new T.Vector3());
    enfocar(c.x, c.z + 1, orb.minD * 2);
    return true;
  }
  function posCam() {
    var ce = Math.cos(orb.el);
    cam.position.set(orb.tx + orb.d * Math.sin(orb.az) * ce, orb.d * Math.sin(orb.el), orb.tz + orb.d * Math.cos(orb.az) * ce);
    cam.lookAt(orb.tx, 0, orb.tz);
  }
  function proyectar(e) {
    var p = e.obj ? v3.copy(e.obj.position).add(e.off) : v3.copy(e.p);
    p.project(cam);
    var vis = p.z < 1 && p.x > -1.1 && p.x < 1.1 && p.y > -1.1 && p.y < 1.1 && !e.oculta;
    e.el.style.display = vis ? '' : 'none';
    if (vis) e.el.style.transform = 'translate(' + Math.round((p.x * 0.5 + 0.5) * tamW) + 'px,' + Math.round((-p.y * 0.5 + 0.5) * tamH) + 'px)';
  }

  /* ---------------- cámara: arrastrar = girar, dos dedos = desplazar, pellizcar / ctrl+rueda = zoom ---------------- */
  function eventos() {
    var drag = null;
    cv.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, mov: 0, pan: e.button === 2 || e.shiftKey };
      try { cv.setPointerCapture(e.pointerId); } catch (x) {}
    });
    cv.addEventListener('pointermove', function (e) {
      if (drag) {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.mov += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) desplazar(dx, dy);
        else { orb.az = lim(orb.az - dx * 0.005, -1.1, 1.1); orb.el = lim(orb.el + dy * 0.004, 0.32, 1.35); }
        pedir();
      } else marcarHover(e);
    });
    function soltar(e) {
      if (drag && drag.mov < 5) elegir(e);
      drag = null;
    }
    cv.addEventListener('pointerup', soltar);
    cv.addEventListener('pointercancel', function () { drag = null; });
    cv.addEventListener('pointerleave', function () { if (hover) { hover = null; cv.style.cursor = ''; actualizarEtiquetasHover(); pedir(); cbHover(null); } });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey) orb.d = lim(orb.d * (1 + e.deltaY * 0.01), orb.minD, orb.maxD);
      else if (e.deltaMode === 0 && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 60 && !Number.isInteger(e.deltaY)) desplazar(-e.deltaX, -e.deltaY);
      else orb.d = lim(orb.d * (1 + e.deltaY * 0.0015), orb.minD, orb.maxD);
      pedir();
    }, { passive: false });
  }
  function desplazar(dx, dy) {
    var k = orb.d / Math.max(300, tamH) * 1.1, s = Math.sin(orb.az), c = Math.cos(orb.az);
    orb.tx -= (dx * c + dy * s) * k; orb.tz -= (-dx * s + dy * c) * k;
    if (plano) { orb.tx = lim(orb.tx, plano.x0 - 10, plano.x1 + 10); orb.tz = lim(orb.tz, plano.z0 - 10, plano.z1 + 10); }
  }
  function lim(v, a, b) { return v < a ? a : v > b ? b : v; }

  function rayo(e) {
    var r = cv.getBoundingClientRect();
    v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(v2, cam);
    var mejor = null, dm = Infinity, p = new T.Vector3();
    for (var id in figuras) {
      var f = figuras[id];
      f.caja.setFromCenterAndSize(v3.set(f.obj.position.x, f.obj.position.y + 1.9, f.obj.position.z), new T.Vector3(2.2, 3.8, 2));
      if (ray.ray.intersectBox(f.caja, p)) { var d = p.distanceTo(ray.ray.origin); if (d < dm) { dm = d; mejor = { tipo: 'agente', id: id }; } }
    }
    if (mejor) return mejor;
    for (var i = 0; i < lugares.length; i++) {
      if (ray.ray.intersectBox(lugares[i].caja, p)) { var d2 = p.distanceTo(ray.ray.origin); if (d2 < dm) { dm = d2; mejor = { tipo: lugares[i].tipo }; } }
    }
    return mejor;
  }
  var hoverPend = null;
  function marcarHover(e) {
    if (hoverPend) { hoverPend = e; return; }
    hoverPend = e;
    requestAnimationFrame(function () {
      var ev = hoverPend; hoverPend = null;
      var h = rayo(ev), clave = h ? (h.tipo + ':' + (h.id || '')) : null;
      cv.style.cursor = h ? 'pointer' : '';
      if (clave !== hover) { hover = clave; actualizarEtiquetasHover(); pedir(); cbHover(h); }
    });
  }
  function elegir(e) {
    var h = rayo(e);
    if (!h) return;
    if (h.tipo === 'agente') cbAgente(h.id); else cbLugar(h.tipo);
  }
  function actualizarEtiquetasHover() {
    for (var id in figuras) {
      var f = figuras[id], ver = hover === 'agente:' + id || elegido === id || f.ocupado || hablando === id || !!trabajo[id];
      f.etiqueta.oculta = !ver;
      f.etiqueta.el.classList.toggle('activa', elegido === id);
      f.etiqueta.el.classList.toggle('hablando', hablando === id);
    }
    lugares.forEach(function (l) { if (l.etiqueta) l.etiqueta.el.classList.toggle('hover', hover === l.tipo + ':'); });
  }

  /* ---------------- armado del edificio ----------------
     Un solo edificio rectangular: recepción a la izquierda (de punta a punta) y una o más alas a la derecha.
     Cada ala = fila de salas al fondo + pasillo + fila de salas al frente. Si hay muchos departamentos, el edificio
     se alarga y, pasado cierto largo, suma otra ala debajo (sigue siendo el mismo rectángulo).
     Vista de maqueta: la fachada del fondo es alta con ventanas, los laterales medianos y el frente bajo. */
  var CELDA_X = 7, CELDA_Z = 6, PASILLO = 4, RECEPCION = 12, MARGEN = 4;

  function disenarSala(s) {
    if (s.tipo === 'reunion') { s.w = 17; s.d = 13; return; }
    if (s.tipo === 'biblioteca') { s.w = 14; s.d = 13; return; }
    var n = Math.max(1, s.agentes.length);
    s.filasDesk = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    s.cols = Math.ceil(n / s.filasDesk);
    s.w = s.cols * CELDA_X + 2;
    s.d = s.filasDesk * CELDA_Z + 5;
  }

  function planificar(salas) {
    salas.forEach(disenarSala);
    var total = salas.reduce(function (a, s) { return a + s.w; }, 0);
    var alas = Math.max(1, Math.round(Math.sqrt(total / 110)));
    var largoMax = Math.max(Math.ceil(total / (2 * alas)), Math.max.apply(null, salas.map(function (s) { return s.w; })));
    var lista = [], ala = null;
    function nuevaAla() { ala = { fondo: [], frente: [], lf: 0, lr: 0 }; lista.push(ala); }
    nuevaAla();
    salas.forEach(function (s, i) {
      var aFondo = s.tipo === 'reunion' || (s.tipo !== 'biblioteca' && ala.lf <= ala.lr);
      if (s.tipo === 'biblioteca') aFondo = false;
      if ((aFondo ? ala.lf : ala.lr) + s.w > largoMax + 6 && (aFondo ? ala.lr : ala.lf) + s.w > largoMax + 6) nuevaAla();
      else if ((aFondo ? ala.lf : ala.lr) + s.w > largoMax + 6) aFondo = !aFondo;
      if (aFondo) { ala.fondo.push(s); ala.lf += s.w; } else { ala.frente.push(s); ala.lr += s.w; }
    });
    var largo = Math.max.apply(null, lista.map(function (a) { return Math.max(a.lf, a.lr); }));
    var z = 0;
    lista.forEach(function (a, i) {
      a.df = Math.max(13, Math.max.apply(null, a.fondo.map(function (s) { return s.d; }).concat([0])));
      a.dr = Math.max(13, Math.max.apply(null, a.frente.map(function (s) { return s.d; }).concat([0])));
      a.z = z; a.pasilloZ = z + a.df + PASILLO / 2; a.indice = i;
      [['fondo', z, a.df], ['frente', z + a.df + PASILLO, a.dr]].forEach(function (f) {
        var fila = a[f[0]], x = RECEPCION;
        if (!fila.length) fila.push({ tipo: 'comun', nombre: 'Espacio común', w: largo, d: f[2] });
        fila.forEach(function (s, k) {
          s.x = x; s.z = f[1]; s.d = f[2]; s.ala = a; s.lado = f[0];
          if (k === fila.length - 1) s.w = Math.max(s.w, RECEPCION + largo - x);   // la última sala llega a la fachada
          x += s.w;
        });
      });
      z += a.df + PASILLO + a.dr;
    });
    return { alas: lista, W: RECEPCION + largo + 1, D: z, x0: -MARGEN, z0: -MARGEN, x1: RECEPCION + largo + 1 + MARGEN, z1: z + MARGEN + 3, pasilloX: RECEPCION / 2 };
  }

  function construir(oficina) {
    var token = ++construyendo;
    var deps = oficina.departamentos || [], ags = oficina.agentes || [];
    var porDep = {};
    deps.forEach(function (d) { porDep[d.id] = []; });
    var sinDep = [];
    ags.forEach(function (a) { if (porDep[a.departamento]) porDep[a.departamento].push(a); else sinDep.push(a); });
    if (sinDep.length) { porDep.__sin = sinDep; deps = deps.concat([{ id: '__sin', nombre: 'Sin departamento', color: '#9a9a9a' }]); }
    var salas = [{ tipo: 'reunion', nombre: 'Sala de reuniones' }, { tipo: 'biblioteca', nombre: 'Biblioteca' }]
      .concat(deps.map(function (d) { return { tipo: 'depto', dep: d, nombre: d.nombre, agentes: porDep[d.id] || [] }; }));
    var nuevo = planificar(salas);
    nuevo.nombre = oficina.nombre || '';

    var L = lote(), LV = lote(), grupo = new T.Group();
    lugares = []; etiquetas.forEach(function (e) { e.el.remove(); }); etiquetas = [];

    /* terreno: placa base con studs alrededor del edificio y vereda frente a la entrada */
    var bx0 = nuevo.x0, bz0 = nuevo.z0, bx1 = Math.ceil(nuevo.x1), bz1 = Math.ceil(nuevo.z1);
    var base = new T.Mesh(geoBloque(bx1 - bx0, bz1 - bz0, 0.2), P.plastico('#9ea3a6', { rugosidad: 0.5 }));
    base.position.set((bx0 + bx1) / 2, -0.2, (bz0 + bz1) / 2); base.receiveShadow = true; grupo.add(base);
    var entradaX = Math.floor(RECEPCION / 2) - 2;
    for (var i = bx0; i < bx1; i++) for (var j = bz0; j < bz1; j++) {
      var dentro = i >= 0 && i < nuevo.W && j >= 0 && j < nuevo.D;
      var vereda = j >= nuevo.D && j < nuevo.D + 3 && i >= entradaX - 2 && i < entradaX + 6;
      if (vereda) continue;
      if (!dentro) poner(L, geoStud(), 'stud', i + 0.5, 0, j + 0.5, '#9ea3a6');
    }
    for (var vx = entradaX - 2; vx < entradaX + 6; vx += 2) for (var vz = nuevo.D; vz < nuevo.D + 3; vz++) ladrillo(L, 2, 1, PLACA, vx, 0, vz, '#c8c4bc', false);

    /* recepción */
    pisoBaldosas(L, 0, 0, RECEPCION, nuevo.D, '#b9b3aa');
    recepcion(L, nuevo, entradaX);
    var etqR = etiqueta('sala', nuevo.nombre ? nuevo.nombre + ' · Recepción' : 'Recepción', null);
    etqR.p = new T.Vector3(1, PLACA, nuevo.D - 1.2);

    var asientosDesk = {};
    nuevo.alas.forEach(function (a) {
      pisoBaldosas(L, RECEPCION, a.z + a.df, nuevo.W - RECEPCION, PASILLO, '#d6d3cd');    // pasillo
      a.fondo.concat(a.frente).forEach(function (s) {
        var piso = s.tipo === 'reunion' ? '#d9d6d0' : s.tipo === 'biblioteca' ? '#cdbfa6' : s.tipo === 'comun' ? '#dcd9d3' : mezclar(s.dep.color || '#999999', '#dedbd5', 0.5);
        pisoBaldosas(L, s.x, s.z, s.w, s.d, piso);
        paredesSala(L, LV, s, nuevo);
        var alFondo = s.lado === 'fondo';
        s.puertaX = s.x + s.w - 3.5;
        s.puertaZ = alFondo ? s.z + s.d - 2 : s.z + 2;           // punto justo adentro de la puerta
        var etq = etiqueta('sala', s.nombre, s.dep ? s.dep.color : null);
        etq.p = new T.Vector3(s.x + 1.5, PLACA + (alFondo ? 0 : 1.2), alFondo ? s.z + s.d - 0.3 : s.z + 0.7);
        if (s.tipo === 'depto') {
          for (var k = 0; k < Math.max(1, s.agentes.length); k++) {
            var col = k % s.cols, fil = Math.floor(k / s.cols);
            var cx = s.x + 1 + col * CELDA_X + CELDA_X / 2, cz = s.z + (alFondo ? 2.8 : 4.2) + fil * CELDA_Z;
            escritorio(L, cx, cz);
            var asiento = { x: cx, z: cz + 0.2, rot: 0, sala: s, salida: { x: cx + CELDA_X / 2, z: cz + 0.2 } };
            if (s.agentes[k]) asientosDesk[s.agentes[k].id] = asiento;
          }
        } else if (s.tipo === 'reunion') {
          salaReunion(L, s, nuevo);
          lugares.push({ tipo: 'reunion', caja: new T.Box3(new T.Vector3(s.x, 0, s.z), new T.Vector3(s.x + s.w, 2.5, s.z + s.d)), etiqueta: etq });
        } else if (s.tipo === 'biblioteca') {
          biblioteca(L, s);
          lugares.push({ tipo: 'biblioteca', caja: new T.Box3(new T.Vector3(s.x, 0, s.z), new T.Vector3(s.x + s.w, 6, s.z + s.d)), etiqueta: etq });
        } else {
          comun(L, s);
        }
      });
    });
    fachada(L, LV, nuevo, entradaX);
    cerrarLote(L, grupo);
    cerrarLote(LV, grupo, vidrio());

    return Promise.all(ags.map(function (a) {
      return P.figura(a.avatar, a.id).then(function (fig) { return { a: a, fig: fig }; });
    })).then(function (lista) {
      if (token !== construyendo) return;
      if (mundo) { escena.remove(mundo); liberar(mundo); }
      mundo = grupo; escena.add(mundo);
      var viejas = figuras; figuras = {};
      Object.keys(viejas).forEach(function (id) {
        viejas[id].etiqueta.el.remove();
        if (viejas[id].etqTarea) viejas[id].etqTarea.el.remove();
        if (viejas[id].etqFaro) viejas[id].etqFaro.el.remove();
        if (viejas[id].pantalla) { viejas[id].pantalla.tex.dispose(); viejas[id].pantalla.mat.dispose(); }
      });
      animando = {};
      var cambioTam = !plano || plano.W !== nuevo.W || plano.D !== nuevo.D;
      plano = nuevo;
      lista.forEach(function (x) {
        var f = { obj: x.fig, caja: new T.Box3(), asiento: asientosDesk[x.a.id], estado: 'escritorio', camino: null, fase: 0, a: x.a };
        sentar(f, f.asiento);
        mundo.add(x.fig);
        f.etiqueta = etiqueta('agente', x.a.nombre, null);
        f.etiqueta.obj = x.fig; f.etiqueta.off = new T.Vector3(0, 4.6, 0); f.etiqueta.oculta = true;
        f.etqTarea = etiquetaTarea(x.fig);
        figuras[x.a.id] = f;
        crearPantalla(f);
      });
      actividad(trabajo);
      faros(faroDe);
      encuadrar(cambioTam);
      actualizarEtiquetasHover();
      sombrasSucias = true;
      pedir();
      if (reunionActual) reunion(reunionActual.agentes, reunionActual.hablando, true);
    });
  }

  var matVidrio = null;
  function vidrio() {
    if (!matVidrio) matVidrio = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.4 });
    return matVidrio;
  }

  function liberar(g) {
    g.traverse(function (o) { if (o.isInstancedMesh) o.dispose && o.dispose(); });
  }

  function etiqueta(tipo, texto, color) {
    var el = document.createElement('div');
    el.className = 'etq etq-' + tipo;
    var dentro = document.createElement('div'); dentro.className = 'etq-in'; el.appendChild(dentro);
    if (color) { var p = document.createElement('i'); p.style.background = color; dentro.appendChild(p); }
    var s = document.createElement('span'); s.textContent = texto; dentro.appendChild(s);
    capa.appendChild(el);
    var e = { el: el, p: null, obj: null, off: null, oculta: false };
    etiquetas.push(e);
    return e;
  }

  /* cartel de tarea sobre la cabeza: título (qué pidieron) y detalle (qué está haciendo ahora) */
  function etiquetaTarea(obj) {
    var e = etiqueta('tarea', '', null);
    vaciarNodo(e.el.firstChild);
    var t = document.createElement('b'), d = document.createElement('small');
    e.el.firstChild.appendChild(t); e.el.firstChild.appendChild(d);
    e.titulo = t; e.detalle = d; e.obj = obj; e.off = new T.Vector3(0, 5.9, 0); e.oculta = true;
    return e;
  }
  function vaciarNodo(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function pisoBaldosas(L, x, z, w, d, hex) {
    for (var a = 0; a < w; a += 2) for (var b = 0; b < d; b += 2) ladrillo(L, Math.min(2, w - a), Math.min(2, d - b), PLACA, x + a, 0, z + b, hex, false);
  }

  /* tramo de pared a lo largo de x o z, con aparejo trabado; huecos = [[desde, hasta]] en la coordenada del tramo */
  function pared(L, eje, x, z, largo, alto, hex, huecos, studsArriba) {
    for (var n = 0; n < alto; n++) {
      var p = 0, desf = n % 2 ? 2 : 0, primero = true;
      while (p < largo) {
        var w = Math.max(1, Math.min(primero && desf ? desf : 4, largo - p));
        primero = false;
        var tapa = false;
        (huecos || []).forEach(function (h) { if (p < h[1] && p + w > h[0]) tapa = true; });
        if (tapa) {
          /* se parte el ladrillo para respetar el hueco */
          (huecos || []).forEach(function (h) { if (p < h[0] && h[0] < p + w) w = h[0] - p; });
          var enHueco = (huecos || []).some(function (h) { return p >= h[0] && p < h[1]; });
          if (enHueco) { var fin = (huecos || []).filter(function (h) { return p >= h[0] && p < h[1]; })[0][1]; p = fin; continue; }
        }
        if (eje === 'x') ladrillo(L, w, 1, LADRILLO, x + p, PLACA + n * LADRILLO, z, hex, studsArriba && n === alto - 1);
        else ladrillo(L, 1, w, LADRILLO, x, PLACA + n * LADRILLO, z + p, hex, studsArriba && n === alto - 1);
        p += w;
      }
    }
  }

  function fachada(L, LV, pl, entradaX) {
    var W = pl.W, D = pl.D;
    /* fondo: zócalo, ventanas y coronamiento */
    pared(L, 'x', 0, 0, W, 1, BLANCO, null, false);
    for (var p = 0; p < W; p += 6) {
      var pil = Math.min(2, W - p), vw = Math.min(4, W - p - pil);
      ladrillo(L, pil, 1, LADRILLO * 2, p, PLACA + LADRILLO, 0, BLANCO, false);
      if (vw > 0) {
        poner(LV, geoBloque(vw, 0.25, LADRILLO * 2), 'v' + vw, p + pil + vw / 2, PLACA + LADRILLO, 0.5, '#d8eaf0');
        ladrillo(L, vw, 1, 0.2, p + pil, PLACA + LADRILLO, 0, '#8d9296', false);                    // alféizar
      }
    }
    for (var q = 0; q < W; q += 4) ladrillo(L, Math.min(4, W - q), 1, LADRILLO, q, PLACA + LADRILLO * 3, 0, BLANCO, true);
    /* laterales: dos ladrillos */
    pared(L, 'z', 0, 1, D - 1, 2, BLANCO, null, true);
    pared(L, 'z', W - 1, 1, D - 1, 2, BLANCO, null, true);
    /* frente: un ladrillo, con la puerta de entrada en la recepción */
    pared(L, 'x', 1, D - 1, W - 2, 1, BLANCO, [[entradaX - 1, entradaX + 3]], true);
  }

  function paredesSala(L, LV, s, pl) {
    var a = s.ala, alFondo = s.lado === 'fondo';
    /* tabique izquierdo (todas las salas: el de la primera las separa de la recepción) */
    var z0 = s.z + (alFondo && a.indice === 0 ? 1 : 0), largoZ = s.d - (alFondo && a.indice === 0 ? 1 : 0) - (!alFondo && a.indice === pl.alas.length - 1 ? 1 : 0);
    if (s.x === RECEPCION) {
      /* contra la recepción: tabique con vidrio para que se vea el movimiento */
      pared(L, 'z', s.x, z0, largoZ, 1, BLANCO, null, false);
      poner(LV, geoBloque(0.25, largoZ, LADRILLO), 'vz' + largoZ, s.x + 0.5, PLACA + LADRILLO, z0 + largoZ / 2, '#d8eaf0');
    } else pared(L, 'z', s.x, z0, largoZ, 2, BLANCO, null, true);
    /* muro entre alas (el fondo de un ala que no es la primera) */
    if (alFondo && a.indice > 0) pared(L, 'x', s.x + 1, s.z, s.w - 1, 2, BLANCO, null, true);
    /* frente al pasillo: un ladrillo con puerta de 3 */
    var zp = alFondo ? s.z + s.d - 1 : s.z, px = s.w - 6;
    pared(L, 'x', s.x + 1, zp, s.w - 1, 1, BLANCO, [[px, px + 3]], true);
  }

  function escritorio(L, cx, cz) {
    var y = PLACA;
    poner(L, geoBloque(0.35, 1.8, LADRILLO * 2), 'pata', cx - 1.75, y, cz + 2.2, GRIS_CLARO);
    poner(L, geoBloque(0.35, 1.8, LADRILLO * 2), 'pata', cx + 1.75, y, cz + 2.2, GRIS_CLARO);
    ladrillo(L, 4, 2, PLACA, cx - 2, y + LADRILLO * 2, cz + 1.2, BLANCO, false);
    var tope = y + LADRILLO * 2 + PLACA;
    ladrillo(L, 2, 1, 0.12, cx + 0.1, tope, cz + 1.5, NEGRO, false);
    poner(L, geoBloque(1.6, 0.08, 1.05), 'pantalla', cx + 1.1, tope + 0.05, cz + 2.45, NEGRO);
    poner(L, geoRedondo(0.35, LADRILLO - PLACA), 'pie', cx, y, cz + 0.2, NEGRO);
    ladrillo(L, 2, 2, PLACA, cx - 1, y + LADRILLO - PLACA, cz - 0.8, GRIS_OSCURO, false);
    poner(L, geoBloque(2, 0.35, LADRILLO * 1.4), 'respaldo', cx, y + LADRILLO, cz - 0.62, GRIS_OSCURO);
    poner(L, geoRedondo(0.4, 0.8), 'maceta', cx - 1.5, tope, cz + 2.4, '#e8e4dc');
    poner(L, geoRedondo(0.32, 0.5), 'hojas', cx - 1.5, tope + 0.8, cz + 2.4, '#4b7f52');
  }

  function recepcion(L, pl, entradaX) {
    var y = PLACA, cx = RECEPCION / 2, cz = pl.D - 9;
    /* mostrador en L */
    ladrillo(L, 6, 1, LADRILLO * 2, cx - 3, y, cz, BLANCO, false);
    ladrillo(L, 6, 2, PLACA, cx - 3, y + LADRILLO * 2, cz - 0.5, MADERA, false);
    /* sillones de espera y plantas */
    ladrillo(L, 4, 2, LADRILLO * 0.75, 1.5, y, pl.D - 5, '#4a5560', false);
    ladrillo(L, 4, 0.6, LADRILLO * 1.5, 1.5, y, pl.D - 5, '#4a5560', false);
    [[1.5, 1.5], [RECEPCION - 2, 1.5], [1.5, pl.D - 2.5]].forEach(function (p) {
      poner(L, geoRedondo(0.7, 1.4), 'macetaG', p[0], y, p[1], '#e8e4dc');
      poner(L, geoRedondo(0.6, 1.6), 'arbusto', p[0], y + 1.4, p[1], '#4b7f52');
    });
    /* cartel en la pared del fondo */
    poner(L, geoBloque(8, 0.2, 1.6), 'cartel', cx, y + LADRILLO * 1.6, 1.15, NEGRO);
  }

  function salaReunion(L, s, pl) {
    var y = PLACA, mx = s.x + 1 + (s.w - 1) / 2, mz = s.z + s.d / 2 + 0.2;
    ladrillo(L, 2, 2, LADRILLO * 2, mx - 4, y, mz - 1, GRIS_OSCURO, false);
    ladrillo(L, 2, 2, LADRILLO * 2, mx + 2, y, mz - 1, GRIS_OSCURO, false);
    ladrillo(L, 10, 4, PLACA, mx - 5, y + LADRILLO * 2, mz - 2, MADERA, false);
    var asientos = [];
    for (var i = 0; i < 4; i++) asientos.push({ x: mx - 3.6 + i * 2.4, z: mz - 3.4, rot: 0 });
    for (var j = 0; j < 4; j++) asientos.push({ x: mx - 3.6 + j * 2.4, z: mz + 3.4, rot: Math.PI });
    asientos.push({ x: mx - 6.6, z: mz, rot: Math.PI / 2 }, { x: mx + 6.6, z: mz, rot: -Math.PI / 2 });
    asientos.forEach(function (a) {
      var dz = Math.cos(a.rot), dx = Math.sin(a.rot);
      poner(L, geoRedondo(0.35, LADRILLO - PLACA), 'pie', a.x, y, a.z, NEGRO);
      poner(L, geoBloque(2, 2, PLACA), 'b2x2x' + PLACA, a.x, y + LADRILLO - PLACA, a.z, GRIS_OSCURO, a.rot);
      poner(L, geoBloque(2, 0.35, LADRILLO * 1.4), 'respaldo', a.x - dx * 0.82, y + LADRILLO, a.z - dz * 0.82, GRIS_OSCURO, a.rot);
    });
    pl.reunion = { sala: s, asientos: asientos };
    poner(L, geoBloque(6, 0.2, 3.4), 'tele', mx, y + 0.9, s.z + 1.15, NEGRO);
  }

  function biblioteca(L, s) {
    /* estanterías contra la pared del pasillo (fondo de la sala), dejando libre la puerta */
    var y = PLACA, libros = ['#b5442e', '#2f5d8a', '#d9a21b', '#3f7a53', '#7a4a8c', '#e8e4dc', '#26262b', '#c46d3d'];
    var nEst = Math.max(1, Math.floor((s.w - 5) / 3.4));
    for (var e = 0; e < nEst; e++) {
      var x0 = s.x + 1.5 + e * 3.4;
      for (var n = 0; n < 4; n++) {
        var yy = y + n * 1.2;
        ladrillo(L, 3, 2, 0.2, x0, yy, s.z + 1, MADERA, false);
        if (n < 3) for (var k = 0; k < 5; k++) {
          var h = 0.75 + ((k * 7 + n * 3 + e) % 3) * 0.1;
          poner(L, geoBloque(0.5, 1.4, h), 'libro' + h, x0 + 0.35 + k * 0.55, yy + 0.2, s.z + 2.1, libros[(k + n * 2 + e * 3) % libros.length]);
        }
      }
      poner(L, geoBloque(0.3, 2, 4.8), 'lateralEst', x0 + 3.05, y, s.z + 2, MADERA);
    }
    var mx = s.x + s.w / 2, mz = s.z + s.d - 5;
    poner(L, geoRedondo(0.5, LADRILLO * 2), 'patamesa', mx, y, mz, GRIS_OSCURO);
    poner(L, geoRedondo(2.2, PLACA), 'mesaredonda', mx, y + LADRILLO * 2, mz, TOSTADO);
  }

  function comun(L, s) {
    var y = PLACA, cx = s.x + Math.min(s.w, 14) / 2 + 1, cz = s.z + s.d / 2;
    ladrillo(L, 4, 2, LADRILLO * 0.75, cx - 2, y, cz - 3, '#4a5560', false);
    poner(L, geoRedondo(1.2, LADRILLO * 0.9), 'mesita', cx, y, cz, TOSTADO);
    poner(L, geoRedondo(0.7, 1.4), 'macetaG', s.x + 2, y, s.z + 2, '#e8e4dc');
    poner(L, geoRedondo(0.6, 1.6), 'arbusto', s.x + 2, y + 1.4, s.z + 2, '#4b7f52');
  }

  function sentar(f, a) {
    if (!a) { f.obj.position.set(plano ? plano.pasilloX : RECEPCION / 2, PLACA, plano ? plano.D - 4 : 4); f.obj.rotation.y = 0; P.pose(f.obj, ''); return; }
    f.obj.position.set(a.x, PLACA + LADRILLO - 1.38, a.z);
    f.obj.rotation.y = a.rot || 0;
    P.pose(f.obj, 'sentado');
  }

  function encuadrar(reset) {
    if (!plano) return;
    var w = plano.x1 - plano.x0, d = plano.z1 - plano.z0;
    orb.tx = (plano.x0 + plano.x1) / 2; orb.tz = (plano.z0 + plano.z1) / 2 + 1;
    var fov = cam.fov * Math.PI / 180, aspecto = cam.aspect || 1.5;
    var dh = (w * 0.56) / Math.tan(fov / 2) / aspecto, dv = (d * 0.5 + 4) / Math.tan(fov / 2);
    var dd = Math.max(dh, dv, 24);
    orb.minD = Math.max(10, dd * 0.22); orb.maxD = dd * 2.2;
    if (reset || orb.d > orb.maxD || orb.d < orb.minD) orb.d = dd;
    var k = Math.max(w, d);
    sol.position.set(orb.tx - k * 0.35, k * 1.1 + 20, orb.tz + k * 0.55);
    sol.target.position.set(orb.tx, 0, orb.tz);
    var sc = sol.shadow.camera, half = k * 0.75 + 6;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 1; sc.far = k * 3 + 80; sc.updateProjectionMatrix();
    sombrasSucias = true;
  }

  /* ---------------- caminatas ---------------- */
  var VEL = 5.5;
  function caminar(id, puntos, alLlegar) {
    var f = figuras[id]; if (!f) return;
    f.camino = puntos; f.alLlegar = alLlegar; f.estado = 'caminando';
    /* se para al lado del escritorio */
    f.obj.position.y = PLACA;
    P.pose(f.obj, '');
    animando[id] = true; pedir();
  }
  function animar(id, dt) {
    var f = figuras[id]; if (!f) return false;
    if (f.estado === 'caminando' && f.camino && f.camino.length) {
      var obj = f.obj, dest = f.camino[0], dx = dest.x - obj.position.x, dz = dest.z - obj.position.z, dist = Math.hypot(dx, dz);
      var paso = VEL * dt;
      if (dist <= paso) {
        obj.position.x = dest.x; obj.position.z = dest.z; f.camino.shift();
        if (!f.camino.length) { f.estado = 'quieto'; if (f.alLlegar) f.alLlegar(); return f.estado === 'hablando'; }
      } else {
        obj.position.x += dx / dist * paso; obj.position.z += dz / dist * paso;
        var objetivo = Math.atan2(dx, dz), dif = objetivo - obj.rotation.y;
        dif = Math.atan2(Math.sin(dif), Math.cos(dif));
        obj.rotation.y += dif * Math.min(1, dt * 12);
      }
      f.fase += dt * 11;
      P.pose(obj, 'caminar', f.fase);
      sombraAnim = true; soloLento = false;
      return true;
    }
    if (f.estado === 'hablando') {
      f.fase += dt * 6;
      P.pose(f.obj, 'sentado');
      P.pose(f.obj, 'hablar', f.fase);
      soloLento = false;
      return true;
    }
    if (f.estado === 'escritorio' && trabajo[id]) {
      f.fase += dt * 9;
      P.pose(f.obj, 'sentado');
      P.pose(f.obj, POSE[trabajo[id].estado] || 'tipear', f.fase);
      f.tPant = (f.tPant || 0) + dt;
      if (f.pantalla && f.tPant > 0.12) { f.tPant = 0; f.cuadroPant = (f.cuadroPant || 0) + 1; dibujarPantalla(f); }
      return true;
    }
    return false;
  }

  /* ---------------- trabajo en vivo: pose, pantalla y cartel ---------------- */
  var POSE = { pensando: 'pensar', leyendo: 'leer', escribiendo: 'tipear', buscando: 'mirar', consultando: 'pensar', trabajando: 'tipear' };
  var VERBO = { pensando: 'pensando', leyendo: 'leyendo', escribiendo: 'escribiendo', buscando: 'buscando',
    consultando: 'consultando a', trabajando: 'trabajando' };

  /* pantalla del escritorio: una textura de canvas en las dos caras (hacia el agente y hacia la cámara) */
  function crearPantalla(f) {
    if (!f.asiento) return;
    var c = document.createElement('canvas'); c.width = 128; c.height = 80;
    var tex = new T.CanvasTexture(c);
    if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
    var mat = new T.MeshBasicMaterial({ map: tex, toneMapped: false });
    var geo = geoCache.pantallaPlana || (geoCache.pantallaPlana = new T.PlaneGeometry(1.46, 0.92));
    var cx = f.asiento.x, cz = f.asiento.z - 0.2, tope = PLACA + LADRILLO * 2 + PLACA, y = tope + 0.05 + 0.525;
    var g = new T.Group();
    var adelante = new T.Mesh(geo, mat); adelante.position.set(cx + 1.1, y, cz + 2.45 - 0.045); adelante.rotation.y = Math.PI;
    var atras = new T.Mesh(geo, mat); atras.position.set(cx + 1.1, y, cz + 2.45 + 0.045);
    g.add(adelante, atras);
    mundo.add(g);
    f.pantalla = { canvas: c, ctx: c.getContext('2d'), tex: tex, mat: mat, grupo: g };
    dibujarPantalla(f);
  }

  function dibujarPantalla(f) {
    var P2 = f.pantalla; if (!P2) return;
    var x = P2.ctx, w = 128, h = 80, t = trabajo[f.a.id], n = f.cuadroPant || 0, i;
    var est = t ? t.estado : null;
    x.fillStyle = est === 'leyendo' ? '#f1efe9' : est ? '#1f2227' : '#2a2b2e';
    x.fillRect(0, 0, w, h);
    if (!est) { P2.tex.needsUpdate = true; return; }
    if (est === 'pensando' || est === 'consultando') {
      /* destello giratorio (ocho rayos, uno resaltado que avanza) */
      for (i = 0; i < 8; i++) {
        var a = i / 8 * Math.PI * 2, on = (i === n % 8);
        x.strokeStyle = on ? '#e8875b' : 'rgba(232,135,91,.32)'; x.lineWidth = 7; x.lineCap = 'round';
        x.beginPath(); x.moveTo(64 + Math.cos(a) * 11, 40 + Math.sin(a) * 11); x.lineTo(64 + Math.cos(a) * 24, 40 + Math.sin(a) * 24); x.stroke();
      }
      if (est === 'consultando') { x.fillStyle = '#9ad1ff'; x.beginPath(); x.arc(104, 18, 9, 0, Math.PI * 2); x.fill(); }
    } else if (est === 'leyendo') {
      /* página con renglones que se desplazan */
      var off = (n * 3) % 12;
      x.fillStyle = '#bdb8ae';
      for (i = -1; i < 8; i++) { var yy = 10 + i * 12 - off; if (yy > 4 && yy < 74) x.fillRect(16, yy, 60 + ((i * 37) % 36), 5); }
      x.fillStyle = '#e8875b'; x.fillRect(8, 8, 3, 64);
    } else if (est === 'escribiendo' || est === 'trabajando') {
      /* editor: renglones de colores que van apareciendo y cursor */
      var cols = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff'], lineas = 1 + (n % 9);
      for (i = 0; i < lineas && i < 8; i++) {
        x.fillStyle = cols[(i * 3) % cols.length]; x.fillRect(10 + (i % 3) * 8, 8 + i * 8, 20 + ((i * 29) % 60), 4);
      }
      if (n % 2) { x.fillStyle = '#ffffff'; x.fillRect(12 + ((lineas % 3) * 8) + 40, 8 + Math.min(lineas, 8) * 8, 4, 6); }
    } else if (est === 'buscando') {
      x.fillStyle = '#3a3f47'; for (i = 0; i < 5; i++) x.fillRect(12, 10 + i * 13, 70, 5);
      var mx = 70 + Math.sin(n * 0.5) * 22, my = 40 + Math.cos(n * 0.7) * 12;
      x.strokeStyle = '#9ad1ff'; x.lineWidth = 5; x.beginPath(); x.arc(mx, my, 12, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.moveTo(mx + 9, my + 9); x.lineTo(mx + 20, my + 20); x.stroke();
    }
    P2.tex.needsUpdate = true;
  }

  function pintarTarea(f) {
    var t = trabajo[f.a.id], e = f.etqTarea; if (!e) return;
    e.oculta = !t || f.estado !== 'escritorio' && f.estado !== 'caminando';
    if (!t) return;
    var linea2 = VERBO[t.estado] || t.estado;
    if (t.objetivo) linea2 += ' ' + t.objetivo;
    e.titulo.textContent = t.tarea || (t.origen === 'reunion' ? 'En reunión' : 'Trabajando');
    e.detalle.textContent = linea2;
    e.el.dataset.estado = t.estado;
  }

  /* faros «te necesita»: mapa {id: tipo}; una etiqueta que late sobre la cabeza */
  var faroDe = {};
  function faros(mapa) {
    faroDe = mapa || {};
    for (var id in figuras) {
      var f = figuras[id];
      if (!f.etqFaro) {
        f.etqFaro = etiqueta('faro', '', null);
        vaciarNodo(f.etqFaro.el.firstChild);
        f.etqFaro.el.firstChild.appendChild(document.createElement('b'));
        f.etqFaro.obj = f.obj; f.etqFaro.off = new T.Vector3(0, 6.3, 0);
      }
      f.etqFaro.oculta = !faroDe[id];
      f.etqFaro.el.firstChild.firstChild.textContent = faroDe[id] === 'error' ? '!' : '•';
      f.etqFaro.el.dataset.tipo = faroDe[id] || '';
    }
    pedir();
  }

  /* mapa: {id: {estado, herramienta, objetivo, tarea, origen}} de /api/actividad */
  function actividad(mapa) {
    trabajo = mapa || {};
    for (var id in figuras) {
      var f = figuras[id];
      if (trabajo[id]) { if (f.estado === 'escritorio') animando[id] = true; }
      else if (f.estado === 'escritorio') { sentar(f, f.asiento); f.cuadroPant = 0; }
      dibujarPantalla(f);
      pintarTarea(f);
    }
    consultasActualizar();
    actualizarEtiquetasHover();
    pedir();
  }

  /* Ruta escritorio -> silla de la sala de reuniones, siempre por pasillos:
     salida del escritorio -> puerta de la sala -> pasillo del ala -> (recepción si cambia de ala) -> puerta de reuniones -> silla */
  function rutaHaciaReunion(f, asiento) {
    var pl = plano, r = pl.reunion.sala, pts = [];
    var s = f.asiento ? f.asiento.sala : null;
    if (s) {
      pts.push({ x: f.asiento.salida.x, z: f.asiento.salida.z });
      pts.push({ x: f.asiento.salida.x, z: s.puertaZ });
      pts.push({ x: s.puertaX, z: s.puertaZ });
      pts.push({ x: s.puertaX, z: s.ala.pasilloZ });
      if (s.ala !== r.ala) { pts.push({ x: pl.pasilloX, z: s.ala.pasilloZ }); pts.push({ x: pl.pasilloX, z: r.ala.pasilloZ }); }
    } else {
      pts.push({ x: pl.pasilloX, z: r.ala.pasilloZ });
    }
    pts.push({ x: r.puertaX, z: r.ala.pasilloZ });
    pts.push({ x: r.puertaX, z: r.puertaZ });
    /* rodea la mesa por el lado que corresponde */
    var c = Math.cos(asiento.rot), sn = Math.sin(asiento.rot);
    if (c > 0.5) { pts.push({ x: r.puertaX, z: asiento.z - 1.8 }); pts.push({ x: asiento.x, z: asiento.z - 1.8 }); }
    else if (c < -0.5) pts.push({ x: asiento.x, z: asiento.z + 1.6 });
    else pts.push({ x: asiento.x - sn * 1.6, z: r.puertaZ }), pts.push({ x: asiento.x - sn * 1.6, z: asiento.z });
    pts.push({ x: asiento.x, z: asiento.z });
    return pts;
  }

  var reunionActual = null;
  /* agentes: ids en la reunión; hablando: id o null. Los que no están vuelven a su escritorio. */
  function reunion(ids, quien, forzar) {
    reunionActual = ids && ids.length ? { agentes: ids.slice(), hablando: quien } : null;
    if (!plano || !plano.reunion) return;
    var asientos = plano.reunion.asientos, usados = 0;
    hablando = quien || null;
    Object.keys(figuras).forEach(function (id) {
      var f = figuras[id], idx = ids ? ids.indexOf(id) : -1;
      if (idx >= 0 && idx < asientos.length) {
        var a = asientos[idx]; usados++;
        if (f.estado === 'escritorio' || (forzar && f.estado !== 'en-reunion' && f.estado !== 'caminando')) {
          caminar(id, rutaHaciaReunion(f, a), function () { f.estado = 'en-reunion'; sentar(f, a); f.enSilla = a; if (hablando === id) { f.estado = 'hablando'; } });
        } else if (f.estado === 'en-reunion' || f.estado === 'hablando') {
          f.estado = hablando === id ? 'hablando' : 'en-reunion';
          if (f.estado === 'hablando') animando[id] = true; else sentar(f, f.enSilla || a);
        }
      } else if (f.estado !== 'escritorio' && !f.consulta) {
        volver(id);
      }
    });
    actualizarEtiquetasHover();
    sombrasSucias = true; pedir();
  }
  function volver(id) {
    var f = figuras[id]; if (!f) return;
    if (!f.asiento) { f.estado = 'escritorio'; sentar(f, null); return; }
    var ida = rutaHaciaReunion(f, f.enSilla || plano.reunion.asientos[0]).reverse();
    ida.shift();
    ida.push({ x: f.asiento.x, z: f.asiento.z });
    caminar(id, ida, function () {
      f.estado = 'escritorio'; sentar(f, f.asiento); f.enSilla = null; sombrasSucias = true;
      if (trabajo[id]) animando[id] = true;
      pintarTarea(f);
    });
  }


  /* ---------------- consultas entre agentes (Fase 4) ----------------
     Cuando la actividad de A muestra la herramienta mcp__hq__consultar con objetivo = B (id o nombre), A camina desde su
     escritorio hasta el de B por los pasillos, queda parado ahí con un globito «?» y vuelve a su escritorio cuando su
     actividad deja de estar en «consultando». f.consulta = {colega, fase: yendo|esperando|volviendo, ruta, volver}. */
  function sinTildes(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

  /* id del colega que A está consultando ahora (según /api/actividad), o null */
  function colegaConsultado(id) {
    var t = trabajo[id];
    if (!t || t.estado !== 'consultando' || !/^mcp__hq__consultar/.test(t.herramienta || '') || !t.objetivo) return null;
    if (t.objetivo !== id && figuras[t.objetivo]) return t.objetivo;
    var q = sinTildes(t.objetivo);
    for (var k in figuras) if (k !== id && (sinTildes(k) === q || sinTildes(figuras[k].a.nombre) === q)) return k;
    return null;
  }

  /* Ruta escritorio de f -> al lado del escritorio de g, siempre por pasillos:
     salida del escritorio -> puerta de su sala -> pasillo del ala -> (recepción si cambia de ala) -> puerta de la sala de g -> al lado de g.
     `n`: cuántos otros esperan ya junto a g (se paran un poco más lejos para no apilarse). Null si alguno no tiene escritorio. */
  function rutaHaciaColega(f, g, n) {
    var pl = plano, pts = [];
    if (!pl || !f.asiento || !g.asiento) return null;
    var s = f.asiento.sala, d = g.asiento.sala, a = f.asiento.salida, b = g.asiento.salida;
    pts.push({ x: a.x, z: a.z });
    pts.push({ x: a.x, z: s.puertaZ });
    if (s === d) {
      pts.push({ x: b.x, z: s.puertaZ });
    } else {
      pts.push({ x: s.puertaX, z: s.puertaZ });
      pts.push({ x: s.puertaX, z: s.ala.pasilloZ });
      if (s.ala !== d.ala) { pts.push({ x: pl.pasilloX, z: s.ala.pasilloZ }); pts.push({ x: pl.pasilloX, z: d.ala.pasilloZ }); }
      pts.push({ x: d.puertaX, z: d.ala.pasilloZ });
      pts.push({ x: d.puertaX, z: d.puertaZ });
      pts.push({ x: b.x, z: d.puertaZ });
    }
    pts.push({ x: b.x, z: b.z + (n || 0) * 1.4 });
    return pts;
  }

  function globoConsulta(f, ver) {
    if (!f.etqConsulta && ver) {
      var e = etiqueta('consulta', '?', null);
      e.obj = f.obj; e.off = new T.Vector3(0, 6.4, 0); e.oculta = true;
      f.etqConsulta = e;
    }
    if (f.etqConsulta) f.etqConsulta.oculta = !ver;
  }

  function esperandoJuntoA(quien, salvo) {
    var n = 0;
    for (var k in figuras) if (k !== salvo && figuras[k].consulta && figuras[k].consulta.colega === quien) n++;
    return n;
  }

  function irAConsultar(f, quien) {
    var g = figuras[quien], ruta = g ? rutaHaciaColega(f, g, esperandoJuntoA(quien, f.a.id)) : null;
    if (!ruta) return;
    var c = f.consulta, previa = c && c.fase === 'esperando' && figuras[c.colega] ? c.ruta.slice().reverse() : [];
    f.consulta = { colega: quien, fase: 'yendo', ruta: ruta, volver: false };
    globoConsulta(f, false);
    caminar(f.a.id, previa.concat(ruta), function () { llegoAConsultar(f); });
    sombrasSucias = true;
  }

  function llegoAConsultar(f) {
    var c = f.consulta, g = c && figuras[c.colega];
    if (!c) return;
    P.pose(f.obj, '');
    if (g && g.asiento) f.obj.rotation.y = Math.atan2(g.asiento.x - f.obj.position.x, g.asiento.z - f.obj.position.z);
    c.fase = 'esperando';
    globoConsulta(f, true);
    if (c.volver || !colegaConsultado(f.a.id)) volverDeConsulta(f); else consultasActualizar();
    sombrasSucias = true; pedir();
  }

  function volverDeConsulta(f) {
    var c = f.consulta;
    if (!c || c.fase === 'volviendo') return;
    c.fase = 'volviendo';
    globoConsulta(f, false);
    var ida = c.ruta.slice().reverse();
    ida.push({ x: f.asiento.x, z: f.asiento.z });
    caminar(f.a.id, ida, function () {
      f.consulta = null; f.estado = 'escritorio'; sentar(f, f.asiento); sombrasSucias = true;
      if (trabajo[f.a.id]) animando[f.a.id] = true;
      pintarTarea(f);
      consultasActualizar();
      pedir();
    });
  }

  /* se llama desde actividad(): arranca, mantiene o termina las consultas según el mapa de actividad */
  function consultasActualizar() {
    if (!plano) return;
    Object.keys(figuras).forEach(function (id) {
      var f = figuras[id], c = f.consulta, quien = colegaConsultado(id);
      if (quien) {
        if (!c) { if (f.estado === 'escritorio') irAConsultar(f, quien); }
        else if (c.colega !== quien) { if (c.fase === 'esperando') irAConsultar(f, quien); }
        else c.volver = false;
      } else if (c) {
        if (c.fase === 'esperando') volverDeConsulta(f); else if (c.fase === 'yendo') c.volver = true;
      }
    });
  }

  /* ---------------- API ---------------- */
  return {
    iniciar: iniciar,
    construir: construir,
    alElegirAgente: function (fn) { cbAgente = fn; },
    alElegirLugar: function (fn) { cbLugar = fn; },
    alPasar: function (fn) { cbHover = fn; },
    elegir: function (id) { elegido = id; actualizarEtiquetasHover(); pedir(); },
    ocupado: function (id, si) { var f = figuras[id]; if (!f) return; f.ocupado = !!si; f.etiqueta.el.classList.toggle('ocupado', !!si); actualizarEtiquetasHover(); pedir(); },
    reunion: reunion,
    finReunion: function () { reunion([], null); },
    encuadrar: function () { encuadrar(true); pedir(); },
    actividad: actividad,
    faros: faros,
    enfocar: enfocar,
    enfocarAgente: enfocarAgente,
    enfocarLugar: enfocarLugar,
    pedir: pedir,
    _estado: function () { return { figuras: Object.keys(figuras).length, animando: Object.keys(animando), orb: orb, plano: plano && { w: plano.x1, d: plano.z1 }, info: renderer.info.render }; }
  };
})();
