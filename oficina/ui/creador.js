/* Creador de flujos: una hoja con el chat a la izquierda y el borrador de tarjetas a la derecha.
   Nada se crea hasta que la persona lo aprueba con el botón del pie. */
window.App = window.App || {};
(function () {
  'use strict';
  var h = App.h, api = App.api;

  var TIPOS = ['departamento', 'agente', 'regla', 'conector', 'flujo', 'tarea'];
  var TIPO_TXT = { departamento: 'Departamentos', agente: 'Agentes', regla: 'Reglas', conector: 'Conectores', flujo: 'Flujos', tarea: 'Tareas' };
  var TIPO_UNO = { departamento: 'Departamento', agente: 'Agente', regla: 'Regla', conector: 'Conector', flujo: 'Flujo', tarea: 'Tarea' };
  var TIPO_ICONO = { departamento: 'edificio', agente: 'personas', regla: 'regla', conector: 'enchufe', flujo: 'flujo', tarea: 'recargar' };
  var ACCION_TXT = { crear: 'Nuevo', modificar: 'Cambio', quitar: 'Quitar' };
  var ESTADO_TXT = { borrador: 'Borrador', lista: 'Lista', creada: 'Creada', error: 'Error' };
  var DIAS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [7, 'Dom']];
  var MODELOS = [['', 'El de siempre (Sonnet)'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
  var INTRO = 'Contame qué hace tu negocio y cómo querés organizar el equipo. Voy armando tarjetas a la derecha: nada se crea hasta que lo apruebes.';
  var abierta = null;   // la hoja abierta (una sola a la vez)
  var alActividadActual = null;
  App.on('actividad', function (r) { if (alActividadActual) alActividadActual(r); });

  function buscar(lista, f) { for (var i = 0; i < (lista || []).length; i++) if (f(lista[i])) return lista[i]; return null; }
  function recortar(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

  /* un uuid por oficina, guardado en el navegador (si no se puede, vale solo hasta cerrar) */
  function sesionDe() {
    var k = 'creador-sesion:' + (App.E.carpeta || '');
    try {
      var v = localStorage.getItem(k);
      if (v) return v;
      v = App.uuid(); localStorage.setItem(k, v); return v;
    } catch (e) { return App.uuid(); }
  }

  /* ---------------- nombres y valores legibles ---------------- */
  var tarjetasActuales = [];
  function tarjetaPorId(id) { return buscar(tarjetasActuales, function (t) { return t.id === id; }); }
  function tituloTarjeta(t) {
    var d = t.datos || {};
    if (t.tipo === 'regla') return recortar(d.texto || 'Regla sin texto', 70);
    if (t.tipo === 'conector') return (d.servidor || 'Conector') + (d.agente ? ' · ' + nombreDe('agente', d.agente) : '');
    if (t.tipo === 'tarea' && d.nombre) return d.nombre;
    return d.nombre || (t.objetivo ? nombreDe(t.tipo, t.objetivo) : '') || ('Sin nombre');
  }
  /* una referencia puede ser un id existente, «tarjeta:x» o «persona» */
  function nombreDe(tipo, ref) {
    if (ref === undefined || ref === null || ref === '') return '';
    ref = String(ref);
    if (ref === 'persona') return 'Vos';
    if (ref.indexOf('tarjeta:') === 0) {
      var t = tarjetaPorId(ref.slice(8));
      return t ? tituloTarjeta(t) + ' (propuesta)' : ref;
    }
    var o = App.E.oficina || {};
    if (tipo === 'departamento') { var d = App.depto(ref); return d ? d.nombre : ref; }
    if (tipo === 'agente') { var a = App.agente(ref); return a ? a.nombre : ref; }
    if (tipo === 'flujo') { var f = buscar(o.flujos, function (x) { return x.id === ref; }); return f ? f.nombre : ref; }
    if (tipo === 'regla') { var r = buscar(o.reglas, function (x) { return x.id === ref; }); return r ? recortar(r.texto, 70) : ref; }
    return ref;
  }
  function listaTxt(l) { return (l || []).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join('; '); }
  function limitesTxt(l) {
    if (!l) return '';
    var p = [];
    if (l.solo && l.solo.length) p.push('Hace solo: ' + listaTxt(l.solo));
    if (l.proponer && l.proponer.length) p.push('Propone y espera: ' + listaTxt(l.proponer));
    return p.join(' · ');
  }
  /* el valor de un campo, en texto, para «Antes → Ahora» */
  function valorTxt(clave, v) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (clave === 'departamento' || clave === 'agente') return nombreDe(clave, v);
    if (clave === 'permisos') return (v || []).indexOf('coordinador') >= 0 ? 'Es coordinador/a' : '—';
    if (clave === 'limites') return limitesTxt(v) || '—';
    if (clave === 'conectores') return v.map(function (c) { return c.servidor; }).join(', ');
    if (clave === 'pasos') return v.map(function (p) { return p.nombre + (p.quien ? ' (' + nombreDe('agente', p.quien) + ')' : ''); }).join(' → ');
    if (clave === 'dias') return v.map(function (n) { return (buscar(DIAS, function (d) { return d[0] === n; }) || [0, n])[1]; }).join(', ');
    if (Array.isArray(v)) return listaTxt(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  var ETIQUETAS = { nombre: 'Nombre', mision: 'Misión', color: 'Color', rol: 'Rol', departamento: 'Departamento', prompt: 'Instrucciones', description: 'Descripción',
    modelo: 'Modelo', chips: 'Atajos', limites: 'Límites', conectores: 'Conectores', permisos: 'Coordinación', descripcion: 'Descripción', pasos: 'Pasos',
    texto: 'Texto', agente: 'Agente', servidor: 'Conector', leer: 'Puede leer', actuar: 'Puede hacer', consigna: 'Consigna', dias: 'Días', hora: 'Hora', zona: 'Zona', fecha: 'Fecha' };

  /* lo que hay hoy en oficina.json para la tarjeta de modificar */
  function actualDe(t) {
    var o = App.E.oficina || {}, obj = t.objetivo;
    if (!obj && t.tipo !== 'conector') return null;
    if (t.tipo === 'departamento') return App.depto(obj);
    if (t.tipo === 'agente') return App.agente(obj);
    if (t.tipo === 'flujo') return buscar(o.flujos, function (x) { return x.id === obj; });
    if (t.tipo === 'regla') return buscar(o.reglas, function (x) { return x.id === obj; });
    if (t.tipo === 'conector') {
      var a = App.agente((t.datos || {}).agente || obj);
      var c = a ? buscar(a.conectores, function (x) { return x.servidor === (t.datos || {}).servidor; }) : null;
      return c;
    }
    return null;
  }
  function diferencias(t) {
    var antes = actualDe(t), d = t.datos || {}, out = [];
    if (!antes) return out;
    Object.keys(d).forEach(function (k) {
      if (k === 'id') return;
      var a = valorTxt(k, antes[k]), b = valorTxt(k, d[k]);
      if (a !== b) out.push({ etq: ETIQUETAS[k] || k, antes: a, ahora: b });
    });
    return out;
  }

  /* ---------------- tarjeta ---------------- */
  function fila(etq, contenido) {
    if (contenido === null || contenido === undefined || contenido === false || contenido === '') return null;
    return h('div.tb-fila', h('b', etq), h('div', contenido));
  }
  function itemsCortos(items, max) {
    items = items || [];
    if (!items.length) return null;
    var ul = h('ul.tb-lista', items.slice(0, max).map(function (x) { return h('li', x); }));
    if (items.length > max) ul.appendChild(h('li.tb-mas', 'y ' + (items.length - max) + ' más'));
    return ul;
  }
  function camposClave(t) {
    var d = t.datos || {};
    if (t.tipo === 'departamento') return [fila('Misión', d.mision)];
    if (t.tipo === 'agente') {
      var l = d.limites || {}, cons = (d.conectores || []).map(function (c) { return c.servidor; });
      return [
        fila('Rol', d.rol),
        fila('Departamento', d.departamento ? nombreDe('departamento', d.departamento) : null),
        fila('Hace solo', itemsCortos(l.solo, 3)),
        fila('Propone y espera', itemsCortos(l.proponer, 3)),
        fila('Conectores', cons.length ? cons.join(', ') : null),
        (d.permisos || []).indexOf('coordinador') >= 0 ? fila('Coordinación', h('span.insignia.ok', 'Es coordinador/a')) : null
      ];
    }
    if (t.tipo === 'flujo') {
      var pasos = d.pasos || [];
      return [fila('Qué es', d.descripcion), pasos.length ? h('ol.tb-pasos', pasos.map(function (p, i) {
        return h('li', h('span.tb-paso-n', String(i + 1)),
          h('span.tb-paso-t', h('b', p.nombre || 'Paso sin nombre'), p.quien ? h('span.ayuda', ' · ' + nombreDe('agente', p.quien)) : null),
          p.aprobacion === true ? h('span.insignia.ok', 'Pide aprobación') : p.aprobacion === false ? h('span.insignia', 'Sin aprobación') : h('span.insignia.aviso', 'Aprobación sin definir'));
      })) : h('div.ayuda', 'Todavía no tiene pasos.')];
    }
    if (t.tipo === 'regla') return [];
    if (t.tipo === 'conector') return [fila('Agente', d.agente ? nombreDe('agente', d.agente) : null), fila('Puede leer', itemsCortos(d.leer, 4)), fila('Puede hacer', itemsCortos(d.actuar, 4))];
    if (t.tipo === 'tarea') return [fila('Agente', d.agente ? nombreDe('agente', d.agente) : null), fila('Consigna', d.consigna),
      fila('Cuándo', [d.dias ? valorTxt('dias', d.dias) : '', d.hora || '', d.zona || ''].filter(Boolean).join(' · '))];
    return [];
  }

  /* ---------------- hoja ---------------- */
  function abrir() {
    if (abierta) { try { abierta.el.scrollIntoView(); } catch (e) {} return; }
    var sid = sesionDe();
    var cerrada = false, relojChat = null, versionVista = -1, mensajes = [], corriendo = false, enviando = false;
    var tarjetas = [], resumen = {}, filtro = '', excluidas = {}, aplicando = false, erroresAplicar = [];

    var hj = App.hoja({ titulo: 'Armar la oficina', ancho: 1100, alto: 'min(780px, 94vh)', sinPie: true, alCerrar: function () {
      cerrada = true; clearTimeout(relojChat); abierta = null; alActividadActual = null;
    } });
    abierta = hj;
    hj.cuerpo.style.cssText = 'padding:0;display:flex;flex-direction:column;overflow:hidden';

    /* ---- izquierda: chat ---- */
    var lista = h('div.chat'), cuerpoChat = h('div.creador-chat-cuerpo', lista);
    var txt = h('textarea.campo', { rows: 2, maxlength: 60000, placeholder: 'Pegá el texto completo de cómo querés tu oficina, o contame de a poco' });
    var enviar = h('button.btn.primario.icono', { title: 'Enviar (Cmd/Ctrl+Enter)', onclick: mandar }, App.icono('enviar'));
    txt.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); mandar(); } });
    txt.addEventListener('input', function () { txt.style.height = 'auto'; txt.style.height = Math.min(180, txt.scrollHeight + 2) + 'px'; });
    var colChat = h('div.creador-col.creador-chat', cuerpoChat,
      h('div.creador-redactar', h('div.redactar', txt, enviar), h('div.ayuda', 'Cmd/Ctrl+Enter para enviar · Podés pegar un texto largo')));

    /* ---- derecha: borrador ---- */
    var cabBorrador = h('div.creador-cab'), listaTarjetas = h('div.creador-tarjetas'), errBox = h('div.creador-errores');
    var botonAplicar = h('button.btn.primario', { onclick: aplicar }, 'Crear las 0 listas');
    var notaPie = h('span.ayuda');
    var colBorrador = h('div.creador-col.creador-borrador', cabBorrador, listaTarjetas, errBox, h('div.creador-pie', notaPie, h('span', { style: { flex: 1 } }), botonAplicar));

    App.add(hj.cuerpo, h('div.creador', colChat, colBorrador));

    /* ---------------- chat ---------------- */
    function pintarChat() {
      App.vaciar(lista);
      if (!mensajes.length) lista.appendChild(App.htmlSeguro(h('div.msg.a'), App.markdown(INTRO)));
      mensajes.forEach(function (m) {
        if (m.rol === 'u') lista.appendChild(h('div.msg.u', m.texto));
        else lista.appendChild(App.htmlSeguro(h('div.msg.a' + (m.error ? '.e' : '')), App.markdown(m.texto)));
      });
      if (corriendo || enviando) lista.appendChild(h('div.escribiendo', h('span.puntos', h('i'), h('i'), h('i')), 'El Creador está armando…'));
      cuerpoChat.scrollTop = cuerpoChat.scrollHeight;
      enviar.disabled = corriendo || enviando;
    }
    /* trae el estado del chat; mientras corra, vuelve a pedirlo cada 1,5 s y refresca el borrador */
    function sondear() {
      clearTimeout(relojChat);
      if (cerrada) return;
      api.get('/api/creador/estado', { session: sid }).then(function (r) {
        if (cerrada) return;
        var del = r.mensajes || [];
        if (del.length >= mensajes.length || !enviando) mensajes = del;
        corriendo = !!r.corriendo;
        if (corriendo) enviando = false;   // ya lo tomó el servidor
        pintarChat();
        cargarBorrador();
        if (corriendo || enviando) relojChat = setTimeout(sondear, 1500);
      }).catch(function (e) {
        if (cerrada) return;
        if (corriendo || enviando) relojChat = setTimeout(sondear, 3000);
        else App.fallo(e);
      });
    }
    function mandar() {
      var t = txt.value.trim();
      if (!t || corriendo || enviando) return;
      enviando = true;
      mensajes.push({ rol: 'u', texto: t });
      txt.value = ''; txt.style.height = '';
      pintarChat();
      api.post('/api/creador/chat', { message: t, session: sid }).then(function () {
        if (cerrada) return;
        corriendo = true; enviando = false;
        pintarChat();
        relojChat = setTimeout(sondear, 1500);
      }).catch(function (e) {
        enviando = false;
        txt.value = t;
        mensajes.pop();
        if (!cerrada) { pintarChat(); App.fallo(e); }
      });
    }

    /* ---------------- borrador ---------------- */
    function cargarBorrador() {
      return api.get('/api/creador/borrador').then(function (r) {
        if (cerrada) return;
        versionVista = r.version;
        tarjetas = r.tarjetas || []; resumen = r.resumen || {};
        tarjetasActuales = tarjetas;
        pintarBorrador();
      }).catch(function (e) { if (!cerrada) { App.vaciar(listaTarjetas).appendChild(h('div.vacio', e.message)); } });
    }
    function alActividad(r) {
      if (cerrada || !r) return;
      if (r.creadorVersion !== undefined && r.creadorVersion !== versionVista) cargarBorrador();
    }
    alActividadActual = alActividad;

    function incluida(t) { return t.estado === 'lista' && !excluidas[t.id]; }
    function pintarCab() {
      App.vaciar(cabBorrador);
      var partes = [];
      if (resumen.lista) partes.push(plural(resumen.lista, 'lista', 'listas'));
      if (resumen.borrador) partes.push(plural(resumen.borrador, 'en borrador', 'en borrador'));
      if (resumen.creada) partes.push(plural(resumen.creada, 'creada', 'creadas'));
      if (resumen.error) partes.push(plural(resumen.error, 'con error', 'con error'));
      cabBorrador.appendChild(h('div.creador-resumen', h('b', 'Borrador'), h('span.ayuda', partes.length ? partes.join(' · ') : 'Sin tarjetas todavía')));
      var presentes = TIPOS.filter(function (tp) { return tarjetas.some(function (t) { return t.tipo === tp; }); });
      if (presentes.length) {
        var chips = h('div.creador-chips', h('button.chip' + (filtro ? '' : '.activo'), { onclick: function () { filtro = ''; pintarBorrador(); } }, 'Todas ' + tarjetas.length));
        presentes.forEach(function (tp) {
          var n = tarjetas.filter(function (t) { return t.tipo === tp; }).length;
          chips.appendChild(h('button.chip' + (filtro === tp ? '.activo' : ''), { onclick: function () { filtro = filtro === tp ? '' : tp; pintarBorrador(); } }, App.icono(TIPO_ICONO[tp]), TIPO_TXT[tp] + ' ' + n));
        });
        cabBorrador.appendChild(chips);
      } else filtro = '';
    }
    function pintarBorrador() {
      var y = listaTarjetas.scrollTop;
      pintarCab();
      App.vaciar(listaTarjetas);
      if (!tarjetas.length) {
        listaTarjetas.appendChild(h('div.vacio', 'Todavía no hay tarjetas. Contame y las voy armando.'));
      } else {
        TIPOS.forEach(function (tp) {
          if (filtro && filtro !== tp) return;
          var grupo = tarjetas.filter(function (t) { return t.tipo === tp; });
          if (!grupo.length) return;
          listaTarjetas.appendChild(h('div.creador-grupo', App.icono(TIPO_ICONO[tp]), TIPO_TXT[tp], h('span.ayuda', String(grupo.length))));
          grupo.forEach(function (t) { listaTarjetas.appendChild(tarjetaEl(t)); });
        });
      }
      listaTarjetas.scrollTop = y;
      pintarPie();
    }
    function pintarPie() {
      var n = tarjetas.filter(incluida).length, quitar = tarjetas.filter(function (t) { return incluida(t) && t.accion === 'quitar'; }).length;
      botonAplicar.textContent = n === 1 ? 'Crear la 1 lista' : 'Crear las ' + n + ' listas';
      botonAplicar.disabled = !n || aplicando;
      var nota = [];
      if (resumen.borrador) nota.push(plural(resumen.borrador, 'tarjeta espera', 'tarjetas esperan') + ' respuestas');
      if (quitar) nota.push(plural(quitar, 'quita', 'quitan') + ' algo de la oficina');
      notaPie.textContent = nota.join(' · ') || (n ? 'Revisalas antes de crear.' : '');
      App.vaciar(errBox);
      erroresAplicar.forEach(function (e) { errBox.appendChild(h('div.error-txt', e)); });
    }

    function tarjetaEl(t) {
      var d = t.datos || {};
      var dif = t.accion === 'modificar' ? diferencias(t) : [];
      var cab = h('div.tb-cab',
        t.estado === 'lista' ? h('input', { type: 'checkbox', checked: incluida(t), title: 'Incluirla al crear', 'aria-label': 'Incluir ' + tituloTarjeta(t), onchange: function () {
          if (this.checked) delete excluidas[t.id]; else excluidas[t.id] = true;
          pintarPie();
        } }) : null,
        h('span.tb-icono', App.icono(TIPO_ICONO[t.tipo])),
        h('div.tb-tit', h('b', tituloTarjeta(t)), h('span.ayuda', TIPO_UNO[t.tipo])),
        h('span.insignia' + (t.accion === 'quitar' ? '.error' : t.accion === 'modificar' ? '.aviso' : ''), ACCION_TXT[t.accion] || t.accion),
        h('span.insignia' + (t.estado === 'lista' || t.estado === 'creada' ? '.ok' : t.estado === 'error' ? '.error' : '.aviso'), ESTADO_TXT[t.estado] || t.estado));
      var faltan = (t.faltantes || []).map(function (f) { return f.pregunta || f.campo || String(f); });
      var acciones = h('div.tb-acciones',
        t.estado !== 'creada' ? h('button.btn.chico', { onclick: function () { editar(t); } }, 'Editar') : null,
        t.estado !== 'creada' ? h('button.btn.chico.peligro', { onclick: function () { descartar(t); } }, 'Descartar') : null);
      return h('div.tarjeta-borrador', { 'data-estado': t.estado, 'data-tipo': t.tipo, 'data-accion': t.accion },
        cab,
        h('div.tb-cuerpo',
          t.tipo === 'regla' ? h('div.tb-texto', d.texto || '') : null,
          camposClave(t),
          dif.length ? h('div.tb-dif', h('b', 'Qué cambia'), dif.map(function (x) {
            return h('div.tb-dif-fila', h('span.tb-dif-etq', x.etq), h('span.tb-antes', x.antes), h('span.tb-flecha', '→'), h('span.tb-ahora', x.ahora));
          })) : null,
          faltan.length ? h('div.tb-faltan', h('b', 'Le falta:'), h('ul', faltan.map(function (f) { return h('li', f); }))) : null,
          t.estado === 'error' && t.error ? h('div.error-txt', t.error) : null,
          t.origen ? h('blockquote.tb-origen', t.origen) : null),
        acciones);
    }

    function descartar(t) {
      api.del('/api/creador/tarjetas/' + encodeURIComponent(t.id)).then(cargarBorrador).catch(App.fallo);
    }

    /* ---------------- aplicar ---------------- */
    function aplicar() {
      var sel = tarjetas.filter(incluida);
      if (!sel.length || aplicando) return;
      var quitar = sel.filter(function (t) { return t.accion === 'quitar'; });
      var confirmado = quitar.length ? App.confirmar(quitar.length === 1 ? '¿Quitar algo de la oficina?' : '¿Quitar ' + quitar.length + ' cosas de la oficina?',
        'Se va a quitar: ' + quitar.map(tituloTarjeta).join(', ') + '. Lo demás se crea o cambia como figura en las tarjetas.', 'Quitar y crear', true) : Promise.resolve(true);
      confirmado.then(function (si) {
        if (!si || cerrada) return;
        aplicando = true; erroresAplicar = []; botonAplicar.disabled = true; botonAplicar.textContent = 'Creando…';
        var cuerpo = { ids: sel.map(function (t) { return t.id; }) };
        if (quitar.length) cuerpo.confirmarQuitar = true;
        return api.post('/api/creador/aplicar', cuerpo).then(function (r) {
          var res = r.resultados || [], ok = res.filter(function (x) { return x.ok; }).length;
          res.filter(function (x) { return !x.ok; }).forEach(function (x) {
            var t = tarjetaPorId(x.id);
            erroresAplicar.push((t ? tituloTarjeta(t) : x.id) + ': ' + (x.error || 'no se pudo crear'));
          });
          App.recargarOficina().catch(function () {});
          if (ok) App.aviso(ok === 1 ? 'Se creó 1 cosa.' : 'Se crearon ' + ok + ' cosas.');
          if (erroresAplicar.length) App.aviso(plural(erroresAplicar.length, 'no se pudo crear', 'no se pudieron crear'), true);
        }).catch(function (e) {
          if (e.status === 409 && e.datos && e.datos.borradores) {
            erroresAplicar = e.datos.borradores.map(function (b) {
              var t = tarjetaPorId(b.id);
              return (t ? tituloTarjeta(t) : b.id) + ' todavía le falta: ' + (b.faltantes || []).map(function (f) { return f.pregunta || f.campo; }).join(' / ');
            });
          }
          App.fallo(e);
        }).then(function () { aplicando = false; return cargarBorrador(); });
      });
    }

    /* ---------------- editar ---------------- */
    function editar(t) {
      var ed = App.hoja({ titulo: 'Editar: ' + recortar(tituloTarjeta(t), 40), ancho: 640, alto: 'min(720px, 92vh)' });
      var d = JSON.parse(JSON.stringify(t.datos || {}));
      var campos = [];   // {clave, leer()}
      var faltBox = h('div.tb-faltan');
      ed.cuerpo.style.cssText = 'padding:14px 18px';

      function fc(etq, el, ayuda) { return h('div.fila-campo', h('label.etiqueta-campo', etq), el, ayuda ? h('div.ayuda', ayuda) : null); }
      function reg(clave, el, leer) { campos.push({ clave: clave, leer: leer }); return el; }
      function vacioNull(v) { v = typeof v === 'string' ? v.trim() : v; return v === '' || (Array.isArray(v) && !v.length) ? null : v; }
      function texto(clave, etq, op) {
        op = op || {};
        var el = op.area ? h('textarea.campo', { rows: op.filas || 3, value: d[clave] || '', placeholder: op.ph || '' }) : h('input.campo', { value: d[clave] || '', placeholder: op.ph || '', type: op.tipo || 'text' });
        return fc(etq + (op.obl ? ' *' : ''), reg(clave, el, function () { return vacioNull(el.value); }), op.ayuda);
      }
      function lineas(clave, etq, valor, ayuda, leerFn) {
        var el = h('textarea.campo', { rows: 3, value: (valor || []).join('\n') });
        return fc(etq, reg(clave, el, leerFn ? function () { return leerFn(lin(el)); } : function () { return vacioNull(lin(el)); }), ayuda || 'Uno por línea.');
      }
      function lin(el) { return el.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }
      function opcionesRef(tipo, extra) {
        var ops = [['', 'Elegí…']];
        if (extra) ops.push(extra);
        var base = tipo === 'departamento' ? (App.E.oficina.departamentos || []) : (App.E.oficina.agentes || []);
        base.forEach(function (x) { ops.push([x.id, x.nombre]); });
        tarjetas.forEach(function (x) { if (x.tipo === tipo && x.accion !== 'quitar' && x.id !== t.id) ops.push(['tarjeta:' + x.id, tituloTarjeta(x) + ' (propuesta)']); });
        return ops;
      }
      function sel(clave, etq, ops, valor, op) {
        op = op || {};
        if (valor && !buscar(ops, function (o) { return o[0] === valor; })) ops = ops.concat([[valor, nombreDe(op.tipo || 'agente', valor)]]);
        var el = h('select.campo', ops.map(function (o) { return h('option', { value: o[0], selected: o[0] === (valor || '') }, o[1]); }));
        return fc(etq + (op.obl ? ' *' : ''), op.sinReg ? el : reg(clave, el, function () { return vacioNull(el.value); }), op.ayuda);
      }

      var cont = h('div');
      if (t.tipo === 'departamento') {
        App.add(cont, texto('nombre', 'Nombre', { obl: true }), texto('mision', 'Misión', { area: true, filas: 3 }), texto('color', 'Color', { ph: '#7aa2e3' }));
      } else if (t.tipo === 'agente') {
        var lim = d.limites || {};
        var solo = h('textarea.campo', { rows: 3, value: (lim.solo || []).join('\n') }), prop = h('textarea.campo', { rows: 3, value: (lim.proponer || []).join('\n') });
        reg('limites', solo, function () { var a = lin(solo), b = lin(prop); if (!a.length && !b.length) return null; var o = {}; if (a.length) o.solo = a; if (b.length) o.proponer = b; return o; });
        var coord = h('input', { type: 'checkbox', checked: (d.permisos || []).indexOf('coordinador') >= 0 });
        reg('permisos', coord, function () { return coord.checked ? ['coordinador'] : null; });
        App.add(cont,
          h('div.dos', texto('nombre', 'Nombre', { obl: true }), texto('rol', 'Rol', { obl: true })),
          sel('departamento', 'Departamento', opcionesRef('departamento'), d.departamento, { obl: true, tipo: 'departamento' }),
          texto('prompt', 'Instrucciones', { area: true, filas: 6, obl: true, ayuda: 'Cómo trabaja, qué sabe y qué entrega.' }),
          texto('description', 'Descripción corta', {}),
          sel('modelo', 'Modelo', MODELOS, d.modelo || ''),
          lineas('chips', 'Atajos del chat', d.chips),
          fc('Hace solo', solo, 'Uno por línea: lo que puede hacer y entregar.'),
          fc('Propone y espera', prop, 'Uno por línea: lo que deja como propuesta hasta tu «Listo».'),
          h('label.tb-check', coord, 'Es coordinador/a de la oficina'));
        if ((d.conectores || []).length) cont.appendChild(h('div.ayuda', 'Conectores: ' + valorTxt('conectores', d.conectores) + '. Se cambian desde una tarjeta de conector.'));
      } else if (t.tipo === 'regla') {
        App.add(cont, texto('texto', 'Texto de la regla', { area: true, filas: 4, obl: true }));
      } else if (t.tipo === 'conector') {
        App.add(cont,
          sel('agente', 'Agente', opcionesRef('agente'), d.agente, { obl: true }),
          texto('servidor', 'Conector', { obl: true, ph: 'Ej.: Google Calendar' }),
          lineas('leer', 'Puede leer', d.leer, 'Una herramienta por línea.'),
          lineas('actuar', 'Puede hacer (con aprobación)', d.actuar, 'Una herramienta por línea.'));
      } else if (t.tipo === 'tarea') {
        var dias = {}; (d.dias || []).forEach(function (n) { dias[n] = true; });
        var chipsDias = h('div.creador-dias', DIAS.map(function (x) {
          var b = h('button.chip', { type: 'button', 'aria-pressed': dias[x[0]] ? 'true' : 'false', onclick: function () {
            dias[x[0]] = !dias[x[0]]; b.setAttribute('aria-pressed', dias[x[0]] ? 'true' : 'false'); b.classList.toggle('activo', !!dias[x[0]]);
          } }, x[1]);
          if (dias[x[0]]) b.classList.add('activo');
          return b;
        }));
        reg('dias', chipsDias, function () { var l = DIAS.map(function (x) { return x[0]; }).filter(function (n) { return dias[n]; }); return l.length ? l : null; });
        App.add(cont,
          sel('agente', 'Agente', opcionesRef('agente'), d.agente, { obl: true }),
          texto('nombre', 'Nombre', { obl: true }),
          texto('consigna', 'Consigna', { area: true, filas: 4, obl: true }),
          d.fecha ? null : fc('Días', chipsDias),
          h('div.dos', texto('hora', 'Hora', { tipo: 'time', obl: true }), texto('zona', 'Zona horaria', { ph: 'America/Argentina/Buenos_Aires' })));
      } else if (t.tipo === 'flujo') {
        var pasos = JSON.parse(JSON.stringify(d.pasos || []));
        var cajaPasos = h('div.creador-pasos');
        var quienOps = function () { return opcionesRef('agente', ['persona', 'Vos (la persona)']); };
        var pintarPasos = function () {
          App.vaciar(cajaPasos);
          pasos.forEach(function (p, i) {
            var n = h('input.campo', { value: p.nombre || '', placeholder: 'Nombre del paso' });
            var q = h('select.campo', quienOps().map(function (o) { return h('option', { value: o[0], selected: o[0] === (p.quien || '') }, o[1]); }));
            if (p.quien && !buscar(quienOps(), function (o) { return o[0] === p.quien; })) q.appendChild(h('option', { value: p.quien, selected: true }, nombreDe('agente', p.quien)));
            var c = h('textarea.campo', { rows: 2, value: p.consigna || '', placeholder: 'Consigna (qué tiene que hacer)' });
            var rc = h('input.campo', { value: p.recibe || '', placeholder: 'Qué recibe' });
            var en = h('input.campo', { value: p.entrega || '', placeholder: 'Qué entrega' });
            var ap = h('select.campo', [['', 'Aprobación: sin definir'], ['si', 'Pide aprobación'], ['no', 'Sin aprobación']].map(function (o) {
              return h('option', { value: o[0], selected: o[0] === (p.aprobacion === true ? 'si' : p.aprobacion === false ? 'no' : '') }, o[1]);
            }));
            var pl = h('input.campo', { type: 'number', min: 0, value: p.plazoDias == null ? '' : p.plazoDias, placeholder: 'Plazo (días)' });
            p._leer = function () {
              var o = {};
              Object.keys(p).forEach(function (k) { if (k !== '_leer') o[k] = p[k]; });
              function poner(k, v) { if (v === '' || v === null) delete o[k]; else o[k] = v; }
              poner('nombre', n.value.trim()); poner('quien', q.value); poner('consigna', c.value.trim()); poner('recibe', rc.value.trim()); poner('entrega', en.value.trim());
              if (ap.value) o.aprobacion = ap.value === 'si'; else delete o.aprobacion;
              poner('plazoDias', pl.value === '' ? '' : Math.max(0, parseInt(pl.value, 10) || 0));
              return o;
            };
            cajaPasos.appendChild(h('div.creador-paso',
              h('div.creador-paso-cab', h('b', 'Paso ' + (i + 1)), h('span', { style: { flex: 1 } }),
                h('button.btn.chico.fantasma', { type: 'button', title: 'Subir', disabled: i === 0, onclick: function () { guardarPasos(); pasos.splice(i - 1, 0, pasos.splice(i, 1)[0]); pintarPasos(); } }, '↑'),
                h('button.btn.chico.fantasma', { type: 'button', title: 'Bajar', disabled: i === pasos.length - 1, onclick: function () { guardarPasos(); pasos.splice(i + 1, 0, pasos.splice(i, 1)[0]); pintarPasos(); } }, '↓'),
                h('button.btn.chico.peligro', { type: 'button', onclick: function () { guardarPasos(); pasos.splice(i, 1); pintarPasos(); } }, 'Quitar')),
              h('div.dos', n, q), c, h('div.dos', rc, en), h('div.dos', ap, pl)));
          });
          if (!pasos.length) cajaPasos.appendChild(h('div.ayuda', 'Sin pasos todavía.'));
        };
        var guardarPasos = function () { pasos = pasos.map(function (p) { return p._leer ? p._leer() : p; }); };
        pintarPasos();
        reg('pasos', cajaPasos, function () { guardarPasos(); var l = pasos.map(function (p) { var o = {}; Object.keys(p).forEach(function (k) { if (k !== '_leer') o[k] = p[k]; }); return o; }); return l.length ? l : null; });
        App.add(cont, texto('nombre', 'Nombre', { obl: true }), texto('descripcion', 'Qué hace este flujo', { area: true, filas: 2 }),
          h('label.etiqueta-campo', 'Pasos *'), cajaPasos,
          h('button.btn.chico', { type: 'button', style: { marginTop: '8px' }, onclick: function () { guardarPasos(); pasos.push({}); pintarPasos(); } }, App.icono('mas'), 'Agregar un paso'));
      }
      if (t.origen) cont.appendChild(h('blockquote.tb-origen', { style: { marginTop: '14px' } }, t.origen));
      App.add(ed.cuerpo, cont, faltBox);

      var guardar = h('button.btn.primario', { onclick: function () {
        var datos = {};
        campos.forEach(function (c) { datos[c.clave] = c.leer(); });
        guardar.disabled = true;
        api.patch('/api/creador/tarjetas/' + encodeURIComponent(t.id), { datos: datos }).then(function (r) {
          var nueva = r.tarjeta || {}, falta = (nueva.faltantes || []);
          cargarBorrador();
          if (!falta.length) { ed.cerrar(); App.aviso('Guardado: la tarjeta está lista.'); return; }
          t = nueva; d = JSON.parse(JSON.stringify(nueva.datos || {}));
          App.vaciar(faltBox);
          App.add(faltBox, h('b', 'Todavía le falta:'), h('ul', falta.map(function (f) { return h('li', f.pregunta || f.campo); })));
          App.aviso('Guardado. Todavía le faltan cosas.');
          guardar.disabled = false;
        }).catch(function (e) { guardar.disabled = false; App.fallo(e); });
      } }, 'Guardar');
      App.add(ed.pie, h('button.btn', { onclick: ed.cerrar }, 'Cerrar'), guardar);
    }

    pintarChat();
    pintarBorrador();
    sondear();
    cargarBorrador();
  }

  App.Creador = { abrir: abrir };
})();
