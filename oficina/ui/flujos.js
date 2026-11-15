/* Flujos (docs/plan-creador-flujos.md §7 y §12): tablero de corridas, detalle de una corrida (línea de pasos), hoja «Nueva corrida»
   y editor de las definiciones. Panel derecho en modo «flujos». También anima la pieza en el 3D cuando una corrida cambia de paso
   y cuenta en la barra lateral las corridas que esperan a la persona o están trabadas (llegan con /api/actividad). */
window.App = window.App || {};
App.Flujos = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var api = function () { return App.api; };
  var filtro = 'abiertas';          // abiertas | terminadas | todas
  var abierta = null;               // id de la corrida que muestra el panel (null = lista)
  var firmaDetalle = '';            // para repintar el detalle solo si algo cambió
  var relojDetalle = null;
  var conocidas = null;             // id -> {paso, quien, estado}; null hasta la primera actividad (la primera no anima)
  var firmaAbiertas = '';
  var borrador = { corrida: null, nota: '', archivos: [] };   // lo que la persona va cargando en «Te toca» (sobrevive a repintar)
  var MAX_ARCHIVOS = 10, MAX_MB = 25;

  var ESTADO_CORRIDA = {
    en_curso: ['En curso', 'info'], esperando_aprobacion: ['Espera tu OK', 'aviso'], esperando_persona: ['Te toca', 'aviso'],
    trabada: ['Trabada', 'error'], terminada: ['Terminó', 'ok'], cancelada: ['Cancelada', '']
  };
  var ESTADO_PASO = {
    pendiente: 'Por empezar', corriendo: 'En marcha', esperando_aprobacion: 'Espera tu aprobación', esperando_persona: 'Te toca',
    listo: 'Listo', error: 'Trabado', saltado: 'Saltado', cancelado: 'Cancelado'
  };

  function abiertoPanel() { return App.modoDerecho && App.modoDerecho() === 'flujos'; }
  function oficina() { return App.E.oficina || { agentes: [] }; }
  function esPersona(q) { return q === 'persona'; }
  function nombreQuien(q) {
    if (esPersona(q)) return 'Vos';
    var a = q && App.agente(q);
    return a ? a.nombre : '';
  }

  /* quién: retrato del agente, «Vos» o un signo de pregunta si ya no está */
  function marca(q, tam) {
    if (esPersona(q)) { var yo = App.Yo.retrato('retrato', tam || 64); yo.title = 'Vos'; return yo; }
    var a = q && App.agente(q);
    if (a) return App.retratoImg(a, 'retrato', tam || 64);
    return h('div.retrato.sin-asignar', { title: 'Sin asignar' }, '?');
  }
  function insigniaCorrida(estado) {
    var e = ESTADO_CORRIDA[estado] || [estado, ''];
    return h('span.insignia' + (e[1] ? '.' + e[1] : ''), e[0]);
  }

  /* ---------------- panel: cabecera ---------------- */
  function cabecera(titulo, sub, extra) {
    return h('div.der-cab',
      h('div.retrato.flu-icono', App.icono('flujo')),
      h('div.der-tit', h('h2', { title: titulo }, titulo), sub ? h('div.sub', sub) : null),
      extra || null,
      h('button.btn.fantasma.icono', { title: 'Cerrar panel', onclick: App.cerrarDerecho }, App.icono('cerrar')));
  }

  function prepararPanel() {
    if (App.Agente && App.Agente.alCerrar && App.modoDerecho && App.modoDerecho() === 'agente') App.Agente.alCerrar();
    if (!abiertoPanel()) App.abrirDerecho('flujos');
  }

  /* ---------------- panel: lista de corridas ---------------- */
  function abrir() {
    prepararPanel();
    abierta = null; clearTimeout(relojDetalle);
    pintarLista();
  }

  function pintarLista() {
    if (!abiertoPanel()) return;
    abierta = null; clearTimeout(relojDetalle);
    var der = App.dom.derecho, cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie'), lista = h('div.corridas', h('div.vacio', h('span.giro')));
    function chip(est, txt) {
      return h('button.chip' + (filtro === est ? '.sel' : ''), { onclick: function () { filtro = est; pintarLista(); } }, txt);
    }
    App.add(App.vaciar(der), cabecera('Flujos', 'Lo que está en marcha en la oficina'), cuerpo, pie);
    App.add(cuerpo, h('div.entregas-filtros', chip('abiertas', 'En curso'), chip('terminadas', 'Terminadas'), chip('todas', 'Todas')), lista);
    App.add(pie, h('div.flu-pie',
      h('button.btn.primario', { onclick: function () { nuevaCorrida(); } }, App.icono('mas'), 'Nueva corrida'),
      h('button.btn', { onclick: function () { editor(); } }, 'Flujos de la oficina…')));
    api().get('/api/flujos/corridas', { estado: filtro, limite: 100 }).then(function (r) {
      if (!abiertoPanel() || abierta !== null) return;
      App.vaciar(lista);
      var cs = r.corridas || [];
      if (!cs.length) {
        lista.appendChild(h('div.vacio', filtro === 'abiertas'
          ? 'No hay nada en marcha. Empezá una corrida con «Nueva corrida».'
          : 'Todavía no hay corridas terminadas.'));
        return;
      }
      cs.forEach(function (c) { lista.appendChild(fila(c)); });
    }).catch(function (e) { App.vaciar(lista).appendChild(h('div.error-txt', e.message)); });
  }

  function fila(c) {
    var toca = c.estado === 'esperando_persona' || c.estado === 'trabada';
    var cerrada = c.estado === 'terminada' || c.estado === 'cancelada';
    var paso = cerrada ? (c.estado === 'terminada' ? 'Completo' : 'Cancelada') : (c.pasoNombre || 'Paso ' + ((c.paso | 0) + 1));
    return h('button.corrida-fila' + (toca ? '.nueva' : ''), { onclick: function () { verCorrida(c.id); } },
      cerrada ? h('div.retrato.flu-icono', App.icono('flujo')) : marca(c.quien, 64),
      h('div.entrega-txt',
        h('div.entrega-tit', c.nombre),
        h('div.entrega-sub', (c.flujoNombre || c.flujo) + ' · ' + paso + (cerrada ? '' : (c.total ? ' (' + ((c.paso | 0) + 1) + ' de ' + c.total + ')' : ''))),
        h('div.entrega-sub', (cerrada || !c.quien ? '' : (nombreQuien(c.quien) || 'Sin asignar') + ' · ') + App.hace(c.actualizada))),
      insigniaCorrida(c.estado));
  }

  /* ---------------- panel: detalle de una corrida ---------------- */
  function verCorrida(id) {
    id = +id;
    if (!id) { abrir(); return; }
    prepararPanel();
    abierta = id; firmaDetalle = '';
    if (borrador.corrida !== id) borrador = { corrida: id, nota: '', archivos: [] };
    App.vaciar(App.dom.derecho).appendChild(h('div.vacio', h('span.giro')));
    cargarDetalle(id, true);
  }

  function cargarDetalle(id, forzar) {
    return api().get('/api/flujos/corridas/' + id).then(function (r) {
      if (abierta !== id || !abiertoPanel()) return;
      var f = firma(r);
      if (forzar || f !== firmaDetalle) { firmaDetalle = f; pintarDetalle(r); }
      vigilar(id, r);
    }).catch(function (e) {
      if (abierta !== id) return;
      App.fallo(e); pintarLista();
    });
  }

  function firma(r) {
    return r.corrida.estado + '|' + r.corrida.paso + '|' + (r.pasos || []).map(function (p) {
      return (p.intentos || []).map(function (i) { return i.id + ':' + i.estado + ':' + (i.entrega ? i.entrega.id + i.entrega.estado : '') + ':' + (i.consultas || []).length + ':' + (i.sid || ''); }).join(',');
    }).join(';');
  }

  /* mientras haya pasos corriendo (o por empezar) se vuelve a leer cada 3 s */
  function vigilar(id, r) {
    clearTimeout(relojDetalle);
    var c = r.corrida;
    if (c.estado !== 'en_curso') return;
    var activo = (r.pasos || []).some(function (p) {
      return (p.intentos || []).some(function (i) { return i.estado === 'corriendo' || i.estado === 'pendiente'; });
    });
    if (!activo) return;
    relojDetalle = setTimeout(function () {
      if (abierta !== id || !abiertoPanel()) return;
      cargarDetalle(id, false);
    }, 3000);
  }

  function ultimoIntento(p) { var l = p.intentos || []; return l.length ? l[l.length - 1] : null; }

  function pintarDetalle(r) {
    var c = r.corrida, pasos = r.pasos || [], der = App.dom.derecho;
    var cuerpo = h('div.der-cuerpo'), pie = h('div.der-pie');
    var volverLista = h('button.btn.fantasma.icono', { title: 'Volver a la lista', onclick: function () { pintarLista(); } }, '←');
    var sub = (c.flujoNombre || c.flujo) + ' · ' + App.hace(c.creada);
    App.add(App.vaciar(der), cabecera(c.nombre, sub, volverLista), cuerpo, pie);
    var abiertaC = c.estado !== 'terminada' && c.estado !== 'cancelada';
    var meta = h('div.entrega-meta', insigniaCorrida(c.estado),
      c.estado === 'en_curso' ? h('span.insignia', 'Paso ' + (c.paso + 1) + ' de ' + c.total) : null);
    App.add(cuerpo, meta);
    if (c.contexto) {
      var sp = App.Adjuntos.separar(c.contexto);
      App.add(cuerpo, h('div.flu-contexto', h('div.etiqueta-campo', 'Contexto'), sp.texto ? h('div', sp.texto) : null,
        sp.rutas.length ? App.Adjuntos.chips(sp.rutas) : null));
    }
    var linea = h('ol.pasos');
    pasos.forEach(function (p, i) { linea.appendChild(pasoItem(c, p, i)); });
    cuerpo.appendChild(linea);
    var botones = [];
    /* el backend solo deja volver en corridas abiertas (una terminada o cancelada da 409) */
    if (abiertaC && pasos.length) botones.push(h('button.btn', { onclick: function () { volverAPaso(c, pasos); } }, 'Volver a un paso…'));
    botones.push(h('span', { style: { flex: 1 } }));
    if (abiertaC) botones.push(h('button.btn.peligro-suave', { onclick: function () { cancelar(c); } }, 'Cancelar la corrida'));
    App.add(pie, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, botones));
  }

  function pasoItem(c, p, i) {
    var def = p.def || {}, ult = ultimoIntento(p), cerrada = c.estado === 'terminada' || c.estado === 'cancelada';
    var cls = ['paso'];
    var est = ult ? ult.estado : '';
    if (i < c.paso || (c.estado === 'terminada')) cls.push('hecho');
    else if (i === c.paso && !cerrada) {
      cls.push('actual');
      if (est === 'esperando_aprobacion') cls.push('espera');
      else if (est === 'esperando_persona') cls.push('persona');
      else if (est === 'error' || c.estado === 'trabada') cls.push('error');
    }
    var quien = def.quien;
    var nom = nombreQuien(quien);
    var sin = p.sinAsignar || (!esPersona(quien) && !nom);
    var cabeza = h('div.paso-cab',
      h('div.paso-tit', (i + 1) + '. ' + (def.nombre || 'Paso')),
      est ? h('span.insignia' + (est === 'error' ? '.error' : est === 'listo' || est === 'saltado' ? '.ok' : est === 'esperando_aprobacion' || est === 'esperando_persona' ? '.aviso' : ''),
        est === 'corriendo' ? [h('span.giro'), ESTADO_PASO[est]] : ESTADO_PASO[est] || est) : null);
    var quienEl = h('div.paso-quien', marca(quien, 48), h('span' + (sin ? '.sin' : ''), sin ? 'Sin asignar' : nom));
    var datos = h('div.paso-datos',
      def.recibe ? h('div', h('b', 'Recibe: '), def.recibe) : null,
      def.entrega ? h('div', h('b', 'Entrega: '), def.entrega) : null,
      def.aprobacion ? h('div.paso-aprob', App.icono('escudo'), 'Pide tu aprobación') : null,
      def.esperaDias ? h('div', h('b', 'Espera: '), def.esperaDias + (def.esperaDias === 1 ? ' día' : ' días') + ' después del paso anterior') : null);
    var item = h('li.' + cls.join('.'), h('span.paso-punto'), h('div.paso-cuerpo', cabeza, quienEl, datos));
    var cuerpo = item.lastChild;

    /* intentos: enlace a la entrega y nota */
    var ints = p.intentos || [];
    if (ints.length) {
      var lista = h('div.paso-intentos');
      ints.forEach(function (it) {
        var fila = h('div.paso-intento',
          ints.length > 1 ? h('span.paso-intento-n', 'Intento ' + it.intento) : null,
          h('span.paso-intento-t', (ints.length > 1 ? (ESTADO_PASO[it.estado] || it.estado) + ' · ' : '') +
            (it.estado === 'pendiente' && it.despues ? 'arranca ' + App.fecha(it.despues) : App.hace(it.fin || it.inicio))),
          h('span.paso-intento-acc',
            it.sid && it.agente ? h('button.btn.chico.fantasma', { title: 'Lo que se le pidió y lo que respondió; podés seguir escribiéndole', onclick: function () { App.Agente.abrirSesion(it.agente, it.sid); } }, App.icono('reunion'), 'Conversación') : null,
            it.entrega ? h('button.btn.chico.fantasma', { title: it.entrega.titulo, onclick: function () { App.Entregables.abrir(it.entrega.id); } }, App.icono('abrir'), 'Ver la entrega') : null));
        lista.appendChild(fila);
        if (it.estado === 'corriendo') {
          var vivo = h('div.paso-vivo', { 'data-agente': it.agente || def.quien });
          pintarVivo(vivo);
          lista.appendChild(vivo);
        }
        if (it.consultas && it.consultas.length) lista.appendChild(consultasIntento(it.consultas));
        if (it.nota) lista.appendChild(h('div.paso-nota', it.nota));
      });
      cuerpo.appendChild(lista);
    }

    /* acciones del paso actual según el estado */
    if (cls.indexOf('actual') >= 0) {
      if (est === 'esperando_aprobacion' && ult && ult.entrega) {
        cuerpo.appendChild(h('div.paso-acc', h('button.btn.primario', { onclick: function () { App.Entregables.abrir(ult.entrega.id); } }, 'Revisar la entrega')));
      } else if (est === 'esperando_persona') {
        cuerpo.appendChild(teToca(c, def));
      } else if (c.estado === 'trabada' || est === 'error') {
        cuerpo.appendChild(h('div.paso-acc',
          h('button.btn.primario', { onclick: function () { accion(c, 'reintentar'); } }, 'Reintentar'),
          h('button.btn', { onclick: function () { saltar(c, def); } }, 'Saltar este paso')));
      }
    }
    return item;
  }

  /* ---------------- en vivo: qué está haciendo el agente del paso ---------------- */
  var VERBO = { pensando: 'Pensando', leyendo: 'Leyendo', escribiendo: 'Escribiendo', buscando: 'Buscando', consultando: 'Consultando a', trabajando: 'Trabajando' };
  function pintarVivo(el) {
    var t = (App.E.actividad || {})[el.getAttribute('data-agente')];
    App.vaciar(el);
    if (!t) { App.add(el, h('span.giro'), h('span', 'Arrancando…')); return; }
    App.add(el, h('span.giro'),
      h('span.paso-vivo-txt', (VERBO[t.estado] || 'Trabajando') + (t.objetivo ? ' ' + t.objetivo : '…')),
      t.desde ? h('span.paso-vivo-hace', App.hace(t.desde)) : null);
  }
  function pintarVivos() { document.querySelectorAll('.paso-vivo[data-agente]').forEach(pintarVivo); }

  /* lo que el agente le preguntó a sus colegas en ese intento */
  function consultasIntento(cs) {
    var det = h('details.paso-consultas', h('summary', App.icono('reunion'), cs.length === 1 ? 'Consultó a ' + cs[0].aNombre : cs.length + ' consultas a colegas'));
    cs.forEach(function (q) {
      det.appendChild(h('div.paso-consulta',
        h('div.paso-consulta-p', h('b', q.aNombre + ': '), q.pregunta),
        q.respuesta ? h('div.paso-consulta-r', q.respuesta) : q.error ? h('div.paso-consulta-r.error-txt', q.error) : h('div.paso-consulta-r', h('span.giro'), ' Esperando respuesta…')));
    });
    return det;
  }

  /* ---------------- «Te toca»: archivos, nota y Hecho ---------------- */
  function teToca(c, def) {
    var bloque = h('div.te-toca');
    var err = h('div.error-txt'), lista = h('div.te-toca-archivos');
    var sel = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    var nota = h('textarea.campo', { rows: 3, maxlength: 4000, placeholder: 'Una nota para el equipo (opcional)', value: borrador.nota,
      oninput: function () { borrador.nota = nota.value; } });
    var ok = h('button.btn.primario', { onclick: enviar }, 'Hecho');
    function pintarArchivos() {
      App.vaciar(lista);
      borrador.archivos.forEach(function (f, i) {
        lista.appendChild(h('div.archivo-fila', { style: { cursor: 'default' } }, App.icono('carpeta'), h('span', f.name + ' · ' + App.tam(f.size)),
          h('button.btn.fantasma.chico', { title: 'Sacar', onclick: function () { borrador.archivos.splice(i, 1); pintarArchivos(); } }, App.icono('cerrar'))));
      });
    }
    sel.addEventListener('change', function () {
      err.textContent = '';
      Array.prototype.forEach.call(sel.files, function (f) {
        if (borrador.archivos.length >= MAX_ARCHIVOS) { err.textContent = 'Máximo ' + MAX_ARCHIVOS + ' archivos por vez.'; return; }
        if (f.size > MAX_MB * 1048576) { err.textContent = '«' + f.name + '» pesa más de ' + MAX_MB + ' MB.'; return; }
        borrador.archivos.push(f);
      });
      sel.value = '';
      pintarArchivos();
    });
    function leer(f) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); res({ nombre: f.name, base64: s.slice(s.indexOf(',') + 1) }); };
        fr.onerror = function () { rej(new Error('No pude leer «' + f.name + '».')); };
        fr.readAsDataURL(f);
      });
    }
    function enviar() {
      ok.disabled = true; err.textContent = '';
      Promise.all(borrador.archivos.map(leer)).then(function (archivos) {
        var cuerpo = { nota: nota.value.trim() };
        if (archivos.length) cuerpo.archivos = archivos;
        return api().post('/api/flujos/corridas/' + c.id + '/hecho', cuerpo);
      }).then(function () {
        borrador = { corrida: c.id, nota: '', archivos: [] };
        App.aviso('Listo, la corrida sigue.');
        if (App.Actividad) App.Actividad.ya();
        cargarDetalle(c.id, true);
      }).catch(function (e) { err.textContent = e.message; ok.disabled = false; });
    }
    App.add(bloque,
      h('div.te-toca-tit', App.icono('personas'), 'Te toca'),
      def.entrega ? h('div.ayuda', 'Entregá: ' + def.entrega) : null,
      h('div.te-toca-fila', h('button.btn', { onclick: function () { sel.click(); } }, App.icono('subir'), 'Agregar archivos'), sel),
      lista, nota, err, h('div.paso-acc', ok));
    pintarArchivos();
    return bloque;
  }

  /* ---------------- acciones sobre la corrida ---------------- */
  function accion(c, nombre) {
    return api().post('/api/flujos/corridas/' + c.id + '/' + nombre).then(function () {
      if (App.Actividad) App.Actividad.ya();
      cargarDetalle(c.id, true);
    }).catch(App.fallo);
  }
  function saltar(c, def) {
    App.confirmar('Saltar este paso', '«' + (def.nombre || 'Paso') + '» queda sin hacer y la corrida sigue con el paso que viene.', 'Saltar el paso').then(function (si) {
      if (si) accion(c, 'saltar');
    });
  }
  function cancelar(c) {
    App.confirmar('Cancelar la corrida', '«' + c.nombre + '» se frena y no se puede retomar. Lo que ya se entregó queda guardado.', 'Cancelar la corrida', true).then(function (si) {
      if (!si) return;
      accion(c, 'cancelar').then(function () { App.aviso('Corrida cancelada.'); });
    });
  }

  function volverAPaso(c, pasos) {
    var hj = App.hoja({ titulo: 'Volver a un paso', ancho: 520 });
    var hasta = Math.min(c.paso, pasos.length - 1);
    var elegido = hasta, err = h('div.error-txt');
    var opciones = h('div.lista-ed');
    function pintarOpc() {
      App.vaciar(opciones);
      for (var i = 0; i <= hasta; i++) (function (i) {
        var def = pasos[i].def || {};
        opciones.appendChild(h('button.fila-ed.opcion-paso' + (elegido === i ? '.sel' : ''), { onclick: function () { elegido = i; pintarOpc(); } },
          h('b', (i + 1) + '.'), h('span', def.nombre || 'Paso'), h('small', nombreQuien(def.quien) || (esPersona(def.quien) ? 'Vos' : 'Sin asignar'))));
      })(i);
    }
    pintarOpc();
    var nota = h('textarea.campo', { rows: 4, maxlength: 4000, placeholder: 'Qué hay que rehacer. Por ejemplo: la nueva toma, sin el ruido de fondo.' });
    App.add(hj.cuerpo,
      h('div.fila-campo', h('label.etiqueta-campo', 'Reabrir desde'), opciones),
      h('div.fila-campo', h('label.etiqueta-campo', 'Nota para quien lo rehace'), nota,
        h('div.ayuda', 'El paso se hace de nuevo con la nota en la consigna. Los pasos que vienen después se rehacen cuando este termine.')), err);
    var ok = h('button.btn.primario', { onclick: function () {
      ok.disabled = true; err.textContent = '';
      api().post('/api/flujos/corridas/' + c.id + '/volver', { paso: elegido, nota: nota.value.trim() }).then(function () {
        hj.cerrar(); App.aviso('Volvió al paso ' + (elegido + 1) + '.');
        if (App.Actividad) App.Actividad.ya();
        cargarDetalle(c.id, true);
      }).catch(function (e) { err.textContent = e.message; ok.disabled = false; });
    } }, 'Volver a este paso');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok);
  }

  /* ---------------- hoja: nueva corrida ---------------- */
  function nuevaCorrida(flujoId) {
    var hj = App.hoja({ titulo: 'Nueva corrida', ancho: 520 });
    App.add(hj.cuerpo, h('div.vacio', h('span.giro')));
    api().get('/api/flujos').then(function (r) {
      var fs = (r.flujos || []).filter(function (f) { return f.activo !== false; });
      App.vaciar(hj.cuerpo);
      if (!fs.length) {
        App.add(hj.cuerpo, h('div.vacio', 'Todavía no hay flujos para correr. Armalos con el Creador o a mano.'));
        App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cerrar'),
          h('button.btn', { onclick: function () { hj.cerrar(); App.Creador.abrir(); } }, App.icono('chispa'), 'Armar con el Creador'),
          h('button.btn.primario', { onclick: function () { hj.cerrar(); editor(); } }, 'Crear un flujo'));
        return;
      }
      var sel = h('select.campo', { onchange: resumen }, fs.map(function (f) { return h('option', { value: f.id }, f.nombre); }));
      if (flujoId) sel.value = flujoId;
      var nombre = h('input.campo', { maxlength: 80, placeholder: 'Clase 7', autofocus: true });
      var ctx = h('textarea.campo', { rows: 4, maxlength: 4000, placeholder: 'Lo que el equipo tiene que saber para arrancar: el tema, el público, las fechas…' });
      var res = h('div.ayuda'), err = h('div.error-txt');
      var adj = App.Adjuntos({ texto: 'Adjuntar archivos', error: err });
      adj.zona(hj.cuerpo, ctx);
      function resumen() {
        var f = fs.filter(function (x) { return x.id === sel.value; })[0];
        res.textContent = f ? (f.pasos.length + (f.pasos.length === 1 ? ' paso' : ' pasos') + (f.descripcion ? ' · ' + f.descripcion : '')) : '';
      }
      resumen();
      App.add(hj.cuerpo,
        h('div.fila-campo', h('label.etiqueta-campo', 'Flujo'), sel, res),
        h('div.fila-campo', h('label.etiqueta-campo', 'Nombre de esta corrida'), nombre),
        h('div.fila-campo', h('label.etiqueta-campo', 'Contexto'), ctx),
        h('div.fila-campo', h('label.etiqueta-campo', 'Archivos'), h('div', adj.boton, adj.input), adj.lista,
          h('div.ayuda', 'Fotos, documentos o lo que el equipo tenga que mirar. Los ven todos los pasos.')), err);
      var ok = h('button.btn.primario', { onclick: empezar }, 'Empezar');
      function empezar() {
        var n = nombre.value.trim();
        if (!n) { err.textContent = 'Ponele un nombre a la corrida, por ejemplo «Clase 7».'; nombre.focus(); return; }
        ok.disabled = true; err.textContent = '';
        var leidos = [];
        adj.leer().then(function (archivos) {
          leidos = archivos;
          var cuerpo = { nombre: n, contexto: ctx.value.trim() };
          if (archivos.length) cuerpo.archivos = archivos;
          return api().post('/api/flujos/' + sel.value + '/correr', cuerpo);
        }).then(function (rr) {
          adj.guardarEnBiblioteca(leidos);
          hj.cerrar();
          App.aviso('Arrancó «' + n + '».');
          if (App.Actividad) App.Actividad.ya();
          verCorrida(rr.corrida.id);
        }).catch(function (e) { err.textContent = e.message; ok.disabled = false; });
      }
      nombre.addEventListener('keydown', function (e) { if (e.key === 'Enter') empezar(); });
      App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok);
    }).catch(function (e) { App.vaciar(hj.cuerpo).appendChild(h('div.error-txt', e.message)); });
  }

  /* ---------------- hoja: flujos de la oficina (editor) ---------------- */
  /* `borrador` (opcional): un FlujoDef armado por el servidor (desde una reunión o desde esperas repetidas); se abre como un flujo
     nuevo ya cargado y sin guardar, y la persona lo guarda con el botón de siempre */
  function editor(idInicial, borrador) {
    var hj = App.hoja({ titulo: 'Flujos de la oficina', ancho: 720 });
    var flujos = [], ed = null, sucio = false, err = h('div.error-txt'), borradorPendiente = borrador || null;
    var selector = h('div.flu-selector'), formulario = h('div'), pie = hj.pie;
    App.add(hj.cuerpo, selector, formulario, err);

    function vacioEd() {
      return { id: null, nombre: '', descripcion: '', activo: true, abrirTodo: true,
        pasos: [pasoNuevo()] };
    }
    function pasoNuevo() {
      return { id: null, nombre: '', quien: '', consigna: '', recibe: '', entrega: '', aprobacion: false, plazoDias: '', esperaDias: '', recibeDe: [], recibeNada: false, abierto: true };
    }
    function desdeFlujo(f) {
      return { id: f.id, nombre: f.nombre || '', descripcion: f.descripcion || '', activo: f.activo !== false, origen: f.origen,
        pasos: (f.pasos || []).map(function (p, i) {
          return { id: p.id, nombre: p.nombre || '', quien: p.quien || '', consigna: p.consigna || '', recibe: p.recibe || '', entrega: p.entrega || '',
            aprobacion: !!p.aprobacion, plazoDias: p.plazoDias || '', esperaDias: p.esperaDias || '', recibeDe: (p.recibeDe || []).slice(),
            /* `recibeDe: []` explícito = no recibe nada (sin él, recibe del paso anterior): hay que mandarlo tal cual al guardar */
            recibeNada: Array.isArray(p.recibeDe) && p.recibeDe.length === 0, abierto: (f.pasos || []).length <= 3 };
        }) };
    }

    function cargar(elegirId) {
      return api().get('/api/flujos').then(function (r) {
        flujos = r.flujos || [];
        var f = elegirId && flujos.filter(function (x) { return x.id === elegirId; })[0];
        ed = f ? desdeFlujo(f) : (flujos.length && elegirId !== null ? desdeFlujo(flujos[0]) : vacioEd());
        sucio = false;
        if (borradorPendiente) { ed = desdeFlujo(borradorPendiente); ed.id = null; sucio = true; borradorPendiente = null; }
        pintar();
      }).catch(function (e) { err.textContent = e.message; });
    }

    function cambiarA(fn) {
      if (!sucio) { fn(); return; }
      App.confirmar('Descartar los cambios', 'Tenés cambios sin guardar en este flujo.', 'Descartar').then(function (si) { if (si) fn(); });
    }

    function pintar() {
      err.textContent = '';
      App.vaciar(selector); App.vaciar(formulario); App.vaciar(pie);
      var sel = h('select.campo', { onchange: function () {
        var v = sel.value;
        cambiarA(function () {
          if (v === '__nuevo') { ed = vacioEd(); sucio = false; pintar(); }
          else { ed = desdeFlujo(flujos.filter(function (x) { return x.id === v; })[0]); sucio = false; pintar(); }
        });
        sel.value = ed.id || '__nuevo';
      } }, flujos.map(function (f) { return h('option', { value: f.id }, f.nombre + (f.activo === false ? ' (pausado)' : '')); })
        .concat([h('option', { value: '__nuevo' }, '+ Flujo nuevo')]));
      sel.value = ed.id || '__nuevo';
      App.add(selector, h('label.etiqueta-campo', 'Flujo'), sel);

      var nombre = h('input.campo', { value: ed.nombre, maxlength: 80, placeholder: 'Producción de una clase', oninput: function () { ed.nombre = nombre.value; sucio = true; } });
      var desc = h('textarea.campo', { rows: 2, maxlength: 600, placeholder: 'Para qué sirve este flujo (opcional)', oninput: function () { ed.descripcion = desc.value; sucio = true; } });
      desc.value = ed.descripcion;
      var activo = h('input', { type: 'checkbox', checked: ed.activo, onchange: function () { ed.activo = activo.checked; sucio = true; } });
      App.add(formulario,
        h('div.fila-campo', h('label.etiqueta-campo', 'Nombre'), nombre),
        h('div.fila-campo', h('label.etiqueta-campo', 'Descripción'), desc),
        h('label.flu-check', activo, 'Se puede correr (si lo desmarcás queda pausado)'),
        h('div.etiqueta-campo', { style: { marginTop: '12px' } }, 'Pasos'));
      var lista = h('div.lista-ed.flu-pasos-ed');
      formulario.appendChild(lista);
      ed.pasos.forEach(function (p, i) { lista.appendChild(filaPaso(p, i)); });
      formulario.appendChild(h('button.btn', { style: { marginTop: '8px' }, onclick: function () {
        if (ed.pasos.length >= 20) { err.textContent = 'Un flujo tiene como máximo 20 pasos.'; return; }
        ed.pasos.push(pasoNuevo()); sucio = true; pintar();
      } }, App.icono('mas'), 'Agregar un paso'));

      if (ed.id) App.add(pie, h('button.btn.peligro-suave.izq', { onclick: borrar }, App.icono('papelera'), 'Borrar el flujo'));
      var guardarBtn = h('button.btn.primario', { onclick: function () { guardar(guardarBtn); } }, 'Guardar');
      App.add(pie, h('button.btn', { onclick: hj.cerrar }, 'Cerrar'), guardarBtn);
    }

    function agentesOpc(actual) {
      var o = oficina(), ops = [h('option', { value: '' }, 'Elegí quién…'), h('option', { value: 'persona' }, 'Vos (una persona)')];
      (o.agentes || []).forEach(function (a) { ops.push(h('option', { value: a.id }, a.nombre + ' · ' + a.rol)); });
      if (actual && actual !== 'persona' && !App.agente(actual)) ops.push(h('option', { value: actual }, 'Sin asignar (' + actual + ')'));
      return ops;
    }

    function filaPaso(p, i) {
      var n = ed.pasos.length;
      var nom = h('input.campo', { value: p.nombre, maxlength: 80, placeholder: 'Nombre del paso', oninput: function () { p.nombre = nom.value; sucio = true; } });
      var quien = h('select.campo', { onchange: function () { p.quien = quien.value; sucio = true; } }, agentesOpc(p.quien));
      quien.value = p.quien;
      var subir = h('button.btn.fantasma.icono', { title: 'Subir', disabled: i === 0, onclick: function () { mover(i, -1); } }, '↑');
      var bajar = h('button.btn.fantasma.icono', { title: 'Bajar', disabled: i === n - 1, onclick: function () { mover(i, 1); } }, '↓');
      var quitar = h('button.btn.fantasma.icono', { title: 'Quitar', disabled: n === 1, onclick: function () { quitarPaso(i); } }, App.icono('cerrar'));
      var det = h('button.btn.fantasma.icono', { title: p.abierto ? 'Cerrar el detalle' : 'Abrir el detalle', onclick: function () { p.abierto = !p.abierto; pintar(); } }, p.abierto ? '▾' : '▸');
      var cab = h('div.fila-ed.flu-paso-cab', h('b.flu-num', (i + 1) + '.'), nom, quien, subir, bajar, quitar, det);
      var caja = h('div.flu-paso-ed', cab);
      if (!p.abierto) return caja;
      var consigna = h('textarea.campo', { rows: 3, maxlength: 4000, placeholder: 'Qué tiene que hacer, con tus palabras', oninput: function () { p.consigna = consigna.value; sucio = true; } });
      consigna.value = p.consigna;
      var recibe = h('input.campo', { value: p.recibe, maxlength: 600, placeholder: 'Qué recibe (por ejemplo: el tema de la clase)', oninput: function () { p.recibe = recibe.value; sucio = true; } });
      var entrega = h('input.campo', { value: p.entrega, maxlength: 600, placeholder: 'Qué entrega (por ejemplo: ficha, guion y ejercicios)', oninput: function () { p.entrega = entrega.value; sucio = true; } });
      var aprob = h('input', { type: 'checkbox', checked: p.aprobacion, onchange: function () { p.aprobacion = aprob.checked; sucio = true; } });
      var plazo = h('input.campo', { type: 'number', min: 1, max: 60, value: p.plazoDias, placeholder: '2', oninput: function () { p.plazoDias = plazo.value; sucio = true; } });
      var espera = h('input.campo', { type: 'number', min: 1, max: 90, value: p.esperaDias, placeholder: 'Enseguida', oninput: function () { p.esperaDias = espera.value; sucio = true; } });
      var cuerpo = h('div.flu-paso-form',
        h('div.fila-campo', h('label.etiqueta-campo', 'Consigna'), consigna),
        h('div.flu-dos', h('div', h('label.etiqueta-campo', 'Recibe'), recibe), h('div', h('label.etiqueta-campo', 'Entrega'), entrega)),
        h('label.flu-check', aprob, 'Requiere tu aprobación'),
        h('div.flu-dos',
          h('div', h('label.etiqueta-campo', 'Plazo (días)'), plazo, h('div.ayuda', 'Pasados estos días sin avance, se marca como bloqueado. Si lo dejás vacío, 2.')),
          h('div', h('label.etiqueta-campo', 'Arranca después de (días)'), espera, h('div.ayuda', 'Espera estos días desde que termina el paso anterior.'))));
      if (i > 0) {
        var previos = h('div.flu-previos');
        ed.pasos.slice(0, i).forEach(function (q, j) {
          var marcado = !!q.id && (p.recibeDe || []).indexOf(q.id) >= 0;
          previos.appendChild(h('button.chip' + (marcado ? '.sel' : ''), { onclick: function () {
            asegurarId(q);
            var clave = q.id;
            var k = p.recibeDe.indexOf(clave);
            if (k >= 0) p.recibeDe.splice(k, 1); else p.recibeDe.push(clave);
            p.recibeNada = false;   // al tocar una casilla, se vuelve a la regla de siempre
            sucio = true; pintar();
          } }, (j + 1) + '. ' + (q.nombre || 'Paso')));
        });
        cuerpo.appendChild(h('div.fila-campo', h('label.etiqueta-campo', 'Recibe lo que entregaron'),
          previos, h('div.ayuda', p.recibeNada && !(p.recibeDe || []).length ? 'Este paso no recibe nada de los anteriores. Si elegís alguno, recibe solo lo de ese.' : 'Sin elegir ninguno, recibe lo del paso inmediato anterior.')));
      }
      caja.appendChild(cuerpo);
      return caja;
    }

    function asegurarId(q) {
      if (q.id) return;
      q.id = App.slug(q.nombre || 'paso', ed.pasos.map(function (x) { return x.id; }).filter(Boolean));
    }
    function mover(i, d) {
      var j = i + d; if (j < 0 || j >= ed.pasos.length) return;
      var t = ed.pasos[i]; ed.pasos[i] = ed.pasos[j]; ed.pasos[j] = t;
      sucio = true; pintar();
    }
    function quitarPaso(i) {
      var q = ed.pasos.splice(i, 1)[0];
      var clave = q.id || null;
      if (clave) ed.pasos.forEach(function (p) { p.recibeDe = (p.recibeDe || []).filter(function (x) { return x !== clave; }); });
      sucio = true; pintar();
    }

    /* arma el cuerpo a enviar: ids de los pasos nuevos, recibeDe solo hacia pasos anteriores */
    function payload() {
      var pasos = [];
      ed.pasos.forEach(function (p, i) {
        if (!p.nombre.trim()) throw new Error('Al paso ' + (i + 1) + ' le falta el nombre.');
        if (!p.quien) throw new Error('Elegí quién hace «' + p.nombre.trim() + '».');
        if (!p.entrega.trim()) throw new Error('Contá qué entrega «' + p.nombre.trim() + '».');
        asegurarId(p);
      });
      ed.pasos.forEach(function (p, i) {
        var previos = ed.pasos.slice(0, i).map(function (q) { return q.id; });
        var rec = (p.recibeDe || []).filter(function (x) { return previos.indexOf(x) >= 0; });
        p.recibeDe = rec;
        var o = { id: p.id, nombre: p.nombre.trim(), quien: p.quien, entrega: p.entrega.trim(), aprobacion: !!p.aprobacion };
        if (p.consigna.trim()) o.consigna = p.consigna.trim();
        if (p.recibe.trim()) o.recibe = p.recibe.trim();
        if (rec.length) o.recibeDe = rec;
        else if (p.recibeNada) o.recibeDe = [];
        if (String(p.plazoDias).trim() !== '') o.plazoDias = +p.plazoDias;
        if (String(p.esperaDias).trim() !== '') o.esperaDias = +p.esperaDias;
        pasos.push(o);
      });
      if (!ed.nombre.trim()) throw new Error('Ponele un nombre al flujo.');
      var cuerpo = { nombre: ed.nombre.trim(), pasos: pasos, activo: !!ed.activo };
      cuerpo.descripcion = ed.descripcion.trim();
      if (!ed.id && ed.origen) cuerpo.origen = ed.origen;   // un flujo nuevo armado desde una reunión o desde esperas recuerda de dónde salió
      return cuerpo;
    }

    function guardar(btn) {
      var cuerpo;
      err.textContent = '';
      try { cuerpo = payload(); } catch (e) { err.textContent = e.message; return; }
      btn.disabled = true;
      var pedido = ed.id ? api().patch('/api/flujos/' + ed.id, cuerpo) : api().post('/api/flujos', cuerpo);
      pedido.then(function (r) {
        App.aviso('Flujo guardado.');
        sucio = false;
        if (abiertoPanel() && abierta === null) pintarLista();
        return cargar(r.flujo.id);
      }).catch(function (e) { err.textContent = e.message; btn.disabled = false; });
    }

    function borrar() {
      var id = ed.id, nom = ed.nombre;
      App.confirmar('Borrar el flujo', '«' + nom + '» se borra de la oficina. Las corridas que ya están en marcha siguen hasta terminar.', 'Borrar', true).then(function (si) {
        if (!si) return;
        api().del('/api/flujos/' + id).then(function () {
          App.aviso('Flujo borrado.');
          if (abiertoPanel() && abierta === null) pintarLista();
          return cargar(undefined);
        }).catch(function (e) { err.textContent = e.message; });
      });
    }

    cargar(idInicial);
  }

  /* ---------------- actividad: insignia, lista viva y pieza en el 3D ---------------- */
  function alActividad(r) {
    pintarVivos();
    var cs = r.corridas || [];
    var nuevo = {};
    cs.forEach(function (c) { nuevo[c.id] = { paso: c.paso, quien: c.quien, estado: c.estado }; });

    /* la pieza viaja cuando una corrida cambia de paso (o aparece una nueva, que sale de la recepción) */
    if (conocidas !== null && App.Oficina3D && App.Oficina3D.pieza) {
      cs.forEach(function (c) {
        var antes = conocidas[c.id];
        if (antes && antes.paso === c.paso) return;
        /* sale de quien la tenía (así «volver» y «saltar» también salen del lugar correcto); si no se sabe, del paso anterior */
        var prev = antes ? (antes.quien || c.anterior) : null;
        var desde = prev && prev !== 'persona' ? prev : null;
        var hacia = c.quien && c.quien !== 'persona' ? c.quien : null;
        try { App.Oficina3D.pieza(desde, hacia); } catch (e) { /* la animación nunca rompe nada */ }
      });
    }
    conocidas = nuevo;

    var toca = cs.filter(function (c) { return c.estado === 'esperando_persona' || c.estado === 'trabada'; }).length;
    var b = App.dom && App.dom.navFlu;
    if (b) { b.textContent = toca; b.classList.toggle('oculto', !toca); }

    var f = cs.map(function (c) { return c.id + ':' + c.paso + ':' + c.estado; }).join('|');
    var cambio = f !== firmaAbiertas;
    firmaAbiertas = f;
    if (!cambio || !abiertoPanel()) return;
    if (abierta === null) pintarLista();
    else cargarDetalle(abierta, false);
  }

  if (App.on) App.on('actividad', alActividad);

  return {
    abrir: abrir,
    verCorrida: verCorrida,
    nueva: nuevaCorrida,
    editor: editor,
    alCerrarPanel: function () { abierta = null; clearTimeout(relojDetalle); }
  };
})();
