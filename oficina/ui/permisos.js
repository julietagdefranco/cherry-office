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

  if (App.on) App.on('actividad', function (r) { aplicar(r.permisos || []); });
  return { pendientes: function () { return lista.slice(); } };
})();
