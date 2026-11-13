/* Oficina 3D: maqueta de ladrillos generada a partir de la oficina (departamentos y agentes).
   Principios: se dibuja cuando algo cambia (cámara, caminatas, resaltado) y, para la vida de fondo (autos, tecleo), a ~30 cps; todos los ladrillos, baldosas y
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
  var muroObj = null;               // muro de entregables (muro3d.js), se rearma en cada construir
  var muroDatos = { entregas: [], n: 0 }, muroAgentes = {};   // último estado del muro (sobrevive a reconstruir)
  var pendiente = false, sombrasSucias = true, ultimo = 0, construyendo = 0, sombraAnim = false, soloLento = true;
  var hover = null, elegido = null, hablando = null;
  var orb = { az: 0.42, el: 0.78, d: 60, tx: 0, tz: 0, minD: 10, maxD: 200 };
  var cbAgente = function () {}, cbLugar = function () {}, cbHover = function () {};
  var ray = new T.Raycaster(), v2 = new T.Vector2(), v3 = new T.Vector3();
  var BLANCO = '#f4f4f1', GRIS_CLARO = '#a3a7aa', GRIS_OSCURO = '#5d6166', NEGRO = '#2a2b2e', MADERA = '#8b6d4c', TOSTADO = '#c9b58c';
  /* paleta "ciudad de ladrillos": colores de pieza saturados y alegres */
  var C = {
    rojo: '#c91a09', amarillo: '#f5cd2f', azul: '#0a5fb4', azulClaro: '#5aaee6', verde: '#237a35', verdeClaro: '#5cad2c',
    naranja: '#f57d20', rosa: '#f06aa8', lila: '#9a72c9', turquesa: '#1ea7a1', marron: '#6b3f22', arena: '#e4cd9e',
    pasto: '#9ea3a6', pastoLejos: '#e7e4de', calle: '#55595e', vereda: '#c9cbc7', terracota: '#c86a3c', pantalla: '#58c4f5'
  };
  var VIVOS = [C.rojo, C.amarillo, C.azul, C.verdeClaro, C.naranja, C.rosa, C.lila, C.turquesa];
  /* tonos sobrios para muebles y objetos (el color fuerte queda en las sillas de cada depto y en las pantallas) */
  var SOBRIOS = ['#4a5560', '#6b7078', '#8b6d4c', '#2a2b2e', '#a3a7aa', '#c9b58c'];
  var TAZAS = ['#f4f4f1', '#2a2b2e', '#6b7078', '#d9d4c7'];
  var MARCADORES = ['#2a2b2e', '#2f5d8a', '#b5442e', '#3f7a53'];
  var ALFOMBRAS = ['#8d9296', '#b9b3aa', '#9c8a6e', '#6b7078'];
  var POSTIT = '#f3e3a0';

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
  /* caja sin junta (pantallas, papeles, cuadros): origen en el centro de la base */
  function geoCaja(w, d, h) {
    var k = 'c' + w + 'x' + d + 'x' + h;
    if (geoCache[k]) return geoCache[k];
    var g = new T.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
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
      /* variación mínima de tono por pieza (como el plástico real, que nunca sale idéntico); los studs no varían
         para que no se despeguen del color del ladrillo de abajo */
      var varia = !material && k !== 'stud' && k.charAt(0) === 'b';
      for (var i = 0; i < g.items.length; i++) {
        var it = g.items[i];
        q.setFromAxisAngle(up, it.r);
        m4.compose(new T.Vector3(it.x, it.y, it.z), q, uno);
        im.setMatrixAt(i, m4);
        c.set(it.c);
        if (varia) c.offsetHSL(0, 0, ((Math.sin(it.x * 12.9898 + it.y * 4.1 + it.z * 78.233) * 43758.5453) % 1) * 0.022);
        im.setColorAt(i, c.convertSRGBToLinear());
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
    renderer.toneMappingExposure = 0.9;            // un poco menos de exposición: colores más plenos, menos lavados
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    cv = renderer.domElement; cv.className = 'lienzo3d';
    cont.appendChild(cv);
    capa = document.createElement('div'); capa.className = 'capa3d'; cont.appendChild(capa);
    escena = new T.Scene();
    escena.environment = P.entorno(renderer);
    /* fondo liso del color de la mesa; la niebla funde la mesa lejana con el fondo */
    escena.background = new T.Color(HORIZONTE).convertSRGBToLinear();
    escena.fog = new T.Fog(new T.Color(HORIZONTE).convertSRGBToLinear(), 200, 600);
    cam = new T.PerspectiveCamera(26, 1, 0.5, 2000);
    var hemi = new T.HemisphereLight(0xffffff, 0xd8d2c8, 0.42); escena.add(hemi);
    sol = new T.DirectionalLight(0xffe2b8, 3.1);            // sol de tarde: cálido y con sombras más largas
    sol.castShadow = true; sol.shadow.mapSize.set(2048, 2048); sol.shadow.bias = -0.0004; sol.shadow.normalBias = 0.02; sol.shadow.radius = 3;
    escena.add(sol, sol.target);
    /* mesa infinita debajo de la maqueta */
    var mesa = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.MeshStandardMaterial({ color: P.lineal('#e7e4de'), roughness: 0.9, metalness: 0 }));
    mesa.rotation.x = -Math.PI / 2; mesa.position.y = -0.21; mesa.receiveShadow = true; escena.add(mesa);
    eventos();
    if (window.ResizeObserver) new ResizeObserver(function () { medir(); }).observe(cont);
    window.addEventListener('resize', medir);
    post = crearPost();
    medir();
    return true;
  }

  var HORIZONTE = '#e7e4de';                       // color de la mesa: la niebla funde la mesa lejana con el fondo

  /* ---------------- look de película ----------------
     La escena se dibuja en un buffer HDR y se pasa por dos pasadas: desenfoque horizontal y vertical que crece hacia
     arriba y abajo de la imagen (efecto miniatura / foto macro de juguetes), y al final tono ACES, balance cálido,
     un poco más de saturación y contraste, y viñeta. Sin WebGL2 se dibuja directo, como antes. */
  var post = null;
  var VS_POST = 'attribute vec3 position; attribute vec2 uv; varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  var FS_POST = [
    'precision highp float;',
    'uniform sampler2D t; uniform vec2 paso; uniform float foco, banda, final, exposicion; varying vec2 vUv;',
    'vec3 aces(vec3 x) { x *= exposicion; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }',
    'void main() {',
    '  float d = abs(vUv.y - foco);',
    '  vec2 st = paso * smoothstep(banda, banda + 0.38, d);',
    '  vec3 c = texture2D(t, vUv).rgb * 0.2270;',
    '  c += (texture2D(t, vUv + st * 1.3846).rgb + texture2D(t, vUv - st * 1.3846).rgb) * 0.3162;',
    '  c += (texture2D(t, vUv + st * 3.2308).rgb + texture2D(t, vUv - st * 3.2308).rgb) * 0.0703;',
    '  if (final > 0.5) {',
    '    c *= vec3(1.06, 1.0, 0.92);',
    '    c = aces(c);',
    '    float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.14);',
    '    c = srgb(clamp(c, 0.0, 1.0));',
    '    c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);',
    '    float v = smoothstep(0.92, 0.32, length((vUv - 0.5) * vec2(1.15, 1.0)));',
    '    c *= mix(0.80, 1.0, v);',
    '  }',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');
  function crearPost() {
    if (!renderer.capabilities.isWebGL2 || !T.WebGLMultisampleRenderTarget) return null;
    var flotante = renderer.extensions.get('EXT_color_buffer_float') ? T.HalfFloatType : T.UnsignedByteType;
    var p = {
      rtA: new T.WebGLMultisampleRenderTarget(1, 1, { type: flotante }),
      rtB: new T.WebGLRenderTarget(1, 1, { type: flotante, depthBuffer: false }),
      cam: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    };
    p.rtA.samples = 4;
    /* profundidad de 24 bits: con la de 16 que usa three por defecto en multisample, donde dos piezas se tocan
       (sofá sobre alfombra, teja sobre mesa) aparecen dientes de sierra */
    p.rtA.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
    function pasada(final) {
      var m = new T.RawShaderMaterial({ vertexShader: VS_POST, fragmentShader: FS_POST, depthTest: false, depthWrite: false,
        uniforms: { t: { value: null }, paso: { value: new T.Vector2() }, foco: { value: 0.47 }, banda: { value: 0.16 }, final: { value: final }, exposicion: { value: 1.0 } } });
      var esc = new T.Scene(); esc.add(new T.Mesh(new T.PlaneGeometry(2, 2), m));
      return { m: m, esc: esc };
    }
    p.h = pasada(0); p.v = pasada(1);
    p.h.m.uniforms.t.value = p.rtA.texture; p.v.m.uniforms.t.value = p.rtB.texture;
    return p;
  }
  function tamPost(w, h) {
    var pr = renderer.getPixelRatio(), W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
    post.rtA.setSize(W, H); post.rtB.setSize(W, H);
    var r = 2.6 * pr;                                   // radio máximo del desenfoque, en píxeles
    post.h.m.uniforms.paso.value.set(r / W, 0);
    post.v.m.uniforms.paso.value.set(0, r / H);
  }
  function dibujar() {
    if (!post) { renderer.render(escena, cam); return; }
    post.v.m.uniforms.exposicion.value = renderer.toneMappingExposure * 0.78;
    renderer.setRenderTarget(post.rtA); renderer.render(escena, cam);
    renderer.setRenderTarget(post.rtB); renderer.render(post.h.esc, post.cam);
    renderer.setRenderTarget(null); renderer.render(post.v.esc, post.cam);
  }

  var tamW = 0, tamH = 0;
  function medir() {
    var w = Math.max(1, Math.floor(cont.clientWidth)), h = Math.max(1, Math.floor(cont.clientHeight));
    if (w === tamW && h === tamH) return;
    tamW = w; tamH = h;
    renderer.setSize(w, h, false);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cam.aspect = w / h; cam.updateProjectionMatrix();
    if (post) tamPost(w, h);
    if (plano) encuadrar(false);
    pedir();
  }

  /* ---------------- render bajo demanda ---------------- */
  var pedidoEn = 0, idCuadro = 0;
  function pedir() {
    /* si un cuadro pedido no llegó en 1 s (ventana oculta), se vuelve a pedir en vez de quedar trabado */
    if (pendiente && performance.now() - pedidoEn < 1000) return;
    if (pendiente) cancelAnimationFrame(idCuadro);
    pendiente = true; pedidoEn = performance.now();
    idCuadro = requestAnimationFrame(cuadro);
  }
  function cuadro(t) {
    pendiente = false;
    var dt = ultimo ? Math.min(0.05, (t - ultimo) / 1000) : 0.016; ultimo = t;
    var hayAnim = false;
    sombraAnim = false; soloLento = true;
    for (var id in animando) { if (animar(id, dt)) hayAnim = true; else delete animando[id]; }
    if (camara(dt)) { hayAnim = true; soloLento = false; }
    var amb = AMBIENTE && mundo ? ambiente(dt) : false;
    posCam();
    /* las sombras solo se recalculan si algo se mueve de lugar (caminar), no por gestos sentados, pantallas ni autos */
    if (sombrasSucias || sombraAnim) { renderer.shadowMap.needsUpdate = true; sombrasSucias = false; }
    dibujar();
    for (var i = 0; i < etiquetas.length; i++) proyectar(etiquetas[i]);
    if (hayAnim) { if (soloLento) setTimeout(pedir, 60); else pedir(); }   /* gestos de trabajo a ~16 fps; caminatas y cámara a pleno */
    else if (amb) pedirLuego(); else ultimo = 0;
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
    enfocar(c.x, c.z + 1, orb.minD * (tipo === 'entregables' ? 1.1 : 2));   // el muro es chico: más cerca
    return true;
  }

  /* ---------------- vida: autos que circulan y gente que teclea ----------------
     Movimiento chico y continuo, a ~30 cuadros por segundo. No actualiza sombras (los autos llevan una sombra propia
     y los brazos que se mueven no cambian la sombra de forma visible). Se apaga con "reducir movimiento". */
  var AMBIENTE = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var timerAmb = null, timerAuto = null;
  function pedirLuego() {
    if (timerAmb) return;
    timerAmb = setTimeout(function () { timerAmb = null; pedir(); }, 33);
  }
  function ambiente(dt) {
    var algo = false, ahora = performance.now(), proximo = Infinity;
    for (var i = 0; i < autos.length; i++) {
      var a = autos[i];
      /* entre pasada y pasada el auto espera fuera de la base (con hora de reloj: el bucle puede dormirse mientras tanto) */
      if (a.vuelve) {
        if (ahora < a.vuelve) { proximo = Math.min(proximo, a.vuelve); continue; }
        a.vuelve = 0; a.g.visible = true;
      }
      var x = a.g.position.x + a.dir * a.vel * dt;
      if (x > a.x1 || x < a.x0) {
        x = a.dir > 0 ? a.x0 : a.x1;
        a.vuelve = ahora + 1000 * (ESPERA_AUTO[0] + Math.random() * (ESPERA_AUTO[1] - ESPERA_AUTO[0]));
        a.g.visible = false;
      }
      a.g.position.x = x; algo = true;
    }
    /* si no queda ningún auto en la calle, se despierta solo cuando vuelve el próximo */
    if (proximo < Infinity) {
      clearTimeout(timerAuto);
      timerAuto = setTimeout(function () { timerAuto = null; pedir(); }, proximo - ahora + 20);
    }
    for (var id in figuras) {
      var f = figuras[id];
      if (animando[id] || !f.obj.userData.partes) continue;
      if (f.estado === 'escritorio' && f.asiento) { mirar(f, id, dt); algo = true; }   /* reposo: el tecleo real lo animan las poses de trabajo */
      else if (f.estado === 'en-reunion') { mirar(f, id, dt); algo = true; }
    }
    return algo;
  }
  function mirar(f, id, dt) {
    if (f.t === undefined) { f.fs = (semilla(id) % 628) / 100; f.t = f.fs * 3; }
    f.t += dt;
    f.obj.userData.partes.cabeza.rotation.y = Math.sin(f.t * 0.5 + f.fs) * 0.3;
  }
  function posCam() {
    var ce = Math.cos(orb.el);
    cam.position.set(orb.tx + orb.d * Math.sin(orb.az) * ce, orb.d * Math.sin(orb.el), orb.tz + orb.d * Math.cos(orb.az) * ce);
    cam.lookAt(orb.tx, 0, orb.tz);
    /* plano cercano según la distancia: más precisión de profundidad, menos parpadeo entre caras cercanas */
    var cerca = Math.max(0.5, orb.d * 0.3);
    if (Math.abs(cam.near - cerca) > 0.01) { cam.near = cerca; cam.far = orb.d * 8 + 400; cam.updateProjectionMatrix(); }
    if (escena.fog) {
      var k = plano ? Math.max(plano.x1 - plano.x0, plano.z1 - plano.z0) : 60;
      escena.fog.near = orb.d + k * 0.7; escena.fog.far = escena.fog.near + orb.d * 1.6 + k * 1.5;
    }
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
    if (muroObj) { var hm = muroObj.pick(ray); if (hm && hm.dist < dm) { dm = hm.dist; mejor = { tipo: hm.tipo, id: hm.id }; } }
    for (var i = 0; i < lugares.length; i++) {
      if (lugares[i].tipo === 'entregables') continue;      // el muro se resuelve arriba (hoja por hoja)
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
      if (h && muroObj && (h.tipo === 'entrega' || h.tipo === 'entregables')) h.texto = muroObj.texto(h);
      if (clave !== hover) { hover = clave; actualizarEtiquetasHover(); pedir(); cbHover(h); }
    });
  }
  function elegir(e) {
    var h = rayo(e);
    if (!h) return;
    if (h.tipo === 'agente') cbAgente(h.id); else cbLugar(h.tipo, h.id);   // 'entrega' lleva el id de la entrega
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
  var CELDA_X = 9, CELDA_Z = 8, PASILLO = 5, RECEPCION = 14, MARGEN = 6, VEREDA = 3, CALLE = 8, FRENTE = VEREDA + CALLE + 4;

  function disenarSala(s) {
    if (s.tipo === 'reunion') { s.w = 20; s.d = 15; return; }
    if (s.tipo === 'biblioteca') { s.w = 17; s.d = 15; return; }
    var n = Math.max(1, s.agentes.length);
    s.filasDesk = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    s.cols = Math.ceil(n / s.filasDesk);
    s.w = s.cols * CELDA_X + 2;
    s.d = s.filasDesk * CELDA_Z + 7;
  }

  function planificar(salas) {
    salas.forEach(disenarSala);
    var total = salas.reduce(function (a, s) { return a + s.w; }, 0);
    var alas = Math.max(1, Math.round(Math.sqrt(total / 140)));
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
      a.df = Math.max(15, Math.max.apply(null, a.fondo.map(function (s) { return s.d; }).concat([0])));
      a.dr = Math.max(15, Math.max.apply(null, a.frente.map(function (s) { return s.d; }).concat([0])));
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
    return { alas: lista, W: RECEPCION + largo + 1, D: z, x0: -MARGEN, z0: -MARGEN, x1: RECEPCION + largo + 1 + MARGEN, z1: z + FRENTE, pasilloX: RECEPCION / 2 };
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
    var colorDep = {};
    deps.forEach(function (d) { colorDep[d.id] = d.color; });
    var agentesMuro = {};
    ags.forEach(function (a) { agentesMuro[a.id] = { nombre: a.nombre || a.id, color: colorDep[a.departamento] || '#6b7078' }; });

    var L = lote(), LV = lote(), grupo = new T.Group();
    LP = lote(); LD = {};
    lugares = []; etiquetas.forEach(function (e) { e.el.remove(); }); etiquetas = [];

    /* terreno: placa base gris con studs, vereda a lo largo del frente y calle con líneas */
    var bx0 = nuevo.x0, bz0 = nuevo.z0, bx1 = Math.ceil(nuevo.x1), bz1 = Math.ceil(nuevo.z1);
    var base = new T.Mesh(geoBloque(bx1 - bx0, bz1 - bz0, 0.2), P.plastico(C.pasto, { rugosidad: 0.45 }));
    base.position.set((bx0 + bx1) / 2, -0.2, (bz0 + bz1) / 2); base.receiveShadow = true; grupo.add(base);
    var entradaX = Math.floor(RECEPCION / 2) - 2;
    var zVereda = nuevo.D, zCalle = nuevo.D + VEREDA, zPasto = zCalle + CALLE;
    for (var i = bx0; i < bx1; i++) for (var j = bz0; j < bz1; j++) {
      var dentro = i >= 0 && i < nuevo.W && j >= 0 && j < nuevo.D;
      if (!dentro && (j < zVereda || j >= zPasto)) poner(L, geoStud(), 'stud', i + 0.5, 0, j + 0.5, C.pasto);
    }
    exterior(L, LV, nuevo, entradaX, bx0, bx1, bz0, bz1);

    /* recepción */
    pisoBaldosas(L, 0, 0, RECEPCION, nuevo.D, '#b9b3aa');
    recepcion(L, nuevo, entradaX);
    cartelNombre(grupo, nuevo.nombre);
    var etqR = etiqueta('sala', nuevo.nombre ? nuevo.nombre + ' · Recepción' : 'Recepción', null);
    etqR.p = new T.Vector3(1, PLACA, nuevo.D - 1.2);

    var asientosDesk = {};
    nuevo.alas.forEach(function (a) {
      pisoBaldosas(L, RECEPCION, a.z + a.df, nuevo.W - RECEPCION, PASILLO, '#d6d3cd');    // pasillo
      a.fondo.concat(a.frente).forEach(function (s) {
        s.color = s.tipo === 'reunion' ? C.azul : s.tipo === 'biblioteca' ? C.verde : s.tipo === 'comun' ? C.naranja : (s.dep.color || '#999999');
        var piso = s.tipo === 'reunion' ? '#d9d6d0' : s.tipo === 'biblioteca' ? '#cdbfa6' : s.tipo === 'comun' ? '#dcd9d3' : mezclar(s.color, '#dedbd5', 0.78);
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
            escritorio(L, cx, cz, s.color, k + semilla(s.dep.id), /video|edici|film|reel|youtube/i.test(s.nombre), cajaSala(s));
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
        if (s.tipo === 'depto') decorarSala(L, s);
      });
    });
    fachada(L, LV, nuevo, entradaX);
    cerrarLote(L, grupo);
    cerrarLote(LV, grupo, vidrio());
    cerrarLote(LP, grupo, pantallaMat());
    LP = null;

    var piezasListas = cerrarLDraw(grupo), autosListos = armarAutos(grupo, nuevo);
    return Promise.all(ags.map(function (a) {
      return P.figura(a.avatar, a.id).then(function (fig) { return { a: a, fig: fig }; });
    }).concat([piezasListas, autosListos])).then(function (lista) {
      var autosNuevos = lista.pop(); lista.pop();
      if (token !== construyendo) return;
      if (mundo) { escena.remove(mundo); liberar(mundo); }
      mundo = grupo; escena.add(mundo);
      autos = autosNuevos || [];
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
      muroAgentes = agentesMuro;
      armarMuro();
      actividad(trabajo);
      faros(faroDe);
      encuadrar(cambioTam);
      actualizarEtiquetasHover();
      sombrasSucias = true;
      pedir();
      if (reunionActual) reunion(reunionActual.agentes, reunionActual.hablando, true);
    });
  }

  /* muro de entregables: lo arma muro3d.js (cargado después) sobre el plano recién construido */
  function armarMuro() {
    muroObj = null;
    if (!App.Muro3D || !plano || !mundo) return;
    muroObj = App.Muro3D.construir({ T: T, P: P, plano: plano, geoBloque: geoBloque, PLACA: PLACA, LADRILLO: LADRILLO,
                                     MADERA: MADERA, NEGRO: NEGRO, GRIS_OSCURO: GRIS_OSCURO });
    mundo.add(muroObj.grupo);
    lugares.push({ tipo: 'entregables', caja: muroObj.caja });
    muroObj.actualizar(muroDatos.entregas, muroDatos.n, muroAgentes);
  }
  function muro(entregas, sinRevisar) {
    muroDatos = { entregas: (entregas || []).slice(), n: sinRevisar || 0 };
    if (muroObj) { muroObj.actualizar(muroDatos.entregas, muroDatos.n, muroAgentes); pedir(); }
  }

  var matVidrio = null;
  function vidrio() {
    if (!matVidrio) matVidrio = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.4 });
    return matVidrio;
  }

  var matPantalla = null;
  function pantallaMat() {
    if (!matPantalla) matPantalla = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    return matPantalla;
  }

  function liberar(g) {
    g.traverse(function (o) {
      if (o.isInstancedMesh) o.dispose && o.dispose();
      /* solo el cartel con el nombre tiene textura propia; las mallas de los autos usan arreglos de materiales y
         geometrías compartidas, que no se liberan acá */
      else if (o.isMesh && o.material && !Array.isArray(o.material) && o.material.map && o.material.map.isTexture) {
        o.material.map.dispose(); o.material.dispose(); o.geometry.dispose();
      }
    });
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

  function pisoBaldosas(L, x, z, w, d, hex, hex2) {
    for (var a = 0; a < w; a += 2) for (var b = 0; b < d; b += 2) {
      var c = hex2 && ((a + b) / 2) % 2 ? hex2 : hex;
      ladrillo(L, Math.min(2, w - a), Math.min(2, d - b), PLACA, x + a, 0, z + b, c, false);
    }
  }

  /* tramo de pared a lo largo de x o z, con aparejo trabado; huecos = [[desde, hasta]] en la coordenada del tramo */
  function pared(L, eje, x, z, largo, alto, hex, huecos, studsArriba) {
    for (var n = 0; n < alto; n++) {
      var p = 0, desf = n % 2 ? 2 : 0, primero = true, col = typeof hex === 'function' ? hex(n) : hex;
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
        if (eje === 'x') ladrillo(L, w, 1, LADRILLO, x + p, PLACA + n * LADRILLO, z, col, studsArriba && n === alto - 1);
        else ladrillo(L, 1, w, LADRILLO, x, PLACA + n * LADRILLO, z + p, col, studsArriba && n === alto - 1);
        p += w;
      }
    }
  }

  function fachada(L, LV, pl, entradaX) {
    var W = pl.W, D = pl.D, MURO = BLANCO;
    /* fondo: blanco, con ventanas de alféizar gris */
    pared(L, 'x', 0, 0, W, 1, BLANCO, null, false);
    for (var p = 0; p < W; p += 6) {
      var pil = Math.min(2, W - p), vw = Math.min(4, W - p - pil);
      ladrillo(L, pil, 1, LADRILLO * 2, p, PLACA + LADRILLO, 0, MURO, false);
      if (vw > 0) {
        poner(LV, geoBloque(vw, 0.25, LADRILLO * 2), 'v' + vw, p + pil + vw / 2, PLACA + LADRILLO, 0.5, '#d8eaf0');
        ladrillo(L, vw, 1, 0.2, p + pil, PLACA + LADRILLO, 0, '#8d9296', false);                   // alféizar
        poner(L, geoBloque(vw, 1, 0.2), 'b' + vw + 'x1x0.2', p + pil + vw / 2, PLACA + LADRILLO * 3 - 0.2, 0.5, BLANCO);   // dintel
      }
    }
    for (var q = 0; q < W; q += 4) ladrillo(L, Math.min(4, W - q), 1, LADRILLO, q, PLACA + LADRILLO * 3, 0, BLANCO, true);
    /* laterales: blancos */
    var lateral = function (n) { return n ? BLANCO : MURO; };
    pared(L, 'z', 0, 1, D - 1, 2, lateral, null, true);
    pared(L, 'z', W - 1, 1, D - 1, 2, lateral, null, true);
    /* frente: un ladrillo, con la puerta de entrada en la recepción */
    pared(L, 'x', 1, D - 1, W - 2, 1, MURO, [[entradaX - 1, entradaX + 3]], true);
    /* toldo gris y blanco sobre la entrada */
    for (var t = 0; t < 6; t++) poner(L, geoBloque(1, 1.6, 0.25), 'b1x1.6x0.25', entradaX - 1.5 + t + 0.5, PLACA + LADRILLO * 2.3, D - 0.2, t % 2 ? BLANCO : '#8d9296');
    poner(L, geoRedondo(0.15, LADRILLO * 2.3), 'poste', entradaX - 1.3, PLACA, D + 0.4, BLANCO);
    poner(L, geoRedondo(0.15, LADRILLO * 2.3), 'poste', entradaX + 4.3, PLACA, D + 0.4, BLANCO);
  }

  function paredesSala(L, LV, s, pl) {
    var a = s.ala, alFondo = s.lado === 'fondo', col = s.color || BLANCO;
    var tabique = BLANCO;
    /* tabique izquierdo (todas las salas: el de la primera las separa de la recepción) */
    var z0 = s.z + (alFondo && a.indice === 0 ? 1 : 0), largoZ = s.d - (alFondo && a.indice === 0 ? 1 : 0) - (!alFondo && a.indice === pl.alas.length - 1 ? 1 : 0);
    if (s.x === RECEPCION) {
      /* contra la recepción: tabique con vidrio para que se vea el movimiento */
      pared(L, 'z', s.x, z0, largoZ, 1, BLANCO, null, false);
      poner(LV, geoBloque(0.25, largoZ, LADRILLO), 'vz' + largoZ, s.x + 0.5, PLACA + LADRILLO, z0 + largoZ / 2, '#d8eaf0');
    } else pared(L, 'z', s.x, z0, largoZ, 2, tabique, null, true);
    /* muro entre alas (el fondo de un ala que no es la primera) */
    if (alFondo && a.indice > 0) pared(L, 'x', s.x + 1, s.z, s.w - 1, 2, tabique, null, true);
    /* frente al pasillo: un ladrillo blanco con puerta de 3 */
    var zp = alFondo ? s.z + s.d - 1 : s.z, px = s.w - 6;
    pared(L, 'x', s.x + 1, zp, s.w - 1, 1, BLANCO, [[px, px + 3]], true);
  }

  /* ---------------- muebles y objetos ----------------
     Todo armado con piezas que existen: medidas en studs (1 x 1, 2 x 4...), alturas en placas (0.4) y ladrillos (1.2),
     studs arriba salvo en las tejas (piezas lisas). Las redondas son ladrillos/placas redondas con su stud y los conos
     son conos LEGO (truncados, con stud chico arriba). LP = lote de pantallas (material sin luz: se ven encendidas).
     Regla de oro: nada se apoya en los caminos de las figuras (salida de cada escritorio, fila de la puerta, pasillos). */
  var LP = null;
  /* ---------------- piezas LDraw reales (oficina.mpd) ----------------
     Silla, taza, pantallas, plantas, árboles, faroles, biblioteca y autos son piezas LEGO de verdad (geometría LDraw).
     Durante el armado se anotan en LD; al final se crea UNA InstancedMesh por pieza y por color fijo de la pieza
     (la parte de color "principal" lleva el color de cada instancia). Origen: centro en x/z, base apoyada en y = 0. */
  var LD = null;
  var CENTRAR = { '3823': 1, '1': 1 };
  var listas = {};                     // parte -> Promise<{geo, partes:[{geo, ranura}]}>
  function ldraw(parte, x, y, z, rot, col, mat, inc) {
    var k = parte + '|' + (mat || '');
    (LD[k] || (LD[k] = { parte: parte, mat: mat, items: [] })).items.push({ x: x, y: y, z: z, r: rot || 0, c: col, i: inc || 0 });
  }
  /* Huella en planta de las piezas anchas (hojas), en studs, en el espacio de la pieza: [x0, x1, z0, z1].
     Sirve para no ponerlas donde atravesarían una pared. inc = inclinación hacia arriba (achica el largo en planta). */
  var HUELLA = { '2423': [-1.3, 1.3, -0.5, 3.4], '2417': [-2.4, 2.4, -2.4, 3.4], '6255': [-2.3, 2.3, -2.75, 1.65] };
  function cajaSala(s) { return { x0: s.x + 1, x1: s.x + s.w, z0: s.z + 1, z1: s.z + s.d - 1 }; }
  function cabe(parte, x, z, rot, inc, caja) {
    if (!caja) return true;
    var h = HUELLA[parte], k = Math.cos(inc || 0), sn = Math.sin(rot), c = Math.cos(rot);
    return [[h[0], h[2] * k], [h[1], h[2] * k], [h[0], h[3] * k], [h[1], h[3] * k]].every(function (e) {
      var wx = x + c * e[0] + sn * e[1], wz = z - sn * e[0] + c * e[1];
      return wx > caja.x0 + 0.05 && wx < caja.x1 - 0.05 && wz > caja.z0 + 0.05 && wz < caja.z1 - 0.05;
    });
  }
  function cabeGiro(parte, x, z, inc, caja) {
    for (var i = 0; i < 8; i++) { var r = i * Math.PI / 4; if (cabe(parte, x, z, r, inc, caja)) return r; }
    return null;
  }
  function normalizada(parte) {
    if (listas[parte]) return listas[parte];
    listas[parte] = P.pieza(parte, 'oficina').then(function (def) {
      var geo = def.geo.clone();
      geo.applyMatrix4(new T.Matrix4().makeRotationX(Math.PI));
      geo.scale(P.LDU, P.LDU, P.LDU);
      geo.computeBoundingBox();
      var b = geo.boundingBox;
      geo.translate(CENTRAR[parte] ? -(b.min.x + b.max.x) / 2 : 0, -b.min.y, CENTRAR[parte] ? -(b.min.z + b.max.z) / 2 : 0);
      /* una geometría por color: la principal se tiñe por instancia, las demás llevan su color fijo */
      var partes = [], pos = geo.attributes.position, nor = geo.attributes.normal;
      var grupos = geo.groups.length ? geo.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
      grupos.forEach(function (g) {
        var r = def.ranuras[g.materialIndex] || { principal: true };
        var n = Math.min(g.count, pos.count - g.start), sub = new T.BufferGeometry();
        sub.setAttribute('position', new T.BufferAttribute(pos.array.slice(g.start * 3, (g.start + n) * 3), 3));
        if (nor) sub.setAttribute('normal', new T.BufferAttribute(nor.array.slice(g.start * 3, (g.start + n) * 3), 3));
        partes.push({ geo: sub, ranura: r });
      });
      return { geo: geo, ranuras: def.ranuras, partes: partes };
    });
    return listas[parte];
  }
  var matsEsp = {};
  function matEspecial(nombre) {
    if (matsEsp[nombre]) return matsEsp[nombre];
    var m;
    if (nombre === 'vidrio') m = new T.MeshStandardMaterial({ color: P.lineal('#3a4a5c'), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false });
    else if (nombre === 'luz') m = new T.MeshStandardMaterial({ color: P.lineal('#fff1a8'), emissive: P.lineal('#ffe38a'), emissiveIntensity: 0.9, roughness: 0.2, transparent: true, opacity: 0.9 });
    else if (nombre === 'oro') m = new T.MeshStandardMaterial({ color: P.lineal('#d9a92e'), roughness: 0.25, metalness: 0.75 });
    return (matsEsp[nombre] = m);
  }
  function cerrarLDraw(destino) {
    var pedidos = LD; LD = null;
    return Promise.all(Object.keys(pedidos).map(function (k) {
      var pd = pedidos[k];
      return normalizada(pd.parte).then(function (n) {
        var m4 = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), uno = new T.Vector3(1, 1, 1), c = new T.Color();
        n.partes.forEach(function (pt) {
          var r = pt.ranura, tinte = r.principal && !pd.mat;
          var mat = r.principal ? (pd.mat ? matEspecial(pd.mat) : (matInst || (matInst = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0 }))))
            : P.plastico(r.hex, { opacidad: r.opacidad });
          var im = new T.InstancedMesh(pt.geo, mat, pd.items.length);
          pd.items.forEach(function (it, i) {
            if (it.i) q.setFromEuler(new T.Euler(it.i, it.r, 0, 'YXZ')); else q.setFromAxisAngle(up, it.r);
            m4.compose(new T.Vector3(it.x, it.y, it.z), q, uno);
            im.setMatrixAt(i, m4);
            if (tinte) im.setColorAt(i, c.set(it.c || BLANCO).convertSRGBToLinear());
          });
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.castShadow = !mat.transparent; im.receiveShadow = true;
          destino.add(im);
        });
      });
    })).catch(function (e) { console.warn('Piezas de la maqueta:', e && e.message); });
  }
  /* malla suelta (para lo que se mueve, como los autos) */
  function mallaLDraw(parte, col, mat) {
    return normalizada(parte).then(function (n) {
      var mats = n.ranuras.map(function (r) { return r.principal ? (mat ? matEspecial(mat) : P.plastico(col)) : P.plastico(r.hex, { opacidad: r.opacidad }); });
      var m = new T.Mesh(n.geo, mats.length === 1 ? mats[0] : mats);
      m.castShadow = false; m.receiveShadow = true;
      return m;
    });
  }

  function semilla(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function sobrio(n) { return SOBRIOS[n % SOBRIOS.length]; }
  var PANTALLAS = [C.pantalla, '#8de08f', '#ffd75e', '#f59ac2', '#b9a4f2'];
  var R1 = 0.48, R2 = 0.96, R3 = 1.46, R4 = 1.96;      // radios de piezas redondas 1x1, 2x2, 3x3, 4x4

  function geoConoLego(rb, h) {
    var k = 'kl' + rb + 'x' + h;
    if (geoCache[k]) return geoCache[k];
    var g = new T.CylinderGeometry(rb * 0.45, rb, h, 24, 1, false); g.translate(0, h / 2, 0);
    return (geoCache[k] = g);
  }
  function geoStudChico() {
    if (geoCache.studCh) return geoCache.studCh;
    var g = new T.CylinderGeometry(0.22, 0.22, 0.14, 16); g.translate(0, 0.07, 0);
    return (geoCache.studCh = g);
  }
  function geoBola(r, alto) {
    var k = 'o' + r + 'x' + alto;
    if (geoCache[k]) return geoCache[k];
    var g = new T.SphereGeometry(r, 24, 16); g.scale(1, alto / (2 * r), 1); g.translate(0, alto / 2, 0);
    return (geoCache[k] = g);
  }
  /* pieza rectangular centrada en (cx, cz) */
  function pieza(L, w, d, h, cx, y, cz, hex, studs) { ladrillo(L, w, d, h, cx - w / 2, y, cz - d / 2, hex, studs); }
  /* teja (pieza lisa, altura de placa) */
  function teja(L, w, d, cx, y, cz, hex) { pieza(L, w, d, PLACA, cx, y, cz, hex, false); }
  /* pieza redonda: r = R1/R2/R3/R4; stud: 1 (centro), 4 (2x2) o 0 */
  function redonda(L, r, h, x, y, z, hex, studs) {
    poner(L, geoRedondo(r, h), 'r' + r + 'x' + h, x, y, z, hex);
    if (studs === 1) poner(L, geoStud(), 'stud', x, y + h, z, hex);
    else if (studs === 4) [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].forEach(function (o) { poner(L, geoStud(), 'stud', x + o[0], y + h, z + o[1], hex); });
  }
  function cono(L, rb, h, x, y, z, hex) {
    poner(L, geoConoLego(rb, h), 'cono' + rb + 'x' + h, x, y, z, hex);
    poner(L, geoStudChico(), 'studCh', x, y + h, z, hex);
  }
  /* pieza rotada en múltiplos de 90°: (ox, oz) y (lw, ld) en el espacio local del mueble, que mira hacia +z */
  function rotada(L, base, lw, ld, h, ox, oz, y, hex, studs) {
    var s = Math.round(Math.sin(base.rot)), c = Math.round(Math.cos(base.rot));
    var x = base.x + c * ox + s * oz, z = base.z - s * ox + c * oz;
    var w = c !== 0 ? lw : ld, d = c !== 0 ? ld : lw;
    pieza(L, w, d, h, x, y, z, hex, studs);
  }

  /* silla de oficina: dos placas redondas 1x1 de pie y la silla de minifig 4079 (pieza real) */
  function silla(L, x, z, rot, col) {
    var y = PLACA;
    ldraw('6141', x, y, z, 0, NEGRO);
    ldraw('6141', x, y + PLACA, z, 0, NEGRO);
    ldraw('4079', x, y + PLACA * 2, z, rot, col);
  }

  /* Monitor como en los sets de oficina actuales: placa 2x1 negra de base, una barra de pie y una teja 3x2 negra
     parada (el marco) con la pantalla encendida adelante. Mira hacia -z (hacia quien está sentado). video: muestra
     una línea de tiempo de edición en vez de ventanas. */
  function monitor(L, x, y, z, k, video) {
    pieza(L, 2, 1, PLACA, x, y, z + 0.3, NEGRO, false);
    poner(L, geoRedondo(0.14, 0.7), 'cuelloMon', x, y + PLACA, z + 0.3, NEGRO);
    poner(L, geoBloque(3, 0.4, 2), 'marcoMon', x, y + 0.9, z + 0.3, NEGRO);
    var zs = z + 0.085, yb = y + 1.05;
    if (video) {
      poner(LP, geoCaja(2.7, 0.02, 1.7), 'scrMon', x, yb, zs, '#1d2733');
      poner(LP, geoCaja(2.2, 0.025, 0.75), 'scrVid', x, yb + 0.8, zs - 0.01, '#58c4f5');
      [[C.amarillo, -0.5, 0.35], [C.rosa, 0.3, 0.2], ['#8de08f', -0.2, 0.05]].forEach(function (b, i) {
        poner(LP, geoCaja(1.1, 0.025, 0.1), 'scrPista' + i, x + b[1], yb + b[2], zs - 0.01, b[0]);
      });
    } else {
      poner(LP, geoCaja(2.7, 0.02, 1.7), 'scrMon', x, yb, zs, PANTALLAS[k % PANTALLAS.length]);
      poner(LP, geoCaja(1.2, 0.025, 0.9), 'scrVent', x - 0.5, yb + 0.55, zs - 0.01, '#ffffff');
      poner(LP, geoCaja(0.8, 0.025, 0.1), 'scrLin', x + 0.75, yb + 1.2, zs - 0.01, '#ffffff');
      poner(LP, geoCaja(0.8, 0.025, 0.1), 'scrLin', x + 0.75, yb + 0.95, zs - 0.01, '#ffffff');
    }
  }

  /* escritorio de 4 x 3: patas, tapa blanca, monitor, teclado (teja 1x2 impresa), taza y un objeto */
  function escritorio(L, cx, cz, col, k, video, caja) {
    var y = PLACA;
    pieza(L, 1, 2, LADRILLO * 2, cx - 1.5, y, cz + 2.7, GRIS_CLARO, false);
    pieza(L, 1, 2, LADRILLO * 2, cx + 1.5, y, cz + 2.7, GRIS_CLARO, false);
    ladrillo(L, 4, 3, PLACA, cx - 2, y + LADRILLO * 2, cz + 1.2, BLANCO, false);
    var tope = y + LADRILLO * 2 + PLACA;
    monitor(L, cx + 1, tope, cz + 3.1, k, video);
    ldraw('3069bpcc', cx + 1, tope, cz + 1.7, Math.PI, GRIS_CLARO);
    silla(L, cx, cz + 0.2, 0, col);
    ldraw('3899', cx - 0.9, tope, cz + 2.7, 2.4, TAZAS[k % TAZAS.length]);
    teja(L, 2, 1, cx - 1, tope, cz + 1.75, BLANCO);
    teja(L, 1, 1, cx - 0.5, tope + PLACA, cz + 1.75, POSTIT);
    var objeto = k % 3, ox = cx - 1.55, oz = cz + 3.75;
    var rotPlanta = cabeGiro('6255', ox, oz, 0, caja);
    if (objeto === 0 && rotPlanta !== null) {   /* maceta: ladrillo redondo 1x1 + planta de 3 hojas (6255) */
      ldraw('3062b', ox, tope, oz, 0, C.terracota);
      ldraw('6255', ox, tope + LADRILLO - 0.4, oz, rotPlanta, C.verde);
    } else if (objeto !== 2) {     /* lámpara: placa redonda, barra y cono 1x1 */
      ldraw('6141', ox, tope, oz, 0, NEGRO);
      poner(L, geoRedondo(0.1, 1.0), 'barra1', ox, tope + PLACA, oz, NEGRO);
      ldraw('4589', ox, tope + 1.4, oz, 0, k % 2 ? NEGRO : BLANCO);
    } else {                       /* carpetas: dos placas 1x2 apiladas */
      pieza(L, 1, 2, PLACA, ox, tope, oz - 0.3, NEGRO, false);
      pieza(L, 1, 2, PLACA, ox, tope + PLACA, oz - 0.3, '#6b7078', true);
    }
    /* papelera debajo del escritorio: ladrillo redondo 1x1 */
    ldraw('3062b', cx + 0.4, y, cz + 3.6, 0, GRIS_OSCURO);
  }

  /* planta grande: maceta redonda 2x2, tallo marrón y hojas 4x3 (o 6x5 si es grande) alrededor, con un brote arriba */
  /* Planta grande: maceta redonda 2x2, tallo marrón y hasta tres hojas (4x3, o 6x5 si es grande) inclinadas hacia
     arriba como en las plantas LEGO. Solo se ponen las hojas que entran en la sala (caja), así ninguna atraviesa una
     pared; arriba, la planta de 3 hojas si entra, o un brote chico. */
  function plantaGrande(L, x, z, k, grande, caja) {
    var y = PLACA, hoja = grande ? '2417' : '2423', inc = grande ? 0.7 : 0.85;
    ldraw('3941', x, y, z, 0, k % 2 ? C.terracota : BLANCO);
    ldraw('3062b', x, y + LADRILLO, z, 0, C.marron);
    if (grande) ldraw('3062b', x, y + LADRILLO * 2, z, 0, C.marron);
    var yh = y + LADRILLO * (grande ? 3 : 2), elegidas = [];
    for (var i = 0; i < 12 && elegidas.length < 3; i++) {
      var a = k + i * Math.PI / 6;
      if (!cabe(hoja, x, z, a, inc, caja)) continue;
      if (elegidas.some(function (b) { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1.7; })) continue;
      elegidas.push(a);
    }
    elegidas.forEach(function (a) { ldraw(hoja, x, yh, z, a, C.verde, null, -inc); });
    var giro = cabeGiro('6255', x, z, 0, caja);
    if (giro !== null) ldraw('6255', x, yh + 0.2, z, giro, C.verdeClaro);
    else ldraw('4589', x, yh, z, 0, C.verdeClaro);
  }
  function dispenser(L, x, z) {
    var y = PLACA;
    pieza(L, 1, 1, LADRILLO * 2, x, y, z, BLANCO, false);
    redonda(L, R1, LADRILLO, x, y + LADRILLO * 2, z, C.azulClaro, 1);
    teja(L, 1, 1, x, y + LADRILLO * 2 - PLACA * 1.2, z + 0.6, GRIS_OSCURO);
  }
  function archivero(L, x, z, col) {
    var y = PLACA;
    pieza(L, 1, 2, LADRILLO * 2, x, y, z, GRIS_CLARO, true);
    for (var n = 0; n < 2; n++) poner(L, geoBloque(0.1, 0.8, 0.2), 'manija', x + 0.55, y + 0.7 + n * 1.2, z, col);
  }
  /* sillón armado con ladrillos: asiento liso de 2 placas, respaldo 1 x (largo + 2) y apoyabrazos 1x2 con studs */
  function sillon(L, x, z, rot, col, largo) {
    largo = largo || 2;
    var b = { x: x, z: z, rot: rot }, y = PLACA;
    rotada(L, b, largo, 2, PLACA * 2, 0, 0, y, col, false);
    rotada(L, b, largo + 2, 1, PLACA * 5, 0, -1.5, y, col, true);
    rotada(L, b, 1, 2, LADRILLO, largo / 2 + 0.5, 0, y, col, true);
    rotada(L, b, 1, 2, LADRILLO, -largo / 2 - 0.5, 0, y, col, true);
    rotada(L, b, 1, 1, PLACA, largo / 2 - 0.5, -0.5, y + PLACA * 2, BLANCO, false);   // almohadón
  }
  /* mesa ratona: ladrillo redondo 1x1 de pata + teja redonda 3x3 */
  function mesita(L, x, z, col) {
    var y = PLACA;
    redonda(L, R1, LADRILLO, x, y, z, GRIS_OSCURO, 0);
    redonda(L, R3, PLACA, x, y + LADRILLO, z, col || BLANCO, 0);
    ldraw('3899', x + 0.4, y + LADRILLO + PLACA, z - 0.3, 0, BLANCO);
  }
  /* banqueta: ladrillo redondo 2x2 con sus 4 studs */
  function banqueta(L, x, z, col) { redonda(L, R2, LADRILLO, x, PLACA, z, col, 4); }
  /* alfombra: placa lisa con borde (medidas enteras en studs) */
  function alfombra(L, x0, z0, x1, z1, col) {
    var w = Math.max(2, Math.round(x1 - x0)), d = Math.max(2, Math.round(z1 - z0)), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    pieza(L, w, d, 0.16, cx, PLACA, cz, col, false);
    if (w > 2 && d > 2) pieza(L, w - 1, d - 1, 0.2, cx, PLACA, cz, mezclar(col, '#ffffff', 0.35), false);
  }
  /* pizarra: dos barras grises y un panel blanco 4 x 3 con dibujos impresos del lado de la cámara */
  function pizarra(L, x, z, k) {
    var y = PLACA;
    redonda(L, R1, PLACA, x - 1.6, y, z, GRIS_OSCURO, 0);
    redonda(L, R1, PLACA, x + 1.6, y, z, GRIS_OSCURO, 0);
    poner(L, geoRedondo(0.12, 3.6), 'barraPiz', x - 1.6, y + PLACA, z, GRIS_CLARO);
    poner(L, geoRedondo(0.12, 3.6), 'barraPiz', x + 1.6, y + PLACA, z, GRIS_CLARO);
    pieza(L, 4, 0.5, LADRILLO * 2, x, y + 1.6, z, BLANCO, false);
    for (var i = 0; i < 4; i++) poner(LP, geoCaja(0.4 + ((k + i * 5) % 4) * 0.35, 0.02, 0.09), 'garabato' + i, x - 0.9 + ((k + i) % 3) * 0.5, y + 3.6 - i * 0.4, z + 0.25, MARCADORES[(k + i) % MARCADORES.length]);
    teja(L, 1, 1, x + 1.2, y + 2.4, z + 0.45, POSTIT);
  }

  /* Decoración de una sala de departamento: rincón izquierdo, franja libre frente a los escritorios y,
     si la sala quedó más ancha (la última de la fila llega a la fachada), un living al costado. */
  function decorarSala(L, s) {
    var col = s.color, alFondo = s.lado === 'fondo', k = semilla(s.dep ? s.dep.id : s.nombre);
    var paredAtras = alFondo ? s.z + 1 : s.z + s.d - 1;
    var hacia = alFondo ? 1 : -1;                    // desde la pared de atrás hacia el pasillo
    var xi = s.x + 2.4, zA = paredAtras + hacia * 1.0;
    /* rincón izquierdo: planta, dispenser de agua y archivero */
    plantaGrande(L, xi, zA + hacia * 0.5, k, false, cajaSala(s));
    dispenser(L, s.x + 1.5, zA + hacia * 3.6);
    archivero(L, s.x + 1.5, zA + hacia * 5.2, col);
    /* franja libre entre los escritorios y la pared del pasillo (fondo) o la de atrás (frente) */
    var primera = s.z + (alFondo ? 2.8 : 4.2), finEsc = primera + (s.filasDesk - 1) * CELDA_Z + 4.2;
    var b0 = finEsc + 0.8, b1 = alFondo ? s.z + s.d - 3 : s.z + s.d - 1.6;
    if (b1 - b0 >= 3.2) {
      for (var c = 0; c < s.cols; c++) {
        var cx = s.x + 1 + c * CELDA_X + CELDA_X / 2, zb = (b0 + b1) / 2, tipo = (k + c) % 3;
        if (!alFondo) alfombra(L, cx - 2.5, b0, cx + 2.5, b1, ALFOMBRAS[(k + c) % ALFOMBRAS.length]);
        if (tipo === 0) sillon(L, cx, zb + 0.5, 0, sobrio(k + c), 2);
        else if (tipo === 1) { mesita(L, cx, zb, MADERA); banqueta(L, cx - 2, zb, sobrio(k + c + 1)); banqueta(L, cx + 2, zb, sobrio(k + c + 1)); }
        else pizarra(L, cx, zb, k + c);
      }
    }
    /* living al costado si sobra lugar */
    var xr0 = s.x + 1 + s.cols * CELDA_X, xr1 = s.x + s.w - 1;
    if (xr1 - xr0 >= 6) {
      var zr0 = alFondo ? paredAtras + 0.6 : s.z + 4.2, zr1 = alFondo ? s.z + s.d - 4 : paredAtras - 0.6;
      if (zr1 - zr0 >= 6) {
        var mx = Math.round((xr0 + xr1) / 2);
        alfombra(L, xr0 + 0.5, zr0 + 0.5, xr1 - 0.5, zr1 - 0.5, ALFOMBRAS[k % ALFOMBRAS.length]);
        var zs = alFondo ? zr0 + 2.2 : zr1 - 2.2;
        sillon(L, mx, zs, alFondo ? 0 : Math.PI, sobrio(k), Math.min(4, Math.floor(xr1 - xr0 - 3)));
        mesita(L, mx, zs + hacia * 2.8, MADERA);
        plantaGrande(L, xr1 - 1.2, alFondo ? zr0 + 0.8 : zr1 - 0.8, k + 1, false, cajaSala(s));
      }
    }
  }

  function recepcion(L, pl, entradaX) {
    var y = PLACA, cx = RECEPCION / 2, cz = pl.D - 9;
    /* mostrador blanco con tapa de madera, compu y timbre */
    ladrillo(L, 6, 1, LADRILLO * 2, cx - 3, y, cz, BLANCO, false);
    ladrillo(L, 6, 2, PLACA, cx - 3, y + LADRILLO * 2, cz - 0.5, MADERA, false);
    var tope = y + LADRILLO * 2 + PLACA;
    monitor(L, cx + 1.3, tope, cz + 0.2, 1, false);
    ldraw('3069bpcc', cx - 0.5, tope, cz, Math.PI, GRIS_CLARO);
    ldraw('6141', cx - 2, tope, cz + 0.5, 0, GRIS_OSCURO);
    ldraw('3899', cx - 2, tope, cz - 0.3, 0, BLANCO);
    silla(L, cx + 0.5, cz - 1.8, 0, GRIS_OSCURO);
    /* sala de espera: sillón gris pizarra, mesa ratona con una revista (teja 2x1), alfombra */
    alfombra(L, 1, pl.D - 7, 6, pl.D - 3, '#8d9296');
    sillon(L, 3.5, pl.D - 6, 0, '#4a5560', 2);
    mesita(L, 3.5, pl.D - 3.6, BLANCO);
    teja(L, 2, 1, 3.2, y + LADRILLO + PLACA, pl.D - 3.4, BLANCO);
    banqueta(L, 8.8, pl.D - 4.5, '#6b7078');
    var cajaR = { x0: 1, x1: RECEPCION, z0: 1, z1: pl.D - 1 };
    [[2, 2], [RECEPCION - 2, 2], [RECEPCION - 2, pl.D - 2.6]].forEach(function (p, i) { plantaGrande(L, p[0], p[1], i, true, cajaR); });
    /* felpudo en la entrada */
    pieza(L, 4, 2, 0.16, entradaX + 1, y, pl.D - 2, GRIS_OSCURO, false);
    /* cartel negro en la pared del fondo (el texto va aparte, ver cartelNombre) */
    poner(L, geoBloque(8, 0.2, 1.6), 'cartel', cx, y + LADRILLO * 1.6, 1.15, NEGRO);
  }

  function cartelNombre(grupo, nombre) {
    if (!nombre) return;
    var cv2 = document.createElement('canvas'); cv2.width = 1024; cv2.height = 192;
    var x = cv2.getContext('2d');
    x.fillStyle = NEGRO; x.fillRect(0, 0, 1024, 192);
    x.fillStyle = '#f4f4f1';
    var tam = 120; x.font = '700 ' + tam + 'px Poppins, "Helvetica Neue", Arial, sans-serif';
    while (x.measureText(nombre).width > 940 && tam > 40) { tam -= 6; x.font = '700 ' + tam + 'px Poppins, "Helvetica Neue", Arial, sans-serif'; }
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(nombre, 512, 100);
    var tex = new T.CanvasTexture(cv2); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
    var m = new T.Mesh(new T.PlaneGeometry(7.5, 1.4), new T.MeshBasicMaterial({ map: tex, toneMapped: false }));
    m.position.set(RECEPCION / 2, PLACA + LADRILLO * 1.6 + 0.8, 1.255);
    grupo.add(m);
  }

  function salaReunion(L, s, pl) {
    var y = PLACA, mx = s.x + 1 + (s.w - 1) / 2, mz = s.z + s.d / 2 + 0.2;
    ladrillo(L, 2, 2, LADRILLO * 2, mx - 4, y, mz - 1, GRIS_OSCURO, false);
    ladrillo(L, 2, 2, LADRILLO * 2, mx + 2, y, mz - 1, GRIS_OSCURO, false);
    ladrillo(L, 10, 4, PLACA, mx - 5, y + LADRILLO * 2, mz - 2, MADERA, false);
    var tope = y + LADRILLO * 2 + PLACA;
    var asientos = [];
    for (var i = 0; i < 4; i++) asientos.push({ x: mx - 3.6 + i * 2.4, z: mz - 3.4, rot: 0 });
    for (var j = 0; j < 4; j++) asientos.push({ x: mx - 3.6 + j * 2.4, z: mz + 3.4, rot: Math.PI });
    asientos.push({ x: mx - 6.6, z: mz, rot: Math.PI / 2 }, { x: mx + 6.6, z: mz, rot: -Math.PI / 2 });
    asientos.forEach(function (a, n) {
      var dz = Math.cos(a.rot);
      silla(L, a.x, a.z, a.rot, GRIS_OSCURO);
      /* sobre la mesa: notebook (teja 2x1 + pantalla) o taza frente a cada lugar */
      if (Math.abs(dz) > 0.5) {
        var tz = a.z + dz * 2.0;
        if (n % 2 === 0) {
          pieza(L, 2, 1, 0.12, a.x, tope, tz, GRIS_CLARO, false);
          pieza(L, 2, 0.12, 0.9, a.x, tope, tz + dz * 0.5, GRIS_CLARO, false);
          poner(LP, geoCaja(1.6, 0.02, 0.7), 'nbScr', a.x, tope + 0.12, tz + dz * 0.43, PANTALLAS[n % PANTALLAS.length]);
        } else ldraw('3899', a.x + 0.5, tope, tz, a.rot, TAZAS[n % TAZAS.length]);
      }
    });
    ldraw('3062b', mx, tope, mz, 0, '#cfe6f2');
    pl.reunion = { sala: s, asientos: asientos };
    /* tele con un gráfico de barras encendido */
    poner(L, geoBloque(6, 0.2, 3.4), 'tele', mx, y + 0.9, s.z + 1.15, NEGRO);
    poner(LP, geoCaja(5.5, 0.02, 2.95), 'teleScr', mx, y + 1.12, s.z + 1.265, '#1f3a5c');
    [1.0, 1.7, 1.3, 2.3, 1.9].forEach(function (h, n) {
      poner(LP, geoCaja(0.6, 0.02, h), 'barra' + h, mx - 2 + n, y + 1.4, s.z + 1.28, VIVOS[n % VIVOS.length]);
    });
    plantaGrande(L, s.x + 2.2, s.z + 2.2, 0, false, cajaSala(s));
    plantaGrande(L, s.x + s.w - 1.4, s.z + 2.2, 1, false, cajaSala(s));
  }

  function biblioteca(L, s) {
    /* bibliotecas de verdad (Container Bookcase 2 x 4 x 4) contra la pared del pasillo, con libros de colores adentro */
    var y = PLACA, libros = [C.rojo, C.azul, C.amarillo, C.verde, BLANCO, NEGRO, C.naranja, '#5b4a3a'];
    var nEst = Math.max(1, Math.floor((s.w - 5) / 4));
    for (var e = 0; e < nEst; e++) {
      var x0 = s.x + 1.5 + e * 4, bz = s.z + 2;
      ldraw('1', x0 + 2, y, bz, 0, MADERA);
      for (var n = 0; n < 2; n++) for (var k = 0; k < 6; k++) {
        var h = 0.8 + ((k * 7 + n * 3 + e) % 3) * 0.12;
        poner(L, geoBloque(0.45, 1.3, h), 'libro' + h, x0 + 0.55 + k * 0.58, y + 0.45 + n * 2.4, bz, libros[(k + n * 3 + e * 2) % libros.length]);
      }
    }
    var mx = Math.round(s.x + s.w / 2), mz = s.z + s.d - 5;
    /* alfombra, mesa, dos sillones de lectura, lámpara de pie y planta */
    alfombra(L, mx - 4, mz - 3, mx + 4, mz + 3, '#9c8a6e');
    poner(L, geoRedondo(0.5, LADRILLO * 2), 'patamesa', mx, y, mz, GRIS_OSCURO);
    poner(L, geoRedondo(2.2, PLACA), 'mesaredonda', mx, y + LADRILLO * 2, mz, TOSTADO);
    teja(L, 1, 2, mx - 0.6, y + LADRILLO * 2 + PLACA, mz + 0.3, '#2f3b4a');
    ldraw('3899', mx + 0.8, y + LADRILLO * 2 + PLACA, mz - 0.4, 0, BLANCO);
    sillon(L, mx - 4.5, mz, Math.PI / 2, '#4a5560', 2);
    sillon(L, mx + 4.5, mz, -Math.PI / 2, MADERA, 2);
    var lx = s.x + s.w - 2, lz = s.z + s.d - 2;
    redonda(L, R2, PLACA, lx, y, lz, NEGRO, 0);
    poner(L, geoRedondo(0.12, 3.2), 'barraLampP', lx, y + PLACA, lz, NEGRO);
    ldraw('3942c', lx, y + 3.2, lz, 0, '#e8e4dc');
    plantaGrande(L, s.x + 2.2, s.z + s.d - 2.2, 1, false, cajaSala(s));
  }

  function comun(L, s) {
    var y = PLACA, alFondo = s.lado === 'fondo';
    var zA = alFondo ? s.z + 2 : s.z + s.d - 2;      // junto a la pared de atrás
    /* bajo mesada de ladrillos 2x2 con tapa lisa, heladera y cafetera */
    for (var i = 0; i < 3; i++) pieza(L, 2, 2, LADRILLO * 2, s.x + 2.5 + i * 2, y, zA, [BLANCO, '#a3a7aa', BLANCO][i], false);
    pieza(L, 6, 2, PLACA, s.x + 4.5, y + LADRILLO * 2, zA, BLANCO, false);
    pieza(L, 2, 2, LADRILLO * 3, s.x + 8.5, y, zA, BLANCO, true);
    poner(L, geoBloque(0.12, 0.2, 1.2), 'manijaHel', s.x + 7.45, y + 2.0, zA + (alFondo ? 0.9 : -0.9), GRIS_CLARO);
    pieza(L, 1, 1, LADRILLO, s.x + 2.5, y + LADRILLO * 2 + PLACA, zA, NEGRO, true);
    ldraw('3899', s.x + 3.6, y + LADRILLO * 2 + PLACA, zA, 0, BLANCO);
    ldraw('6936', s.x + 5.5, y + LADRILLO * 2 + PLACA, zA + (alFondo ? -0.5 : 0.5), alFondo ? 0 : Math.PI, GRIS_CLARO);
    /* expendedora: ladrillos 2x2 con un vidrio impreso */
    if (s.w > 16) {
      pieza(L, 2, 2, LADRILLO * 3, s.x + 11, y, zA, GRIS_OSCURO, true);
      poner(LP, geoCaja(1.3, 0.02, 2.4), 'expVidrio', s.x + 10.8, y + 0.8, zA + (alFondo ? 1.01 : -1.01), C.azulClaro);
    }
    /* ping-pong en el medio: tejas verdes sobre patas redondas */
    var cx = Math.round(s.x + Math.min(s.w - 2, 24) / 2 + 1), cz = Math.round(s.z + s.d / 2 + (alFondo ? 1 : -1));
    if (s.w >= 14) {
      [[-2.5, -1.5], [2.5, -1.5], [-2.5, 1.5], [2.5, 1.5]].forEach(function (o) { redonda(L, R1, LADRILLO * 1.5, cx + o[0], y, cz + o[1], GRIS_OSCURO, 0); });
      pieza(L, 6, 4, PLACA, cx, y + LADRILLO * 1.5, cz, '#2f6b45', false);
      poner(L, geoCaja(5.8, 0.06, 0.02), 'lineaPP', cx, y + LADRILLO * 1.5 + PLACA, cz, BLANCO);
      pieza(L, 0.2, 4, 0.5, cx, y + LADRILLO * 1.5 + PLACA, cz, BLANCO, false);
    }
    banqueta(L, cx + 6, cz - 1, '#6b7078'); banqueta(L, cx + 7.5, cz + 1, '#4a5560');
    if (s.w > 26) { sillon(L, s.x + s.w - 4, cz, -Math.PI / 2, '#4a5560', 4); mesita(L, s.x + s.w - 8, cz, MADERA); }
    plantaGrande(L, s.x + s.w - 2.2, zA, 0, false, cajaSala(s));
  }

  /* árboles de verdad: copa ovalada (3470), pino grande (3471) o pino chico (2435) */
  function arbol(L, x, z, k) {
    var tipo = k % 3;
    if (tipo === 0) ldraw('3470', x, 0, z, k, C.verdeClaro);
    else if (tipo === 1) ldraw('3471', x, 0, z, k, C.verde);
    else { ldraw('3062b', x, 0, z, 0, C.marron); ldraw('2435', x, LADRILLO, z, k, C.verde); }
  }
  var FLORES = [C.rojo, C.amarillo, BLANCO, C.rosa];
  function flores(L, x, z, k) {
    for (var i = 0; i < 4; i++) {
      var a = (k * 1.7 + i * 2.39), r = 1.9 + (i % 2) * 0.6;
      var fx = Math.round((x + Math.cos(a) * r) - 0.5) + 0.5, fz = Math.round((z + Math.sin(a) * r) - 0.5) + 0.5;
      ldraw('24855c01', fx, 0, fz, a, FLORES[(k + i) % FLORES.length]);
    }
  }
  /* farol: poste 2 x 2 x 7 (2039), luz amarilla (ladrillo redondo 1x1) y pantalla (plato 2x2 invertido) */
  function farol(L, x, z) {
    ldraw('2039', x, PLACA, z, 0, GRIS_OSCURO);
    ldraw('3062b', x, PLACA + 8.4, z, 0, null, 'luz');
    ldraw('4740', x, PLACA + 8.4 + LADRILLO, z, 0, NEGRO);
  }
  /* Auto clásico de 4 de ancho, mirando hacia +z: dos plates 2x2 con ruedas (122c03), base 4x10, capó con faros
     (4070), parabrisas (3823), asiento de minifig (4079) y baúl. Se arma suelto porque se mueve por la calle. */
  function autoLego(col) {
    var g = new T.Group(), Lc = lote(), y = 1.2;
    pieza(Lc, 2, 2, PLACA, 0, y, 3, GRIS_OSCURO, false);
    pieza(Lc, 2, 2, PLACA, 0, y, -3, GRIS_OSCURO, false);
    pieza(Lc, 4, 10, PLACA, 0, y + PLACA, 0, col, false);
    var yb = y + PLACA * 2;
    pieza(Lc, 4, 1, LADRILLO, 0, yb, 3.5, col, true);
    pieza(Lc, 2, 1, LADRILLO, 0, yb, 4.5, col, true);
    pieza(Lc, 4, 2, PLACA, 0, yb, -2, col, false);
    pieza(Lc, 4, 2, LADRILLO, 0, yb, -4, col, true);
    teja(Lc, 1, 1, -1.5, yb + LADRILLO, -4.5, C.rojo);
    teja(Lc, 1, 1, 1.5, yb + LADRILLO, -4.5, C.rojo);
    cerrarLote(Lc, g);
    g.traverse(function (o) { if (o.isMesh) o.castShadow = false; });
    /* sombra suave debajo */
    var sombra = new T.Mesh(new T.PlaneGeometry(4.6, 10.6), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    sombra.rotation.x = -Math.PI / 2; sombra.position.y = 0.03; g.add(sombra);
    var piezas = [
      ['122c03', 0, 0, 3, 0, GRIS_OSCURO], ['122c03', 0, 0, -3, 0, GRIS_OSCURO],
      ['4070', -1.5, yb, 4.5, 0, col], ['4070', 1.5, yb, 4.5, 0, col],
      ['3823', 0, yb, 2, 0, null, 'vidrio'], ['4079', 0, yb, 0, 0, NEGRO]
    ];
    return Promise.all(piezas.map(function (p) {
      return mallaLDraw(p[0], p[5], p[6]).then(function (m) { m.position.set(p[1], p[2], p[3]); m.rotation.y = p[4]; g.add(m); });
    })).then(function () { return g; });
  }
  var autos = [];
  var ESPERA_AUTO = [12, 30];   // segundos que un auto tarda en volver a aparecer después de salir de la base
  function armarAutos(grupo, pl) {
    return Promise.all((pl.autos || []).map(function (a) {
      return autoLego(a.col).then(function (g) {
        g.position.set(a.x, 0.2, a.z); g.rotation.y = a.dir * Math.PI / 2;
        grupo.add(g);
        return { g: g, dir: a.dir, vel: a.vel, x0: pl.x0 - 5, x1: pl.x1 + 5, vuelve: 0 };     // salen por el borde de la base y vuelven después de un rato
      });
    })).catch(function (e) { console.warn('Autos:', e && e.message); return []; });
  }

  function exterior(L, LV, pl, entradaX, bx0, bx1, bz0, bz1) {
    var zV = pl.D, zC = pl.D + VEREDA, zP = zC + CALLE, ancho = bx1 - bx0;
    /* vereda */
    pisoBaldosas(L, bx0, zV, ancho, VEREDA, C.vereda);
    /* calle: una placa oscura con líneas punteadas y senda peatonal frente a la entrada */
    poner(L, geoBloque(ancho, CALLE, 0.2), 'calle' + ancho, bx0 + ancho / 2, 0, zC + CALLE / 2, C.calle);
    for (var x = bx0 + 1; x < bx1 - 1; x += 4) {
      if (x + 2 > entradaX - 2 && x < entradaX + 6) continue;
      poner(L, geoCaja(2, 0.3, 0.03), 'lineaCalle', x + 1, 0.2, zC + CALLE / 2, BLANCO);
    }
    for (var sx = entradaX - 1.5; sx < entradaX + 5; sx += 1.2) poner(L, geoCaja(0.6, CALLE - 0.8, 0.03), 'cebra', sx, 0.2, zC + CALLE / 2, BLANCO);
    /* autos (se arman aparte porque circulan; ver armarAutos) */
    pl.autos = [
      { x: entradaX + 15, z: zC + 2, dir: -1, col: C.azul, vel: 6 },
      { x: Math.max(bx0 + 5, entradaX - 10), z: zC + CALLE - 2, dir: 1, col: C.amarillo, vel: 7.5 }
    ];
    /* faroles en las esquinas de la vereda (son altos: delante del edificio taparían la vista) */
    farol(L, bx0 + 2, zV + 1.5);
    farol(L, bx1 - 2, zV + 1.5);
    /* árboles y flores alrededor del edificio */
    var k = 0;
    for (var tx = bx0 + 3; tx < bx1 - 2; tx += 7) { arbol(L, tx, bz0 + 3, k); if (k % 2 === 0) flores(L, tx + 3.5, bz0 + 3, k); k++; }
    for (var tz = bz0 + 10; tz < zV - 2; tz += 7) {
      arbol(L, bx0 + 3, tz, k); flores(L, bx0 + 3, tz + 3.5, k); k++;
      arbol(L, bx1 - 3, tz, k); k++;
    }
    for (var ux = bx0 + 2; ux < bx1 - 1; ux += 6) { arbol(L, ux, zP + 2.5, k); if (k % 3 === 0) flores(L, ux + 3, zP + 3, k); k++; }
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
    sol.position.set(orb.tx - k * 0.6, k * 0.8 + 14, orb.tz + k * 0.45);
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
    /* sobre el monitor de escritorio(): marco 3x2 en z = cz+3.1+0.3, pantalla de 2.7x1.7 centrada en tope+1.9 */
    var geo = geoCache.pantallaPlana || (geoCache.pantallaPlana = new T.PlaneGeometry(2.7, 1.7));
    var cx = f.asiento.x, cz = f.asiento.z - 0.2, tope = PLACA + LADRILLO * 2 + PLACA, y = tope + 1.9, zm = cz + 3.1;
    var g = new T.Group();
    var adelante = new T.Mesh(geo, mat); adelante.position.set(cx + 1, y, zm + 0.065); adelante.rotation.y = Math.PI;
    var atras = new T.Mesh(geo, mat); atras.position.set(cx + 1, y, zm + 0.515);
    g.add(adelante, atras);
    mundo.add(g);
    f.pantalla = { canvas: c, ctx: c.getContext('2d'), tex: tex, mat: mat, grupo: g };
    dibujarPantalla(f);
  }

  function dibujarPantalla(f) {
    var P2 = f.pantalla; if (!P2) return;
    var x = P2.ctx, w = 128, h = 80, t = trabajo[f.a.id], n = f.cuadroPant || 0, i;
    var est = t ? t.estado : null;
    /* libre: se oculta y se ve la pantalla decorada del monitor (y su parte de atrás negra) */
    P2.grupo.visible = !!est;
    if (!est) return;
    x.fillStyle = est === 'leyendo' ? '#f1efe9' : '#1f2227';
    x.fillRect(0, 0, w, h);
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
    muro: muro,
    pedir: pedir,
    _estado: function () { return { figuras: Object.keys(figuras).length, animando: Object.keys(animando), orb: orb, plano: plano && { w: plano.x1, d: plano.z1 }, autos: autos.map(function (a) { return Math.round(a.g.position.x * 10) / 10; }), post: !!post, info: renderer.info.render }; }
  };
})();
