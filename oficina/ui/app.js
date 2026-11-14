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
  /* Las mismas cuatro opciones, con los mismos textos e íconos, en la pantalla de inicio, en el menú de la oficina y en ⌘K. */
  function opcionesOficina() {
    return [
      { icono: 'edificio', texto: 'Crear una oficina', bajada: 'Ponele nombre y elegí los departamentos.', accion: crearOficina },
      { icono: 'chispa', texto: 'Armar una oficina charlando', bajada: 'Contale al Creador cómo trabajás y te propone departamentos, agentes y flujos.', accion: armarCharlando },
      { icono: 'carpeta', texto: 'Abrir una oficina existente', bajada: 'Buscá la carpeta de una oficina que ya tengas.', accion: abrirExistente },
      { icono: 'importar', texto: 'Importar una oficina', bajada: 'Abrí un archivo .zip que alguien exportó desde Oficina.', accion: importarOficina },
    ];
  }

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
      opcionesOficina().map(function (o) {
        return h('button.opcion', { onclick: o.accion }, App.icono(o.icono), h('div', h('b', o.texto), h('span', o.bajada)));
      }),
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

  /* Campos comunes a «Crear una oficina» y «Armar una oficina charlando»: nombre, tu nombre y dónde se guarda. */
  function camposOficina() {
    var nombre = h('input.campo', { placeholder: 'Ej.: Estudio Cherry', maxlength: 80, autofocus: true });
    var duenio = h('input.campo', { placeholder: 'Cómo te llaman los agentes', maxlength: 80 });
    var carpeta = null, dondeTxt = h('span', { style: { color: 'var(--suave)' } });
    function pintarDonde() { dondeTxt.textContent = carpeta || ('Oficinas / ' + (nombre.value.trim() || '…') + ' (en tu carpeta de usuario)'); }
    nombre.addEventListener('input', pintarDonde);
    pintarDonde();
    return {
      nombre: nombre, duenio: duenio,
      carpeta: function () { return carpeta || undefined; },
      cabecera: h('div.dos', h('div.fila-campo', h('label.etiqueta-campo', 'Nombre de la oficina'), nombre), h('div.fila-campo', h('label.etiqueta-campo', 'Tu nombre'), duenio)),
      donde: h('div.fila-campo', h('label.etiqueta-campo', 'Dónde se guarda'), h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, App.icono('carpeta'), dondeTxt,
        h('button.btn.chico', { style: { marginLeft: 'auto' }, onclick: function () { App.elegirCarpeta('Elegí dónde crear la oficina', { crear: true }).then(function (r) { if (r) { carpeta = r.replace(/\/$/, '') + '/' + (nombre.value.trim() || 'Oficina'); pintarDonde(); } }); } }, 'Cambiar…')),
        h('div.ayuda', 'Es una carpeta común: ahí quedan los agentes, su conocimiento, las actas y los archivos.')),
    };
  }

  /* Monta la oficina recién creada (o abierta), cerrando lo que hubiera abierto de la anterior. */
  function montarNueva(r) {
    if (E.oficina && App.Agente) App.Agente.cerrar();
    montar(r.carpeta, r.oficina);
  }

  /* La oficina arranca sin departamentos y se abre el Creador para armarla. */
  function armarCharlando() {
    var hj = App.hoja({ titulo: 'Armar una oficina charlando', ancho: 560 });
    var c = camposOficina(), err = h('div.error-txt');
    hj.cuerpo.appendChild(h('div', c.cabecera,
      h('div.fila-campo', h('label.etiqueta-campo', 'Cómo sigue'), h('div.ayuda', 'Se abre el Creador: le contás cómo trabajás, de a poco o pegando un texto, y te propone departamentos, agentes y flujos. No se crea nada hasta que lo apruebes.')),
      c.donde, err));
    var btn = h('button.btn.primario', { onclick: enviar }, 'Empezar a charlar');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);
    function enviar() {
      err.textContent = '';
      if (!c.nombre.value.trim()) { err.textContent = 'Ponele un nombre a la oficina.'; c.nombre.focus(); return; }
      btn.disabled = true; btn.textContent = 'Creando…';
      api.post('/api/oficinas', { nombre: c.nombre.value.trim(), duenio: c.duenio.value.trim(), vacia: true, carpeta: c.carpeta() })
        .then(function (r) { hj.cerrar(); montarNueva(r); App.Creador.abrir(); })
        .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Empezar a charlar'; });
    }
  }

  var SUGERIDOS = [['Dirección', '#26262b'], ['Marketing', '#e6c22e'], ['Ventas', '#3c6fb4'], ['Operaciones', '#2a9d8f'], ['Finanzas', '#4b7f52'], ['Producto', '#8e78c4'], ['Diseño', '#e58aa6'], ['Atención al cliente', '#e0644f']];
  App.PALETA = ['#c4372f', '#e0644f', '#e6a23c', '#e6c22e', '#4b7f52', '#2a9d8f', '#5aa9d6', '#3c6fb4', '#8e78c4', '#e58aa6', '#8a6a4f', '#6b7078'];

  function crearOficina() {
    var hj = App.hoja({ titulo: 'Crear una oficina', ancho: 560 });
    var deps = [['Marketing', '#e6c22e'], ['Ventas', '#3c6fb4'], ['Operaciones', '#2a9d8f']];
    var c = camposOficina();
    var lista = h('div.lista-ed'), sug = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } });
    var err = h('div.error-txt');
    function pintar() {
      App.vaciar(lista); App.vaciar(sug);
      deps.forEach(function (d, i) {
        var muestra = h('button.muestra', { style: { background: d[1] }, title: 'Color', onclick: function () { elegirColor(muestra, d[1], function (col) { d[1] = col; pintar(); }); } });
        var inp = h('input.campo', { value: d[0], maxlength: 60, oninput: function () { d[0] = inp.value; } });
        lista.appendChild(h('div.fila-ed', muestra, inp, h('button.btn.fantasma.icono', { title: 'Quitar', onclick: function () { deps.splice(i, 1); pintar(); } }, App.icono('cerrar'))));
      });
      SUGERIDOS.filter(function (s) { return !deps.some(function (d) { return d[0].toLowerCase() === s[0].toLowerCase(); }); }).forEach(function (s) {
        sug.appendChild(h('button.chip', { onclick: function () { if (deps.length < 12) { deps.push(s.slice()); pintar(); } } }, App.icono('mas'), s[0]));
      });
      sug.appendChild(h('button.chip', { onclick: function () { if (deps.length < 12) { deps.push(['Nuevo departamento', App.PALETA[deps.length % App.PALETA.length]]); pintar(); var u = lista.querySelectorAll('input'); u[u.length - 1].select(); } } }, App.icono('mas'), 'Otro'));
    }
    pintar();
    hj.cuerpo.appendChild(h('div', c.cabecera,
      h('div.fila-campo', h('label.etiqueta-campo', 'Departamentos'), lista, sug, h('div.ayuda', 'Cada departamento es una sala del edificio. Podés cambiarlos después.')),
      c.donde, err));
    var btn = h('button.btn.primario', { onclick: enviar }, 'Crear oficina');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);
    function enviar() {
      err.textContent = '';
      if (!c.nombre.value.trim()) { err.textContent = 'Ponele un nombre a la oficina.'; c.nombre.focus(); return; }
      var lis = deps.filter(function (d) { return d[0].trim(); }).map(function (d) { return { nombre: d[0].trim(), color: d[1] }; });
      if (!lis.length) { err.textContent = 'Agregá al menos un departamento.'; return; }
      btn.disabled = true; btn.textContent = 'Creando…';
      api.post('/api/oficinas', { nombre: c.nombre.value.trim(), duenio: c.duenio.value.trim(), departamentos: lis, carpeta: c.carpeta() })
        .then(function (r) { hj.cerrar(); montarNueva(r); App.aviso('Oficina creada. Ya podés contratar a tu primer agente.'); })
        .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Crear oficina'; });
    }
  }

  function abrirExistente() {
    App.elegirCarpeta('Elegí la carpeta de la oficina', { oficinas: true }).then(function (r) { if (r) abrirCarpeta(r); });
  }
  function abrirCarpeta(c) {
    api.post('/api/oficinas/abrir', { carpeta: c }).then(function (r) { montar(r.carpeta, r.oficina); }).catch(App.fallo);
  }
  /* ---------------- exportar e importar ---------------- */
  function exportarOficina() {
    var hj = App.hoja({ titulo: 'Exportar oficina', ancho: 520 });
    var destino = null, dondeTxt = h('span', { style: { color: 'var(--suave)', overflow: 'hidden', textOverflow: 'ellipsis' } }, 'Descargas');
    var err = h('div.error-txt');
    function item(si, texto) { return h('li', { style: { color: si ? 'var(--texto)' : 'var(--suave)' } }, (si ? '✓ ' : '✕ ') + texto); }
    App.add(hj.cuerpo,
      h('p', { style: { marginTop: 0 } }, 'Arma un archivo .zip con «' + E.oficina.nombre + '» para compartirla o pasarla a otra compu. Quien lo reciba la abre con «Importar una oficina».'),
      h('ul', { style: { listStyle: 'none', padding: 0, margin: '0 0 14px', display: 'grid', gap: '4px', fontSize: '13px' } },
        item(true, 'Departamentos, agentes y tareas programadas'),
        item(true, 'Memoria de la oficina, decisiones y notas de cada agente'),
        item(true, 'Actas de reunión, documentos de la biblioteca (con sus fichas) y entregables'),
        item(false, 'Conversaciones, entregas por revisar y costos (quedan en esta compu)'),
        item(false, 'Carpetas vinculadas y la papelera')),
      h('div.fila-campo', h('label.etiqueta-campo', 'Dónde guardarlo'), h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, App.icono('carpeta'), dondeTxt,
        h('button.btn.chico', { style: { marginLeft: 'auto' }, onclick: function () { App.elegirCarpeta('Elegí dónde guardar el .zip', { crear: true }).then(function (r) { if (r) { destino = r; dondeTxt.textContent = r; } }); } }, 'Cambiar…'))),
      h('div.ayuda', 'Lleva todo lo que sabe la oficina: revisá que quieras compartirlo.'),
      err);
    var btn = h('button.btn.primario', { onclick: enviar }, 'Exportar');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);
    function enviar() {
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Exportando…';
      api.post('/api/oficina/exportar', { destino: destino || undefined }).then(function (r) {
        hj.cerrar(); listoExportar(r);
      }).catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Exportar'; });
    }
  }

  function listoExportar(r) {
    var hj = App.hoja({ titulo: 'Oficina exportada', ancho: 520 });
    var detalle = App.tam(r.tam || 0) + ' · ' + (r.documentos === 1 ? '1 documento' : (r.documentos || 0) + ' documentos');
    var omitidos = [];
    if (r.omitidos && r.omitidos.vinculos) omitidos.push(r.omitidos.vinculos === 1 ? 'No incluye la carpeta vinculada.' : 'No incluye las ' + r.omitidos.vinculos + ' carpetas vinculadas.');
    if (r.omitidos && r.omitidos.papelera) omitidos.push('No incluye la papelera de la biblioteca.');
    App.add(hj.cuerpo,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, App.icono('importar'), h('div', { style: { minWidth: 0 } }, h('b', r.nombre), h('div', { style: { color: 'var(--tenue)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.archivo }, r.archivo), h('div.ayuda', detalle))),
      omitidos.length ? h('div.ayuda', { style: { marginTop: '10px' } }, omitidos.join(' ')) : null,
      avisosLista(r.avisos));
    if (App.nativo.hay) App.add(hj.pie, h('button.btn', { onclick: function () { App.nativo.revelar(r.archivo); } }, 'Mostrar en Finder'));
    App.add(hj.pie, h('button.btn.primario', { onclick: hj.cerrar }, 'Listo'));
  }

  function avisosLista(avisos) {
    if (!avisos || !avisos.length) return null;
    return h('div', { style: { marginTop: '12px' } }, h('div.etiqueta-campo', 'Para revisar'),
      h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '4px', fontSize: '13px' } }, avisos.map(function (a) { return h('li', a); })));
  }

  function importarOficina() {
    App.elegirZip('Elegí el .zip de la oficina').then(function (archivo) {
      if (!archivo) return;
      App.aviso('Importando la oficina…');
      api.post('/api/oficinas/importar', { archivo: archivo }).then(function (r) {
        App.Agente && App.Agente.cerrar && E.oficina && App.Agente.cerrar();
        montar(r.carpeta, r.oficina);
        if (r.avisos && r.avisos.length) {
          var hj = App.hoja({ titulo: 'Oficina importada', ancho: 520 });
          App.add(hj.cuerpo, h('p', { style: { marginTop: 0 } }, '«' + r.oficina.nombre + '» quedó en ' + r.carpeta + '.'), avisosLista(r.avisos));
          App.add(hj.pie, h('button.btn.primario', { onclick: hj.cerrar }, 'Listo'));
        } else {
          App.aviso('Oficina importada: «' + r.oficina.nombre + '».');
        }
      }).catch(App.fallo);
    });
  }
  App.exportarOficina = exportarOficina;
  App.importarOficina = importarOficina;

  App.abrirCarpetaOficina = abrirCarpeta;
  App.crearOficina = crearOficina;
  App.armarCharlando = armarCharlando;
  App.opcionesOficina = opcionesOficina;
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
      dom.navEnt = h('span.insignia.aviso.oculto');
      dom.navParte = h('span.insignia.oculto');
      dom.navFlu = h('span.insignia.info.oculto');
      dom.lienzo = h('div.lienzo');
      dom.carga = h('div.carga3d', h('span.giro'), 'Armando la oficina…');
      dom.avisoReu = h('div.aviso-reunion.oculto');
      dom.derecho = h('aside.derecho');
      dom.app = h('div.app',
        h('aside.lateral', dom.marca, dom.equipo, h('nav.nav',
          h('button.nav-item', { onclick: function () { App.Parte.abrir(); } }, App.icono('parte'), 'Parte del día', dom.navParte),
          h('button.nav-item', { onclick: function () { App.Flujos.abrir(); } }, App.icono('flujo'), 'Flujos', dom.navFlu),
          h('button.nav-item', { onclick: function () { App.Reunion.abrir(); } }, App.icono('reunion'), 'Reuniones', dom.navReu),
          h('button.nav-item', { onclick: function () { App.Biblioteca.abrir(); } }, App.icono('libro'), 'Biblioteca', dom.navBib),
          h('button.nav-item', { onclick: function () { App.Entregables.abrir(); } }, App.icono('chispa'), 'Entregables', dom.navEnt),
          h('button.nav-item', { onclick: function () { App.Deptos.abrir(); } }, App.icono('capas'), 'Departamentos'))),
        h('main.vista', dom.lienzo, dom.carga, dom.avisoReu,
          h('div.herramientas',
            h('button.btn', { onclick: function () { App.Reunion.nueva(); } }, App.icono('reunion'), 'Llamar a reunión'),
            h('button.btn', { onclick: function () { App.Creador.abrir(); } }, App.icono('chispa'), 'Armar con el Creador'),
            h('button.btn.primario', { onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar')),
          h('div.pista', App.Paleta ? App.Paleta.BASE : 'Arrastrá para girar · dos dedos para moverte · pellizcá para acercarte'),
          dom.derecho));
      App.vaciar(raiz).appendChild(dom.app);
      App.dom = dom;
      if (!App.Oficina3D.iniciar(dom.lienzo)) dom.carga.textContent = 'Esta compu no puede mostrar la oficina en 3D. El resto funciona igual.';
      App.Oficina3D.alElegirAgente(function (id) { App.Agente.abrir(id); });
      App.Oficina3D.alElegirLugar(function (t, id) {
        if (t === 'reunion') App.Reunion.abrir();
        else if (t === 'biblioteca') App.Biblioteca.abrir();
        else if (t === 'entregables') App.Entregables.abrir();
        else if (t === 'entrega') App.Entregables.abrir(id);
        else if (t === 'creador') App.Creador.abrir();
        else if (t === 'flujos') App.Flujos.abrir();
      });
      if (App.Oficina3D.alPasar && App.Paleta) App.Oficina3D.alPasar(App.Paleta.pista);
    }
    pintarTodo();
    if (App.Entregables) App.Entregables.refrescar();
    App.Reunion.retomar();
    App.Biblioteca.vigilarEstado();
    /* el parte del día se abre solo la primera vez de la sesión */
    var yaAbierto = false;
    try { yaAbierto = !!sessionStorage.getItem('oficina.parte'); sessionStorage.setItem('oficina.parte', '1'); } catch (e) {}
    if (!yaAbierto && App.Parte) App.Parte.abrir();
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
    if (App.Actividad) { App.Actividad.repintar(); App.Actividad.iniciar(); }
  }
  function marcarEstados() {
    if (!dom.equipo) return;
    var enReu = E.reunion && E.reunion.estado !== 'cerrada' ? E.reunion.agentes || [] : [];
    dom.equipo.querySelectorAll('.persona[data-id]').forEach(function (el) {
      var id = el.getAttribute('data-id');
      el.classList.toggle('activa', App.Agente.actual() === id);
      el.classList.toggle('ocupada', !!E.ocupados[id] || !!(E.actividad || {})[id]);
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
      items.push('-');
      opcionesOficina().forEach(function (o) { items.push({ texto: o.texto + '…', icono: o.icono, accion: o.accion }); });
      items.push('-');
      items.push({ texto: 'Reglas de la oficina…', icono: 'regla', accion: function () { App.Ajustes.reglas(); } });
      items.push({ texto: 'Conectores…', icono: 'enchufe', accion: function () { App.Ajustes.conectores(); } });
      items.push('-');
      items.push({ texto: 'Nombre y dueño…', icono: 'edificio', accion: editarOficina });
      items.push({ texto: 'Exportar oficina…', icono: 'subir', accion: exportarOficina });
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
    else if (m === 'entregables' && App.Entregables) App.Entregables.alCerrarPanel();
    else if (m === 'parte' && App.Parte && App.Parte.alCerrarPanel) App.Parte.alCerrarPanel();
    else if (m === 'flujos' && App.Flujos && App.Flujos.alCerrarPanel) App.Flujos.alCerrarPanel();
  };
  App.modoDerecho = function () { return dom.derecho && dom.derecho.classList.contains('abierto') ? dom.derecho.getAttribute('data-modo') : null; };
  App.volverAlInicio = inicio;

  window.addEventListener('DOMContentLoaded', arrancar);
})();
