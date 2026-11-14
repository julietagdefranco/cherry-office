/* Piezas LDraw: carga el paquete minifigs.mpd una sola vez, parsea cada pieza a demanda (una geometría por pieza,
   compartida entre todas las figuras) y arma minifigs a partir de un avatar
   {pelo, cara, torso, piernas, sombrero, cuello, colorPiel, colorPelo, colorTorso, colorBrazos, colorPiernas, colorAccesorio}.
   Unidades: 1 unidad de mundo = 1 stud = 20 LDU. Las figuras miran hacia +z del mundo. */
window.App = window.App || {};
App.Piezas = (function () {
  'use strict';
  var T = window.THREE;
  var LDU = 1 / 20;
  var COD_PRINCIPAL = '9999';
  var paquete = null;          // Promise<{archivos, ldconfig, catalogo}>
  var geos = {};               // parte -> Promise<{geo, ranuras}>
  var mats = {};               // clave -> material

  /* ---------- materiales: plástico ABS (PBR, sin metal, brillo medio) ---------- */
  function lineal(hex) { return new T.Color(hex).convertSRGBToLinear(); }
  function plastico(hex, opciones) {
    var o = opciones || {};
    var k = hex + '|' + (o.opacidad || 1) + '|' + (o.rugosidad || 0);
    if (mats[k]) return mats[k];
    var m = new T.MeshStandardMaterial({ color: lineal(hex), roughness: o.rugosidad || 0.3, metalness: 0, envMapIntensity: 1 });
    if (o.opacidad && o.opacidad < 1) { m.transparent = true; m.opacity = o.opacidad; m.depthWrite = false; }
    mats[k] = m;
    return m;
  }

  /* ---------- paquetes MPD ----------
     minifigs.mpd: piezas de las figuras (+ catalogo.json). oficina.mpd: muebles, plantas, árboles y autos de la maqueta. */
  function leerMPD(texto) {
    var archivos = {}, actual = null, buf = [];
    var lineas = texto.split(/\r?\n/);
    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i];
      if (l.lastIndexOf('0 FILE ', 0) === 0) {
        if (actual) archivos[actual] = buf.join('\n');
        actual = l.slice(7).trim().toLowerCase(); buf = [];
      } else if (l.lastIndexOf('0 NOFILE', 0) !== 0) buf.push(l);
    }
    if (actual) archivos[actual] = buf.join('\n');
    var ldconfig = (archivos.ldconfig || '') + '\n0 !COLOUR HQ_Principal CODE ' + COD_PRINCIPAL + ' VALUE #FF00FF EDGE #333333\n';
    return { archivos: archivos, ldconfig: ldconfig };
  }
  /* no-cache: revalida con el servidor, así un paquete reempaquetado no queda viejo en la caché del navegador */
  function traer(ruta) {
    return fetch((window.APP_BASE || '') + ruta, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(ruta + ' ' + r.status); return r.text(); });
  }
  function cargar() {
    if (paquete) return paquete;
    paquete = Promise.all([
      traer('ldraw/minifigs.mpd'),
      fetch((window.APP_BASE || '') + 'ldraw/catalogo.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('catalogo.json ' + r.status); return r.json(); })
    ]).then(function (res) {
      var p = leerMPD(res[0]);
      p.catalogo = res[1];
      return p;
    });
    return paquete;
  }
  var paqueteOficina = null;
  function cargarOficina() {
    if (!paqueteOficina) paqueteOficina = traer('ldraw/oficina.mpd').then(leerMPD);
    return paqueteOficina;
  }

  /* Parsea una pieza y la deja como UNA geometría con grupos por color. Las caras de color principal (16 en LDraw)
     quedan marcadas como ranura 'principal' para pintarlas con el color del avatar (o del mueble).
     fuente: 'oficina' para las piezas de la maqueta; si no, las de las figuras. */
  function pieza(parte, fuente) {
    var clave = (fuente || '') + ':' + parte;
    if (geos[clave]) return geos[clave];
    geos[clave] = (fuente === 'oficina' ? cargarOficina() : cargar()).then(function (p) {
      if (!p.archivos[parte.toLowerCase() + '.dat']) throw new Error('Pieza fuera del paquete: ' + parte);
      return new Promise(function (ok) {
        var L = new T.LDrawLoader();
        L.fileMap = {};
        L.smoothNormals = true;
        for (var k in p.archivos) L.subobjectCache[k] = p.archivos[k];
        L.parse(p.ldconfig + '1 ' + COD_PRINCIPAL + ' 0 0 0 1 0 0 0 1 0 0 0 1 ' + parte + '.dat\n', '', ok);
      });
    }).then(function (grupo) {
      var malla = null;
      grupo.traverse(function (o) { if (o.isMesh && !malla) malla = o; });
      if (!malla) throw new Error('Pieza vacía: ' + parte);
      var geo = malla.geometry;
      var lista = Array.isArray(malla.material) ? malla.material : [malla.material];
      var ranuras = lista.map(function (m) {
        var cod = m.userData && m.userData.code;
        if (cod === COD_PRINCIPAL) return { principal: true };
        return { hex: '#' + m.color.getHexString(), opacidad: m.transparent ? m.opacity : 1, codigo: String(cod) };
      });
      geo.computeBoundingBox();
      grupo.traverse(function (o) { if (o !== malla && o.geometry) o.geometry.dispose(); });
      return { geo: geo, ranuras: ranuras };
    });
    return geos[clave];
  }

  /* hexPiel: si viene, el amarillo LDraw (14) se pinta del color de piel. Los estampados de torso dibujan la piel
     del cuello y el escote en amarillo fijo, pensando en figuras amarillas. */
  function malla(def, hexPrincipal, hexPiel) {
    var m = def.ranuras.map(function (r) {
      if (r.principal) return plastico(hexPrincipal);
      if (hexPiel && r.codigo === '14') return plastico(hexPiel);
      return plastico(r.hex, { opacidad: r.opacidad });
    });
    var x = new T.Mesh(def.geo, m.length === 1 ? m[0] : m);
    x.castShadow = true; x.receiveShadow = true;
    return x;
  }

  /* ---------- avatar ---------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function elegir(lista, h, sal) { return lista[(hash(h + ':' + sal)) % lista.length]; }

  var HEX = /^#[0-9a-f]{6}$/i;
  function hexDe(lista, i) { var c = lista[i]; return typeof c === 'string' ? c : c.hex; }

  /* Completa un avatar con valores deterministas a partir de la semilla (el mismo id da siempre la misma figura).
     Por defecto elige pelo, cara y torso solo entre las piezas originales (cat.legado) y deja piel amarilla, pantalón,
     mangas del color del torso y sin accesorios: así los avatares guardados antes de ampliar el catálogo no cambian.
     Con todo=true (botón «Otro aspecto») sortea entre todo el catálogo, con género coherente entre cara, pelo y ropa. */
  function completar(av, cat, semilla, todo) {
    var a = Object.assign({}, av || {});
    var s = a.semilla || semilla || 'x';
    a.semilla = s;
    var leg = cat.legado || {};
    function claves(g, genero) {
      var ks = Object.keys(cat[g] || {});
      if (!todo && leg[g]) ks = ks.slice(0, leg[g]);
      if (genero) { var f = ks.filter(function (k) { var x = cat[g][k].genero; return !x || x === 'u' || x === genero; }); if (f.length) ks = f; }
      return ks;
    }
    var col = cat.colores;
    if (!cat.cara[a.cara]) a.cara = elegir(claves('cara'), s, 'c');
    var gen = todo ? cat.cara[a.cara].genero : null;
    if (!cat.pelo[a.pelo]) a.pelo = elegir(claves('pelo', gen), s, 'p');
    if (!cat.torso[a.torso]) a.torso = elegir(claves('torso', gen), s, 't');
    if (!HEX.test(a.colorPelo || '')) a.colorPelo = hexDe(col.pelo, hash(s + ':cp') % col.pelo.length);
    if (!HEX.test(a.colorTorso || '')) a.colorTorso = hexDe(col.torso, hash(s + ':ct') % col.torso.length);
    if (!HEX.test(a.colorPiernas || '')) a.colorPiernas = hexDe(col.piernas, hash(s + ':cl') % col.piernas.length);
    var sorteo = function (sal) { return (hash(s + ':' + sal) % 100) / 100; };
    if (!HEX.test(a.colorPiel || '')) a.colorPiel = todo ? hexDe(col.piel, hash(s + ':cs') % col.piel.length) : hexDe(col.piel, 0);
    if (!HEX.test(a.colorBrazos || '')) a.colorBrazos = todo && sorteo('mb') < 0.3 ? hexDe(col.torso, hash(s + ':cb') % col.torso.length) : a.colorTorso;
    if (!HEX.test(a.colorAccesorio || '')) a.colorAccesorio = hexDe(col.accesorio, hash(s + ':ca') % col.accesorio.length);
    if (!(cat.piernas || {})[a.piernas]) a.piernas = todo && gen === 'f' && sorteo('fa') < 0.45 ? elegir(claves('piernas', 'f').slice(1), s, 'fa') : 'pantalon';
    if (!(cat.sombrero || {})[a.sombrero]) a.sombrero = todo && sorteo('so') < 0.15 ? elegir(Object.keys(cat.sombrero).slice(1), s, 'so') : 'ninguno';
    if (!(cat.cuello || {})[a.cuello]) a.cuello = todo && sorteo('cu') < 0.15 ? elegir(claves('cuello', gen).slice(1), s, 'cu') : 'nada';
    return a;
  }

  /* Arma la minifig. Devuelve un Group (origen = entre los pies, en el piso) con userData.partes para animar. */
  function figura(avatar, semilla) {
    return cargar().then(function (p) {
      var cat = p.catalogo, a = completar(avatar, cat, semilla), b = cat.base;
      var pier = (cat.piernas || {})[a.piernas] || {}, somb = (cat.sombrero || {})[a.sombrero] || {}, cue = (cat.cuello || {})[a.cuello] || {};
      var partes = [cat.torso[a.torso].parte, cat.cara[a.cara].parte, somb.parte || cat.pelo[a.pelo].parte, b.brazoD, b.brazoI, b.mano,
        pier.reemplaza ? pier.parte : b.cadera, b.piernaD, b.piernaI, (!pier.reemplaza && pier.parte) || null, cue.parte || null];
      return Promise.all(partes.map(function (x) { return x ? pieza(x) : null; })).then(function (d) {
        var raiz = new T.Group();            // espacio de mundo, en studs
        var ld = new T.Group();              // espacio LDraw: y hacia abajo; la figura mira hacia -z
        ld.scale.setScalar(LDU);
        ld.rotation.x = Math.PI;              // y hacia arriba y frente hacia +z
        raiz.add(ld);
        var cuerpo = new T.Group(); ld.add(cuerpo);  // origen = arriba de los hombros
        cuerpo.add(malla(d[0], a.colorTorso, cat.torso[a.torso].amarilloFijo ? null : a.colorPiel));
        var cabeza = new T.Group(); cabeza.position.set(0, -24, 0); cuerpo.add(cabeza);
        cabeza.add(malla(d[1], a.colorPiel));
        cabeza.add(malla(d[2], somb.parte ? a.colorAccesorio : a.colorPelo));   // el sombrero va en lugar del pelo
        if (d[10]) { var cue3 = malla(d[10], cue.color === 'pelo' ? a.colorPelo : a.colorAccesorio); cue3.position.y = 24; cabeza.add(cue3); }  // cuello: origen en los hombros, gira con la cabeza
        function brazo(def, x, lado) {
          var g = new T.Group(); g.position.set(x, 8, 0); g.rotation.z = lado * 0.1;
          g.add(malla(def, a.colorBrazos));
          var mano = malla(d[5], a.colorPiel);
          mano.position.set(-lado, 19, -8);
          mano.rotation.x = Math.PI / 4;
          g.add(mano);
          cuerpo.add(g);
          return g;
        }
        var brazoD = brazo(d[3], -15.552, 1), brazoI = brazo(d[4], 15.552, -1);
        var cadera = malla(d[6], a.colorPiernas); cadera.position.y = 32; cuerpo.add(cadera);
        var colorPatas = pier.parte && !pier.reemplaza ? a.colorPiel : a.colorPiernas;   // bajo una falda de tela, piernas a la vista
        function pierna(def) { var g = new T.Group(); g.position.y = 44; if (def) g.add(malla(def, colorPatas)); cuerpo.add(g); return g; }
        /* falda larga: una sola pieza en lugar de cadera y piernas (los grupos de pierna quedan vacíos para las poses) */
        var piernaD = pierna(pier.reemplaza ? null : d[7]), piernaI = pierna(pier.reemplaza ? null : d[8]);
        if (d[9]) { var falda = malla(d[9], a.colorPiernas); falda.position.y = 32; cuerpo.add(falda); }
        ld.updateMatrixWorld(true);
        var caja = new T.Box3().setFromObject(ld);
        raiz.userData.altura = caja.max.y - caja.min.y;
        ld.position.y = -caja.min.y;
        raiz.userData.partes = { cuerpo: cuerpo, cabeza: cabeza, brazoD: brazoD, brazoI: brazoI, piernaD: piernaD, piernaI: piernaI, ld: ld };
        raiz.userData.avatar = a;
        return raiz;
      });
    });
  }

  /* Poses: valores en radianes sobre los pivotes de cadera y hombros. */
  function pose(fig, nombre, fase) {
    var p = fig.userData.partes; if (!p) return;
    var s = Math.sin(fase || 0);
    if (nombre === 'sentado') {
      p.piernaD.rotation.x = p.piernaI.rotation.x = -Math.PI / 2;
      p.brazoD.rotation.x = p.brazoI.rotation.x = -0.55;
    } else if (nombre === 'caminar') {
      p.piernaD.rotation.x = s * 0.6; p.piernaI.rotation.x = -s * 0.6;
      p.brazoD.rotation.x = -s * 0.5; p.brazoI.rotation.x = s * 0.5;
    } else if (nombre === 'hablar') {
      p.brazoD.rotation.x = -0.55 - Math.max(0, s) * 0.5;
      p.cabeza.rotation.y = Math.sin((fase || 0) * 0.5) * 0.15;
    } else if (nombre === 'tipear') {          /* sobre 'sentado': manos al teclado, alternando */
      p.brazoD.rotation.x = -1.05 + Math.max(0, s) * 0.12;
      p.brazoI.rotation.x = -1.05 + Math.max(0, -s) * 0.12;
      p.cabeza.rotation.y = 0;
    } else if (nombre === 'leer') {            /* mira la pantalla y recorre con la vista */
      p.brazoD.rotation.x = p.brazoI.rotation.x = -0.8;
      p.cabeza.rotation.y = Math.sin((fase || 0) * 0.35) * 0.22;
    } else if (nombre === 'pensar') {          /* mano al mentón */
      p.brazoD.rotation.x = -1.75 + Math.sin((fase || 0) * 0.4) * 0.05;
      p.brazoI.rotation.x = -0.55;
      p.cabeza.rotation.y = 0.18;
    } else if (nombre === 'mirar') {           /* busca: gira la cabeza de lado a lado */
      p.brazoD.rotation.x = p.brazoI.rotation.x = -0.75;
      p.cabeza.rotation.y = Math.sin((fase || 0) * 0.6) * 0.45;
    } else if (nombre === 'jugar') {           /* sobre 'sentado': joystick en las manos, pulgares rápidos */
      p.brazoD.rotation.x = -1.15 + Math.max(0, s) * 0.1;
      p.brazoI.rotation.x = -1.15 + Math.max(0, Math.sin((fase || 0) * 1.3)) * 0.1;
      p.cabeza.rotation.y = Math.sin((fase || 0) * 0.07) * 0.14;
    } else if (nombre === 'arcade') {          /* parado: una mano en la palanca, la otra en los botones */
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoI.rotation.x = -1.25 + s * 0.12;
      p.brazoD.rotation.x = -1.2 + Math.max(0, Math.sin((fase || 0) * 1.7)) * 0.18;
      p.cabeza.rotation.y = 0;
    } else if (nombre === 'paleta') {          /* ping-pong: fase = golpe (-0.5 paleta atrás, 0 en guardia, 1 swing hacia adelante) */
      var g = Math.min(1, Math.max(-1, fase || 0));
      p.piernaD.rotation.x = 0.15; p.piernaI.rotation.x = -0.15;
      p.brazoD.rotation.x = -0.75 - g * 0.95;
      p.brazoI.rotation.x = -0.45;
    } else if (nombre === 'charla') {          /* sobre 'sentado': taza en la mano, sorbos de vez en cuando, mira a los demás */
      var sorbo2 = Math.max(0, (Math.sin((fase || 0) * 0.5) - 0.7) / 0.3);
      p.brazoD.rotation.x = -0.75 - sorbo2 * 1.25;
      p.brazoI.rotation.x = -0.55;
      p.cabeza.rotation.y = sorbo2 ? 0 : Math.sin((fase || 0) * 0.23) * 0.45;
    } else if (nombre === 'metegol') {         /* parado, las dos manos en los mangos, girando y empujando */
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoD.rotation.x = -1.3 + Math.sin((fase || 0) * 1.1) * 0.25;
      p.brazoI.rotation.x = -1.3 + Math.sin((fase || 0) * 0.9 + 1.5) * 0.25;
      p.cabeza.rotation.y = Math.sin((fase || 0) * 0.15) * 0.3;
    } else if (nombre === 'pinball') {         /* parado, una mano a cada lado del mueble: botonazos */
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoD.rotation.x = -1.0 + (Math.sin((fase || 0) * 1.6) > 0.6 ? 0.18 : 0);
      p.brazoI.rotation.x = -1.0 + (Math.sin((fase || 0) * 1.3 + 2) > 0.6 ? 0.18 : 0);
      p.cabeza.rotation.y = 0;
    } else if (nombre === 'cafe') {            /* parado con la taza: cada tanto un sorbo, y charla mirando a los costados */
      var sorbo = Math.max(0, (Math.sin((fase || 0) * 0.5) - 0.7) / 0.3);
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoI.rotation.x = -0.15;
      p.brazoD.rotation.x = -0.75 - sorbo * 1.25;
      p.cabeza.rotation.y = sorbo ? 0 : Math.sin((fase || 0) * 0.23) * 0.4;
    } else {
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoD.rotation.x = p.brazoI.rotation.x = 0;
      p.cabeza.rotation.y = 0;
    }
    if (nombre === 'sentado') p.cabeza.rotation.y = 0;
  }

  /* ---------- entorno de estudio (iluminación basada en imagen, generada sin texturas externas) ---------- */
  function entorno(renderer) {
    var esc = new T.Scene();
    var cuarto = new T.Mesh(new T.BoxGeometry(40, 20, 40), new T.MeshBasicMaterial({ color: lineal('#6f6c68'), side: T.BackSide }));
    cuarto.position.y = 6; esc.add(cuarto);
    function panel(w, h, x, y, z, ry, rx, int) {
      var m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(int, int, int), side: T.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0); esc.add(m);
    }
    panel(18, 18, 0, 15.9, 0, 0, Math.PI / 2, 3.2);     // cenital grande y suave
    panel(10, 8, -19.9, 6, 4, Math.PI / 2, 0, 2.2);     // relleno lateral
    panel(10, 8, 19.9, 7, -6, -Math.PI / 2, 0, 1.4);    // contraluz
    var piso = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshBasicMaterial({ color: lineal('#8d8a85') }));
    piso.rotation.x = -Math.PI / 2; piso.position.y = -3.9; esc.add(piso);
    var pm = new T.PMREMGenerator(renderer);
    var tex = pm.fromScene(esc, 0.04).texture;
    pm.dispose();
    esc.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return tex;
  }

  function prepararRenderer(r) {
    r.outputEncoding = T.sRGBEncoding;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.physicallyCorrectLights = true;
  }

  /* ---------- retratos: una sola cámara y un renderer chico, en cola, cacheados por avatar ---------- */
  var ret = null, cola = Promise.resolve(), retratos = {};
  /* encuadre: 'busto' (por defecto), 'cara' (cabeza con pelo y accesorios), 'torso' o 'cuerpo' (de la cintura para abajo, para ver la falda). */
  function retrato(avatar, semilla, tam, encuadre) {
    tam = tam || 160;
    var clave = JSON.stringify([avatar || {}, semilla || '', tam, encuadre || '']);
    if (retratos[clave]) return retratos[clave];
    retratos[clave] = cola = cola.catch(function () {}).then(function () {
      return figura(avatar, semilla).then(function (fig) {
        if (!ret) {
          var cv = document.createElement('canvas');
          var r = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
          prepararRenderer(r);
          r.setPixelRatio(1);
          var esc = new T.Scene();
          esc.environment = entorno(r);
          var luz = new T.DirectionalLight(0xffffff, 1.6); luz.position.set(2, 5, 6); esc.add(luz);
          var cam = new T.PerspectiveCamera(22, 1, 0.1, 100);
          ret = { r: r, esc: esc, cam: cam };
        }
        ret.r.setSize(tam, tam, false);
        ret.esc.add(fig);
        var h = fig.userData.altura;
        if (encuadre === 'cara' || encuadre === 'torso') {
          fig.updateMatrixWorld(true);
          var pt = fig.userData.partes, ref = encuadre === 'cara' ? pt.cabeza.children[0] : pt.cuerpo.children[0];  // la cabeza sola, sin pelo
          var c = new T.Box3().setFromObject(ref).getCenter(new T.Vector3());
          if (encuadre === 'cara') c.y += 0.25;   // deja lugar arriba para el pelo o el sombrero
          var dist = encuadre === 'cara' ? 4.6 : 5.2;
          ret.cam.position.set(c.x + dist * 0.16, c.y + dist * 0.06, dist);
          ret.cam.lookAt(c.x, c.y, 0);
        } else if (encuadre === 'cuerpo') {
          ret.cam.position.set(h * 0.4, h * 0.5, h * 2.2);   // de la cintura para abajo, con algo de torso
          ret.cam.lookAt(0, h * 0.36, 0);
        } else {
          ret.cam.position.set(1.3, h * 0.78, 8.2);
          ret.cam.lookAt(0, h * 0.67, 0);
        }
        ret.r.render(ret.esc, ret.cam);
        var url = ret.r.domElement.toDataURL('image/png');
        ret.esc.remove(fig);
        return url;
      });
    });
    return retratos[clave];
  }

  function catalogo() { return cargar().then(function (p) { return p.catalogo; }); }

  return {
    cargar: cargar, catalogo: catalogo, figura: figura, pieza: pieza, pose: pose, retrato: retrato,
    completar: function (av, semilla, todo) { return catalogo().then(function (c) { return completar(av, c, semilla, todo); }); },
    plastico: plastico, lineal: lineal, entorno: entorno, prepararRenderer: prepararRenderer, LDU: LDU
  };
})();
