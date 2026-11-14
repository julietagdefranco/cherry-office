/* Entregables (docs/plan-entregables.md, E2): lo que los agentes terminaron y te falta revisar.
   Panel derecho con la lista (filtro «sin revisar» por defecto, por agente y por origen) y el detalle de cada entrega
   (texto, archivos, «Listo», «Pedir cambios», «Abrir en el chat»). El contador llega con /api/actividad y se reparte a la
   barra lateral, al muro 3D, al Dock (junto con los avisos) y a la tecla N. Abrir una entrega NO la marca revisada. */
window.App = window.App || {};
App.Entregables = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var api = function () { return App.api; };
  var sinRevisar = 0, ultimas = [], firma = null;
  var filtro = { estado: 'sin_revisar', agente: '', origen: '' };
  var abierta = null;          // id de la entrega que muestra el panel (null = lista)
  var ORIGEN = { tarea: 'Tarea programada', encargo: 'Pendiente de reunión', reunion: 'Acta de reunión', chat: 'Chat', cambios: 'Con cambios',
    flujo: 'Paso de un flujo', persona: 'Hecho por vos', propuesta: 'Propuesta', accion: 'Acción aprobada', parte: 'Parte del día' };
  var ESTADO = { sin_revisar: 'Sin revisar', revisada: 'Revisada', cambios: 'Reemplazada' };

  /* quién la hizo: en una entrega tuya (paso de persona) no hay agente */
  function nombreDe(e) { return e.origen === 'persona' && !e.agente ? 'Vos' : nombre(e.agente); }
  function nombre(id) { var a = id && App.agente(id); return a ? a.nombre : (id ? id : 'Reunión'); }
  function hace(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
    return 'hace ' + Math.round(s / 86400) + ' d';
  }
  function abiertoPanel() { return App.modoDerecho && App.modoDerecho() === 'entregables'; }

  /* ---------------- contador (con cada /api/actividad) ---------------- */
  function alActividad(r) {
    var n = r.entregasSinRevisar | 0;
    if (n === sinRevisar && firma !== null) return;
    sinRevisar = n;
    refrescarUltimas();
    if (abiertoPanel() && abierta === null) pintarLista();
  }

  function refrescarUltimas() {
    return api().get('/api/entregas', { limite: 8 }).then(function (r) {
      ultimas = r.entregas || []; sinRevisar = r.sinRevisar | 0;
      firma = JSON.stringify(ultimas.map(function (e) { return e.id + e.estado; })) + sinRevisar;
      pintarContador();
    }).catch(function () { /* se reintenta con la próxima actividad */ });
  }

  function pintarContador() {
    var b = App.dom && App.dom.navEnt;
    if (b) { b.textContent = sinRevisar; b.classList.toggle('oculto', !sinRevisar); }
    if (App.Oficina3D && App.Oficina3D.muro) App.Oficina3D.muro(ultimas, sinRevisar);
    if (App.Avisos && App.Avisos.insignia) App.Avisos.insignia();
  }

  /* ---------------- panel: lista ---------------- */
  function abrir(id) {
    if (App.Agente && App.Agente.alCerrar) App.Agente.alCerrar();
    App.abrirDerecho('entregables');
    if (id) verEntrega(+id); else { abierta = null; pintarLista(); }
  }

  function cabecera(titulo, sub, extra) {
    return h('div.der-cab',
      h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '52px', height: '52px', borderRadius: '12px' } }, App.icono('libro')),
      h('div.der-tit', h('h2', { title: titulo }, titulo), sub ? h('div.sub', sub) : null),
      extra || null,
      h('button.btn.fantasma.icono', { title: 'Cerrar panel', onclick: App.cerrarDerecho }, App.icono('cerrar')));
  }

  function pintarLista() {
    if (!abiertoPanel()) return;
    abierta = null;
    var der = App.dom.derecho, cuerpo = h('div.der-cuerpo'), lista = h('div.entregas', h('div.vacio', h('span.giro')));
    var o = App.E.oficina || { agentes: [] };
    function chip(est, txt) {
      return h('button.chip' + (filtro.estado === est ? '.sel' : ''), { onclick: function () { filtro.estado = est; pintarLista(); } }, txt);
    }
    var selAg = h('select.campo.chico', { onchange: function () { filtro.agente = selAg.value; pintarLista(); } },
      [h('option', { value: '' }, 'Todos'), h('option', { value: '__reunion' }, 'Actas de reunión')]
        .concat(o.agentes.map(function (a) { return h('option', { value: a.id }, a.nombre); })));
    selAg.value = filtro.agente;
    var selOr = h('select.campo.chico', { onchange: function () { filtro.origen = selOr.value; pintarLista(); } },
      [h('option', { value: '' }, 'Cualquier origen')].concat(Object.keys(ORIGEN).map(function (k) { return h('option', { value: k }, ORIGEN[k]); })));
    selOr.value = filtro.origen;
    App.add(App.vaciar(der),
      cabecera('Entregables', sinRevisar ? (sinRevisar === 1 ? '1 sin revisar' : sinRevisar + ' sin revisar') : 'Todo revisado'),
      cuerpo);
    App.add(cuerpo,
      h('div.entregas-filtros', chip('sin_revisar', 'Sin revisar' + (sinRevisar ? ' (' + sinRevisar + ')' : '')), chip('', 'Todas'), selAg, selOr),
      lista);
    var q = { limite: 100 };
    if (filtro.estado) q.estado = filtro.estado;
    if (filtro.origen) q.origen = filtro.origen;
    if (filtro.agente && filtro.agente !== '__reunion') q.agente = filtro.agente;
    api().get('/api/entregas', q).then(function (r) {
      App.vaciar(lista);
      var es = (r.entregas || []).filter(function (e) { return filtro.agente !== '__reunion' || !e.agente; });
      if (!es.length) {
        lista.appendChild(h('div.vacio', filtro.estado === 'sin_revisar'
          ? 'No tenés nada para revisar. Cuando un agente termine una tarea o un encargo, aparece acá.'
          : 'Todavía no hay entregas con ese filtro.'));
        return;
      }
      es.forEach(function (e) { lista.appendChild(fila(e)); });
    }).catch(function (e) { App.vaciar(lista).appendChild(h('div.error-txt', e.message)); });
  }

  function marcaAgente(e) {
    var a = e.agente && App.agente(e.agente), d = a && App.depto(a.departamento);
    if (!a && (e.origen === 'persona' || e.origen === 'propuesta' || e.origen === 'accion' || e.origen === 'parte' || e.origen === 'flujo')) {
      return h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel-2)', color: 'var(--suave)', border: '1px solid var(--linea)' } }, App.icono(e.origen === 'flujo' ? 'flujo' : 'libro'));
    }
    return a ? App.retratoImg(a, 'retrato', 64) : h('div.retrato', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: d ? d.color : '#0a5fb4' } }, App.icono('reunion'));
  }

  function fila(e) {
    var est = e.estado === 'sin_revisar' ? h('span.insignia.aviso', 'Sin revisar') : e.estado === 'revisada' ? h('span.insignia.ok', 'Revisada') : h('span.insignia', 'Reemplazada');
    return h('button.entrega-fila' + (e.estado === 'sin_revisar' ? '.nueva' : ''), { onclick: function () { verEntrega(e.id); } },
      marcaAgente(e),
      h('div.entrega-txt',
        h('div.entrega-tit', e.titulo),
        h('div.entrega-sub', nombreDe(e) + ' · ' + (ORIGEN[e.origen] || e.origen) + ' · ' + hace(e.creada) +
          (e.archivos && e.archivos.length ? ' · ' + e.archivos.length + (e.archivos.length === 1 ? ' archivo' : ' archivos') : '')),
        e.resumen ? h('div.entrega-res', e.resumen) : null),
      est);
  }

  /* ---------------- panel: detalle ---------------- */
  function verEntrega(id) {
    abierta = id;
    if (!abiertoPanel()) App.abrirDerecho('entregables');
    var der = App.dom.derecho;
    App.vaciar(der).appendChild(h('div.vacio', h('span.giro')));
    api().get('/api/entregas/' + id).then(function (r) { if (abierta === id) pintarDetalle(r.entrega); })
      .catch(function (e) { App.fallo(e); pintarLista(); });
  }

  function linkOrigen(e) {
    var reu = e.origen === 'reunion' ? e.ref : (e.origen === 'encargo' ? (e.ref.split(':')[1] || '') : '');
    if (reu && App.Reunion && App.Reunion.ver) return h('button.btn.chico.fantasma', { onclick: function () { App.Reunion.ver(reu); } }, App.icono('reunion'), 'Ver la reunión');
    if (e.origen === 'tarea' && e.agente) return h('button.btn.chico.fantasma', { onclick: function () { App.Agente.abrir(e.agente, 'tareas'); } }, 'Ver la tarea');
    return null;
  }

  function abrirArchivo(rel) {
    if (App.nativo.hay && App.E.carpeta) { App.nativo.abrir(App.E.carpeta.replace(/\/$/, '') + '/' + rel); return; }
    api().get('/api/oficina/archivo', { ruta: rel }).then(App.abrirContenido).catch(App.fallo);
  }

  function pintarDetalle(e) {
    if (!abiertoPanel() || abierta !== e.id) return;
    var der = App.dom.derecho, cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var bloqueAccion = h('div');
    var volver = h('button.btn.fantasma.icono', { title: 'Volver a la lista', onclick: function () { pintarLista(); } }, '←');
    var sub = nombreDe(e) + ' · ' + (ORIGEN[e.origen] || e.origen) + ' · ' + hace(e.creada) + (typeof e.costo === 'number' && e.costo > 0 ? ' · ≈ US$ ' + e.costo.toFixed(2) : '');
    App.add(App.vaciar(der), cabecera(e.titulo, sub, volver), cuerpo, pie);
    var est = e.estado === 'sin_revisar' ? h('span.insignia.aviso', 'Sin revisar') : e.estado === 'revisada' ? h('span.insignia.ok', 'Revisada') : h('span.insignia', 'Reemplazada por una versión nueva');
    var meta = h('div.entrega-meta', est, e.padre ? h('span.insignia', 'Versión con cambios') : null, linkOrigen(e));
    App.add(cuerpo, meta, bloqueAccion);
    if (e.enCambios) {
      App.add(cuerpo, h('div.entrega-meta', h('span.insignia.aviso', h('span.giro'), ' ' + nombre(e.agente) + ' está haciendo los cambios…')));
      vigilarCambios(e.id);
    }
    if (e.archivos && e.archivos.length) {
      App.add(cuerpo, h('div.entrega-archivos', h('div.etiqueta-campo', 'Archivos'), e.archivos.map(function (rel) {
        return h('button.archivo-fila', { onclick: function () { abrirArchivo(rel); }, title: rel }, App.icono('abrir'), h('span', rel));
      })));
    }
    App.add(cuerpo, App.htmlSeguro(h('div.msg.a.entrega-texto', { style: { maxWidth: 'none' } }), App.markdown(e.texto || '(sin texto)')));
    /* flujo y acción llegan aparte: hasta entonces el pie queda vacío, para no ofrecer «Listo» sobre una propuesta sin resolver */
    var extra = { corrida: null, accion: null };
    Promise.all([
      api().get('/api/flujos/corridas', { entrega: e.id, estado: 'todas' }).then(function (r) { return (r.corridas || [])[0] || null; }).catch(function () { return null; }),
      api().get('/api/acciones', { entrega: e.id }).then(function (r) { return r.accion || null; }).catch(function () { return null; })
    ]).then(function (r) {
      if (!abiertoPanel() || abierta !== e.id) return;
      extra.corrida = r[0]; extra.accion = r[1];
      if (extra.corrida) {
        var c = extra.corrida;
        meta.appendChild(h('button.insignia.info.insignia-link', { title: 'Ver el flujo', onclick: function () { if (App.Flujos && App.Flujos.verCorrida) App.Flujos.verCorrida(c.id); } },
          App.icono('flujo'), 'Flujo · ' + (c.pasoNombre || ('paso ' + (c.paso + 1)))));
      }
      pintarAccion(e, extra.accion, bloqueAccion);
      pintarPie(e, extra, pie);
      if (extra.accion && extra.accion.estado === 'ejecutando') vigilarAccion(e.id);
    });
  }

  /* ---------------- acción hacia afuera (plan §8) ---------------- */
  var TEXTO_ACCION = { send_message: 'Mandar el mail', create_event: 'Crear el evento' };
  function cortoHerramienta(h2) { return String(h2 || '').replace(/^mcp__.*__/, ''); }
  function textoAprobar(ac) { return TEXTO_ACCION[cortoHerramienta(ac.herramienta)] || 'Aprobar y ejecutar'; }

  function pintarAccion(e, ac, caja) {
    App.vaciar(caja);
    if (!ac) return;
    var estado = {
      pendiente: h('span.insignia.aviso', 'Esperando tu aprobación'),
      ejecutando: h('span.insignia.aviso', h('span.giro'), ' Ejecutando…'),
      hecha: h('span.insignia.ok', 'Hecha'),
      error: h('span.insignia.error', 'Con error'),
      descartada: h('span.insignia', 'Descartada')
    }[ac.estado] || h('span.insignia', ac.estado);
    var detalle = ac.detalle && Object.keys(ac.detalle).length ? JSON.stringify(ac.detalle, null, 2) : '';
    App.add(caja, h('div.entrega-accion',
      h('h4', 'Acción propuesta'),
      h('div.acc-res', ac.resumen),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span.insignia', { title: ac.herramienta }, cortoHerramienta(ac.herramienta)), estado),
      detalle ? h('pre', detalle) : null,
      ac.resultado && ac.estado !== 'pendiente' ? App.htmlSeguro(h('div.msg.a', { style: { maxWidth: 'none', marginTop: '8px' } }), App.markdown(ac.resultado)) : null));
  }

  function vigilarAccion(id) {
    clearTimeout(relojAccion);
    relojAccion = setTimeout(function () {
      if (abierta !== id || !abiertoPanel()) return;
      api().get('/api/acciones', { entrega: id }).then(function (r) {
        if (r.accion && r.accion.estado === 'ejecutando') vigilarAccion(id);
        else { refrescarUltimas(); verEntrega(id); }
      }).catch(function () { vigilarAccion(id); });
    }, 3000);
  }
  var relojAccion = null;

  function pintarPie(e, extra, pie) {
    var ac = extra.accion, pendiente = !!(ac && ac.estado === 'pendiente');
    var pasoAprobacion = !!(extra.corrida && extra.corrida.pasoEstado === 'esperando_aprobacion' && extra.corrida.entrega === e.id);
    var botones = [];
    if (e.sid && e.agente && App.Agente.abrirSesion) botones.push(h('button.btn', { onclick: function () { App.Agente.abrirSesion(e.agente, e.sid); } }, 'Abrir en el chat'));
    if (e.estado !== 'cambios' && e.sid && e.agente && !e.enCambios && !pendiente) botones.push(h('button.btn', { onclick: function () { pedirCambios(e); } }, 'Pedir cambios'));
    botones.push(h('span', { style: { flex: 1 } }));
    if (e.enCambios) {
      // mientras trabaja no se marca: la versión nueva llega como otra entrega
    } else if (pendiente) {
      var ok = h('button.btn.primario', { onclick: function () {
        ok.disabled = true;
        api().post('/api/entregas/' + e.id + '/ejecutar').then(function () {
          App.aviso('Aprobado: ya se está ejecutando.');
          refrescarUltimas(); if (App.Actividad) App.Actividad.ya();
          verEntrega(e.id);
        }).catch(function (x) { App.fallo(x); ok.disabled = false; });
      } }, textoAprobar(ac));
      botones.push(h('button.btn', { onclick: function () {
        api().post('/api/entregas/' + e.id + '/descartar-accion').then(function () {
          App.aviso('Acción descartada.');
          refrescarUltimas(); verEntrega(e.id);
        }).catch(App.fallo);
      } }, 'Descartar'), ok);
    } else if (e.estado === 'sin_revisar' && !(ac && ac.estado === 'ejecutando')) {
      botones.push(h('button.btn.primario', { onclick: function () { marcar(e, 'revisada', pasoAprobacion); } }, pasoAprobacion ? 'Listo, seguí' : 'Listo'));
    } else if (e.estado === 'revisada') {
      botones.push(h('button.btn.fantasma', { onclick: function () { marcar(e, 'sin-revisar'); } }, 'Marcar sin revisar'));
    }
    App.add(App.vaciar(pie), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, botones));
  }

  /* ---------------- pedir cambios (E4) ---------------- */
  function pedirCambios(e) {
    var hj = App.hoja({ titulo: 'Pedir cambios a ' + nombre(e.agente), ancho: 520 });
    var txt = h('textarea.campo', { rows: 6, maxlength: 4000, autofocus: true, placeholder: 'Qué querés que cambie. Por ejemplo: más corto, con una tabla al final, sin el punto 3.' });
    var err = h('div.error-txt');
    App.add(hj.cuerpo, h('div.fila-campo', h('label.etiqueta-campo', '«' + e.titulo + '»'), txt,
      h('div.ayuda', 'Se lo pide en la misma conversación. La versión nueva aparece como otra entrega sin revisar y esta queda reemplazada.')), err);
    var ok = h('button.btn.primario', { onclick: function () {
      var v = txt.value.trim(); if (!v) { err.textContent = 'Escribí qué querés que cambie.'; txt.focus(); return; }
      ok.disabled = true; err.textContent = '';
      api().post('/api/entregas/' + e.id + '/cambios', { texto: v }).then(function () {
        hj.cerrar();
        App.aviso(nombre(e.agente) + ' se puso a hacer los cambios.');
        if (App.Actividad) App.Actividad.ya();
        verEntrega(e.id);
      }).catch(function (x) { err.textContent = x.message; ok.disabled = false; });
    } }, 'Pedir cambios');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok);
  }

  /* mientras el agente hace los cambios, se vuelve a leer la entrega cada 3 s; al terminar se muestra la versión nueva */
  var relojCambios = null;
  function vigilarCambios(id) {
    clearTimeout(relojCambios);
    relojCambios = setTimeout(function () {
      if (abierta !== id || !abiertoPanel()) return;
      api().get('/api/entregas/' + id).then(function (r) {
        var e = r.entrega;
        if (e.enCambios) { vigilarCambios(id); return; }
        if (e.estado === 'cambios') {
          return api().get('/api/entregas', { limite: 20 }).then(function (l) {
            var hija = (l.entregas || []).filter(function (x) { return x.padre === id; })[0];
            refrescarUltimas();
            if (hija) verEntrega(hija.id); else pintarDetalle(e);
          });
        }
        pintarDetalle(e);   // falló: queda como estaba (el error llega como aviso)
      }).catch(function () { vigilarCambios(id); });
    }, 3000);
  }

  function marcar(e, como, sigueFlujo) {
    api().post('/api/entregas/' + e.id + '/' + como).then(function (r) {
      sinRevisar = r.sinRevisar | 0;
      refrescarUltimas();
      if (como === 'revisada') {
        App.aviso(sigueFlujo ? 'Listo: el flujo sigue.' : 'Marcada como revisada.');
        siguienteOLista(e.id);
      } else verEntrega(e.id);
    }).catch(App.fallo);
  }

  /* después de «Listo»: la próxima sin revisar, o la lista si no queda ninguna */
  function siguienteOLista(actual) {
    api().get('/api/entregas', { estado: 'sin_revisar', limite: 1 }).then(function (r) {
      var sig = (r.entregas || [])[0];
      if (sig && sig.id !== actual) verEntrega(sig.id); else pintarLista();
    }).catch(function () { pintarLista(); });
  }

  /* tecla N sin avisos: la próxima entrega sin revisar */
  function siguiente() {
    if (!sinRevisar) return false;
    api().get('/api/entregas', { estado: 'sin_revisar', limite: 1 }).then(function (r) {
      var e = (r.entregas || [])[0]; if (e) abrir(e.id);
    }).catch(App.fallo);
    if (App.Oficina3D && App.Oficina3D.enfocarLugar) App.Oficina3D.enfocarLugar('entregables');
    return true;
  }

  if (App.on) App.on('actividad', alActividad);

  return {
    abrir: abrir, siguiente: siguiente,
    sinRevisar: function () { return sinRevisar; },
    refrescar: refrescarUltimas,
    alCerrarPanel: function () { abierta = null; clearTimeout(relojAccion); },
    _verEntrega: verEntrega
  };
})();
