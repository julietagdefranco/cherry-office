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
      // primera vez que se abre la app: elegir cómo piden permiso los agentes (se ve encima de lo que se monte)
      if (st.modo_permisos === null && !arrancar.modoPreguntado) { arrancar.modoPreguntado = true; App.Permisos.elegirModo(null, true); }
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
    var duenio = h('input.campo', { placeholder: 'Cómo te llaman los agentes', maxlength: 80, value: App.Yo.nombre() });
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
  /* Borra la oficina abierta: sus chats, reuniones, tareas y el historial del Creador. En la app la carpeta va a la
     papelera (se puede recuperar); en el navegador queda donde está. Después vuelve a la pantalla de inicio. */
  function borrarOficina() {
    var carpeta = E.carpeta, nombre = E.oficina.nombre;
    var archivos = App.nativo.hay ? 'Su carpeta va a la papelera, por si te arrepentís.' : 'Su carpeta queda en ' + carpeta + ': borrala a mano si no la querés.';
    App.confirmar('¿Borrar «' + nombre + '»?', 'Se borran sus conversaciones, reuniones, tareas y lo que charlaste con el Creador. ' + archivos, 'Borrar oficina', true).then(function (si) {
      if (!si) return;
      var p = App.nativo.hay ? App.nativo.borrarOficina(carpeta) : api.del('/api/oficina');
      p.then(function (r) {
        if (r && r.error) throw new Error(r.error);
        if (r && r.papelera === false) App.aviso('Borré la oficina, pero no pude mandar su carpeta a la papelera: quedó en ' + carpeta + '.', true);
        App.Agente.cerrar();
        setTimeout(function () { location.reload(); }, r && r.papelera === false ? 2500 : 0);
      }).catch(App.fallo);
    });
  }

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
    if (App.nativo.hay) App.add(hj.pie, h('button.btn', { onclick: function () { App.nativo.revelar(r.archivo); } }, 'Mostrar ' + App.nativo.enExplorador));
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
  App.editarOficina = editarOficina;
  App.borrarOficina = function () { borrarOficina(); };
  App.otraOficina = function () { otraOficina(); };

  /* ---------------- selector de color ---------------- */
  function elegirColor(ancla, actual, alElegir) {
    var e = App.emergente(ancla, h('div',
      h('div.paleta', App.PALETA.map(function (c) { return h('button', { class: c.toLowerCase() === (actual || '').toLowerCase() ? 'sel' : '', style: { background: c }, title: c, onclick: function () { e.cerrar(); alElegir(c); } }); })),
      h('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--suave)' } }, 'Otro:',
        h('input', { type: 'color', value: actual || '#888888', onchange: function (ev) { e.cerrar(); alElegir(ev.target.value); } }))));
  }
  App.elegirColor = elegirColor;

  /* ---------------- estructura principal ---------------- */
  var atajoBuscar = /Mac/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl+K';

  /* «+ Nuevo»: todo lo que agrega algo a la oficina, en un solo botón */
  function menuNuevo(ancla) {
    App.menu(ancla, [
      { texto: 'Contratar un agente…', icono: 'personas', accion: function () { App.Contratar.abrir(); } },
      { texto: 'Armar con el Creador…', icono: 'chispa', accion: function () { App.Creador.abrir(); } },
      { texto: 'Nueva corrida de flujo…', icono: 'flujo', accion: function () { App.Flujos.abrir(); App.Flujos.nueva(); } },
      { texto: 'Nuevo departamento…', icono: 'capas', accion: function () { App.Deptos.agregar(); } },
    ]);
  }

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
      dom.navCon = h('span.insignia.oculto');
      dom.lienzo = h('div.lienzo');
      dom.carga = h('div.carga3d', h('span.giro'), 'Armando la oficina…');
      dom.avisoReu = h('div.aviso-reunion.oculto');
      dom.derecho = h('aside.derecho');
      /* en el celular la barra lateral es un cajón: se abre con el botón de menú y se cierra al elegir algo */
      function cajon(abrir) { dom.app.classList.toggle('lateral-abierta', abrir); }
      dom.lateral = h('aside.lateral', { onclick: function (ev) { if (ev.target.closest('.persona, .nav-item')) cajon(false); } }, dom.marca, dom.equipo, h('nav.nav',
          /* solo lo del día a día, ordenado por uso; la configuración vive en el menú de la oficina */
          h('button.nav-item', { onclick: function () { App.Yo.irAlDespacho(); App.Entregables.abrir(); } }, App.icono('bandeja'), 'Tu bandeja', dom.navEnt),
          h('button.nav-item', { onclick: function () { App.Parte.abrir(); } }, App.icono('parte'), 'Parte del día', dom.navParte),
          h('button.nav-item', { onclick: function () { App.Reunion.abrir(); } }, App.icono('reunion'), 'Reuniones', dom.navReu),
          h('button.nav-item', { onclick: function () { App.Flujos.abrir(); } }, App.icono('flujo'), 'Flujos', dom.navFlu),
          h('button.nav-item', { onclick: function () { App.Biblioteca.abrir(); } }, App.icono('libro'), 'Biblioteca', dom.navBib),
          h('button.nav-item', { onclick: function () { App.Conocimiento.abrir(); } }, App.icono('bombilla'), 'Conocimiento', dom.navCon)));
      dom.app = h('div.app', dom.lateral,
        h('div.velo-lateral', { onclick: function () { cajon(false); } }),
        h('main.vista', dom.lienzo, dom.carga, dom.avisoReu,
          h('button.btn.icono.boton-menu', { title: 'Equipo y secciones', onclick: function () { cajon(true); } }, App.icono('menu')),
          h('div.herramientas',
            h('button.btn', { title: 'Buscar agentes, salas y acciones (' + atajoBuscar + ')', onclick: function () { App.Paleta.abrir(); } }, App.icono('buscar'), h('span.btn-txt', 'Buscar'), h('kbd.btn-txt', atajoBuscar)),
            h('button.btn', { title: 'Llamar a reunión', onclick: function () { App.Reunion.nueva(); } }, App.icono('reunion'), h('span.btn-txt', 'Llamar a reunión')),
            h('button.btn.primario', { title: 'Nuevo', onclick: function (ev) { menuNuevo(ev.currentTarget); } }, App.icono('mas'), h('span.btn-txt', 'Nuevo'), App.icono('abajo'))),
          h('div.pista', App.Paleta ? App.Paleta.BASE : 'Arrastrá para girar · dos dedos para moverte · pellizcá para acercarte'),
          dom.derecho));
      App.vaciar(raiz).appendChild(dom.app);
      App.dom = dom;
      if (!App.Oficina3D.iniciar(dom.lienzo)) dom.carga.textContent = App.Oficina3D.sinMotor
        ? 'No llegó el motor 3D (vendor/three.min.js): revisá que esté en la carpeta oficina/vendor del servidor. El resto funciona igual.'
        : 'Esta compu no puede mostrar la oficina en 3D. El resto funciona igual.';
      App.Oficina3D.alElegirAgente(function (id) { App.Agente.abrir(id); });
      App.Oficina3D.alElegirLugar(function (t, id) {
        if (t === 'reunion') App.Reunion.abrir();
        else if (t === 'biblioteca') App.Biblioteca.abrir();
        else if (t === 'entregables' || t === 'direccion') App.Entregables.abrir();
        else if (t === 'yo') App.Yo.abrir();
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
    if (App.Conocimiento) App.Conocimiento.vigilarEstado();
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
    if (App.Oficina3D.sinMotor) return;           // sin three.js queda a la vista el aviso de montar()
    var t0 = performance.now();
    dom.carga.classList.remove('oculto');
    App.Oficina3D.construir(o, App.Yo.perfil()).then(function () { dom.carga.classList.add('oculto'); if (App.Agente.actual()) App.Oficina3D.elegir(App.Agente.actual()); })
      .catch(function (e) { dom.carga.textContent = 'No pude armar la oficina en 3D: ' + e.message; console.error(e); });
  }

  App.depto = function (id) { return (E.oficina.departamentos || []).filter(function (d) { return d.id === id; })[0] || null; };
  App.agente = function (id) { return (E.oficina.agentes || []).filter(function (a) { return a.id === id; })[0] || null; };

  function pintarEquipo() {
    var o = E.oficina, c = App.vaciar(dom.equipo);
    c.appendChild(App.Yo.fila());
    if (!o.agentes.length) {
      c.appendChild(h('div.vacio', h('p', 'Todavía no hay nadie en la oficina.'), h('button.btn.primario', { style: { marginTop: '12px' }, onclick: function () { App.Contratar.abrir(); } }, App.icono('mas'), 'Contratar al primero')));
    }
    var deps = o.departamentos.slice();
    var sueltos = o.agentes.filter(function (a) { return !App.depto(a.departamento); });
    if (sueltos.length) deps.push({ id: '__sin', nombre: 'Sin departamento', color: '#9a9a9a' });
    deps.forEach(function (d) {
      var ags = d.id === '__sin' ? sueltos : o.agentes.filter(function (a) { return a.departamento === d.id; });
      if (!ags.length && !o.agentes.length) return;
      var tit = h('div.grupo-tit', h('span.punto', { style: { background: d.color } }), d.nombre, h('span.cuenta', ags.length || ''));
      if (d.id !== '__sin') tit.appendChild(h('button.grupo-mas', { title: 'Opciones de ' + d.nombre, 'aria-label': 'Opciones de ' + d.nombre,
        onclick: function (ev) { ev.stopPropagation(); App.Deptos.menu(ev.currentTarget, d); } }, App.icono('puntos')));
      c.appendChild(tit);
      if (!ags.length) c.appendChild(h('div.persona', { onclick: function () { App.Contratar.abrir({ departamento: d.id }); }, style: { color: 'var(--tenue)' } },
        h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, App.icono('mas')), h('div.persona-txt', 'Contratar')));
      ags.forEach(function (a) {
        var fila = h('div.persona', { 'data-id': a.id, onclick: function () { App.Agente.abrir(a.id); } },
          App.retratoImg(a, 'retrato', 96), h('div.persona-txt', h('div.persona-nombre', a.nombre), h('div.persona-rol', a.rol)), h('span.estado-dot'));
        c.appendChild(fila);
      });
    });
    c.appendChild(h('button.persona.agregar-depto', { onclick: function () { App.Deptos.agregar(); } },
      h('div.retrato', App.icono('mas')), h('div.persona-txt', 'Departamento')));
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
      items.push({ texto: 'Otra oficina…', icono: 'mas', accion: otraOficina });
      items.push('-');
      /* toda la configuración (de esta oficina y de la app) vive en la ventana de Ajustes */
      items.push({ texto: 'Ajustes…', icono: 'ajustes', nota: App.Ajustes.atajo, accion: function () { App.Ajustes.abrir(); } });
      App.menu(ancla, items);
    });
  }

  /* crear, armar charlando, abrir o importar: las mismas opciones que la pantalla de inicio, en una hoja */
  function otraOficina() {
    var hj = App.hoja({ titulo: 'Otra oficina', ancho: 480, sinPie: true });
    App.add(hj.cuerpo, opcionesOficina().map(function (o) {
      return h('button.opcion', { onclick: function () { hj.cerrar(); o.accion(); } }, App.icono(o.icono), h('div', h('b', o.texto), h('span', o.bajada)));
    }));
  }

  /* sección «General» de Ajustes: nombre, quién dirige y carpeta. `crear` (opcional) reemplaza a App.hoja. */
  function editarOficina(crear) {
    var hj = (crear || App.hoja)({ titulo: 'General', ancho: 440 });
    var n = h('input.campo', { value: E.oficina.nombre, maxlength: 80, autofocus: !hj.enVentana });
    var err = h('div.error-txt');
    var quien = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, App.Yo.retrato('retrato', 96), h('b', App.Yo.nombre() || 'Sin nombre todavía'),
      h('button.btn.chico', { style: { marginLeft: 'auto' }, onclick: function () { if (!hj.enVentana) hj.cerrar(); App.Yo.abrir(); } }, 'Cambiar…'));
    var carpeta = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } }, App.icono('carpeta'),
      h('span', { style: { color: 'var(--suave)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }, title: E.carpeta }, E.carpeta),
      h('button.btn.chico', { style: { marginLeft: 'auto', flex: 'none' }, onclick: function () { if (App.nativo.hay) App.nativo.revelar(E.carpeta); else App.verArchivosOficina(); } },
        App.nativo.hay ? 'Mostrar' : 'Ver archivos'));
    App.add(hj.cuerpo, h('div.fila-campo', h('label.etiqueta-campo', 'Nombre'), n),
      h('div.fila-campo', h('label.etiqueta-campo', 'Quién la dirige'), quien, h('div.ayuda', 'Cada oficina tiene su propio director.')),
      h('div.fila-campo', h('label.etiqueta-campo', 'Carpeta'), carpeta, h('div.ayuda', 'Ahí quedan los agentes, su conocimiento, las actas y los archivos.')), err);
    App.add(hj.pie, hj.enVentana ? null : h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), h('button.btn.primario', {
      onclick: function () {
        err.textContent = '';
        api.patch('/api/oficina', { nombre: n.value.trim() }).then(function (r) { actualizar(r.oficina); hj.cerrar(); if (hj.enVentana) App.aviso('Guardado.'); }).catch(function (e) { err.textContent = e.message; });
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
