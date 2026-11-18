/* Del chat a las tareas (docs/plan-chat-a-tareas.md): «Sacar tareas» lee la charla (POST /api/chat/tareas) y abre una hoja
   para revisar la propuesta. Cada tarea marcada se crea con POST /api/tareas como «una sola vez» (ahora o en una fecha),
   con origen {chat}. Lo que le toca a la persona va aparte, para copiar: no se crea. */
App.ChatTareas = (function () {
  'use strict';
  var h = App.h, api = App.api;
  var leyendo = {};   // sesión -> true mientras se lee esa charla

  /* «En una fecha» arranca en mañana: hoy a una hora que ya pasó correría enseguida */
  function mananaISO() { var d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function zonaSistema() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }
  function copiar(texto) {
    App.copiarTexto(texto);
  }

  /* a: agente de la charla; sid: sesión. */
  function abrir(a, sid) {
    if (!sid) { App.aviso('Charlá primero con ' + a.nombre + ': después se pueden sacar tareas de la charla.'); return; }
    if (leyendo[sid]) return;
    var hj = App.hoja({ titulo: 'Tareas de esta charla', ancho: 620, alCerrar: function () { cerrada = true; } });
    var cerrada = false;
    leyendo[sid] = true;
    hj.cuerpo.appendChild(App.cargando('Leyendo la charla con ' + a.nombre + '…'));
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'));
    api.post('/api/chat/tareas', { agent: a.id, session: sid }).then(function (r) {
      if (!cerrada) pintar(hj, a, sid, r.pendientes || []);
    }).catch(function (e) {
      if (cerrada) return;
      App.vaciar(hj.cuerpo).appendChild(h('div.error-txt', e.message));
    }).then(function () { delete leyendo[sid]; });
  }

  function pintar(hj, a, sid, pendientes) {
    App.vaciar(hj.cuerpo); App.vaciar(hj.pie);
    var agentes = (App.E.oficina && App.E.oficina.agentes) || [];
    var propias = [], deVos = [];
    pendientes.forEach(function (p, i) { (p.usuario || !p.agente ? deVos : propias).push({ p: p, i: i }); });
    if (!propias.length && !deVos.length) {
      hj.cuerpo.appendChild(App.vacio('reloj', 'No encontré trabajo pendiente', 'En esta charla no quedó nada por hacer. Si falta algo, pedíselo a ' + a.nombre + ' y volvé a probar.'));
      App.add(hj.pie, h('button.btn.primario', { onclick: hj.cerrar }, 'Listo'));
      return;
    }
    var nombreDe = function (i) { return pendientes[i] ? '«' + pendientes[i].nombre + '»' : 'la ' + (i + 1); };
    var err = h('div.error-txt');
    var crear = h('button.btn.primario');

    var filas = propias.map(function (x) {
      var p = x.p;
      var f = { origen: x.i, marcada: true, agente: p.agente, ahora: !(p.dependeDe && p.dependeDe.length), hecha: false };
      f.nombre = h('input.campo', { value: p.nombre, maxlength: 80, 'aria-label': 'Nombre de la tarea' });
      f.consigna = h('textarea.campo', { rows: 4, maxlength: 4000, 'aria-label': 'Consigna' });
      f.consigna.value = p.consigna;
      f.fecha = h('input.campo', { type: 'date', value: mananaISO(), style: { width: '160px' } });
      f.hora = h('input.campo', { type: 'time', value: '09:00', step: 60, style: { width: '120px' } });
      f.err = h('div.error-txt');
      var ck = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Crear esta tarea' });
      var cuando = h('div.ct-cuando', f.fecha, f.hora);
      function verCuando() { cuando.style.display = f.ahora ? 'none' : ''; }
      var agenteEl = App.elegir({ etiqueta: 'Para quién', valor: p.agente, forma: 'chips',
        opciones: agentes.map(function (x2) { return { valor: x2.id, titulo: x2.nombre, retrato: x2 }; }),
        alCambiar: function (id) { f.agente = id; } });
      var cuandoEl = App.elegir({ etiqueta: 'Cuándo', valor: f.ahora, forma: 'chips',
        opciones: [{ valor: true, titulo: 'Ahora' }, { valor: false, titulo: 'En una fecha' }],
        alCambiar: function (v) { f.ahora = v; verCuando(); } });
      var deps = (p.dependeDe || []).map(nombreDe);
      var cuerpo = h('div.ct-cuerpo',
        h('div.fila-campo', h('label.etiqueta-campo', 'Para quién'), agenteEl),
        h('div.fila-campo', h('label.etiqueta-campo', 'Nombre'), f.nombre),
        h('div.fila-campo', h('label.etiqueta-campo', 'Consigna'), h('div.ayuda', 'Se hace en una conversación nueva: tiene que entenderse sin la charla.'), f.consigna),
        h('div.fila-campo', h('label.etiqueta-campo', 'Cuándo'),
          deps.length ? h('div.ayuda', 'Va después de ' + deps.join(' y ') + ': elegí una fecha en la que eso ya esté hecho.') : null,
          cuandoEl, cuando),
        f.err);
      ck.addEventListener('change', function () { f.marcada = ck.checked; cuerpo.style.display = ck.checked ? '' : 'none'; f.el.classList.toggle('apagada', !ck.checked); contar(); });
      f.el = h('div.ct-tarea', h('label.ct-cab', ck, h('b', p.nombre)), cuerpo);
      verCuando();
      return f;
    });

    function contar() {
      var n = filas.filter(function (f) { return f.marcada && !f.hecha; }).length;
      crear.textContent = n === 1 ? 'Crear 1 tarea' : 'Crear ' + n + ' tareas';
      crear.disabled = n === 0;
    }

    if (filas.length) hj.cuerpo.appendChild(App.seccion('Para el equipo', filas.map(function (f) { return f.el; }),
      { cuenta: String(filas.length), ayuda: 'Revisá cada una antes de crearla. Las que desmarques no se crean.' }));
    if (deVos.length) {
      var dueno = (App.E.oficina && App.E.oficina.duenio) || '';
      hj.cuerpo.appendChild(App.seccion('Para vos', deVos.map(function (x) {
        return App.filaDecision({ marca: 'personas', titulo: x.p.nombre, sub: x.p.consigna !== x.p.nombre ? x.p.consigna : null,
          principal: h('button.btn.chico', { onclick: function () { copiar(x.p.nombre + '\n\n' + x.p.consigna); } }, 'Copiar') });
      }), { cuenta: String(deVos.length), ayuda: 'Lo que tiene que hacer ' + (dueno || 'la persona') + ' (o terminar a mano): no se crea como tarea.' }));
    }
    hj.cuerpo.appendChild(err);

    crear.onclick = function () {
      var pend = filas.filter(function (f) { return f.marcada && !f.hecha; });
      err.textContent = '';
      for (var k = 0; k < pend.length; k++) {
        var f = pend[k]; f.err.textContent = '';
        if (!f.agente) { f.err.textContent = 'Elegí para quién es.'; return; }
        if (!f.nombre.value.trim()) { f.err.textContent = 'Poné un nombre.'; return; }
        if (!f.consigna.value.trim()) { f.err.textContent = 'Escribí la consigna.'; return; }
        if (!f.ahora && (!/^\d{4}-\d\d-\d\d$/.test(f.fecha.value) || !/^\d\d:\d\d$/.test(f.hora.value))) { f.err.textContent = 'Elegí la fecha y la hora.'; return; }
      }
      crear.disabled = true;
      var hechas = 0, ahora = 0;
      /* de a una y en orden: si una falla, las anteriores ya quedaron creadas y no se repiten */
      var cadena = pend.reduce(function (prom, f) {
        return prom.then(function () {
          var cuerpo = { agente: f.agente, nombre: f.nombre.value.trim(), consigna: f.consigna.value.trim(), tipo: 'unica', origen: { chat: sid } };
          if (f.ahora) cuerpo.ahora = true;
          else { cuerpo.fecha = f.fecha.value; cuerpo.hora = f.hora.value; cuerpo.zona = zonaSistema(); }
          return api.post('/api/tareas', cuerpo).then(function () {
            f.hecha = true; hechas++; if (f.ahora) ahora++;
            f.el.classList.add('creada');
            f.el.querySelector('.ct-cab').appendChild(h('span.insignia', 'Creada'));
            f.el.querySelector('.ct-cuerpo').style.display = 'none';
            f.el.querySelector('input[type=checkbox]').disabled = true;
          }, function (e) { f.err.textContent = e.message; throw e; });
        });
      }, Promise.resolve());
      cadena.then(function () {
        hj.cerrar();
        App.aviso(hechas === 1 ? 'Tarea creada.' : hechas + ' tareas creadas.', false, App.Tareas ? { texto: 'Ver tareas', fn: function () { App.Tareas.abrir(); } } : null);
        if (ahora && App.Actividad) setTimeout(App.Actividad.ya, 300);
      }).catch(function () {
        err.textContent = hechas ? 'Se crearon ' + hechas + '; la que falló quedó marcada arriba.' : '';
        contar();
      });
    };
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), crear);
    contar();
  }

  return { abrir: abrir };
})();
