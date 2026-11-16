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

  function pintar() {
    var vista = App.dom && App.dom.lienzo && App.dom.lienzo.parentNode; if (!vista) return;
    if (!pila || !vista.contains(pila)) { pila = h('div.permisos-pila'); vista.appendChild(pila); }
    App.vaciar(pila);
    lista.forEach(function (p) { pila.appendChild(tarjeta(p)); });
  }

  function tarjeta(p) {
    var a = App.agente(p.agente) || { nombre: p.agente };
    var ocupado = !!enviando[p.id];
    var reglas = p.reglas || [];
    function boton(sel, texto, decision, titulo, apagado) {
      return h('button.btn.chico' + sel, { disabled: ocupado || !!apagado, title: titulo || '', onclick: function () { responder(p, decision); } }, texto);
    }
    return h('div.permiso',
      h('div.permiso-cab', App.agente(p.agente) ? App.retratoImg(a, 'retrato-mini', 48) : null,
        h('div', h('b', a.nombre), h('span', QUE[p.herramienta] || 'Quiere usar ' + p.herramienta))),
      p.tarea ? h('div.permiso-desc', 'Tarea «' + p.tarea + '»: sigue cuando respondas.') : null,
      p.descripcion ? h('div.permiso-desc', p.descripcion) : null,
      h('code.permiso-det', p.detalle),
      h('div.permiso-acciones',
        boton('.primario', 'Permitir una vez', 'una_vez'),
        reglas.length ? boton('', 'Permitir siempre', 'siempre', 'Guarda el permiso: ' + reglas.join(' · '))
          : boton('', 'Permitir siempre', 'siempre', 'Esto no se puede guardar como permiso fijo: solo se puede permitir una vez.', true),
        boton('.fantasma', 'No', 'rechazar')),
      h('div.permiso-regla', reglas.length ? 'Siempre guarda: ' + reglas.join(' · ') : 'Esto solo se puede permitir una vez.'));
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
     La primera vez que se abre la app (`modo_permisos` null en /api/estado) se pide elegir; después se cambia desde el
     menú de la oficina. Se guarda con PUT /api/preferencias y vale desde la próxima corrida de cada agente. */
  var MODOS = [
    { id: 'auto', titulo: 'Automático', nota: 'recomendado',
      bajada: 'Claude revisa cada acción y deja pasar lo razonable. Solo te pregunta lo dudoso.' },
    { id: 'preguntar', titulo: 'Preguntarme siempre',
      bajada: 'Cada comando o archivo que el agente no tenga permitido te llega como tarjeta para aprobar.' },
  ];

  function elegirModo(actual, primeraVez) {
    var elegido = actual || 'auto';
    var hj = App.hoja({ titulo: primeraVez ? 'Antes de empezar: los permisos' : 'Permisos de los agentes', ancho: 520, modal: !!primeraVez });
    var err = h('div.error-txt');
    var opciones = MODOS.map(function (m) {
      var b = h('button.opcion.modo-permiso', { onclick: function () { elegido = m.id; marcar(); } },
        h('div', h('b', m.titulo, m.nota ? h('span.modo-nota', m.nota) : null), h('div.ayuda', { style: { margin: '2px 0 0' } }, m.bajada)));
      b.dataset.modo = m.id;
      return b;
    });
    function marcar() { opciones.forEach(function (b) { b.classList.toggle('elegida', b.dataset.modo === elegido); }); }
    marcar();
    App.add(hj.cuerpo,
      h('p', { style: { marginTop: 0, color: 'var(--suave)' } }, 'Los agentes corren comandos y escriben archivos en tu compu para hacer su trabajo. Elegí cuánto querés que te pregunten.'),
      opciones,
      h('div.modo-aviso',
        h('b', 'En automático tené en cuenta que:'),
        h('ul',
          h('li', 'Un agente puede escribir archivos de la oficina fuera de su carpeta si a Claude le parece razonable para la tarea.'),
          h('li', 'Las tareas programadas avanzan solas, sin esperarte, salvo en lo que Claude frene.'),
          h('li', 'Cada acción pasa por una revisión extra de Claude: suma un poco de costo y de tiempo.'),
          h('li', 'Lo que sale de la oficina (mandar un mail, publicar, gastar) sigue siendo una propuesta que aprobás vos.'))),
      h('div.ayuda', 'Lo podés cambiar cuando quieras desde el menú de la oficina › Permisos de los agentes.'),
      err);
    var guardar = h('button.btn.primario', { autofocus: true, onclick: function () {
      guardar.disabled = true; err.textContent = '';
      App.api.put('/api/preferencias', { modo_permisos: elegido }).then(function () {
        if (App.E && App.E.estado) App.E.estado.modo_permisos = elegido;
        hj.cerrar();
        App.aviso(elegido === 'auto' ? 'Modo automático activado.' : 'Te vamos a preguntar cada permiso.');
      }).catch(function (e) { guardar.disabled = false; err.textContent = e.message; });
    } }, primeraVez ? 'Empezar' : 'Guardar');
    if (!primeraVez) hj.pie.appendChild(h('button.btn', { onclick: hj.cerrar }, 'Cancelar'));
    hj.pie.appendChild(guardar);
  }

  /** Desde el menú: lee lo guardado y abre la hoja. */
  function abrirModo() {
    App.api.get('/api/preferencias').then(function (r) { elegirModo(r.modo_permisos, false); }).catch(App.fallo);
  }

  if (App.on) App.on('actividad', function (r) { aplicar(r.permisos || []); });
  return { pendientes: function () { return lista.slice(); }, elegirModo: elegirModo, abrirModo: abrirModo };
})();
