/* Parte del día (docs/plan-creador-flujos.md §10 y §12): panel derecho en modo «parte».
   Secciones: te necesita, para revisar, flujos en curso, qué pasó, bloqueos y próximas tareas. Arriba, el parte narrado por el
   coordinador si existe; si no, un botón para pedírselo. El pie «Listo, ya lo vi» marca el parte como visto. */
window.App = window.App || {};
App.Parte = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var api = function () { return App.api; };
  var pedido = 0;          // para descartar respuestas viejas
  var reloj = null;        // sondeo mientras el coordinador redacta
  var redactando = false;
  var intentos = 0;

  function abiertoPanel() { return App.modoDerecho && App.modoDerecho() === 'parte'; }
  function coordinador() {
    var o = App.E.oficina || { agentes: [] };
    return o.agentes.filter(function (a) { return (a.permisos || []).indexOf('coordinador') >= 0; })[0] || null;
  }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }
  function diasTxt(d) {
    if (d < 1) return Math.max(1, Math.round(d * 24)) + ' h';
    var n = Math.round(d * 10) / 10;
    return (n % 1 ? n.toFixed(1).replace('.', ',') : String(n)) + (n === 1 ? ' día' : ' días');
  }

  function abrir() {
    if (App.Agente && App.Agente.alCerrar) App.Agente.alCerrar();
    App.abrirDerecho('parte');
    cargar(true);
  }

  function cerrarPanel() { clearTimeout(reloj); reloj = null; redactando = false; intentos = 0; pedido++; }

  function cabecera(sub) {
    return h('div.der-cab',
      h('div.retrato.parte-ico', { style: { width: '52px', height: '52px', borderRadius: '12px' } }, App.icono('parte')),
      h('div.der-tit', h('h2', 'Parte del día'), sub ? h('div.sub', sub) : null),
      h('button.btn.fantasma.icono', { title: 'Cerrar panel', onclick: App.cerrarDerecho }, App.icono('cerrar')));
  }

  function cargar(conGiro) {
    if (!abiertoPanel()) return;
    var n = ++pedido, der = App.dom.derecho;
    if (conGiro) App.add(App.vaciar(der), cabecera(''), h('div.der-cuerpo', h('div.vacio', h('span.giro'))));
    api().get('/api/parte').then(function (p) {
      if (n === pedido && abiertoPanel()) pintar(p);
    }).catch(function (e) {
      if (n !== pedido || !abiertoPanel()) return;
      App.add(App.vaciar(der), cabecera(''), h('div.der-cuerpo', h('div.vacio', e.message)));
    });
  }

  /* ---------------- piezas ---------------- */
  function seccion(titulo, hijos) {
    return h('div.det-sec.parte-sec', h('h4', titulo), hijos);
  }

  function quienMarca(id) {
    var a = id && id !== 'persona' && App.agente(id);
    if (a) return App.retratoImg(a, 'retrato', 64);
    return h('div.retrato.parte-vos', 'Vos');
  }
  function quienNombre(id) {
    if (!id || id === 'persona') return 'Vos';
    var a = App.agente(id); return a ? a.nombre : id;
  }

  function filaAviso(a) {
    var ag = a.agente && App.agente(a.agente);
    var marca = ag ? App.retratoImg(ag, 'retrato', 64) : h('div.retrato.parte-ico', App.icono(a.tipo === 'flujo' ? 'flujo' : 'parte'));
    return h('button.parte-fila', { onclick: function () { abrirAviso(a); } }, marca,
      h('div.parte-txt', h('div.parte-tit', a.texto), a.creado ? h('div.parte-sub', App.hace(a.creado)) : null));
  }
  function abrirAviso(a) {
    /* App.Avisos.abrir ya manda los de flujo a App.Flujos.verCorrida y los marca vistos sin desincronizar el banner */
    if (App.Avisos) App.Avisos.abrir(a.id);
    else if (a.tipo === 'flujo' && App.Flujos && App.Flujos.verCorrida) App.Flujos.verCorrida(a.ref);
  }

  function filaEntrega(e) {
    var ag = e.agente && App.agente(e.agente);
    return h('button.parte-fila', { onclick: function () { App.Entregables.abrir(e.id); } },
      ag ? App.retratoImg(ag, 'retrato', 64) : h('div.retrato.parte-ico', App.icono('libro')),
      h('div.parte-txt', h('div.parte-tit', e.titulo), h('div.parte-sub', (ag ? ag.nombre + ' · ' : '') + App.hace(e.creada))));
  }

  function filaFlujo(f) {
    var trabado = f.dias > 1;
    return h('button.parte-fila', { onclick: function () { if (App.Flujos && App.Flujos.verCorrida) App.Flujos.verCorrida(f.corrida); } },
      quienMarca(f.quien),
      h('div.parte-txt',
        h('div.parte-tit', f.nombre || f.flujoNombre),
        h('div.parte-sub', (f.flujoNombre ? f.flujoNombre + ' · ' : '') + 'paso ' + (f.paso + 1) + (f.pasoNombre ? ': ' + f.pasoNombre : '') + ' · ' + quienNombre(f.quien))),
      trabado ? h('span.insignia.aviso', 'trabado hace ' + diasTxt(f.dias)) : null);
  }

  /* la espera con la v1 que la dejó esperando: abre esa entrega, o la reunión si el pendiente es de una reunión */
  function abrirEspera(x) {
    if (!x) return;
    if (x.reunion && App.Reunion && App.Reunion.ver) App.Reunion.ver(x.reunion);
    else if (x.entregaParcial) App.Entregables.abrir(x.entregaParcial);
    else if (App.agente(x.agente)) App.Agente.abrir(x.agente, 'chat');
  }
  /* desde un aviso o un bloqueo que solo trae el id de la espera */
  function abrirEsperaPorId(id) {
    return api().get('/api/esperas', { estado: 'todas' }).then(function (r) {
      abrirEspera((r.esperas || []).filter(function (x) { return String(x.id) === String(id); })[0]);
    }).catch(App.fallo);
  }

  function filaEspera(x) {
    var ag = App.agente(x.agente);
    var estado = x.estado === 'lista' ? 'ya llegó, falta relanzar' : x.estado === 'relanzada' ? 'haciendo la versión completa' : (x.vencida ? 'vencida hace ' + diasTxt(x.dias) : 'hace ' + diasTxt(x.dias));
    return h('button.parte-fila', { onclick: function () { abrirEspera(x); } },
      ag ? App.retratoImg(ag, 'retrato', 64) : h('div.retrato.parte-ico', App.icono('reloj')),
      h('div.parte-txt', h('div.parte-tit', x.agenteNombre + ' espera a ' + x.esperaANombre), h('div.parte-sub', x.que + ' · ' + estado)));
  }

  function filaBloqueo(b, esperas) {
    var abre = b.tipo === 'espera' ? function () { var x = (esperas || {})[b.ref]; if (x) abrirEspera(x); else abrirEsperaPorId(b.ref); }
      : b.tipo === 'corrida' ? function () { if (App.Flujos && App.Flujos.verCorrida) App.Flujos.verCorrida(+b.ref); }
      : b.tipo === 'entrega' ? function () { App.Entregables.abrir(+b.ref); }
      : b.tipo === 'tarea' ? function () { var t = b.ref && b.ref.split(':')[0]; if (App.agente(t)) App.Agente.abrir(t, 'tareas'); } : null;
    return h('button.parte-fila' + (abre ? '' : '.quieta'), { onclick: abre || null },
      h('div.retrato.parte-ico.aviso', App.icono(b.tipo === 'corrida' ? 'flujo' : b.tipo === 'espera' ? 'reloj' : 'cerrar')),
      h('div.parte-txt', h('div.parte-tit', b.texto)),
      typeof b.dias === 'number' ? h('span.insignia.aviso', diasTxt(b.dias)) : null);
  }

  function filaProxima(t) {
    var ag = App.agente(t.agente);
    return h('button.parte-fila', { onclick: function () { if (ag) App.Agente.abrir(t.agente, 'tareas'); } },
      ag ? App.retratoImg(ag, 'retrato', 64) : h('div.retrato.parte-ico', App.icono('parte')),
      h('div.parte-txt', h('div.parte-tit', t.nombre || t.tarea), h('div.parte-sub', (ag ? ag.nombre + ' · ' : '') + cuando(t.cuando))));
  }
  function cuando(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function quePaso(p) {
    var l = [];
    if (p.entregas) l.push(plural(p.entregas, 'entrega nueva', 'entregas nuevas'));
    if (p.pasosTerminados) l.push(plural(p.pasosTerminados, 'paso de flujo terminado', 'pasos de flujo terminados'));
    if (p.ejecucionesOk) l.push(plural(p.ejecucionesOk, 'tarea hecha', 'tareas hechas'));
    if (p.ejecucionesError) l.push(plural(p.ejecucionesError, 'tarea con error', 'tareas con error'));
    if (p.reunionesCerradas) l.push(plural(p.reunionesCerradas, 'reunión cerrada', 'reuniones cerradas'));
    if (!l.length) return null;
    var out = [h('ul.parte-lista', l.map(function (x) { return h('li', x); }))];
    if (typeof p.costo === 'number' && p.costo > 0) out.push(h('div.ayuda', '≈ US$ ' + p.costo.toFixed(2) + ' en total'));
    return out;
  }

  /* ---------------- panel ---------------- */
  function pintar(p) {
    var der = App.dom.derecho, cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var necesita = p.teNecesita || [], rev = p.paraRevisar || { total: 0, entregas: [] }, flujos = p.flujos || [],
        bloq = p.bloqueos || [], esperas = p.esperas || [], prox = p.proximas || [], narrado = p.narrado && p.narrado.texto ? p.narrado : null;
    var entregas = (rev.entregas || []).slice(0, 5);
    var vacio = !necesita.length && !entregas.length && !flujos.length && !esperas.length && !bloq.length && !prox.length && !narrado;
    var desde = p.desde ? App.hace(p.desde) : '';
    App.add(App.vaciar(der), cabecera(desde ? (desde === 'recién' ? 'Desde recién' : 'Desde ' + desde) : ''), cuerpo, pie);

    var coord = coordinador();
    if (narrado) {
      App.add(cuerpo, h('div.parte-narrado', App.htmlSeguro(h('div.msg.a', { style: { maxWidth: 'none' } }), App.markdown(narrado.texto))));
    } else if (coord) {
      var btn = h('button.btn', { disabled: redactando, onclick: function () { redactar(coord, btn); } },
        redactando ? [h('span.giro'), coord.nombre + ' está redactando…'] : 'Pedile el parte a ' + coord.nombre);
      App.add(cuerpo, h('div.parte-pedir', btn));
      if (redactando) vigilar();
    }

    if (vacio) {
      App.add(cuerpo, h('div.vacio', 'Todo en orden: no hay nada que te espere.'));
    } else {
      if (necesita.length) App.add(cuerpo, seccion('Te necesita', h('div.parte-filas', necesita.map(filaAviso))));
      if (entregas.length) {
        App.add(cuerpo, seccion('Para revisar' + (rev.total > entregas.length ? ' (' + rev.total + ')' : ''),
          [h('div.parte-filas', entregas.map(filaEntrega)),
            rev.total > entregas.length ? h('button.btn.chico.fantasma', { onclick: function () { App.Entregables.abrir(); } }, 'Ver las ' + rev.total) : null]));
      }
      if (flujos.length) App.add(cuerpo, seccion('Flujos en curso', h('div.parte-filas', flujos.map(filaFlujo))));
      if (esperas.length) App.add(cuerpo, seccion('En espera', h('div.parte-filas', esperas.map(filaEspera))));
    }
    var qp = p.paso && quePaso(p.paso);
    if (qp) App.add(cuerpo, seccion('Qué pasó', qp));
    var porId = {};
    esperas.forEach(function (x) { porId[String(x.id)] = x; });
    if (bloq.length) App.add(cuerpo, seccion('Bloqueos', h('div.parte-filas', bloq.map(function (b) { return filaBloqueo(b, porId); }))));
    if (prox.length) App.add(cuerpo, seccion('Próximas tareas', h('div.parte-filas', prox.map(filaProxima))));

    var listo = h('button.btn.primario', { onclick: function () {
      listo.disabled = true;
      api().post('/api/parte/visto').then(function () { App.cerrarDerecho(); }).catch(function (e) { App.fallo(e); listo.disabled = false; });
    } }, 'Listo, ya lo vi');
    App.add(pie, h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, listo));
  }

  function redactar(coord, btn) {
    btn.disabled = true;
    api().post('/api/parte/redactar').then(function () {
      redactando = true; intentos = 0;
      App.aviso(coord.nombre + ' se puso a redactar el parte.');
      if (App.Actividad) setTimeout(App.Actividad.ya, 300);
      cargar(false);
    }).catch(function (e) { App.fallo(e); btn.disabled = false; });
  }

  /* mientras redacta, se vuelve a pedir el parte cada 4 s (hasta 4 minutos) hasta que aparezca el narrado */
  function vigilar() {
    clearTimeout(reloj);
    if (++intentos > 60) { redactando = false; intentos = 0; return; }
    reloj = setTimeout(function () {
      if (!abiertoPanel() || !redactando) { redactando = false; intentos = 0; return; }
      api().get('/api/parte').then(function (p) {
        if (!abiertoPanel()) return;
        if (p.narrado && p.narrado.texto) { redactando = false; intentos = 0; pedido++; pintar(p); } else vigilar();
      }).catch(function () { vigilar(); });
    }, 4000);
  }

  return { abrir: abrir, alCerrarPanel: cerrarPanel, abrirEspera: abrirEsperaPorId };
})();
