/* Navegación: riel de secciones, columna de lista y rutas con # (Atrás y Adelante funcionan).
   Los módulos siguen pintando en App.dom.derecho y llamando a App.abrirDerecho(modo). Acá se decide dónde se ve:
   - Bandeja: lo que te espera (para revisar, permisos pendientes, parte del día).
   - Oficina: la maqueta 3D, sola.
   - Charlas (con las reuniones), Equipo (la ficha de cada agente y los departamentos), Archivos y Trabajo: el panel ocupa
     todo el ancho y a su izquierda queda la lista. Cada acción tiene una sola entrada por pantalla.
   Se sincroniza en los dos sentidos: una ruta abre el módulo, y un módulo abierto desde otro lado (un aviso, la
   maqueta, ⌘K) deja la ruta que le corresponde en el historial. */
App.Nav = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var api = function () { return App.api; };

  /* `movil`: en el celular la barra de abajo muestra solo estas; el resto va en «Más» */
  var SECCIONES = [
    { id: 'bandeja', texto: 'Bandeja', icono: 'bandeja', ruta: '#/bandeja', movil: true },
    { id: 'oficina', texto: 'Oficina', icono: 'edificio', ruta: '#/oficina' },
    { id: 'charlas', texto: 'Charlas', icono: 'charla', ruta: '#/charlas', movil: true },
    { id: 'equipo', texto: 'Equipo', icono: 'personas', ruta: '#/equipo', movil: true },
    { id: 'archivos', texto: 'Archivos', icono: 'carpeta', ruta: '#/archivos', movil: true },
    { id: 'trabajo', texto: 'Trabajo', icono: 'reloj', ruta: '#/trabajo' }
  ];
  /* modo del panel -> sección y subsección (el agente depende de la pestaña: la charla en Charlas, la ficha en Equipo) */
  var LUGAR = {
    reunion: ['charlas'],
    entregables: ['bandeja', 'revisar'], permisos: ['bandeja', 'permisos'], parte: ['bandeja', 'hoy'],
    deptos: ['equipo', 'departamentos'], contratar: ['equipo', 'contratar'], creador: ['equipo', 'creador'],
    'reunion-nueva': ['charlas'], 'flujos-editor': ['trabajo', 'flujos'],
    biblioteca: ['archivos', 'biblioteca'], conocimiento: ['archivos', 'conocimiento'], carpeta: ['archivos', 'carpeta'],
    tareas: ['trabajo', 'tareas'], flujos: ['trabajo', 'flujos']
  };
  function lugarDe(modo) {
    if (modo === 'agente') return App.Agente.pestana() === 'chat' ? ['charlas'] : ['equipo'];
    return LUGAR[modo];
  }
  var seccion = null, sub = null;
  var aplicando = false;        // mientras una ruta abre un módulo, el módulo no vuelve a escribir la ruta
  var dom = {};                 // riel, lista, items del riel
  var sesiones = null;          // cache de /api/sesiones
  var reuniones = null;         // cache de /api/reuniones
  var buscar = '';
  var plegado = {};
  try { plegado = JSON.parse(localStorage.getItem('oficina.nav.plegado') || '{}') || {}; } catch (e) {}

  function esMovil() { return window.matchMedia('(max-width: 720px)').matches; }
  function leer() {
    var p = (location.hash || '').replace(/^#\/?/, '').split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } });
    // #/reuniones/<id> es una reunión: se ve dentro de Charlas
    var sec = p[0] === 'reuniones' || SECCIONES.some(function (s) { return s.id === p[0]; }) ? p[0] : 'oficina';
    return { sec: sec, a: p[1] || null, b: p[2] || null, resto: p.slice(2).join('/') };
  }
  function empujar(ruta, reemplazar) {
    if (location.hash === ruta) return;
    if (reemplazar) history.replaceState(null, '', ruta); else history.pushState(null, '', ruta);
  }

  /* ---------------- riel ---------------- */
  /* `op`: {menuOficina(ancla), menuNuevo(ancla), insignias: {seccion: elemento}, extra: [elementos abajo]} */
  function riel(op) {
    dom.items = {};
    var items = SECCIONES.map(function (s, i) {
      var b = h('button.riel-item' + (s.movil ? '' : '.riel-no-movil'), { title: s.texto + ' (' + (App.atajoMod || '⌘') + (i + 1) + ')', onclick: function () { ir(s.id === 'oficina' ? s.ruta : rutaSeccion(s.id)); } },
        App.icono(s.icono), h('span', s.texto), op.insignias && op.insignias[s.id] ? op.insignias[s.id] : null);
      dom.items[s.id] = b;
      return b;
    });
    dom.riel = h('nav.riel',
      h('button.riel-logo', { title: 'Cambiar de oficina', onclick: function (ev) { op.menuOficina(ev.currentTarget); } }, App.logo()),
      h('button.riel-nuevo', { title: 'Nuevo…', onclick: function (ev) { op.menuNuevo(ev.currentTarget); } }, App.icono('mas')),
      items,
      h('button.riel-item.riel-mas', { title: 'Más', onclick: function (ev) { menuMas(ev.currentTarget); } }, App.icono('menu'), h('span', 'Más')),
      h('div.riel-sep'), op.extra || null);
    return dom.riel;
  }
  /* celular: lo que no entra en la barra de abajo */
  function menuMas(ancla) {
    var items = SECCIONES.filter(function (s) { return !s.movil; }).map(function (s) {
      return { texto: s.texto, icono: s.icono, accion: function () { ir(s.id === 'oficina' ? s.ruta : rutaSeccion(s.id)); } };
    });
    items.push('-',
      { texto: 'Buscar o ir a…', icono: 'buscar', accion: function () { App.Paleta.abrir(); } },
      { texto: 'Ajustes', icono: 'ajustes', accion: function () { App.Ajustes.abrir(); } },
      { texto: 'Cambiar de oficina…', icono: 'edificio', accion: function () { App.menuOficina(ancla); } });
    App.menu(ancla, items);
  }
  /* la última subsección que miraste de cada sección (Archivos › Biblioteca, Trabajo › Flujos…) */
  var ultimaSub = { bandeja: 'hoy', archivos: 'biblioteca', trabajo: 'tareas' };
  function rutaSeccion(id) {
    if (ultimaSub[id]) return '#/' + id + (esMovil() ? '' : '/' + ultimaSub[id]);
    return '#/' + id;
  }

  /* ---------------- secciones ---------------- */
  function ponerSeccion(sec, s) {
    var antes = seccion;
    seccion = sec; sub = s || null;
    if (antes !== sec && sec === 'charlas' && sesiones) cargarSesiones();      // al entrar, se pone al día sin parpadear
    if (antes !== sec && sec === 'charlas' && reuniones) cargarReuniones();
    if (s && ultimaSub[sec] !== undefined && s !== 'carpeta') ultimaSub[sec] = s;
    var app = App.dom.app;
    app.classList.toggle('en-oficina', sec === 'oficina');
    app.classList.toggle('en-seccion', sec !== 'oficina');
    app.setAttribute('data-seccion', sec);
    if (App.Oficina3D && App.Oficina3D.pausar) App.Oficina3D.pausar(sec !== 'oficina');
    Object.keys(dom.items || {}).forEach(function (k) {
      dom.items[k].classList.toggle('activo', k === sec);
      if (k === sec) dom.items[k].setAttribute('aria-current', 'page'); else dom.items[k].removeAttribute('aria-current');
    });
    marcarDetalle();
    pintarLista();
  }
  function marcarDetalle() {
    var m = App.modoDerecho ? App.modoDerecho() : null;
    App.dom.app.classList.toggle('con-detalle', seccion !== 'oficina' && !!m && m !== 'vacio');
  }

  /* El panel vacío de una sección (nada elegido todavía). Cierra lo que hubiera con su limpieza de siempre. */
  function vacio() {
    if (App.modoDerecho() && App.modoDerecho() !== 'vacio') App.cerrarDerecho(true);
    var der = App.dom.derecho;
    der.classList.remove('con-relacionado');
    der.classList.add('abierto'); der.setAttribute('data-modo', 'vacio');
    var txt = {
      bandeja: ['bandeja', 'Lo que te espera', 'Hoy junta lo que te entregaron, los permisos que te piden y lo que pasó.'],
      charlas: ['charla', 'Elegí una charla o empezá una', 'Hablale a alguien del equipo, o juntá a varios en una reunión. Todo queda guardado a la izquierda.'],
      equipo: ['personas', 'Tu equipo', 'Elegí a alguien para ver y cambiar su perfil, sus permisos, sus notas, sus tareas y sus archivos.'],
      archivos: ['carpeta', 'Archivos de la oficina', 'La carpeta de la oficina, la biblioteca y lo que sabe la oficina.'],
      trabajo: ['reloj', 'Lo que los agentes hacen solos', 'Tareas programadas y flujos que pasan de un agente a otro.']
    }[seccion] || ['edificio', '', ''];
    var accion = seccion === 'charlas' ? h('div.acciones', { style: { justifyContent: 'center' } },
      h('button.btn.primario', { onclick: function (ev) { elegirAgente(ev.currentTarget, nuevaCharla); } }, App.icono('charla'), 'Charlar con alguien'),
      h('button.btn', { onclick: function () { App.Reunion.nueva(); } }, App.icono('reunion'), 'Llamar a reunión'))
      : seccion === 'equipo' ? h('button.btn.primario', { onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar un agente') : null;
    App.add(App.vaciar(der), h('div.nav-vacio', App.icono(txt[0]), h('b', txt[1]), h('p', txt[2]), accion));
    marcarDetalle();
  }

  /* ---------------- rutas -> módulos ---------------- */
  function aplicar() {
    var r = leer(), m = App.modoDerecho();
    aplicando = true;
    try {
      /* rutas viejas: lo que esperaba tu revisión vivía en Archivos */
      if (r.sec === 'archivos' && r.a === 'revisar') { empujar('#/bandeja/revisar' + (r.b ? '/' + r.b : ''), true); r = leer(); }
      var enChat = m === 'agente' && App.Agente.pestana() === 'chat';
      if (r.sec === 'oficina') {
        ponerSeccion('oficina');
        if (m) App.cerrarDerecho(true);
      } else if (r.sec === 'bandeja') {
        if (!r.a && !esMovil()) { empujar('#/bandeja/hoy', true); r.a = 'hoy'; }   // en la compu, la Bandeja abre en Hoy
        ponerSeccion('bandeja', r.a === 'parte' ? 'hoy' : r.a);
        if (r.a === 'revisar') {
          var ab = m === 'entregables' ? App.Entregables.abierta() : undefined;
          if (r.b) { if (ab !== +r.b) App.Entregables.abrir(+r.b); }
          else if (m !== 'entregables' || ab) App.Entregables.abrir();
        } else if (r.a === 'permisos') { if (m !== 'permisos') App.Permisos.abrirPanel(); }
        else if (r.a === 'hoy' || r.a === 'parte') { if (m !== 'parte') App.Parte.abrir(); }
        else vacio();
      } else if (r.sec === 'equipo') {
        ponerSeccion('equipo', ['departamentos', 'contratar', 'creador'].indexOf(r.a) >= 0 ? r.a : null);
        if (r.a === 'departamentos') { if (m !== 'deptos') abrirDeptos(); }
        else if (r.a === 'contratar') { if (m !== 'contratar') App.Contratar.abrir(); }
        else if (r.a === 'creador') { if (m !== 'creador') App.Creador.abrir(); }
        else if (r.a && App.agente(r.a)) {
          var pest = r.b || 'perfil';
          if (!(m === 'agente' && App.Agente.actual() === r.a && App.Agente.pestana() === pest)) App.Agente.abrir(r.a, pest);
        } else vacio();
      } else if (r.sec === 'charlas') {
        ponerSeccion('charlas');
        if (r.a === 'nueva-reunion') { if (m !== 'reunion-nueva') App.Reunion.nueva(); }
        else if (r.a && App.agente(r.a)) {
          if (r.b) { if (!(enChat && App.Agente.actual() === r.a && App.Agente.sesion(r.a) === r.b)) App.Agente.abrirSesion(r.a, r.b); }
          else if (!(enChat && App.Agente.actual() === r.a)) App.Agente.abrir(r.a, 'chat');
        } else if (!esMovil() && sesiones && sesiones.length && !enChat) {
          var s = sesiones[0];
          empujar('#/charlas/' + encodeURIComponent(s.agente) + '/' + s.session, true);
          App.Agente.abrirSesion(s.agente, s.session);
        } else if (enChat && !esMovil()) {
          empujar(rutaDe('agente'), true);
        } else vacio();
      } else if (r.sec === 'reuniones') {
        ponerSeccion('charlas');
        if (r.a) { if (!(m === 'reunion' && App.Reunion.abierta() === r.a)) App.Reunion.ver(r.a); }
        else { empujar('#/charlas', true); vacio(); }
      } else if (r.sec === 'archivos') {
        ponerSeccion('archivos', r.a);
        if (r.a === 'biblioteca') { if (m !== 'biblioteca') App.Biblioteca.abrir(); }
        else if (r.a === 'conocimiento') { if (m !== 'conocimiento') App.Conocimiento.abrir(); }
        else if (r.a === 'carpeta') { if (!(m === 'carpeta' && App.Carpeta.ruta() === (r.resto || ''))) App.Carpeta.abrir(r.resto || ''); }
        else vacio();
      } else if (r.sec === 'trabajo') {
        ponerSeccion('trabajo', r.a);
        if (r.a === 'flujos' && r.b === 'editar') {
          var ed = m === 'flujos-editor' && App.Flujos.editando ? App.Flujos.editando() : undefined;
          if (m !== 'flujos-editor' || String(ed || '') !== (r.resto.split('/')[1] || '')) App.Flujos.editor(r.resto.split('/')[1] || null);
        } else if (r.a === 'flujos') {
          var co = m === 'flujos' && App.Flujos.corridaAbierta ? App.Flujos.corridaAbierta() : undefined;
          if (r.b) { if (co !== +r.b) App.Flujos.verCorrida(r.b); }
          else if (m !== 'flujos' || co) App.Flujos.abrir();
        }
        else if (r.a === 'tareas') { if (m !== 'tareas') App.Tareas.abrir(); }
        else vacio();
      }
    } finally { aplicando = false; }
    marcarDetalle();
    pintarLista();
  }

  /* ---------------- módulos -> ruta ---------------- */
  function rutaDe(modo) {
    if (modo === 'agente') {
      var id = App.Agente.actual(), sid = App.Agente.sesionFija && App.Agente.sesionFija(), p = App.Agente.pestana();
      if (p !== 'chat') return '#/equipo/' + encodeURIComponent(id || '') + '/' + p;
      return '#/charlas/' + encodeURIComponent(id || '') + (sid ? '/' + sid : '');
    }
    if (modo === 'reunion') return '#/reuniones/' + encodeURIComponent((App.Reunion.abierta && App.Reunion.abierta()) || '');
    if (modo === 'entregables') { var e = App.Entregables.abierta(); return '#/bandeja/revisar' + (e ? '/' + e : ''); }
    if (modo === 'permisos') return '#/bandeja/permisos';
    if (modo === 'parte') return '#/bandeja/hoy';
    if (modo === 'deptos') return '#/equipo/departamentos';
    if (modo === 'contratar') return '#/equipo/contratar';
    if (modo === 'creador') return '#/equipo/creador';
    if (modo === 'reunion-nueva') return '#/charlas/nueva-reunion';
    if (modo === 'flujos-editor') { var fe = App.Flujos.editando && App.Flujos.editando(); return '#/trabajo/flujos/editar' + (fe ? '/' + encodeURIComponent(fe) : ''); }
    if (modo === 'biblioteca') return '#/archivos/biblioteca';
    if (modo === 'conocimiento') return '#/archivos/conocimiento';
    if (modo === 'carpeta') { var c = App.Carpeta.ruta(); return '#/archivos/carpeta' + (c ? '/' + c.split('/').map(encodeURIComponent).join('/') : ''); }
    if (modo === 'tareas') return '#/trabajo/tareas';
    if (modo === 'flujos') { var co = App.Flujos.corridaAbierta && App.Flujos.corridaAbierta(); return '#/trabajo/flujos' + (co ? '/' + co : ''); }
    return '#/oficina';
  }
  /* App.abrirDerecho avisa acá: si el módulo se abrió desde otro lado, la sección y la ruta lo siguen */
  function alAbrir(modo) {
    if (modo !== 'agente') App.dom.derecho.classList.remove('con-relacionado');
    var lugar = lugarDe(modo);
    if (!lugar) return;
    if (seccion !== lugar[0] || (lugar[1] && sub !== lugar[1])) ponerSeccion(lugar[0], lugar[1]);
    if (!aplicando) empujar(rutaDe(modo));
    marcarDetalle();
    pintarLista();
  }
  /* App.cerrarDerecho avisa acá: en una sección, cerrar el panel vuelve a la lista (en el celular) o al vacío */
  function alCerrar(silencioso) {
    if (seccion === 'oficina' || silencioso) { marcarDetalle(); return; }
    vacio();
    if (!aplicando) empujar('#/' + seccion);
    pintarLista();
  }
  /* un módulo cambió algo que mira la lista (mandaste un mensaje, terminó una reunión…) */
  var refrescoPendiente = null;
  function refrescar() {
    sesiones = seccion === 'charlas' ? sesiones : null;
    clearTimeout(refrescoPendiente);
    refrescoPendiente = setTimeout(function () { if (seccion === 'charlas') { cargarSesiones(); cargarReuniones(); } else pintarLista(); }, 150);
  }

  function ir(ruta) { if (location.hash === ruta) aplicar(); else location.hash = ruta; }

  /* ---------------- columna de lista ---------------- */
  function lista() { return App.dom.lista; }
  function pintarLista() {
    var col = lista(); if (!col) return;
    if (seccion === 'charlas') pintarCharlas(col);
    else if (seccion === 'bandeja') pintarBandeja(col);
    else if (seccion === 'equipo') pintarEquipo(col);
    else if (seccion === 'archivos') pintarArchivos(col);
    else if (seccion === 'trabajo') pintarTrabajo(col);
    else App.vaciar(col);
  }
  function cabecera(titulo, boton) { return h('div.lista-cab', h('h2', titulo), boton || null); }
  function filtroFila(icono, texto, activo, accion, extra) {
    return h('button.lista-filtro' + (activo ? '.activo' : ''), { onclick: accion }, typeof icono === 'string' ? App.icono(icono) : icono, h('span', texto), extra || null);
  }
  function grupoPlegable(clave, titulo, cuerpo, cuenta) {
    var abierto = !plegado[clave];
    var tit = h('button.lista-grupo.plegable' + (abierto ? '.abierto' : ''), { onclick: function () {
      plegado[clave] = abierto; abierto = !abierto;
      try { localStorage.setItem('oficina.nav.plegado', JSON.stringify(plegado)); } catch (e) {}
      tit.classList.toggle('abierto', abierto); cuerpo.classList.toggle('oculto', !abierto);
    } }, App.icono('abajo'), titulo, cuenta ? h('span.cuenta', cuenta) : null);
    cuerpo.classList.toggle('oculto', !abierto);
    return [tit, cuerpo];
  }

  /* --- Charlas: el equipo arriba (plegable) y las charlas guardadas de todos, la más reciente primero --- */
  function cargarSesiones() {
    return api().get('/api/sesiones').then(function (r) {
      sesiones = r.sesiones || [];
      if (seccion === 'charlas') pintarLista();
      return sesiones;
    }).catch(function () { sesiones = sesiones || []; });
  }
  function pintarCharlas(col) {
    var inp = h('input.campo', { placeholder: 'Buscar en charlas', value: buscar });
    var caja = h('div');
    inp.addEventListener('input', function () { buscar = inp.value; llenar(); });
    function llenar() {
      App.vaciar(caja);
      var q = buscar.trim().toLowerCase();
      caja.appendChild(bloqueReuniones(q));
      if (!sesiones) { caja.appendChild(h('div.vacio', h('span.giro'))); return; }
      caja.appendChild(h('div.lista-grupo', 'Charlas'));
      var ss = sesiones.filter(function (s) {
        var a = App.agente(s.agente); if (!a) return false;
        return !q || (titulo(s) + ' ' + s.ultimo + ' ' + a.nombre).toLowerCase().indexOf(q) >= 0;
      });
      var hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      var corte = [hoy.getTime() / 1000, hoy.getTime() / 1000 - 86400, hoy.getTime() / 1000 - 6 * 86400];
      var grupos = [['Hoy', []], ['Ayer', []], ['Esta semana', []], ['Antes', []]];
      ss.forEach(function (s) { grupos[s.ts >= corte[0] ? 0 : s.ts >= corte[1] ? 1 : s.ts >= corte[2] ? 2 : 3][1].push(s); });
      grupos.forEach(function (g) {
        if (!g[1].length) return;
        caja.appendChild(h('div.lista-subgrupo', g[0]));
        g[1].forEach(function (s) { caja.appendChild(filaSesion(s)); });
      });
      if (!ss.length) caja.appendChild(h('div.vacio', q ? 'Nada con «' + buscar + '».' : 'Todavía no hay charlas. Tocá a alguien del equipo para empezar.'));
    }
    llenar();
    App.add(App.vaciar(col),
      cabecera('Charlas', h('button.btn.chico', { title: 'Charla con alguien o reunión', onclick: function (ev) { menuNueva(ev.currentTarget); } }, App.icono('mas'), 'Nueva')),
      h('div.lista-buscar', App.icono('buscar'), inp),
      h('div.lista-cuerpo', caja));
    if (!sesiones) cargarSesiones().then(function () {
      var r = leer();   // recién llegó la lista: en la compu se abre la charla más reciente
      if (r.sec === 'charlas' && !r.a && !esMovil() && App.modoDerecho() !== 'agente' && sesiones.length) aplicar();
    });
  }
  function titulo(s) {
    var t = App.Adjuntos && App.Adjuntos.separar ? App.Adjuntos.separar(s.titulo || '').texto : s.titulo;
    return (t || '').trim() || 'Archivos';
  }
  function filaSesion(s) {
    var a = App.agente(s.agente);
    var activa = App.modoDerecho() === 'agente' && App.Agente.pestana() === 'chat' && App.Agente.actual() === s.agente && App.Agente.sesion(s.agente) === s.session;
    var ult = App.Adjuntos && App.Adjuntos.separar ? App.Adjuntos.separar(s.ultimo || '').texto : s.ultimo;
    return h('div.lista-item' + (activa ? '.activo' : ''), { onclick: function () { ir('#/charlas/' + encodeURIComponent(s.agente) + '/' + s.session); } },
      App.retratoImg(a, 'retrato', 64),
      h('div.lista-item-txt',
        h('div.lista-item-tit', h('b', titulo(s)), h('small', corto(s.ts))),
        h('div.lista-item-sub', a.nombre + ' · ' + (s.de === 'u' ? 'Vos: ' : '') + (ult || '').replace(/[*#`|>]/g, ''))));
  }
  function corto(ts) {
    var d = Date.now() / 1000 - ts;
    if (d < 60) return 'recién';
    if (d < 3600) return Math.round(d / 60) + ' min';
    if (d < 86400) return Math.round(d / 3600) + ' h';
    return Math.round(d / 86400) + ' d';
  }
  function elegirAgente(ancla, alElegir) {
    var items = [{ titulo: 'Charlar con' }];
    (App.E.oficina.agentes || []).forEach(function (a) { items.push({ texto: a.nombre, nota: a.rol, accion: function () { alElegir(a.id); } }); });
    if (items.length === 1) { App.Contratar.abrir(); return; }
    App.menu(ancla, items);
  }
  function nuevaCharla(id) { App.Agente.nueva(id); }

  /* --- Reuniones: la lista de siempre, a la izquierda --- */
  function cargarReuniones() {
    return api().get('/api/reuniones').then(function (r) { reuniones = r.reuniones || []; if (seccion === 'charlas') pintarLista(); }).catch(function () { reuniones = reuniones || []; });
  }
  /* Dentro de Charlas: las reuniones en curso y las últimas (con «Ver todas»). La búsqueda también las filtra. */
  var todasReuniones = false;
  function bloqueReuniones(q) {
    var caja = h('div');
    var abierta = App.modoDerecho() === 'reunion' ? App.Reunion.abierta() : null;
    if (reuniones && abierta && !reuniones.some(function (x) { return x.id === abierta; })) cargarReuniones();   // recién creada
    if (!reuniones) { cargarReuniones(); return caja; }
    var rs = reuniones.filter(function (x) { return !q || (x.tema + ' ' + nombresDe(x).join(' ')).toLowerCase().indexOf(q) >= 0; });
    if (!rs.length) return caja;
    var vivas = rs.filter(function (x) { return x.estado !== 'cerrada'; });
    var cerradas = rs.filter(function (x) { return x.estado === 'cerrada'; });
    var mostrar = vivas.concat(q || todasReuniones ? cerradas : cerradas.slice(0, Math.max(0, 3 - vivas.length)));
    App.add(caja, h('div.lista-grupo', 'Reuniones', vivas.length ? h('span.insignia.ok', { style: { marginLeft: 'auto' } }, vivas.length === 1 ? 'En curso' : vivas.length + ' en curso') : null),
      mostrar.map(function (x) {
        var activa = abierta === x.id;
        var est = x.estado === 'cerrada' ? h('small', App.fecha(x.creada)) : h('span.insignia.ok', x.estado === 'en_curso' ? 'En curso' : 'Esperando');
        return h('div.lista-item' + (activa ? '.activo' : ''), { onclick: function () { ir('#/reuniones/' + encodeURIComponent(x.id)); } },
          h('div.lista-icono', App.icono('reunion')),
          h('div.lista-item-txt', h('div.lista-item-tit', h('b', x.tema), est), h('div.lista-item-sub', nombresDe(x).join(', '))));
      }),
      !q && cerradas.length > mostrar.length - vivas.length || (todasReuniones && cerradas.length > 3)
        ? h('button.lista-mas', { onclick: function () { todasReuniones = !todasReuniones; pintarLista(); } },
          todasReuniones ? 'Ver menos' : 'Ver todas las reuniones (' + rs.length + ')') : null);
    return caja;
  }
  function nombresDe(x) { return (x.agentes || []).map(function (id) { var a = App.agente(id); return a ? a.nombre : id; }); }
  /* «Nueva»: una charla con alguien o una reunión */
  function menuNueva(ancla) {
    var items = [{ titulo: 'Charlar con' }];
    (App.E.oficina.agentes || []).forEach(function (a) { items.push({ texto: a.nombre, nota: a.rol, accion: function () { nuevaCharla(a.id); } }); });
    items.push('-');
    items.push({ texto: 'Llamar a reunión…', icono: 'reunion', accion: function () { App.Reunion.nueva(); } });
    if ((App.E.oficina.agentes || []).length === 0) items = [{ texto: 'Contratar un agente…', icono: 'mas', accion: function () { App.Contratar.abrir(); } }];
    App.menu(ancla, items);
  }

  /* --- Bandeja: lo que te espera --- */
  function pintarBandeja(col) {
    var n = App.Entregables && App.Entregables.sinRevisar ? App.Entregables.sinRevisar() : 0;
    var np = App.Permisos && App.Permisos.cuantos ? App.Permisos.cuantos() : 0;
    App.add(App.vaciar(col), cabecera('Bandeja'), h('div.lista-cuerpo',
      filtroFila('parte', 'Hoy', sub === 'hoy', function () { ir('#/bandeja/hoy'); }, n + np ? h('span.insignia.aviso', n + np) : null),
      h('div.lista-grupo', 'Por tipo'),
      filtroFila('bandeja', 'Para revisar', sub === 'revisar', function () { ir('#/bandeja/revisar'); }, n ? h('span.insignia', n) : null),
      filtroFila('escudo', 'Te piden permiso', sub === 'permisos', function () { ir('#/bandeja/permisos'); }, np ? h('span.insignia', np) : null)));
  }

  /* --- Equipo: vos, los agentes por departamento y los departamentos. Tocar a alguien abre su ficha. --- */
  function pintarEquipo(col) {
    App.add(App.vaciar(col),
      cabecera('Equipo', h('button.btn.chico', { title: 'Contratar un agente', onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar')),
      h('div.lista-cuerpo', App.dom.equipo,
        h('div.lista-grupo', 'La oficina'),
        filtroFila('capas', 'Departamentos', sub === 'departamentos', function () { ir('#/equipo/departamentos'); })));
    if (App.marcarEstados) App.marcarEstados();
  }
  /* Departamentos como pantalla (la misma sección de Ajustes): al guardar se vuelve a pintar */
  function abrirDeptos() {
    App.Deptos.abrir(function (op) {
      var hj = App.hojaEnPanel({ titulo: op.titulo || 'Departamentos', icono: 'capas' }, 'deptos');
      hj.enVentana = true;
      var barra = h('div.acciones'); hj.pie.appendChild(barra); hj.pie = barra;   // los botones van en la barra, no estirados
      hj.cerrar = function () { if (App.modoDerecho() === 'deptos') abrirDeptos(); };
      return hj;
    });
  }

  /* --- Archivos: la carpeta, la biblioteca y el conocimiento --- */
  function pintarArchivos(col) {
    var d = App.dom;
    App.add(App.vaciar(col), cabecera('Archivos'), h('div.lista-cuerpo',
      filtroFila('carpeta', 'Carpeta de la oficina', sub === 'carpeta', function () { ir('#/archivos/carpeta'); }),
      filtroFila('libro', 'Biblioteca', sub === 'biblioteca', function () { ir('#/archivos/biblioteca'); }, d.navBib),
      filtroFila('bombilla', 'Conocimiento', sub === 'conocimiento', function () { ir('#/archivos/conocimiento'); }, d.navCon)));
  }

  /* --- Trabajo: tareas y flujos (los botones de «nuevo» viven en cada panel) --- */
  function pintarTrabajo(col) {
    var d = App.dom;
    App.add(App.vaciar(col), cabecera('Trabajo'), h('div.lista-cuerpo',
      filtroFila('reloj', 'Tareas', sub === 'tareas', function () { ir('#/trabajo/tareas'); }, null),
      filtroFila('flujo', 'Flujos', sub === 'flujos', function () { ir('#/trabajo/flujos'); }, d.navFlu)));
  }

  /* --- «Relacionado»: a la derecha del chat (en una sección y con lugar): quién es, sus otras charlas, lo que te
     entregó y sus tareas. Cada cosa lleva a su lugar. --- */
  function relacionado(id) {
    var a = App.agente(id);
    var caja = h('aside.relacionado');
    if (!a) return caja;
    var charlas = h('div'), entregas = h('div', h('div.ayuda', '…')), tareas = h('div', h('div.ayuda', '…'));
    function mini(icono, texto, nota, accion, cls) {
      return h('button.rel-fila' + (cls || ''), { onclick: accion }, App.icono(icono), h('span', texto), nota ? h('small', nota) : null);
    }
    function pintarCharlas() {
      App.vaciar(charlas);
      var actualSid = App.Agente.sesion(id);
      var ss = (sesiones || []).filter(function (s) { return s.agente === id && s.session !== actualSid; }).slice(0, 6);
      if (!ss.length) charlas.appendChild(h('div.ayuda', sesiones ? 'No hay otras.' : '…'));
      ss.forEach(function (s) { charlas.appendChild(mini('charla', titulo(s), corto(s.ts), function () { ir('#/charlas/' + encodeURIComponent(id) + '/' + s.session); })); });
    }
    if (sesiones) pintarCharlas(); else cargarSesiones().then(pintarCharlas);
    api().get('/api/entregas', { agente: id, limite: 5 }).then(function (r) {
      App.vaciar(entregas);
      var es = r.entregas || [];
      if (!es.length) entregas.appendChild(h('div.ayuda', 'Todavía nada.'));
      es.forEach(function (e) {
        entregas.appendChild(mini('bandeja', e.titulo || 'Entrega', e.estado === 'sin_revisar' ? 'para revisar' : '', function () { App.Entregables.abrir(e.id); }, e.estado === 'sin_revisar' ? '.pendiente' : ''));
      });
    }).catch(function () { App.vaciar(entregas); });
    api().get('/api/tareas').then(function (r) {
      App.vaciar(tareas);
      var ts = (r.tareas || []).filter(function (t) { return t.agente === id; });
      if (!ts.length) tareas.appendChild(h('div.ayuda', 'Sin tareas programadas.'));
      ts.slice(0, 5).forEach(function (t) { tareas.appendChild(mini('reloj', t.nombre, t.corriendo ? 'corriendo' : t.activa === false ? 'en pausa' : '', function () { App.Agente.abrir(id, 'tareas'); })); });
    }).catch(function () { App.vaciar(tareas); });
    App.add(caja,
      h('div.rel-sec.primera', h('h4', 'Otras charlas con ' + a.nombre), charlas),
      h('div.rel-sec', h('h4', 'Lo que te entregó', h('button', { onclick: function () { ir('#/bandeja/revisar'); } }, 'Todo')), entregas),
      h('div.rel-sec', h('h4', 'Sus tareas', h('button', { onclick: function () { App.Agente.nuevaTarea(id, {}); } }, '+ Nueva')), tareas));
    return caja;
  }

  /* ---------------- arranque ---------------- */
  window.addEventListener('hashchange', function () { if (App.dom && App.dom.app) aplicar(); });
  window.addEventListener('popstate', function () { if (App.dom && App.dom.app) aplicar(); });
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !/^[1-6]$/.test(e.key)) return;
    if (!App.dom || !App.dom.app || (App.hojaAbierta && App.hojaAbierta())) return;
    e.preventDefault();
    var s = SECCIONES[+e.key - 1];
    ir(s.id === 'oficina' ? s.ruta : rutaSeccion(s.id));
  });

  return {
    riel: riel, aplicar: aplicar, ir: ir, alAbrir: alAbrir, alCerrar: alCerrar, refrescar: refrescar,
    seccion: function () { return seccion; }, enSeccion: function () { return !!seccion && seccion !== 'oficina'; },
    pintarLista: pintarLista, elegirAgente: elegirAgente, relacionado: relacionado, menuNueva: menuNueva
  };
})();
