/* Panel del agente (a la derecha, sin tapar la maqueta): conversación, perfil, notas y tareas programadas. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var actual = null, pestana = 'chat';
  var sesiones = {};      // id -> session uuid
  var chats = {};         // id -> [{r, t, e}]  (cache en memoria)
  var enCurso = {};       // id -> true mientras espera respuesta

  function abrir(id, pest) {
    var a = App.agente(id); if (!a) return;
    var mismo = actual === id;
    actual = id; pestana = pest || (mismo ? pestana : 'chat');
    App.Oficina3D.elegir(id);
    pintar();
    App.abrirDerecho('agente');
    if (App.Avisos) App.Avisos.vistoAgente(id);
    App.marcarEstados();
  }

  function pintar() {
    var a = App.agente(actual); if (!a) { cerrar(); return; }
    var d = App.depto(a.departamento);
    var cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var tabs = h('div.pestanas', [['chat', 'Conversación'], ['perfil', 'Perfil'], ['notas', 'Notas'], ['tareas', 'Tareas']].map(function (p) {
      return h('button.pestana' + (pestana === p[0] ? '.activa' : ''), { onclick: function () { pestana = p[0]; pintar(); } }, p[1]);
    }));
    App.add(App.vaciar(App.dom.derecho), 
      h('div.der-cab', App.retratoImg(a, 'retrato', 120), h('div.der-tit', h('h2', a.nombre),
        h('div.sub', a.rol, d ? h('span.insignia', h('span.punto', { style: { background: d.color, marginRight: '5px' } }), d.nombre) : null)),
        h('button.btn.fantasma.icono', { title: 'Cerrar', onclick: App.cerrarDerecho }, App.icono('cerrar'))),
      tabs, cuerpo, pie);
    if (pestana === 'chat') pintarChat(a, cuerpo, pie);
    else if (pestana === 'perfil') pintarPerfil(a, cuerpo, pie);
    else if (pestana === 'tareas') pintarTareas(a, cuerpo, pie);
    else pintarNotas(a, cuerpo, pie);
  }

  /* ---------------- conversación ---------------- */
  function pintarChat(a, cuerpo, pie) {
    var lista = h('div.chat'), sug = h('div.sugerencias');
    App.add(cuerpo, lista, sug);
    var txt = h('textarea.campo', { rows: 1, placeholder: 'Escribile a ' + a.nombre + '…', maxlength: 20000 });
    var enviar = h('button.btn.primario.icono', { title: 'Enviar (Enter)', onclick: mandar }, App.icono('enviar'));
    txt.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); mandar(); } });
    txt.addEventListener('input', function () { txt.style.height = 'auto'; txt.style.height = Math.min(160, txt.scrollHeight + 2) + 'px'; });
    App.add(pie, h('div.redactar', txt, enviar),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '6px' } },
        h('span.ayuda', 'Enter para enviar · Mayús+Enter para otra línea'),
        h('button.btn.chico.fantasma', { onclick: function () { sesiones[a.id] = App.uuid(); chats[a.id] = []; pintar(); } }, 'Conversación nueva')));

    function render() {
      App.vaciar(lista); App.vaciar(sug);
      var msgs = chats[a.id] || [];
      if (!msgs.length) {
        lista.appendChild(h('div.chat-intro', App.retratoImg(a, 'x', 192), h('div', { style: { fontWeight: 600, color: 'var(--texto)' } }, a.nombre), h('div', a.rol)));
        (a.chips || []).forEach(function (c) { sug.appendChild(h('button.chip', { onclick: function () { txt.value = c; mandar(); } }, c)); });
      }
      msgs.forEach(function (m) {
        if (m.r === 'u') lista.appendChild(h('div.msg.u', m.t));
        else lista.appendChild(App.htmlSeguro(h('div.msg.a' + (m.e ? '.e' : '')), App.markdown(m.t)));
      });
      if (enCurso[a.id]) lista.appendChild(h('div.escribiendo', h('span.puntos', h('i'), h('i'), h('i')), a.nombre + ' está escribiendo…'));
      cuerpo.scrollTop = cuerpo.scrollHeight;
      enviar.disabled = !!enCurso[a.id];
    }

    function mandar() {
      var t = txt.value.trim();
      if (!t || enCurso[a.id]) return;
      if (!sesiones[a.id]) sesiones[a.id] = App.uuid();
      (chats[a.id] = chats[a.id] || []).push({ r: 'u', t: t });
      txt.value = ''; txt.style.height = '';
      ocupado(a.id, true);
      render();
      if (App.Actividad) setTimeout(App.Actividad.ya, 300);
      var id = a.id;
      api.post('/api/chat', { agent: id, message: t, session: sesiones[id] }).then(function (r) {
        if (App.Actividad) App.Actividad.ya();
        (chats[id] = chats[id] || []).push({ r: 'a', t: r.reply || '(sin respuesta)' });
      }).catch(function (e) {
        (chats[id] = chats[id] || []).push({ r: 'a', t: 'No pude responder: ' + e.message, e: true });
      }).then(function () {
        ocupado(id, false);
        if (actual === id && pestana === 'chat') pintar();   // si no, el aviso llega por /api/actividad (banner y faro)
      });
    }

    if (chats[a.id]) render();
    else {
      lista.appendChild(h('div.vacio', h('span.giro')));
      api.get('/api/historial', { agent: a.id }).then(function (r) {
        if (r.session) sesiones[a.id] = r.session;
        chats[a.id] = (r.msgs || []).map(function (m) { return { r: m.r, t: m.t, e: !!m.e }; });
        if (actual === a.id && pestana === 'chat') render();
      }).catch(function () { chats[a.id] = []; render(); });
    }
    setTimeout(function () { txt.focus(); }, 60);
  }

  function ocupado(id, si) {
    if (si) { enCurso[id] = true; App.E.ocupados[id] = true; } else { delete enCurso[id]; delete App.E.ocupados[id]; }
    App.Oficina3D.ocupado(id, si);
    App.marcarEstados();
  }

  /* ---------------- perfil ---------------- */
  function pintarPerfil(a, cuerpo, pie) {
    var cont = h('div', { style: { padding: '14px' } }, h('div.vacio', h('span.giro')));
    cuerpo.appendChild(cont);
    api.get('/api/agentes/' + encodeURIComponent(a.id)).then(function (r) {
      if (actual !== a.id || pestana !== 'perfil') return;
      var datos = Object.assign({}, r.agente, { prompt: r.prompt, description: r.description || (r.agente && r.agente.description) });
      var ed = App.EditorAgente(datos, { editar: true });
      ed.el.style.gridTemplateColumns = '1fr';
      ed.el.querySelector('.grande').style.cssText = 'width:160px;height:160px';
      var err = h('div.error-txt');
      App.add(App.vaciar(cont), ed.el, err);
      var guardar = h('button.btn.primario', {
        onclick: function () {
          var m = ed.validar(); if (m) { err.textContent = m; return; }
          var v = ed.valor(); delete v.id;
          guardar.disabled = true;
          api.patch('/api/agentes/' + encodeURIComponent(a.id), v).then(function (r2) {
            App.aviso('Cambios guardados.');
            App.actualizar(r2.oficina);
            pintar();
          }).catch(function (e) { err.textContent = e.message; guardar.disabled = false; });
        }
      }, 'Guardar cambios');
      App.add(pie, h('div', { style: { display: 'flex', gap: '8px' } },
        h('button.btn.peligro', { onclick: function () { despedir(a); } }, 'Despedir'),
        h('span', { style: { flex: 1 } }), guardar));
    }).catch(function (e) { App.vaciar(cont).appendChild(h('div.vacio', e.message)); });
  }

  function despedir(a) {
    App.confirmar('¿Despedir a ' + a.nombre + '?', 'Deja de estar en la oficina. Su archivo de Claude Code se archiva (no se borra) y sus notas quedan en la carpeta de conocimiento.', 'Despedir', true).then(function (si) {
      if (!si) return;
      api.del('/api/agentes/' + encodeURIComponent(a.id)).then(function (r) {
        App.cerrarDerecho();
        App.actualizar(r.oficina);
        App.aviso(a.nombre + ' ya no está en la oficina.');
      }).catch(App.fallo);
    });
  }

  /* ---------------- notas y entregables ---------------- */
  function pintarNotas(a, cuerpo) {
    var notas = h('div', h('div.vacio', h('span.giro'))), ent = h('div');
    cuerpo.appendChild(h('div', { style: { padding: '14px' } },
      h('div.det-sec', h('h4', 'Lo que fue anotando'), notas),
      h('div.det-sec', h('h4', 'Entregables'), ent)));
    api.get('/api/agentes/' + encodeURIComponent(a.id) + '/conocimiento').then(function (r) {
      App.vaciar(notas).appendChild(App.htmlSeguro(h('div.msg.a', { style: { maxWidth: 'none' } }), App.markdown(r.texto || 'Todavía no anotó nada.')));
    }).catch(function (e) { App.vaciar(notas).appendChild(h('div.ayuda', e.message)); });
    api.get('/api/biblioteca/entregables', { agente: a.id }).then(function (r) {
      App.vaciar(ent);
      if (!r.entregables || !r.entregables.length) { ent.appendChild(h('div.ayuda', 'Cuando ' + a.nombre + ' guarde trabajos, aparecen acá (' + r.carpeta + ').')); return; }
      r.entregables.forEach(function (x) {
        ent.appendChild(h('div.archivo', { style: { padding: '8px 4px' }, onclick: function () { api.get('/api/biblioteca/entregable', { agente: a.id, ruta: x.ruta }).then(App.abrirContenido).catch(App.fallo); } },
          h('div.tipo', (x.nombre.split('.').pop() || '').slice(0, 4)), h('div.archivo-txt', h('div.archivo-tit', x.nombre), h('div.archivo-meta', App.tam(x.tam || 0)))));
      });
    }).catch(function () { App.vaciar(ent).appendChild(h('div.ayuda', 'No pude leer los entregables.')); });
  }

  /* ---------------- tareas programadas ---------------- */
  var DIAS = [[1, 'L', 'Lunes'], [2, 'M', 'Martes'], [3, 'X', 'Miércoles'], [4, 'J', 'Jueves'], [5, 'V', 'Viernes'], [6, 'S', 'Sábado'], [7, 'D', 'Domingo']];
  var DIAS_CORTO = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  var sondeoTareas = null;

  function zonaSistema() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }
  function textoDias(dias) {
    var d = (dias || []).slice().sort().join(',');
    if (d === '1,2,3,4,5') return 'Lun a vie';
    if (d === '1,2,3,4,5,6,7') return 'Todos los días';
    if (d === '6,7') return 'Fines de semana';
    return (dias || []).slice().sort().map(function (n) { return DIAS_CORTO[n]; }).join(', ');
  }
  /* fecha corta en la zona de la tarea (si no se puede, en la del sistema) */
  function fechaCorta(iso, zona, conDia) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    var op = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    if (conDia) op.weekday = 'short';
    if (zona) op.timeZone = zona;
    try { return d.toLocaleString('es', op); } catch (e) { delete op.timeZone; return d.toLocaleString('es', op); }
  }
  function estadoEjecucion(e) {
    if (!e) return h('span.insignia', 'Todavía no corrió');
    if (e.estado === 'corriendo') return h('span.insignia.aviso', 'Corriendo…');
    return h('span.insignia' + (e.estado === 'ok' ? '.ok' : '.error'), e.estado === 'ok' ? 'Hecha' : 'Con error');
  }

  function pintarTareas(a, cuerpo, pie) {
    var cont = h('div', { style: { padding: '14px' } }, h('div.vacio', h('span.giro')));
    cuerpo.appendChild(cont);
    var id = a.id;
    function vigente() { return actual === id && pestana === 'tareas' && cont.isConnected; }
    function cargar() {
      clearTimeout(sondeoTareas);
      api.get('/api/tareas').then(function (r) {
        if (!vigente()) return;
        var mias = (r.tareas || []).filter(function (t) { return t.agente === id; });
        listar(mias);
        // mientras una corre, se vuelve a mirar cada 3 s
        if (mias.some(function (t) { return t.corriendo; })) sondeoTareas = setTimeout(function () { if (vigente()) cargar(); }, 3000);
      }).catch(function (e) { if (vigente()) App.vaciar(cont).appendChild(h('div.vacio', e.message)); });
    }
    function listar(ts) {
      App.vaciar(cont);
      if (!ts.length) {
        cont.appendChild(h('div.vacio', 'Todavía no hay tareas. Programá algo que ' + a.nombre + ' haga solo, por ejemplo un informe cada mañana.'));
      }
      ts.forEach(function (t) { cont.appendChild(tarjeta(t)); });
      cont.appendChild(h('div.ayuda', 'Las tareas corren mientras Oficina está abierta (aunque cierres la ventana). Si la app estuvo cerrada, una tarea de hoy se pone al día al abrirla, hasta 12 horas después de su hora.'));
    }
    function recargarDespues() { cargar(); if (App.Actividad) setTimeout(App.Actividad.ya, 300); }

    function tarjeta(t) {
      var sis = zonaSistema();
      var activa = t.activa !== false;
      var historial = h('div', { style: { display: 'none', marginTop: '8px' } });
      var btnHist = h('button.btn.chico.fantasma', { onclick: function () {
        var abierto = historial.style.display !== 'none';
        historial.style.display = abierto ? 'none' : 'block';
        btnHist.textContent = abierto ? 'Historial' : 'Ocultar historial';
        if (!abierto) cargarHistorial(t, historial);
      } }, 'Historial');
      var probar = h('button.btn.chico', { disabled: !!t.corriendo, onclick: function () {
        probar.disabled = true;
        api.post('/api/tareas/' + encodeURIComponent(t.id) + '/correr').then(function () {
          App.aviso('Probando «' + t.nombre + '»…');
          recargarDespues();
        }).catch(function (e) { App.fallo(e); probar.disabled = false; });
      } }, 'Probar ahora');
      var botones = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } },
        probar,
        h('button.btn.chico', { onclick: function () { hojaTarea(a, t, cargar); } }, 'Editar'),
        h('button.btn.chico', { onclick: function () {
          api.patch('/api/tareas/' + encodeURIComponent(t.id), { activa: !activa }).then(function () {
            App.aviso(activa ? 'Tarea en pausa.' : 'Tarea reanudada.');
            cargar();
          }).catch(App.fallo);
        } }, activa ? 'Pausar' : 'Reanudar'),
        h('button.btn.chico.peligro', { onclick: function () {
          App.confirmar('¿Borrar «' + t.nombre + '»?', 'Deja de correr y se borra su historial de ejecuciones. Las conversaciones que ya generó quedan en el chat de ' + a.nombre + '.', 'Borrar', true).then(function (si) {
            if (!si) return;
            api.del('/api/tareas/' + encodeURIComponent(t.id)).then(function () { App.aviso('Tarea borrada.'); cargar(); }).catch(App.fallo);
          });
        } }, 'Borrar'),
        h('span', { style: { flex: 1 } }), btnHist);
      return h('div', { style: { border: '1px solid var(--linea)', borderRadius: 'var(--radio-chico)', padding: '10px 12px', marginBottom: '10px', background: 'var(--panel)', opacity: activa ? 1 : 0.8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { style: { fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.nombre),
          activa ? null : h('span.insignia', 'En pausa'),
          estadoEjecucion(t.ultima)),
        h('div.ayuda', textoDias(t.dias) + ' · ' + t.hora + (t.zona && t.zona !== sis ? ' (' + t.zona + ')' : '')),
        h('div.ayuda', activa && t.proxima ? 'Próxima: ' + fechaCorta(t.proxima, t.zona, true)
          : (activa ? 'Sin próxima corrida' : 'No corre mientras esté en pausa')),
        t.ultima ? h('div.ayuda', 'Última: ' + fechaCorta(t.ultima.inicio, t.zona, false) + (t.ultima.manual ? ' (prueba)' : '')) : null,
        botones, historial);
    }

    function cargarHistorial(t, caja) {
      App.vaciar(caja).appendChild(h('div.vacio', { style: { padding: '12px' } }, h('span.giro')));
      api.get('/api/tareas/' + encodeURIComponent(t.id) + '/ejecuciones').then(function (r) {
        App.vaciar(caja);
        var es = r.ejecuciones || [];
        if (!es.length) { caja.appendChild(h('div.ayuda', 'Todavía no se ejecutó.')); return; }
        es.forEach(function (e) { caja.appendChild(filaEjecucion(e)); });
      }).catch(function (e) { App.vaciar(caja).appendChild(h('div.ayuda', e.message)); });
    }

    function filaEjecucion(e) {
      var texto = h('div', { style: { display: 'none', marginTop: '6px' } });
      var detalle = e.estado === 'error' ? (e.error || 'Falló.') : (e.resultado || (e.estado === 'corriendo' ? 'Todavía está corriendo…' : '(sin respuesta)'));
      App.add(texto, e.estado === 'error' ? h('div.error-txt', detalle) : App.htmlSeguro(h('div.msg.a', { style: { maxWidth: 'none' } }), App.markdown(detalle)));
      var ver = h('button.btn.chico.fantasma', { onclick: function () {
        var abierto = texto.style.display !== 'none';
        texto.style.display = abierto ? 'none' : 'block';
        ver.textContent = abierto ? 'Ver texto' : 'Ocultar';
      } }, 'Ver texto');
      var chatBtn = e.sid && e.estado !== 'corriendo' ? h('button.btn.chico.fantasma', { onclick: function () { abrirSesion(a, e.sid); } }, 'Abrir en el chat') : null;
      var costo = typeof e.costo === 'number' && e.costo > 0 ? ' · ≈ US$ ' + e.costo.toFixed(2) : '';
      return h('div', { style: { borderTop: '1px solid var(--linea)', padding: '7px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          estadoEjecucion(e),
          h('span.ayuda', { style: { margin: 0, flex: 1 } }, fechaCorta(e.inicio, null, false) + (e.manual ? ' · prueba' : '') + costo),
          ver, chatBtn),
        texto);
    }

    cargar();
    App.add(pie, h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
      h('button.btn.primario', { onclick: function () { hojaTarea(a, null, cargar); } }, 'Nueva tarea')));
  }

  /* abre la conversación de una ejecución en la pestaña de chat (se puede seguir escribiendo en esa sesión) */
  function abrirSesion(a, sid) {
    api.get('/api/historial', { agent: a.id, session: sid }).then(function (r) {
      sesiones[a.id] = sid;
      chats[a.id] = (r.msgs || []).map(function (m) { return { r: m.r, t: m.t, e: !!m.e }; });
      pestana = 'chat';
      pintar();
    }).catch(App.fallo);
  }

  /* hoja para crear (t = null) o editar una tarea */
  function hojaTarea(a, t, alGuardar) {
    var hj = App.hoja({ titulo: t ? 'Editar tarea' : 'Nueva tarea de ' + a.nombre, ancho: 540 });
    var nombre = h('input.campo', { value: t ? t.nombre : '', maxlength: 80, placeholder: 'Por ejemplo: Informe de la mañana', autofocus: true });
    var consigna = h('textarea.campo', { rows: 6, maxlength: 4000, placeholder: 'Lo que ' + a.nombre + ' tiene que hacer cada vez, como si se lo escribieras en el chat.' });
    consigna.value = t ? t.consigna : '';
    var dias = {};
    (t ? t.dias : [1, 2, 3, 4, 5]).forEach(function (n) { dias[n] = true; });
    var chips = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, DIAS.map(function (d) {
      var b = h('button.chip', { type: 'button', title: d[2], style: { width: '34px', justifyContent: 'center', padding: 0 }, onclick: function () {
        dias[d[0]] = !dias[d[0]]; pintarChip();
      } }, d[1]);
      function pintarChip() {
        b.style.background = dias[d[0]] ? 'var(--acento)' : '';
        b.style.color = dias[d[0]] ? 'var(--sobre-acento)' : '';
        b.style.borderColor = dias[d[0]] ? 'var(--acento)' : '';
        b.setAttribute('aria-pressed', dias[d[0]] ? 'true' : 'false');
      }
      pintarChip();
      return b;
    }));
    var hora = h('input.campo', { type: 'time', value: t ? t.hora : '08:00', step: 60, style: { width: '130px' } });
    var zona = h('input.campo', { value: t ? t.zona : zonaSistema(), placeholder: 'America/Argentina/Buenos_Aires', list: 'hq-zonas', autocomplete: 'off', spellcheck: 'false' });
    var lista = h('datalist', { id: 'hq-zonas' });
    try { (Intl.supportedValuesOf('timeZone') || []).forEach(function (z) { lista.appendChild(h('option', { value: z })); }); } catch (e) { /* sin lista: se escribe a mano */ }
    var activa = h('input', { type: 'checkbox', checked: t ? t.activa !== false : true });
    var err = h('div.error-txt');
    App.add(hj.cuerpo,
      h('div.fila-campo', h('label.etiqueta-campo', 'Nombre'), nombre),
      h('div.fila-campo', h('label.etiqueta-campo', 'Consigna'), consigna,
        h('div.ayuda', 'Se le pide al agente en una conversación nueva cada vez, con sus permisos de siempre.')),
      h('div.fila-campo', h('label.etiqueta-campo', 'Días'), chips),
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } },
        h('div.fila-campo', h('label.etiqueta-campo', 'Hora'), hora),
        h('div.fila-campo', { style: { flex: 1 } }, h('label.etiqueta-campo', 'Zona horaria'), zona, lista)),
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' } }, activa, 'Activa'),
      err);
    var guardar = h('button.btn.primario', { onclick: function () {
      var d = Object.keys(dias).filter(function (k) { return dias[k]; }).map(Number).sort();
      var cuerpo = { nombre: nombre.value.trim(), consigna: consigna.value.trim(), dias: d, hora: hora.value, zona: zona.value.trim() || zonaSistema(), activa: activa.checked };
      if (!cuerpo.nombre) { err.textContent = 'Poné un nombre.'; return; }
      if (!cuerpo.consigna) { err.textContent = 'Escribí la consigna.'; return; }
      if (!d.length) { err.textContent = 'Elegí al menos un día.'; return; }
      if (!/^\d\d:\d\d$/.test(cuerpo.hora)) { err.textContent = 'Elegí la hora.'; return; }
      guardar.disabled = true; err.textContent = '';
      var p = t ? api.patch('/api/tareas/' + encodeURIComponent(t.id), cuerpo) : api.post('/api/tareas', Object.assign({ agente: a.id }, cuerpo));
      p.then(function () {
        hj.cerrar();
        App.aviso(t ? 'Cambios guardados.' : 'Tarea creada.');
        alGuardar();
      }).catch(function (e) { err.textContent = e.message; guardar.disabled = false; });
    } }, t ? 'Guardar cambios' : 'Crear tarea');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
  }

  function cerrar() { if (App.modoDerecho() === 'agente') App.cerrarDerecho(); else alCerrar(); }
  function alCerrar() { actual = null; App.Oficina3D.elegir(null); App.marcarEstados(); }

  App.Agente = { abrir: abrir, cerrar: cerrar, alCerrar: alCerrar, actual: function () { return actual; } };
})();
