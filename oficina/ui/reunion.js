/* Reuniones: los agentes van a la sala, opinan por rondas desde su rol, podés intervenir y al cerrar queda un acta. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var E = App.E;
  var visto = null;         // id de la reunión que muestra el panel
  var reloj = null, vigilando = null, cerrando = false;

  /* patrones de reunión: misma lista y mismos ids que el backend (ReunionPatrones.swift / hq_reuniones.py) */
  var PATRONES = [
    { id: 'debate', nombre: 'Debate', txt: 'Hablan uno tras otro y cada uno responde a lo que se dijo antes.' },
    { id: 'lider', nombre: 'Líder y equipo', txt: 'El líder abre y encuadra, el equipo opina y el líder cierra con su posición.' },
    { id: 'mapreduce', nombre: 'Opiniones independientes', txt: 'Todos responden a la vez sin ver a los demás; después se sintetiza.' },
    { id: 'redblue', nombre: 'Dos bandos', txt: 'Un bando defiende la propuesta y el otro la critica, alternándose.' },
    { id: 'revision', nombre: 'Panel de revisión', txt: 'Cada uno revisa los documentos adjuntos desde su rol: hallazgos, riesgos y cambios.' }
  ];
  function patronDe(id) { return PATRONES.filter(function (p) { return p.id === id; })[0] || PATRONES[0]; }
  function slug(t) {
    var s = (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.length > 41 ? s.slice(0, 41).replace(/-+$/, '') : s;
  }
  function salidaSugerida(tema) {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'archivos/entregables/reuniones/' + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '-' + (slug(tema) || 'reunion') + '.md';
  }

  function activa(r) { return r && (r.estado === 'en_curso' || r.estado === 'esperando'); }

  /* ---------------- lista ---------------- */
  function abrir() {
    if (activa(E.reunion)) { panel(E.reunion.id); return; }
    var hj = App.hoja({ titulo: 'Reuniones', ancho: 560 });
    var lista = h('div.lista-reuniones', h('div.vacio', h('span.giro')));
    hj.cuerpo.appendChild(lista);
    App.add(hj.pie, h('button.btn.primario', { onclick: function () { hj.cerrar(); nueva(); } }, App.icono('mas'), 'Nueva reunión'));
    api.get('/api/reuniones').then(function (r) {
      App.vaciar(lista);
      if (!r.reuniones.length) { lista.appendChild(h('div.vacio', 'Todavía no hubo reuniones.')); return; }
      r.reuniones.forEach(function (x) {
        var est = x.estado === 'cerrada' ? h('span.insignia', 'Cerrada') : h('span.insignia.ok', x.estado === 'en_curso' ? 'En curso' : 'Esperando');
        lista.appendChild(h('div.reciente', { onclick: function () { hj.cerrar(); panel(x.id); } }, App.icono('reunion'),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 550 } }, x.tema),
            h('div.ruta', App.fecha(x.creada) + ' · ' + x.agentes.map(nombre).join(', '))), est));
      });
    }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
  }
  function nombre(id) { var a = App.agente(id); return a ? a.nombre : id; }

  /* ---------------- nueva ---------------- */
  function nueva() {
    if (activa(E.reunion)) { App.aviso('Ya hay una reunión en curso.'); panel(E.reunion.id); return; }
    var o = E.oficina;
    if (o.agentes.length < 2) { App.aviso('Para una reunión hacen falta al menos dos agentes.', true); return; }
    var hj = App.hoja({ titulo: 'Llamar a reunión', ancho: 620 });
    var tema = h('textarea.campo', { rows: 3, maxlength: 500, autofocus: true, placeholder: 'Ej.: ¿Cómo lanzamos la colección de verano? Presupuesto, canales y fechas.' });
    var elegidos = [], grilla = h('div.elegir-agentes');
    o.agentes.forEach(function (a) {
      var b = h('button.elegible', { onclick: function () {
        var i = elegidos.indexOf(a.id);
        if (i >= 0) elegidos.splice(i, 1); else if (elegidos.length < 10) elegidos.push(a.id); else App.aviso('Hasta 10 por reunión.');
        b.classList.toggle('sel', elegidos.indexOf(a.id) >= 0);
        extras();
      } }, App.retratoImg(a, 'retrato', 72), h('div', { style: { minWidth: 0 } }, h('div.persona-nombre', a.nombre), h('div.persona-rol', a.rol)));
      grilla.appendChild(b);
    });
    var rondas = h('select.campo', [1, 2, 3].map(function (n) { return h('option', { value: n, selected: n === 1 }, n === 1 ? 'Una ronda' : n + ' rondas'); }));
    var docs = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }), docsSel = [];
    var err = h('div.error-txt');
    /* patrón, líder o bandos según el patrón, y archivo de salida */
    var bando = {}, editoSalida = false;
    var patron = h('select.campo', PATRONES.map(function (p) { return h('option', { value: p.id }, p.nombre); }));
    var patronAyuda = h('div.ayuda', PATRONES[0].txt);
    var liderSel = h('select.campo'), liderFila = h('div.fila-campo.oculto', h('label.etiqueta-campo', 'Líder'), liderSel);
    var bandosCaja = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    var bandosFila = h('div.fila-campo.oculto', h('label.etiqueta-campo', 'Bandos'), bandosCaja,
      h('div.ayuda', 'A defiende la propuesta del tema; B la critica. Tiene que haber al menos uno en cada bando.'));
    var salida = h('input.campo', { type: 'text', maxlength: 200, value: salidaSugerida(''), oninput: function () { editoSalida = true; } });
    function extras() {
      var p = patron.value;
      patronAyuda.textContent = patronDe(p).txt;
      liderFila.classList.toggle('oculto', p !== 'lider');
      bandosFila.classList.toggle('oculto', p !== 'redblue');
      var previo = liderSel.value;
      App.vaciar(liderSel);
      elegidos.forEach(function (id) { liderSel.appendChild(h('option', { value: id, selected: id === previo }, nombre(id))); });
      App.vaciar(bandosCaja);
      elegidos.forEach(function (id, i) {
        if (!bando[id]) bando[id] = i % 2 === 0 ? 'a' : 'b';
        var fila = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('span', { style: { flex: 1 } }, nombre(id)));
        ['a', 'b'].forEach(function (k) {
          var bt = h('button.btn.chico' + (bando[id] === k ? '.primario' : ''), { type: 'button', onclick: function () { bando[id] = k; extras(); } }, k.toUpperCase());
          fila.appendChild(bt);
        });
        bandosCaja.appendChild(fila);
      });
    }
    patron.onchange = extras;
    tema.addEventListener('input', function () { if (!editoSalida) salida.value = salidaSugerida(tema.value); });
    App.add(hj.cuerpo, 
      h('div.fila-campo', h('label.etiqueta-campo', 'Tema'), tema),
      h('div.fila-campo', h('label.etiqueta-campo', 'Quiénes participan'), grilla),
      h('div.fila-campo', h('label.etiqueta-campo', 'Tipo de reunión'), patron, patronAyuda),
      liderFila, bandosFila,
      h('div.dos', h('div.fila-campo', h('label.etiqueta-campo', 'Rondas'), rondas, h('div.ayuda', 'En cada ronda habla cada uno una vez. Después podés pedir otra.')),
        h('div.fila-campo', h('label.etiqueta-campo', 'Documentos de la biblioteca (opcional)'), docs)),
      h('div.fila-campo', h('label.etiqueta-campo', 'Archivo de salida'), salida,
        h('div.ayuda', 'Al cerrar se guarda acá un resumen en markdown (dentro de archivos/). Si ya existe, se agrega -2, -3…')), err);
    api.get('/api/archivos').then(function (r) {
      var listos = (r.archivos || []).filter(function (f) { return f.estado === 'listo'; });
      if (!listos.length) { docs.appendChild(h('span.ayuda', 'No hay documentos listos.')); return; }
      listos.slice(0, 30).forEach(function (f) {
        var c = h('button.chip', { onclick: function () { var i = docsSel.indexOf(f.slug); if (i >= 0) docsSel.splice(i, 1); else docsSel.push(f.slug); c.style.borderColor = docsSel.indexOf(f.slug) >= 0 ? 'var(--texto)' : ''; } }, f.titulo);
        docs.appendChild(c);
      });
    }).catch(function () { docs.appendChild(h('span.ayuda', '—')); });
    var ir = h('button.btn.primario', {
      onclick: function () {
        err.textContent = '';
        if (!tema.value.trim()) { err.textContent = 'Escribí el tema.'; return; }
        if (elegidos.length < 2) { err.textContent = 'Elegí al menos dos participantes.'; return; }
        var cuerpo = { tema: tema.value.trim(), agentes: elegidos, rondas: +rondas.value, documentos: docsSel.length ? docsSel : undefined, patron: patron.value };
        if (patron.value === 'lider') {
          if (!liderSel.value) { err.textContent = 'Elegí quién lidera.'; return; }
          cuerpo.lider = liderSel.value;
        }
        if (patron.value === 'redblue') {
          var a = elegidos.filter(function (id) { return bando[id] === 'a'; }), b = elegidos.filter(function (id) { return bando[id] === 'b'; });
          if (!a.length || !b.length) { err.textContent = 'Poné al menos uno en cada bando.'; return; }
          cuerpo.bandos = { a: a, b: b };
        }
        if (patron.value === 'revision' && !docsSel.length) { err.textContent = 'El panel de revisión necesita al menos un documento.'; return; }
        if (editoSalida && salida.value.trim()) cuerpo.salida = salida.value.trim();
        ir.disabled = true;
        api.post('/api/reuniones', cuerpo)
          .then(function (r) { hj.cerrar(); E.reunion = r; sincronizar(); panel(r.id); vigilar(r.id); })
          .catch(function (e) { err.textContent = e.message; ir.disabled = false; });
      }
    }, 'Empezar reunión');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ir);
  }

  /* ---------------- seguimiento en vivo ---------------- */
  function vigilar(id) {
    vigilando = id;
    clearTimeout(reloj);
    function tic() {
      if (vigilando !== id) return;
      api.get('/api/reuniones/' + id).then(function (r) {
        if (vigilando !== id) return;
        var antes = E.reunion && E.reunion.id === id ? E.reunion : null;
        E.reunion = r;
        sincronizar();
        if (visto === id && (!antes || antes.turnos.length !== r.turnos.length || antes.hablando !== r.hablando || antes.estado !== r.estado)) pintarPanel(r);
        if (r.estado === 'en_curso') reloj = setTimeout(tic, 2000);
        else vigilando = null;
      }).catch(function () { reloj = setTimeout(tic, 5000); });
    }
    tic();
  }

  /* lleva el estado de la reunión a la maqueta, a la barra lateral y al aviso superior */
  function sincronizar() {
    var r = E.reunion, pill = App.dom && App.dom.avisoReu;
    if (activa(r)) {
      App.Oficina3D.reunion(r.agentes, r.estado === 'en_curso' ? r.hablando : null);
      App.dom.navReu.classList.remove('oculto');
      App.dom.navReu.textContent = r.estado === 'en_curso' ? 'En curso' : 'Esperando';
      if (pill) {
        App.add(App.vaciar(pill), h('span.punto', { style: { background: 'var(--ok)', borderRadius: '50%' } }),
          h('span', r.estado === 'en_curso' ? (r.hablando ? nombre(r.hablando) + ' está hablando' : 'Reunión en curso') : 'Reunión: esperándote'),
          visto === r.id && App.modoDerecho() === 'reunion' ? null : h('button.btn.chico', { onclick: function () { panel(r.id); } }, 'Ver'));
        pill.classList.remove('oculto');
      }
    } else {
      App.Oficina3D.finReunion();
      if (App.dom) { App.dom.navReu.classList.add('oculto'); if (pill) pill.classList.add('oculto'); }
    }
    App.marcarEstados();
  }

  function retomar() {
    vigilando = null; clearTimeout(reloj); E.reunion = null;
    api.get('/api/reuniones').then(function (r) {
      var x = (r.reuniones || []).filter(activa)[0];
      if (!x) { sincronizar(); return; }
      return api.get('/api/reuniones/' + x.id).then(function (d) { E.reunion = d; sincronizar(); if (d.estado === 'en_curso') vigilar(d.id); });
    }).catch(function () {});
  }

  /* ---------------- panel ---------------- */
  function panel(id) {
    visto = id;
    App.Agente.alCerrar();
    App.abrirDerecho('reunion');
    var r = E.reunion && E.reunion.id === id ? E.reunion : null;
    if (r) pintarPanel(r);
    else {
      App.vaciar(App.dom.derecho).appendChild(h('div.vacio', h('span.giro')));
      api.get('/api/reuniones/' + id).then(function (d) { if (activa(d)) { E.reunion = d; sincronizar(); if (d.estado === 'en_curso') vigilar(d.id); } pintarPanel(d); }).catch(App.fallo);
    }
    sincronizar();
  }

  function pintarPanel(r) {
    if (visto !== r.id || App.modoDerecho() !== 'reunion') return;
    if (r.estado === 'esperando' && App.Avisos) App.Avisos.vistoReunion(r.id);   // abierta = vista: se apaga «Reunión esperándote»
    var der = App.dom.derecho;
    var scrollAbajo = true;
    var viejo = der.querySelector('.der-cuerpo');
    if (viejo) scrollAbajo = viejo.scrollTop + viejo.clientHeight >= viejo.scrollHeight - 30;
    var cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var est = r.estado === 'cerrada' ? 'Cerrada' : r.estado === 'en_curso' ? 'En curso' : 'Esperando que intervengas o cierres';
    App.add(App.vaciar(der), 
      h('div.der-cab', h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '52px', height: '52px', borderRadius: '12px' } }, App.icono('reunion')),
        h('div.der-tit', h('h2', { title: r.tema }, r.tema), h('div.sub', est + ' · ' + patronDe(r.patron).nombre + ' · ' + r.agentes.map(nombre).join(', '))),
        h('button.btn.fantasma.icono', { title: 'Cerrar panel', onclick: App.cerrarDerecho }, App.icono('cerrar'))),
      cuerpo, pie);
    var t = h('div.turnos'), ronda = 0;
    r.turnos.forEach(function (x) {
      if (x.ronda !== ronda && x.agente !== 'usuario') { ronda = x.ronda; t.appendChild(h('div.ronda-sep', 'Ronda ' + ronda)); }
      var a = App.agente(x.agente), yo = x.agente === 'usuario';
      t.appendChild(h('div.turno' + (yo ? '.usuario' : ''),
        yo ? h('div.retrato', { style: { width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 } }, (E.oficina.duenio || 'Yo').slice(0, 1).toUpperCase())
          : a ? App.retratoImg(a, 'retrato', 64) : h('div.retrato'),
        h('div.turno-cuerpo', h('div.turno-quien', yo ? (E.oficina.duenio || 'Vos') : nombre(x.agente), h('small', a ? a.rol : '')),
          yo ? h('div.turno-txt', x.texto) : App.htmlSeguro(h('div.turno-txt' + (x.error ? '.error-txt' : '')), App.markdown(x.texto)))));
    });
    if (r.estado === 'en_curso' && r.hablando) {
      var ah = App.agente(r.hablando);
      t.appendChild(h('div.turno', ah ? App.retratoImg(ah, 'retrato', 64) : h('div.retrato'),
        h('div.turno-cuerpo', h('div.turno-quien', nombre(r.hablando)), h('div.escribiendo', h('span.puntos', h('i'), h('i'), h('i')), 'pensando su opinión…'))));
    }
    if (!r.turnos.length && r.estado !== 'en_curso') t.appendChild(h('div.vacio', 'Sin turnos.'));
    cuerpo.appendChild(t);
    if (r.sintesis) cuerpo.appendChild(sintesis(r));
    if (r.errorSintesis) cuerpo.appendChild(h('div.sintesis', h('div.error-txt', 'No se pudo armar el acta: ' + r.errorSintesis)));
    if (r.error) cuerpo.appendChild(h('div.sintesis', h('div.error-txt', r.error)));

    if (r.estado === 'cerrada') {
      App.add(pie, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' } },
        r.salidaRuta && App.nativo.hay ? h('button.btn', { onclick: function () { App.nativo.abrir(r.salidaRuta); } }, App.icono('abrir'), 'Abrir archivo de salida') : null,
        r.actaRuta && App.nativo.hay ? h('button.btn', { onclick: function () { App.nativo.abrir(r.actaRuta); } }, App.icono('abrir'), 'Abrir acta') : null,
        h('button.btn.primario', { onclick: function () { App.cerrarDerecho(); nueva(); } }, 'Nueva reunión')));
    } else {
      var txt = h('textarea.campo', { rows: 2, placeholder: 'Intervenir: sumá un dato o una pregunta para la próxima ronda', maxlength: 5000 });
      var ocupado = r.estado === 'en_curso' || cerrando;
      App.add(pie, txt, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' } },
        h('button.btn', { disabled: cerrando, onclick: function () {
          var v = txt.value.trim(); if (!v) { txt.focus(); return; }
          api.post('/api/reuniones/' + r.id + '/intervencion', { texto: v }).then(function (d) { E.reunion = d; pintarPanel(d); }).catch(App.fallo);
        } }, 'Intervenir'),
        h('span', { style: { flex: 1 } }),
        h('button.btn', { disabled: ocupado, onclick: function () {
          api.post('/api/reuniones/' + r.id + '/ronda').then(function (d) { E.reunion = d; sincronizar(); pintarPanel(d); vigilar(d.id); }).catch(App.fallo);
        } }, 'Otra ronda'),
        h('button.btn.primario', { disabled: ocupado, onclick: function () { cerrar(r); } }, cerrando ? [h('span.giro'), 'Armando el acta…'] : 'Cerrar y resumir')));
    }
    if (scrollAbajo) cuerpo.scrollTop = cuerpo.scrollHeight;
  }

  function sintesis(r) {
    var s = r.sintesis || {};
    return h('div.sintesis',
      h('h4', 'Resumen'), h('p', s.resumen || '—'),
      s.decisiones && s.decisiones.length ? [h('h4', 'Decisiones'), h('ul', s.decisiones.map(function (d) { return h('li', d); }))] : null,
      s.pendientes && s.pendientes.length ? [h('h4', 'Pendientes'), h('ul.pendientes', s.pendientes.map(function (p, i) {
        return h('li', h('div', h('b', p.quien + ': '), p.que), accionesPendiente(r, p, i, (r.pendientesEstado || [])[i]));
      }))] : null,
      r.acta ? h('div.ayuda', { style: { marginTop: '10px' } }, 'Acta guardada en ' + r.acta + '. Las decisiones se sumaron a la memoria de la oficina.') : null,
      r.salidaRuta ? h('div.ayuda', 'Archivo de salida: ' + r.salida) : null);
  }

  /* ---------------- pendientes que se ejecutan ---------------- */
  /* debajo de cada pendiente del acta: «Hacelo ahora» / «Convertir en tarea», o en qué quedó (trabajando, entregado, revisado) */
  function accionesPendiente(r, p, i, est) {
    if (!est) return null;
    var fila = h('div.acciones-pendiente');
    var enc = est.encargo;
    if (enc && enc.estado === 'corriendo') {
      fila.appendChild(h('span.insignia.aviso', h('span.giro'), ' Trabajando en esto…'));
      vigilarPendientes(r.id);
    } else if (enc && enc.entrega) {
      var revisada = enc.entregaEstado === 'revisada';
      fila.appendChild(h('span.insignia' + (revisada ? '.ok' : '.aviso'), revisada ? 'Entregado y revisado' : 'Entregado · sin revisar'));
      fila.appendChild(h('button.btn.chico', { onclick: function () { if (App.Entregables) App.Entregables.abrir(enc.entrega); } }, 'Ver entrega'));
    } else if (enc && enc.estado === 'error') {
      fila.appendChild(h('span.insignia.error', { title: enc.error || '' }, 'Falló'));
    }
    if (est.encargable && !(enc && enc.estado === 'corriendo')) {
      fila.appendChild(h('button.btn.chico' + (enc ? '.fantasma' : ''), { onclick: function (ev) {
        ev.currentTarget.disabled = true;
        api.post('/api/reuniones/' + r.id + '/pendientes/' + i + '/encargar').then(function (d) {
          r.pendientesEstado = d.pendientesEstado; pintarPanel(r); vigilarPendientes(r.id);
          App.aviso((App.agente(est.agente) || {}).nombre ? App.agente(est.agente).nombre + ' se puso a trabajar en eso.' : 'Encargado.');
        }).catch(function (e) { App.fallo(e); pintarPanel(r); });
      } }, enc ? 'Hacerlo de nuevo' : 'Hacelo ahora'));
      fila.appendChild(h('button.btn.chico.fantasma', { onclick: function () {
        if (!App.Agente || !App.Agente.nuevaTarea) return;
        App.Agente.nuevaTarea(est.agente, { nombre: p.que.length > 80 ? p.que.slice(0, 79) + '…' : p.que,
          consigna: 'Pendiente de la reunión «' + r.tema + '»' + (r.acta ? ' (acta: ' + r.acta + ')' : '') + ': ' + p.que,
          origen: { reunion: r.id, pendiente: i }, unica: true }, function () { refrescar(r.id); });
      } }, 'Convertir en tarea'));
    } else if (!est.agente) {
      fila.appendChild(h('span.ayuda', { style: { margin: 0 } }, 'Te toca a vos.'));
    } else if (!est.encargable && !enc) {
      fila.appendChild(h('span.ayuda', { style: { margin: 0 } }, 'Necesita tu parte: ' + ((App.agente(est.agente) || {}).nombre || 'el agente') + ' no lo puede hacer solo.'));
    }
    (est.tareas || []).forEach(function (t) { fila.appendChild(h('span.insignia', { title: 'Tarea programada que salió de este pendiente' }, 'Tarea: ' + t.nombre)); });
    return fila.childNodes.length ? fila : null;
  }

  function refrescar(id) {
    return api.get('/api/reuniones/' + id).then(function (d) { if (visto === id) pintarPanel(d); return d; });
  }

  /* mientras haya un encargo corriendo y el panel muestre esta reunión, se vuelve a leer cada 3 s */
  var relojPend = null;
  function vigilarPendientes(id) {
    clearTimeout(relojPend);
    relojPend = setTimeout(function () {
      if (visto !== id) return;
      refrescar(id).then(function (d) {
        if ((d.pendientesEstado || []).some(function (e) { return e.encargo && e.encargo.estado === 'corriendo'; })) vigilarPendientes(id);
      }).catch(function () { /* se reintenta al volver a abrir */ });
    }, 3000);
  }

  function cerrar(r) {
    cerrando = true; pintarPanel(r);
    api.post('/api/reuniones/' + r.id + '/cerrar').then(function (d) {
      cerrando = false; E.reunion = d; vigilando = null;
      sincronizar(); pintarPanel(d);
      App.aviso('Reunión cerrada. El acta quedó guardada.');
    }).catch(function (e) { cerrando = false; App.fallo(e); pintarPanel(E.reunion || r); });
  }

  App.Reunion = {
    abrir: abrir, nueva: nueva, retomar: retomar, ver: panel,
    abierta: function () { return App.modoDerecho && App.modoDerecho() === 'reunion' ? visto : null; },
    alCerrarPanel: function () { visto = null; sincronizar(); }
  };
})();
