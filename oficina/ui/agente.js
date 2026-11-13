/* Panel del agente (a la derecha, sin tapar la maqueta): conversación, perfil y notas. */
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
    App.marcarEstados();
  }

  function pintar() {
    var a = App.agente(actual); if (!a) { cerrar(); return; }
    var d = App.depto(a.departamento);
    var cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var tabs = h('div.pestanas', [['chat', 'Conversación'], ['perfil', 'Perfil'], ['notas', 'Notas']].map(function (p) {
      return h('button.pestana' + (pestana === p[0] ? '.activa' : ''), { onclick: function () { pestana = p[0]; pintar(); } }, p[1]);
    }));
    App.add(App.vaciar(App.dom.derecho), 
      h('div.der-cab', App.retratoImg(a, 'retrato', 120), h('div.der-tit', h('h2', a.nombre),
        h('div.sub', a.rol, d ? h('span.insignia', h('span.punto', { style: { background: d.color, marginRight: '5px' } }), d.nombre) : null)),
        h('button.btn.fantasma.icono', { title: 'Cerrar', onclick: App.cerrarDerecho }, App.icono('cerrar'))),
      tabs, cuerpo, pie);
    if (pestana === 'chat') pintarChat(a, cuerpo, pie);
    else if (pestana === 'perfil') pintarPerfil(a, cuerpo, pie);
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
      var id = a.id;
      api.post('/api/chat', { agent: id, message: t, session: sesiones[id] }).then(function (r) {
        (chats[id] = chats[id] || []).push({ r: 'a', t: r.reply || '(sin respuesta)' });
      }).catch(function (e) {
        (chats[id] = chats[id] || []).push({ r: 'a', t: 'No pude responder: ' + e.message, e: true });
      }).then(function () {
        ocupado(id, false);
        if (actual === id && pestana === 'chat') pintar();
        else App.aviso(App.agente(id) ? App.agente(id).nombre + ' te respondió.' : 'Llegó una respuesta.');
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

  function cerrar() { if (App.modoDerecho() === 'agente') App.cerrarDerecho(); else alCerrar(); }
  function alCerrar() { actual = null; App.Oficina3D.elegir(null); App.marcarEstados(); }

  App.Agente = { abrir: abrir, cerrar: cerrar, alCerrar: alCerrar, actual: function () { return actual; } };
})();
