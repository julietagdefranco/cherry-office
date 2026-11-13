/* Arranque, pantalla de inicio (sin oficina), estructura principal y barra lateral. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var E = App.E;
  var raiz = document.getElementById('raiz');
  var dom = {};

  /* ---------------- arranque ---------------- */
  function arrancar() {
    api.get('/api/estado').then(function (st) {
      E.estado = st;
      if (st.oficina) return api.get('/api/oficina').then(function (r) { montar(r.carpeta, r.oficina); });
      inicio();
    }).catch(function (e) {
      App.vaciar(raiz).appendChild(h('div.inicio', h('div', { style: { textAlign: 'center' } },
        h('h1', 'No me puedo conectar con la oficina'), h('p.bajada', e.message), h('button.btn', { onclick: arrancar }, 'Reintentar'))));
    });
  }

  /* ---------------- inicio ---------------- */
  function inicio() {
    App.Oficina3D.finReunion && E.oficina && App.Oficina3D.finReunion();
    E.oficina = null; E.carpeta = null;
    var recientes = h('div.recientes');
    var foto = h('div.inicio-foto', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr' } });
    ['ana', 'tomi', 'sol', 'leo'].forEach(function (s) { foto.appendChild(App.retratoImg({ id: s, avatar: { semilla: s } }, 'x', 320)); });
    foto.querySelectorAll('img').forEach(function (i) { i.style.cssText = 'width:100%;height:100%;object-fit:cover;background:var(--fondo)'; });
    App.vaciar(raiz).appendChild(h('div.inicio', h('div.inicio-caja', foto, h('div',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' } }, App.logo(), h('b', 'Oficina')),
      h('h1', 'Armá tu oficina'),
      h('p.bajada', 'Un equipo de agentes de Claude que trabaja para vos: los contratás contándoles qué necesitás, les hablás y los juntás a debatir.'),
      E.estado && !E.estado.claude ? h('p.error-txt', { style: { marginBottom: '14px' } }, 'No encontré Claude Code en esta compu. Vas a poder armar la oficina, pero los agentes no van a responder hasta instalarlo.') : null,
      h('button.opcion', { onclick: crearOficina }, App.icono('edificio'), h('div', h('b', 'Crear mi oficina'), h('span', 'Ponele nombre y elegí los departamentos.'))),
      h('button.opcion', { onclick: abrirExistente }, App.icono('carpeta'), h('div', h('b', 'Abrir una oficina existente'), h('span', 'Buscá la carpeta de una oficina que ya tengas.'))),
      recientes
    ))));
    api.get('/api/oficinas').then(function (r) {
      if (!r.oficinas || !r.oficinas.length) return;
      recientes.appendChild(h('div.etiqueta-campo', 'Recientes'));
      r.oficinas.forEach(function (o) {
        recientes.appendChild(h('div.reciente', { onclick: function () { abrirCarpeta(o.carpeta); } },
          App.icono('edificio'), h('div', { style: { minWidth: 0 } }, h('div', o.nombre), h('div.ruta', o.carpeta))));
      });
    }).catch(function () {});
  }

  var SUGERIDOS = [['Dirección', '#26262b'], ['Marketing', '#e6c22e'], ['Ventas', '#3c6fb4'], ['Operaciones', '#2a9d8f'], ['Finanzas', '#4b7f52'], ['Producto', '#8e78c4'], ['Diseño', '#e58aa6'], ['Atención al cliente', '#e0644f']];
  App.PALETA = ['#c4372f', '#e0644f', '#e6a23c', '#e6c22e', '#4b7f52', '#2a9d8f', '#5aa9d6', '#3c6fb4', '#8e78c4', '#e58aa6', '#8a6a4f', '#6b7078'];

  function crearOficina() {
    var hj = App.hoja({ titulo: 'Crear oficina', ancho: 560 });
    var deps = [['Marketing', '#e6c22e'], ['Ventas', '#3c6fb4'], ['Operaciones', '#2a9d8f']];
    var nombre = h('input.campo', { placeholder: 'Ej.: Estudio Cherry', maxlength: 80, autofocus: true });
    var duenio = h('input.campo', { placeholder: 'Cómo te llaman los agentes', maxlength: 80 });
    var lista = h('div.lista-ed'), sug = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } });
    var carpeta = null, dondeTxt = h('span', { style: { color: 'var(--suave)' } });
    var err = h('div.error-txt');
    function pintarDonde() { dondeTxt.textContent = carpeta || ('Oficinas / ' + (nombre.value.trim() || '…') + ' (en tu carpeta de usuario)'); }
    nombre.addEventListener('input', pintarDonde);
    function pintar() {
      App.vaciar(lista); App.vaciar(sug);
      deps.forEach(function (d, i) {
        var muestra = h('button.muestra', { style: { background: d[1] }, title: 'Color', onclick: function () { elegirColor(muestra, d[1], function (c) { d[1] = c; pintar(); }); } });
        var inp = h('input.campo', { value: d[0], maxlength: 60, oninput: function () { d[0] = inp.value; } });
        lista.appendChild(h('div.fila-ed', muestra, inp, h('button.btn.fantasma.icono', { title: 'Quitar', onclick: function () { deps.splice(i, 1); pintar(); } }, App.icono('cerrar'))));
      });
      SUGERIDOS.filter(function (s) { return !deps.some(function (d) { return d[0].toLowerCase() === s[0].toLowerCase(); }); }).forEach(function (s) {
        sug.appendChild(h('button.chip', { onclick: function () { if (deps.length < 12) { deps.push(s.slice()); pintar(); } } }, App.icono('mas'), s[0]));
      });
      sug.appendChild(h('button.chip', { onclick: function () { if (deps.length < 12) { deps.push(['Nuevo departamento', App.PALETA[deps.length % App.PALETA.length]]); pintar(); var u = lista.querySelectorAll('input'); u[u.length - 1].select(); } } }, App.icono('mas'), 'Otro'));
    }
    pintar(); pintarDonde();
    hj.cuerpo.appendChild(h('div',
      h('div.dos', h('div.fila-campo', h('label.etiqueta-campo', 'Nombre de la oficina'), nombre), h('div.fila-campo', h('label.etiqueta-campo', 'Tu nombre'), duenio)),
      h('div.fila-campo', h('label.etiqueta-campo', 'Departamentos'), lista, sug, h('div.ayuda', 'Cada departamento es una sala del edificio. Podés cambiarlos después.')),
      h('div.fila-campo', h('label.etiqueta-campo', 'Dónde se guarda'), h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, App.icono('carpeta'), dondeTxt,
        h('button.btn.chico', { style: { marginLeft: 'auto' }, onclick: function () { App.elegirCarpeta('Elegí dónde crear la oficina', { crear: true }).then(function (r) { if (r) { carpeta = r.replace(/\/$/, '') + '/' + (nombre.value.trim() || 'Oficina'); pintarDonde(); } }); } }, 'Cambiar…')),
        h('div.ayuda', 'Es una carpeta común: ahí quedan los agentes, su conocimiento, las actas y los archivos.')),
      err));
    var btn = h('button.btn.primario', { onclick: enviar }, 'Crear oficina');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);
    function enviar() {
      err.textContent = '';
      if (!nombre.value.trim()) { err.textContent = 'Ponele un nombre a la oficina.'; nombre.focus(); return; }
      var lis = deps.filter(function (d) { return d[0].trim(); }).map(function (d) { return { nombre: d[0].trim(), color: d[1] }; });
      if (!lis.length) { err.textContent = 'Agregá al menos un departamento.'; return; }
      btn.disabled = true; btn.textContent = 'Creando…';
      api.post('/api/oficinas', { nombre: nombre.value.trim(), duenio: duenio.value.trim(), departamentos: lis, carpeta: carpeta || undefined })
        .then(function (r) { hj.cerrar(); montar(r.carpeta, r.oficina); App.aviso('Oficina creada. Ya podés contratar a tu primer agente.'); })
        .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Crear oficina'; });
    }
  }

  function abrirExistente() {
    App.elegirCarpeta('Elegí la carpeta de la oficina', { oficinas: true }).then(function (r) { if (r) abrirCarpeta(r); });
  }
  function abrirCarpeta(c) {
    api.post('/api/oficinas/abrir', { carpeta: c }).then(function (r) { montar(r.carpeta, r.oficina); }).catch(App.fallo);
  }
  App.abrirCarpetaOficina = abrirCarpeta;
  App.crearOficina = crearOficina;
  App.abrirExistente = abrirExistente;

  /* ---------------- selector de color ---------------- */
  function elegirColor(ancla, actual, alElegir) {
    var e = App.emergente(ancla, h('div',
      h('div.paleta', App.PALETA.map(function (c) { return h('button', { class: c.toLowerCase() === (actual || '').toLowerCase() ? 'sel' : '', style: { background: c }, title: c, onclick: function () { e.cerrar(); alElegir(c); } }); })),
      h('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--suave)' } }, 'Otro:',
        h('input', { type: 'color', value: actual || '#888888', onchange: function (ev) { e.cerrar(); alElegir(ev.target.value); } }))));
  }
  App.elegirColor = elegirColor;

  /* ---------------- estructura principal ---------------- */
  function montar(carpeta, oficina) {
    E.carpeta = carpeta; E.oficina = oficina;
    document.title = oficina.nombre;
    if (!dom.app || !document.body.contains(dom.app)) {
      dom.equipo = h('div.equipo');
      dom.nombre = h('div.marca-nombre'); dom.sub = h('div.marca-sub');
      dom.marca = h('div.marca', { onclick: function () { menuOficina(dom.marca); }, title: 'Oficina' }, App.logo(), h('div.marca-txt', dom.nombre, dom.sub));
      dom.navReu = h('span.insignia.ok.oculto', 'En curso');
      dom.navBib = h('span.insignia.oculto');
      dom.lienzo = h('div.lienzo');
      dom.carga = h('div.carga3d', h('span.giro'), 'Armando la oficina…');
      dom.avisoReu = h('div.aviso-reunion.oculto');
      dom.derecho = h('aside.derecho');
      dom.app = h('div.app',
        h('aside.lateral', dom.marca, dom.equipo, h('nav.nav',
          h('button.nav-item', { onclick: function () { App.Reunion.abrir(); } }, App.icono('reunion'), 'Reuniones', dom.navReu),
          h('button.nav-item', { onclick: function () { App.Biblioteca.abrir(); } }, App.icono('libro'), 'Biblioteca', dom.navBib),
          h('button.nav-item', { onclick: function () { App.Deptos.abrir(); } }, App.icono('capas'), 'Departamentos'))),
        h('main.vista', dom.lienzo, dom.carga, dom.avisoReu,
          h('div.herramientas',
            h('button.btn', { onclick: function () { App.Reunion.nueva(); } }, App.icono('reunion'), 'Llamar a reunión'),
            h('button.btn.primario', { onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar')),
          h('div.pista', 'Arrastrá para girar · dos dedos para moverte · pellizcá para acercarte'),
          dom.derecho));
      App.vaciar(raiz).appendChild(dom.app);
      App.dom = dom;
      if (!App.Oficina3D.iniciar(dom.lienzo)) dom.carga.textContent = 'Esta compu no puede mostrar la oficina en 3D. El resto funciona igual.';
      App.Oficina3D.alElegirAgente(function (id) { App.Agente.abrir(id); });
      App.Oficina3D.alElegirLugar(function (t) { if (t === 'reunion') App.Reunion.abrir(); else if (t === 'biblioteca') App.Biblioteca.abrir(); });
    }
    pintarTodo();
    App.Reunion.retomar();
    App.Biblioteca.vigilarEstado();
  }
  App.montar = montar;

  /* se llama cada vez que cambia la oficina (contratar, editar, departamentos) */
  function actualizar(oficina) {
    if (oficina) E.oficina = oficina;
    pintarTodo();
  }
  App.actualizar = actualizar;
  App.recargarOficina = function () { return api.get('/api/oficina').then(function (r) { E.carpeta = r.carpeta; actualizar(r.oficina); return r.oficina; }); };

  function pintarTodo() {
    var o = E.oficina;
    dom.nombre.textContent = o.nombre;
    dom.sub.textContent = o.duenio ? 'de ' + o.duenio + ' · ' + o.agentes.length + ' ' + (o.agentes.length === 1 ? 'agente' : 'agentes') : o.agentes.length + ' agentes';
    pintarEquipo();
    var t0 = performance.now();
    dom.carga.classList.remove('oculto');
    App.Oficina3D.construir(o).then(function () { dom.carga.classList.add('oculto'); if (App.Agente.actual()) App.Oficina3D.elegir(App.Agente.actual()); })
      .catch(function (e) { dom.carga.textContent = 'No pude armar la oficina en 3D: ' + e.message; console.error(e); });
  }

  App.depto = function (id) { return (E.oficina.departamentos || []).filter(function (d) { return d.id === id; })[0] || null; };
  App.agente = function (id) { return (E.oficina.agentes || []).filter(function (a) { return a.id === id; })[0] || null; };

  function pintarEquipo() {
    var o = E.oficina, c = App.vaciar(dom.equipo);
    if (!o.agentes.length) {
      c.appendChild(h('div.vacio', h('p', 'Todavía no hay nadie en la oficina.'), h('button.btn.primario', { style: { marginTop: '12px' }, onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar al primero')));
    }
    var deps = o.departamentos.slice();
    var sueltos = o.agentes.filter(function (a) { return !App.depto(a.departamento); });
    if (sueltos.length) deps.push({ id: '__sin', nombre: 'Sin departamento', color: '#9a9a9a' });
    deps.forEach(function (d) {
      var ags = d.id === '__sin' ? sueltos : o.agentes.filter(function (a) { return a.departamento === d.id; });
      if (!ags.length && !o.agentes.length) return;
      c.appendChild(h('div.grupo-tit', h('span.punto', { style: { background: d.color } }), d.nombre, h('span.cuenta', ags.length || '')));
      if (!ags.length) c.appendChild(h('div.persona', { onclick: function () { App.Contratar.abrir({ departamento: d.id }); }, style: { color: 'var(--tenue)' } },
        h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, App.icono('mas')), h('div.persona-txt', 'Contratar')));
      ags.forEach(function (a) {
        var fila = h('div.persona', { 'data-id': a.id, onclick: function () { App.Agente.abrir(a.id); } },
          App.retratoImg(a, 'retrato', 96), h('div.persona-txt', h('div.persona-nombre', a.nombre), h('div.persona-rol', a.rol)), h('span.estado-dot'));
        c.appendChild(fila);
      });
    });
    marcarEstados();
  }
  function marcarEstados() {
    if (!dom.equipo) return;
    var enReu = E.reunion && E.reunion.estado !== 'cerrada' ? E.reunion.agentes || [] : [];
    dom.equipo.querySelectorAll('.persona[data-id]').forEach(function (el) {
      var id = el.getAttribute('data-id');
      el.classList.toggle('activa', App.Agente.actual() === id);
      el.classList.toggle('ocupada', !!E.ocupados[id]);
      el.classList.toggle('reunida', enReu.indexOf(id) >= 0);
    });
  }
  App.marcarEstados = marcarEstados;

  /* ---------------- menú de la oficina ---------------- */
  function menuOficina(ancla) {
    api.get('/api/oficinas').then(function (r) { return r.oficinas || []; }).catch(function () { return []; }).then(function (lista) {
      var items = [{ titulo: 'Oficinas' }];
      lista.forEach(function (o) {
        items.push({ texto: o.nombre, icono: 'edificio', nota: o.carpeta === E.carpeta ? 'actual' : '', accion: function () { if (o.carpeta !== E.carpeta) { App.Agente.cerrar(); abrirCarpeta(o.carpeta); } } });
      });
      items.push({ texto: 'Abrir otra oficina…', icono: 'carpeta', accion: abrirExistente });
      items.push({ texto: 'Crear oficina nueva…', icono: 'mas', accion: crearOficina });
      items.push('-');
      items.push({ texto: 'Nombre y dueño…', icono: 'edificio', accion: editarOficina });
      items.push({ texto: App.nativo.hay ? 'Mostrar carpeta en Finder' : 'Ver archivos de la oficina', icono: 'carpeta', accion: function () { if (App.nativo.hay) App.nativo.revelar(E.carpeta); else App.verArchivosOficina(); } });
      if (App.nativo.hay) items.push({ texto: 'Acerca de', icono: 'chispa', accion: App.nativo.acerca });
      App.menu(ancla, items);
    });
  }

  function editarOficina() {
    var hj = App.hoja({ titulo: 'Oficina', ancho: 440 });
    var n = h('input.campo', { value: E.oficina.nombre, maxlength: 80, autofocus: true }), d = h('input.campo', { value: E.oficina.duenio || '', maxlength: 80 });
    var err = h('div.error-txt');
    App.add(hj.cuerpo, h('div.fila-campo', h('label.etiqueta-campo', 'Nombre'), n), h('div.fila-campo', h('label.etiqueta-campo', 'Tu nombre'), d), h('div.ayuda', E.carpeta), err);
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), h('button.btn.primario', {
      onclick: function () {
        api.patch('/api/oficina', { nombre: n.value.trim(), duenio: d.value.trim() }).then(function (r) { hj.cerrar(); actualizar(r.oficina); }).catch(function (e) { err.textContent = e.message; });
      }
    }, 'Guardar'));
  }

  App.alEscape = function () { if (dom.derecho && dom.derecho.classList.contains('abierto')) App.cerrarDerecho(); };
  App.abrirDerecho = function (modo) { dom.derecho.classList.add('abierto'); dom.derecho.setAttribute('data-modo', modo); };
  App.cerrarDerecho = function () {
    dom.derecho.classList.remove('abierto');
    var m = dom.derecho.getAttribute('data-modo');
    dom.derecho.removeAttribute('data-modo');
    if (m === 'agente') App.Agente.alCerrar(); else if (m === 'reunion') App.Reunion.alCerrarPanel();
  };
  App.modoDerecho = function () { return dom.derecho && dom.derecho.classList.contains('abierto') ? dom.derecho.getAttribute('data-modo') : null; };
  App.volverAlInicio = inicio;

  window.addEventListener('DOMContentLoaded', arrancar);
})();
