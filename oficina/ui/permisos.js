/* Pedidos de permiso en vivo: cuando un agente quiere hacer algo que no tiene permitido (correr un comando,
   escribir un archivo fuera de sus notas) en un chat o en una reunión, Claude Code le pregunta a la oficina y el pedido llega con /api/actividad
   (`permisos`). Cada uno es una tarjeta arriba a la derecha de la maqueta: «Una vez», «Siempre» (guarda el permiso en el
   agente; se puede quitar en su pestaña Permisos) o «No». Si nadie responde a tiempo, el pedido vence y se rechaza.
   Los de las tareas (traen `tarea`) no vencen: la tarea queda esperando y retoma cuando se responden todos. */
window.App = window.App || {};
App.Permisos = (function () {
  'use strict';
  var h = App.h;
  var pila = null, lista = [], enviando = {}, firma = '';
  var QUE = { Bash: 'Quiere correr un comando', Edit: 'Quiere editar un archivo', Write: 'Quiere escribir un archivo',
    MultiEdit: 'Quiere editar un archivo', NotebookEdit: 'Quiere editar un notebook' };

  function aplicar(ps) {
    lista = ps || [];
    var f = lista.map(function (p) { return p.id; }).join(',') + '|' + Object.keys(enviando).join(',');
    if (f === firma && pila && pila.isConnected) return;
    firma = f;
    pintar();
  }

  function pintar(soloPila) {
    var vista = App.dom && App.dom.lienzo && App.dom.lienzo.parentNode; if (!vista) return;
    if (!pila || !vista.contains(pila)) { pila = h('div.permisos-pila'); vista.appendChild(pila); }
    App.vaciar(pila);
    /* con la lista abierta en la Bandeja, las tarjetas van ahí y no flotando */
    var modo = App.modoDerecho && App.modoDerecho();
    if (modo === 'permisos') pintarPanel();
    else if (modo === 'parte') { if (!soloPila && App.Parte && App.Parte.recargar) App.Parte.recargar(); }
    else lista.forEach(function (p) { pila.appendChild(tarjeta(p)); });
    if (App.Nav && App.Nav.seccion && App.Nav.seccion() === 'bandeja') App.Nav.pintarLista();
  }

  /* ---------------- Bandeja › Te piden permiso ---------------- */
  function panelAbierto() { return App.modoDerecho && App.modoDerecho() === 'permisos'; }
  function abrirPanel() {
    App.abrirDerecho('permisos');
    pintar();
  }
  function pintarPanel() {
    var cuerpo = h('div.der-cuerpo');
    App.add(App.vaciar(App.dom.derecho),
      App.cabPanel({ icono: 'escudo', titulo: 'Te piden permiso', sub: lista.length ? (lista.length === 1 ? '1 pedido' : lista.length + ' pedidos') : 'Nada pendiente' }),
      cuerpo);
    if (!lista.length) {
      cuerpo.appendChild(App.vacio('escudo', 'Nadie te pide permiso', 'Cuando un agente quiera hacer algo que no tiene permitido (correr un comando, escribir fuera de su carpeta), el pedido aparece acá.',
        [h('button.btn', { onclick: function () { App.Ajustes.abrir('permisos'); } }, 'Cuánto te preguntan')]));
      return;
    }
    cuerpo.appendChild(h('div.permisos-lista', lista.map(tarjeta)));
  }

  /* «correr git pull», «escribir en notas/x»: lo que guarda «Siempre», en palabras (la regla cruda va en el title) */
  function textoGrupo(g) {
    return g.tipo === 'correr' ? 'correr ' + g.texto : g.tipo === 'escribir' ? 'escribir en ' + g.texto : g.texto.charAt(0).toLowerCase() + g.texto.slice(1);
  }
  function queQuiere(p) {
    if (QUE[p.herramienta]) return QUE[p.herramienta];
    return 'Quiere usar ' + App.humano.herramienta(p.herramienta);
  }

  function tarjeta(p) {
    var a = App.agente(p.agente) || { nombre: App.humano.quien(p.agente) };
    var ocupado = !!enviando[p.id];
    var reglas = p.reglas || [];
    var grupos = App.humano.reglas(reglas), siempre = grupos.map(textoGrupo).join(' · ');
    function boton(sel, texto, decision, titulo) {
      return h('button.btn.chico' + sel, { disabled: ocupado, title: titulo || '', onclick: function () { responder(p, decision); } }, texto);
    }
    return h('div.permiso',
      h('div.permiso-cab', App.agente(p.agente) ? App.retratoImg(a, 'retrato-mini', 48) : null,
        h('div', h('b', a.nombre), h('span', queQuiere(p)))),
      p.tarea ? h('div.permiso-desc', 'Tarea «' + p.tarea + '»: sigue cuando respondas.') : null,
      p.descripcion ? h('div.permiso-desc', p.descripcion) : null,
      h('code.permiso-det', p.detalle),
      h('div.permiso-acciones',
        boton('.primario', 'Permitir una vez', 'una_vez'),
        /* si no se puede guardar como permiso fijo, el botón no está (y la nota de abajo lo dice una sola vez) */
        reglas.length ? boton('', 'Permitir siempre', 'siempre', 'Siempre: ' + siempre) : null,
        boton('.fantasma', 'No', 'rechazar')),
      h('div.permiso-regla', { title: reglas.join(' · ') }, reglas.length ? 'Siempre: ' + siempre : 'Esto solo se puede permitir una vez.'));
  }

  function responder(p, decision) {
    enviando[p.id] = true; pintar();
    App.api.post('/api/permisos/' + encodeURIComponent(p.id), { decision: decision }).then(function (r) {
      var ag = App.agente(p.agente);
      if (ag && r && r.reglas) ag.reglas = r.reglas;
      lista = lista.filter(function (x) { return x.id !== p.id; });
      if (p.tarea && r && r.retoma) App.aviso('«' + p.tarea + '» sigue con lo que respondiste.');
      else if (decision === 'siempre') App.aviso('Listo: ' + ((App.agente(p.agente) || {}).nombre || p.agente) + ' ya no te va a preguntar por esto.');
    }).catch(function (e) {
      lista = lista.filter(function (x) { return x.id !== p.id; });
      App.aviso(e.message, true);
    }).then(function () {
      delete enviando[p.id]; firma = ''; pintar();
      if (App.Actividad) App.Actividad.ya();
    });
  }

  /* ---------------- modo de permisos (toda la app) ----------------
     «Automático»: un clasificador de Claude Code revisa cada acción y solo llega una tarjeta con lo dudoso.
     «Preguntarme siempre»: lo que el agente no tiene permitido llega como tarjeta (o se rechaza si nadie mira).
     La primera vez que se abre la app (`modo_permisos` null en /api/estado) se pide elegir; después se cambia desde
     Ajustes › Permisos de los agentes. Se guarda con PUT /api/preferencias y vale desde la próxima corrida de cada agente. */
  var MODOS = [
    { id: 'auto', titulo: 'Automático', nota: 'recomendado',
      bajada: 'Claude revisa cada acción y deja pasar lo razonable. Solo te pregunta lo dudoso.' },
    { id: 'preguntar', titulo: 'Preguntarme siempre',
      bajada: 'Cada comando o archivo que el agente no tenga permitido te llega como tarjeta para aprobar.' },
  ];

  /* Las dos opciones a la vista (App.elegir en lista). `alElegir(id)` se llama al tocar una. */
  function opcionesModo(actual, alElegir) {
    return App.elegir({ forma: 'lista', etiqueta: 'Modo de permisos', valor: actual,
      opciones: MODOS.map(function (m) { return { valor: m.id, titulo: m.titulo + (m.nota ? ' · ' + m.nota : ''), sub: m.bajada }; }),
      alCambiar: alElegir });
  }
  function avisoAutomatico() {
    return h('div.modo-aviso',
      h('b', 'En automático tené en cuenta que:'),
      h('ul',
        h('li', 'Un agente puede escribir archivos de la oficina fuera de su carpeta si a Claude le parece razonable para la tarea.'),
        h('li', 'Las tareas programadas avanzan solas, sin esperarte, salvo en lo que Claude frene.'),
        h('li', 'Cada acción pasa por una revisión extra de Claude: suma un poco de costo y de tiempo.'),
        h('li', 'Lo que sale de la oficina (mandar un mail, publicar, gastar) sigue siendo una propuesta que aprobás vos.')));
  }

  /* `alGuardar(modo)` (opcional): avisa a quien la abrió. Es la ventana de la primera vez (con «Empezar»);
     después se cambia desde Ajustes, adentro de la sección (pintarModo). */
  function elegirModo(actual, primeraVez, alGuardar) {
    var elegido = actual || 'auto';
    var hj = App.hoja({ titulo: primeraVez ? 'Antes de empezar: los permisos' : 'Permisos de los agentes', ancho: 520, modal: !!primeraVez });
    var err = h('div.error-txt'), aviso = h('div');
    function marcarAviso() { App.vaciar(aviso); if (elegido === 'auto') aviso.appendChild(avisoAutomatico()); }
    marcarAviso();
    App.add(hj.cuerpo,
      h('p', { style: { marginTop: 0, color: 'var(--suave)' } }, 'Los agentes corren comandos y escriben archivos en tu compu para hacer su trabajo. Elegí cuánto querés que te pregunten.'),
      opcionesModo(elegido, function (id) { elegido = id; marcarAviso(); }),
      aviso,
      h('div.ayuda', 'Lo podés cambiar cuando quieras desde Ajustes › Permisos de los agentes.'),
      err);
    var guardar = h('button.btn.primario', { autofocus: true, onclick: function () {
      guardar.disabled = true; err.textContent = '';
      App.api.put('/api/preferencias', { modo_permisos: elegido }).then(function () {
        if (App.E && App.E.estado) App.E.estado.modo_permisos = elegido;
        hj.cerrar();
        App.aviso(elegido === 'auto' ? 'Modo automático activado.' : 'Te vamos a preguntar cada permiso.');
        if (alGuardar) alGuardar(elegido);
      }).catch(function (e) { guardar.disabled = false; err.textContent = e.message; });
    } }, primeraVez ? 'Empezar' : 'Guardar');
    if (!primeraVez) hj.pie.appendChild(h('button.btn', { onclick: hj.cerrar }, 'Cancelar'));
    hj.pie.appendChild(guardar);
  }

  /** Ajustes › Permisos de los agentes: las dos opciones adentro de la sección, que se guardan al tocarlas (con «Deshacer»).
      `crear` es el de la ventana de Ajustes (App.hoja si no se pasa). */
  function pintarModo(crear) {
    var hj = (crear || App.hoja)({ titulo: 'Permisos de los agentes' });
    var err = h('div.error-txt'), aviso = h('div'), elegir = null;
    var actual = (App.E.estado && App.E.estado.modo_permisos) || null;
    function marcarAviso() { App.vaciar(aviso); if (actual === 'auto') aviso.appendChild(avisoAutomatico()); }
    function guardarModo(id, silencioso) {
      err.textContent = '';
      var antes = actual;
      return App.api.put('/api/preferencias', { modo_permisos: id }).then(function () {
        if (App.E && App.E.estado) App.E.estado.modo_permisos = id;
        actual = id; marcarAviso();
        if (!silencioso) App.guardado(id === 'auto' ? 'Modo automático.' : 'Te voy a preguntar cada permiso.', antes ? function () { elegir.poner(antes); guardarModo(antes, true); } : null);
      }).catch(function (e) { err.textContent = e.message; elegir.poner(actual); });
    }
    elegir = opcionesModo(actual, function (id) { guardarModo(id); });
    App.add(hj.cuerpo,
      h('p', { style: { marginTop: 0, color: 'var(--suave)' } }, 'Vale para todas tus oficinas. Los agentes corren comandos y escriben archivos en tu compu: elegí cuánto querés que te pregunten.'),
      elegir, aviso, err);
    marcarAviso();
    /* por si cambió desde otro lado, se vuelve a leer */
    App.api.get('/api/preferencias').then(function (r) {
      if (r.modo_permisos && r.modo_permisos !== actual) { actual = r.modo_permisos; elegir.poner(actual); marcarAviso(); }
    }).catch(function () {});
  }

  /** Desde el menú: lee lo guardado y abre la hoja. */
  function abrirModo(alGuardar) {
    App.api.get('/api/preferencias').then(function (r) { elegirModo(r.modo_permisos, false, alGuardar); }).catch(App.fallo);
  }

  if (App.on) App.on('actividad', function (r) { aplicar(r.permisos || []); });
  return { pendientes: function () { return lista.slice(); }, cuantos: function () { return lista.length; }, tarjeta: function (p) { return tarjeta(p); }, abrirPanel: abrirPanel, repintar: function () { pintar(true); }, elegirModo: elegirModo, abrirModo: abrirModo, pintarModo: pintarModo, MODOS: MODOS };
})();
