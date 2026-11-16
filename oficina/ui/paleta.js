/* Paleta ⌘K / Ctrl+K: buscar agentes, salas, acciones y reuniones recientes; Enter abre (y la cámara va hasta ahí).
   También la barra de pistas: dice qué podés hacer con lo que está bajo el mouse en la maqueta. */
window.App = window.App || {};
App.Paleta = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var velo = null, items = [], filtrados = [], sel = 0, reuniones = [];

  function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  /* coincidencia difusa: todas las letras de la búsqueda en orden; puntaje mejor si son contiguas o al inicio de palabra */
  function puntaje(q, txt) {
    if (!q) return 1;
    var t = norm(txt), i = 0, p = 0, prev = -2, s = 0;
    for (; i < q.length; i++) {
      var k = t.indexOf(q[i], p);
      if (k < 0) return 0;
      s += k === prev + 1 ? 3 : (k === 0 || t[k - 1] === ' ') ? 2 : 1;
      prev = k; p = k + 1;
    }
    return s / (t.length + 1) + s;
  }

  function armar() {
    var o = App.E.oficina || { agentes: [], departamentos: [] }, act = App.E.actividad || {}, out = [];
    o.agentes.forEach(function (a) {
      var t = act[a.id], d = App.depto(a.departamento);
      out.push({ tipo: 'Agente', icono: 'personas', txt: a.nombre, sub: t ? (t.tarea || t.estado) : a.rol + (d ? ' · ' + d.nombre : ''),
        buscar: a.nombre + ' ' + a.rol + ' ' + (d ? d.nombre : ''),
        hacer: function () { App.Oficina3D.enfocarAgente(a.id); App.Agente.abrir(a.id); } });
    });
    out.push({ tipo: 'Sala', icono: 'reunion', txt: 'Sala de reuniones', buscar: 'sala reuniones',
      hacer: function () { App.Oficina3D.enfocarLugar('reunion'); App.Reunion.abrir(); } });
    out.push({ tipo: 'Sala', icono: 'libro', txt: 'Biblioteca', buscar: 'biblioteca archivos documentos',
      hacer: function () { App.Oficina3D.enfocarLugar('biblioteca'); App.Biblioteca.abrir(); } });
    out.push({ tipo: 'Sala', icono: 'bandeja', txt: 'Tu bandeja', sub: App.Entregables && App.Entregables.sinRevisar() ? App.Entregables.sinRevisar() + ' sin revisar' : '',
      buscar: 'bandeja entregables entregas revisar despacho direccion',
      hacer: function () { App.Oficina3D.enfocarLugar('entregables'); App.Entregables.abrir(); } });
    out.push({ tipo: 'Vos', icono: 'personas', txt: 'Quién dirige', sub: App.Yo.nombre(), buscar: 'yo perfil quien dirige mi nombre dueño minifig',
      hacer: function () { App.Yo.abrir(); } });
    o.departamentos.forEach(function (d) {
      out.push({ tipo: 'Departamento', icono: 'capas', txt: d.nombre, buscar: 'departamento ' + d.nombre, hacer: function () { App.Ajustes.abrir('departamentos'); } });
    });
    [['Parte del día', 'parte', function () { App.Parte.abrir(); }],
     ['Flujos', 'flujo', function () { App.Flujos.abrir(); }],
     ['Nueva corrida', 'flujo', function () { App.Flujos.abrir(); App.Flujos.nueva(); }],
     ['Armar con el Creador', 'chispa', function () { App.Creador.abrir(); }],
     ['Ajustes', 'ajustes', function () { App.Ajustes.abrir(); }],
     ['Nombre de la oficina y quién dirige', 'edificio', function () { App.Ajustes.abrir('general'); }],
     ['Reglas de la oficina', 'regla', function () { App.Ajustes.abrir('reglas'); }],
     ['Nuevo departamento', 'capas', function () { App.Deptos.agregar(); }],
     ['Conectores', 'enchufe', function () { App.Ajustes.abrir('conectores'); }],
     ['Permisos de los agentes', 'escudo', function () { App.Ajustes.abrir('permisos'); }],
     ['Contratar un agente', 'mas', function () { App.Contratar.abrir(); }],
     ['Llamar a reunión', 'reunion', function () { App.Reunion.nueva(); }],
     ['Departamentos', 'capas', function () { App.Ajustes.abrir('departamentos'); }],
     ['Siguiente aviso pendiente', 'chispa', function () { if (App.Avisos) App.Avisos.siguiente(); }],
     ['Revisar la próxima entrega', 'chispa', function () { if (!App.Entregables.siguiente()) App.aviso('No tenés entregas sin revisar.'); }],
     ['Exportar oficina', 'subir', function () { App.exportarOficina(); }],
     ['Ver toda la oficina', 'edificio', function () { App.Oficina3D.encuadrar(); }]].forEach(function (x) {
      out.push({ tipo: 'Acción', icono: x[1], txt: x[0], buscar: x[0], hacer: x[2] });
    });
    App.opcionesOficina().forEach(function (o) { out.push({ tipo: 'Acción', icono: o.icono, txt: o.texto, buscar: o.texto, hacer: o.accion }); });
    reuniones.slice(0, 8).forEach(function (r) {
      out.push({ tipo: 'Reunión', icono: 'reunion', txt: r.tema, sub: App.fecha ? App.fecha(r.creada) : '', buscar: 'reunion ' + r.tema,
        hacer: function () { App.Reunion.ver ? App.Reunion.ver(r.id) : App.Reunion.abrir(); } });
    });
    return out;
  }

  function abrir() {
    if (velo || document.querySelector('.cmdk-velo')) return;
    if (!App.E.oficina) return;
    items = armar();
    var inp = h('input.cmdk-buscar', { placeholder: 'Buscar agentes, salas, acciones…', autocomplete: 'off', spellcheck: false });
    var lista = h('div.cmdk-lista');
    var caja = h('div.cmdk', { onclick: function (e) { e.stopPropagation(); } }, h('div.cmdk-cab', App.icono('buscar'), inp), lista,
      h('div.cmdk-pie', h('span', h('kbd', '↑'), h('kbd', '↓'), ' elegir'), h('span', h('kbd', '↵'), ' abrir'), h('span', h('kbd', 'esc'), ' cerrar')));
    velo = h('div.velo.cmdk-velo', { onclick: cerrar }, caja);
    document.body.appendChild(velo);
    function filtrar() {
      var q = norm(inp.value.trim());
      filtrados = items.map(function (x) { return { x: x, s: puntaje(q.replace(/\s+/g, ''), x.buscar) }; })
        .filter(function (y) { return y.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 12).map(function (y) { return y.x; });
      sel = 0; pintar();
    }
    function pintar() {
      App.vaciar(lista);
      if (!filtrados.length) { lista.appendChild(h('div.vacio', 'Nada con eso.')); return; }
      filtrados.forEach(function (x, i) {
        var fila = h('div.cmdk-item' + (i === sel ? '.sel' : ''), { onmousemove: function () { if (sel !== i) { sel = i; pintar(); } }, onclick: function () { elegir(i); } },
          App.icono(x.icono), h('div.cmdk-txt', h('b', x.txt), x.sub ? h('small', x.sub) : null), h('span.cmdk-tipo', x.tipo));
        lista.appendChild(fila);
      });
      var s = lista.querySelector('.sel'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
    }
    inp.addEventListener('input', filtrar);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { sel = Math.min(filtrados.length - 1, sel + 1); pintar(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); pintar(); e.preventDefault(); }
      else if (e.key === 'Enter') { elegir(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { cerrar(); e.preventDefault(); e.stopPropagation(); }
    });
    filtrar();
    setTimeout(function () { inp.focus(); }, 0);
    App.api.get('/api/reuniones').then(function (r) { reuniones = r.reuniones || []; if (velo) { items = armar(); filtrar(); } }).catch(function () {});
  }
  function elegir(i) { var x = filtrados[i]; if (!x) return; cerrar(); x.hacer(); }
  function cerrar() {
    document.querySelectorAll('.cmdk-velo').forEach(function (v) { v.remove(); });   /* por si quedó alguna copia */
    velo = null;
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (velo) cerrar(); else if (!(App.hojaAbierta && App.hojaAbierta())) abrir();
    }
  });

  /* ---------------- barra de pistas ---------------- */
  var esMac = /Mac/.test(navigator.platform || navigator.userAgent);
  var BASE = 'Arrastrá para girar · dos dedos para moverte · pellizcá para acercarte · ' + (esMac ? '⌘K' : 'Ctrl+K') + ' buscar · N siguiente aviso';
  var VERBO = { pensando: 'pensando', leyendo: 'leyendo', escribiendo: 'escribiendo', buscando: 'buscando', consultando: 'consultando a', trabajando: 'trabajando' };
  function pista(hov) {
    var el = App.dom && App.dom.lienzo && App.dom.lienzo.parentNode && App.dom.lienzo.parentNode.querySelector('.pista');
    if (!el) return;
    if (!hov) { el.textContent = BASE; el.classList.remove('viva'); return; }
    var t;
    if (hov.tipo === 'agente') {
      var a = App.agente(hov.id), act = (App.E.actividad || {})[hov.id];
      t = 'Clic: hablar con ' + (a ? a.nombre : hov.id);
      if (act) t += ' · ' + (VERBO[act.estado] || act.estado) + (act.objetivo ? ' ' + act.objetivo : '');
    } else if (hov.tipo === 'reunion') t = 'Clic: abrir la sala de reuniones';
    else if (hov.tipo === 'biblioteca') t = 'Clic: abrir la biblioteca';
    else if (hov.tipo === 'direccion') t = 'Clic: abrir tu bandeja de entregables';
    else if (hov.tipo === 'yo') t = 'Sos vos' + (App.Yo.nombre() ? ', ' + App.Yo.nombre() : '') + ' · clic: cambiar tu nombre o tu minifig';
    else if (hov.texto) t = hov.texto;   // bandeja de entregables: el 3D ya arma el texto
    el.textContent = t || BASE;
    el.classList.toggle('viva', !!t);
  }

  return { abrir: abrir, cerrar: cerrar, pista: pista, BASE: BASE };
})();
