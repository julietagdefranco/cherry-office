/* Piezas LDraw: carga el paquete minifigs.mpd una sola vez, parsea cada pieza a demanda (una geometría por pieza,
   compartida entre todas las figuras) y arma minifigs a partir de un avatar {pelo, cara, torso, colores}.
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

  /* ---------- paquete MPD ---------- */
  function cargar() {
    if (paquete) return paquete;
    paquete = Promise.all([
      fetch((window.APP_BASE || '') + 'ldraw/minifigs.mpd').then(function (r) { if (!r.ok) throw new Error('minifigs.mpd ' + r.status); return r.text(); }),
      fetch((window.APP_BASE || '') + 'ldraw/catalogo.json').then(function (r) { if (!r.ok) throw new Error('catalogo.json ' + r.status); return r.json(); })
    ]).then(function (res) {
      var archivos = {}, actual = null, buf = [];
      var lineas = res[0].split(/\r?\n/);
      for (var i = 0; i < lineas.length; i++) {
        var l = lineas[i];
        if (l.lastIndexOf('0 FILE ', 0) === 0) {
          if (actual) archivos[actual] = buf.join('\n');
          actual = l.slice(7).trim().toLowerCase(); buf = [];
        } else if (l.lastIndexOf('0 NOFILE', 0) !== 0) buf.push(l);
      }
      if (actual) archivos[actual] = buf.join('\n');
      var ldconfig = (archivos.ldconfig || '') + '\n0 !COLOUR HQ_Principal CODE ' + COD_PRINCIPAL + ' VALUE #FF00FF EDGE #333333\n';
      return { archivos: archivos, ldconfig: ldconfig, catalogo: res[1] };
    });
    return paquete;
  }

  /* Parsea una pieza y la deja como UNA geometría con grupos por color. Las caras de color principal (16 en LDraw)
     quedan marcadas como ranura 'principal' para pintarlas con el color del avatar. */
  function pieza(parte) {
    if (geos[parte]) return geos[parte];
    geos[parte] = cargar().then(function (p) {
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
        return { hex: '#' + m.color.getHexString(), opacidad: m.transparent ? m.opacity : 1 };
      });
      geo.computeBoundingBox();
      grupo.traverse(function (o) { if (o !== malla && o.geometry) o.geometry.dispose(); });
      return { geo: geo, ranuras: ranuras };
    });
    return geos[parte];
  }

  function malla(def, hexPrincipal) {
    var m = def.ranuras.map(function (r) { return r.principal ? plastico(hexPrincipal) : plastico(r.hex, { opacidad: r.opacidad }); });
    var x = new T.Mesh(def.geo, m.length === 1 ? m[0] : m);
    x.castShadow = true; x.receiveShadow = true;
    return x;
  }

  /* ---------- avatar ---------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function elegir(lista, h, sal) { return lista[(hash(h + ':' + sal)) % lista.length]; }

  /* Completa un avatar con valores deterministas a partir de la semilla (el mismo id da siempre la misma figura). */
  function completar(av, cat, semilla) {
    var a = Object.assign({}, av || {});
    var s = a.semilla || semilla || 'x';
    a.semilla = s;
    var pelos = Object.keys(cat.pelo), caras = Object.keys(cat.cara), torsos = Object.keys(cat.torso);
    if (!cat.pelo[a.pelo]) a.pelo = elegir(pelos, s, 'p');
    if (!cat.cara[a.cara]) a.cara = elegir(caras, s, 'c');
    if (!cat.torso[a.torso]) a.torso = elegir(torsos, s, 't');
    if (!/^#[0-9a-f]{6}$/i.test(a.colorPelo || '')) a.colorPelo = elegir(cat.colores.pelo, s, 'cp').hex;
    if (!/^#[0-9a-f]{6}$/i.test(a.colorTorso || '')) a.colorTorso = elegir(cat.colores.torso, s, 'ct').hex;
    if (!/^#[0-9a-f]{6}$/i.test(a.colorPiernas || '')) a.colorPiernas = elegir(cat.colores.piernas, s, 'cl').hex;
    return a;
  }

  /* Arma la minifig. Devuelve un Group (origen = entre los pies, en el piso) con userData.partes para animar. */
  function figura(avatar, semilla) {
    return cargar().then(function (p) {
      var cat = p.catalogo, a = completar(avatar, cat, semilla), b = cat.base;
      var piel = (cat.colores.piel && cat.colores.piel[0]) || '#f6c928';
      var partes = [cat.torso[a.torso].parte, cat.cara[a.cara].parte, cat.pelo[a.pelo].parte, b.brazoD, b.brazoI, b.mano, b.cadera, b.piernaD, b.piernaI];
      return Promise.all(partes.map(pieza)).then(function (d) {
        var raiz = new T.Group();            // espacio de mundo, en studs
        var ld = new T.Group();              // espacio LDraw: y hacia abajo; la figura mira hacia -z
        ld.scale.setScalar(LDU);
        ld.rotation.x = Math.PI;              // y hacia arriba y frente hacia +z
        raiz.add(ld);
        var cuerpo = new T.Group(); ld.add(cuerpo);  // origen = arriba de los hombros
        cuerpo.add(malla(d[0], a.colorTorso));
        var cabeza = new T.Group(); cabeza.position.set(0, -24, 0); cuerpo.add(cabeza);
        cabeza.add(malla(d[1], piel));
        cabeza.add(malla(d[2], a.colorPelo));
        function brazo(def, x, lado) {
          var g = new T.Group(); g.position.set(x, 8, 0); g.rotation.z = lado * 0.1;
          g.add(malla(def, a.colorTorso));
          var mano = malla(d[5], piel);
          mano.position.set(-lado, 19, -8);
          mano.rotation.x = Math.PI / 4;
          g.add(mano);
          cuerpo.add(g);
          return g;
        }
        var brazoD = brazo(d[3], -15.552, 1), brazoI = brazo(d[4], 15.552, -1);
        var cadera = malla(d[6], a.colorPiernas); cadera.position.y = 32; cuerpo.add(cadera);
        function pierna(def) { var g = new T.Group(); g.position.y = 44; g.add(malla(def, a.colorPiernas)); cuerpo.add(g); return g; }
        var piernaD = pierna(d[7]), piernaI = pierna(d[8]);
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
    } else {
      p.piernaD.rotation.x = p.piernaI.rotation.x = 0;
      p.brazoD.rotation.x = p.brazoI.rotation.x = 0;
      p.cabeza.rotation.y = 0;
    }
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
  function retrato(avatar, semilla, tam) {
    tam = tam || 160;
    var clave = JSON.stringify([avatar || {}, semilla || '', tam]);
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
        ret.cam.position.set(1.3, h * 0.78, 8.2);
        ret.cam.lookAt(0, h * 0.67, 0);
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
    cargar: cargar, catalogo: catalogo, figura: figura, pose: pose, retrato: retrato,
    completar: function (av, semilla) { return catalogo().then(function (c) { return completar(av, c, semilla); }); },
    plastico: plastico, lineal: lineal, entorno: entorno, prepararRenderer: prepararRenderer, LDU: LDU
  };
})();
