/* Chip de contexto de la charla: cuánto de la memoria de trabajo del agente ocupa la conversación. El número sale del
   último turno (lo devuelven /api/chat y /api/historial); al tocarlo, un popover pide el desglose por categoría
   (POST /api/chat/contexto, que corre /context de Claude Code sin llamar a la API). */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var GRUPOS = [
    { clave: 'mensajes', nombre: 'Mensajes', color: '#378ADD' },
    { clave: 'herramientas', nombre: 'Herramientas', color: '#1D9E75' },
    { clave: 'instrucciones', nombre: 'Instrucciones', color: '#BA7517' },
    { clave: 'skills', nombre: 'Skills', color: '#888780' },
    { clave: 'otros', nombre: 'Otros', color: '#B4B2A9' },
  ];
  var AYUDA = {
    mensajes: 'Lo que se dijeron y lo que leyó o hizo con sus herramientas',
    herramientas: 'La descripción de las herramientas que puede usar',
    instrucciones: 'Su rol, las instrucciones de la oficina y la memoria',
    skills: 'La lista de habilidades instaladas',
  };
  var datos = {};      // id de agente -> {usados, ventana?} de su charla abierta
  var chipVivo = null; // {id, el}: el chip de la charla que está a la vista

  function corto(n) {
    if (n >= 1e6) return (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n >= 1e5 ? Math.round(n / 1e3) : Math.round(n / 100) / 10) + 'k';
    return String(Math.round(n));
  }
  function porc(n, tot) {
    var p = n / tot * 100;
    return (p >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10) + '%';
  }
  function nivel(p) { return p >= 85 ? 'limite' : p >= 60 ? 'cerca' : ''; }

  function pintarChip(el, c) {
    App.vaciar(el);
    el.classList.remove('cerca', 'limite');
    el.hidden = !c;
    if (!c) return;
    if (!c.ventana) {
      el.appendChild(h('span.ctx-num', corto(c.usados)));
      el.title = 'Contexto de la charla: ' + corto(c.usados) + ' tokens';
      return;
    }
    var p = Math.min(100, c.usados / c.ventana * 100), n = nivel(p);
    if (n) el.classList.add(n);
    el.appendChild(h('span.ctx-barra', h('i', { style: { width: Math.max(4, p) + '%' } })));
    el.appendChild(h('span.ctx-num', Math.round(p) + '%'));
    el.title = 'Contexto de la charla: ' + corto(c.usados) + ' de ' + corto(c.ventana) + ' tokens';
  }

  function contenido(c, d, error) {
    var ventana = (d && d.ventana) || c.ventana, usados = d ? d.usados : c.usados;
    var cab = h('div.ctx-tit', h('b', 'Contexto'), h('span', corto(usados) + (ventana ? ' / ' + corto(ventana) : '')));
    var barra = h('div.ctx-apilada');
    var filas = [];
    if (d) {
      GRUPOS.forEach(function (g) {
        var n = d.grupos[g.clave] || 0;
        if (!n) return;
        barra.appendChild(h('i', { style: { width: (n / ventana * 100) + '%', background: g.color } }));
        filas.push(h('div.ctx-fila', { title: AYUDA[g.clave] || '' }, h('span.ctx-punto', { style: { background: g.color } }), h('span', g.nombre),
          h('span.ctx-n', corto(n)), h('span.ctx-n', porc(n, ventana))));
      });
      filas.push(h('div.ctx-fila.libre', h('span.ctx-punto'), h('span', 'Libre'), h('span.ctx-n', corto(d.libre)), h('span.ctx-n', porc(d.libre, ventana))));
    } else if (ventana) {
      barra.appendChild(h('i', { style: { width: (usados / ventana * 100) + '%', background: 'var(--tenue)' } }));
    }
    var pie = d && d.reserva
      ? 'Al llenarse, Claude resume la charla y pierde detalle. Aparta ' + corto(d.reserva) + ' para ese resumen.'
      : 'Al llenarse, Claude resume la charla y pierde detalle.';
    return h('div',
      cab, barra,
      d ? h('div.ctx-filas', filas) : error ? h('div.ctx-error', error) : App.cargando('Midiendo…'),
      h('div.ctx-pie', pie));
  }

  function abrir(id, el, pedido) {
    var c = datos[id]; if (!c) return;
    var pop = App.emergente(el, contenido(c), 'ctx-pop');
    var cuerpo = pedido();
    if (!cuerpo) return;
    api.post('/api/chat/contexto', cuerpo).then(function (d) {
      var nodo = document.querySelector('.emergente.ctx-pop');
      if (!nodo) return;
      App.vaciar(nodo).appendChild(contenido(c, d));
      /* el desglose es más nuevo que el último turno: el chip lo sigue */
      datos[id] = { usados: d.usados, ventana: d.ventana };
      if (chipVivo && chipVivo.id === id) pintarChip(chipVivo.el, datos[id]);
    }).catch(function (e) {
      var nodo = document.querySelector('.emergente.ctx-pop');
      if (nodo) App.vaciar(nodo).appendChild(contenido(c, null, e.message || 'No se pudo medir.'));
    });
    return pop;
  }

  /* El chip de la charla de un agente. `pedido()` devuelve el cuerpo para /api/chat/contexto ({agent, session, …lo
     elegido en la charla}) o null si la charla todavía no empezó. Sin datos, el chip no se ve. */
  function chip(id, pedido) {
    var el = h('button.ctx-chip', { type: 'button', onclick: function () { abrir(id, el, pedido); } });
    pintarChip(el, datos[id]);
    chipVivo = { id: id, el: el };
    return el;
  }

  /* Lo que vino del backend (`contexto` de /api/chat o /api/historial; null = no se sabe). */
  function fijar(id, c) {
    if (c && c.usados > 0) datos[id] = { usados: c.usados, ventana: c.ventana }; else delete datos[id];
    if (chipVivo && chipVivo.id === id && chipVivo.el.isConnected) pintarChip(chipVivo.el, datos[id]);
  }

  App.ChipContexto = { chip: chip, fijar: fijar };
})();
