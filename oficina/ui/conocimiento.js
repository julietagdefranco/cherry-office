/* Conocimiento compartido: buscar en lo que ya se sabe en la oficina, las preguntas frecuentes que salen de las
   consultas entre agentes (con su historial), lo que hay para revisar (contradicciones, respuestas vencidas,
   sugerencias para el «sabe de» y fragmentos marcados como desactualizados) y quién sabe de qué. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var TIPOS = { oficina: 'Memoria común', decision: 'Decisión', notas: 'Notas', acta: 'Acta', ficha: 'Documento', entregable: 'Entregable', pregunta: 'Pregunta frecuente' };
  var VENCE = [['', 'No vence'], ['30', '30 días'], ['60', '60 días'], ['90', '90 días'], ['180', '6 meses'], ['365', '1 año']];
  var reloj = null;

  /* lo que cuenta como «Sugerencias»: el mismo criterio en la insignia lateral y en la pestaña */
  function contar(st) { return (st.pendientes || 0) + (st.vencidas || 0) + (st.sugerencias || 0) + (st.obsoletos || 0); }

  /* insignia de la barra lateral: cuántas cosas esperan a la persona */
  function vigilarEstado() {
    clearTimeout(reloj);
    api.get('/api/conocimiento/estado').then(function (st) {
      var b = App.dom && App.dom.navCon;
      var n = contar(st);
      if (b) {
        b.className = 'insignia' + (st.pendientes ? ' aviso' : n ? ' info' : ' oculto');
        b.textContent = n ? n + (n === 1 ? ' sugerencia' : ' sugerencias') : '';
        b.title = n ? 'Para revisar en Conocimiento › Sugerencias' : '';
      }
      reloj = setTimeout(vigilarEstado, 30000);
    }).catch(function () { reloj = setTimeout(vigilarEstado, 60000); });
  }

  /* «…el [curso] cuesta…» -> texto con <mark> en lo que coincide */
  function fragmento(t) {
    var el = h('div.con-frag'), partes = String(t || '').split(/(\[[^\]]*\])/);
    partes.forEach(function (p) {
      if (/^\[[^\]]*\]$/.test(p)) el.appendChild(h('mark', p.slice(1, -1)));
      else if (p) el.appendChild(document.createTextNode(p));
    });
    return el;
  }
  function nombre(id) { var a = App.agente(id); return a ? a.nombre : id; }
  function cuando(iso) { return App.hace(iso) || ''; }
  function vacio(texto) { return h('div.vacio', texto); }
  function cargando(texto) { return App.cargando(texto); }
  /* «⋯» con el resto de las acciones */
  function masBoton(items) {
    return h('button.btn.fantasma.icono.chico', { title: 'Más opciones', 'aria-label': 'Más opciones', onclick: function (ev) { App.menu(ev.currentTarget, items); } }, App.icono('puntos'));
  }
  /* una ruta o referencia cruda → botón «Abrir» (si apunta a un archivo de la oficina) */
  function botonAbrir(ruta) {
    if (!ruta || !/\.[A-Za-z0-9]{1,6}$/.test(String(ruta).split('#')[0]) || !App.ChatRico) return null;
    var r = App.humano.ruta(ruta);
    return h('button.btn.chico.fantasma', { title: r.completa, onclick: function () { App.ChatRico.abrirArchivo(String(ruta).split('#')[0]); } }, App.icono('abrir'), 'Abrir');
  }

  /* ---------------- formulario de una pregunta (alta o edición) ---------------- */
  function formPregunta(p, listo) {
    var nueva = !p;
    p = p || {};
    var hj = App.hoja({ titulo: nueva ? 'Agregar pregunta frecuente' : 'Editar pregunta frecuente', ancho: 560 });
    function campo(etq, el, ayuda) { return h('div.fila-campo', h('label.etiqueta-campo', etq), el, ayuda ? h('div.ayuda', ayuda) : null); }
    var ag = nueva ? App.elegir({ opciones: (App.E.oficina.agentes || []).map(function (a) { return { valor: a.id, titulo: a.nombre, sub: null, retrato: a }; }), valor: p.agente || ((App.E.oficina.agentes || [])[0] || {}).id })
      : h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, App.agente(p.agente) ? App.retratoImg(App.agente(p.agente), 'retrato-mini', 48) : null, h('b', p.agenteNombre || App.humano.quien(p.agente)));
    var preg = h('input.campo', { value: p.pregunta || '', maxlength: 4000, placeholder: 'Ej.: ¿Cuánto cuesta el curso Glow?' });
    var resp = h('textarea.campo', { rows: 6, maxlength: 12000 }); resp.value = p.respuesta || '';
    var tema = h('input.campo', { value: p.tema || '', maxlength: 60, placeholder: 'Ej.: precios del curso' });
    var vence = App.elegir({ opciones: VENCE.map(function (v) { return { valor: v[0], titulo: v[1] }; }), valor: String(p.venceDias || '') });
    var err = h('div.error-txt');
    App.add(hj.cuerpo,
      campo('Quién responde', ag, nueva ? 'A quién le preguntarían esto.' : null),
      campo('Pregunta', preg), campo('Respuesta', resp, nueva ? null : 'Si cambiás la pregunta o la respuesta, la versión anterior queda en el historial.'),
      campo('Tema', tema), campo('Vence', vence, 'Para temas que cambian rápido (precios, fechas).'), err);
    var guardar = h('button.btn.primario', { onclick: function () {
      var cuerpo = { pregunta: preg.value.trim(), respuesta: resp.value.trim(), tema: tema.value.trim(), venceDias: vence.valor() ? Number(vence.valor()) : null };
      if (!cuerpo.pregunta || !cuerpo.respuesta) { err.textContent = 'Faltan la pregunta y la respuesta.'; return; }
      guardar.disabled = true;
      var pedido = nueva ? api.post('/api/conocimiento/preguntas', Object.assign({ agente: ag.valor() }, cuerpo)) : api.patch('/api/conocimiento/preguntas/' + p.id, cuerpo);
      pedido.then(function () { hj.cerrar(); App.aviso('Guardado.'); listo(); vigilarEstado(); })
        .catch(function (e) { err.textContent = e.message; guardar.disabled = false; });
    } }, 'Guardar');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
  }

  function historial(p) {
    var hj = App.hoja({ titulo: 'Historial de la pregunta', ancho: 600, sinPie: true });
    var cont = h('div', { style: { padding: '4px 0' } }, cargando('Trayendo el historial…'));
    hj.cuerpo.appendChild(cont);
    api.get('/api/conocimiento/preguntas/' + p.id + '/historial').then(function (r) {
      App.vaciar(cont);
      (r.versiones || []).forEach(function (v) {
        var est = { vigente: ['ok', 'Vigente'], reemplazada: ['', 'Reemplazada'], borrada: ['error', 'Borrada'], pendiente: ['aviso', 'Pendiente'], descartada: ['', 'Descartada'] }[v.estado] || ['', v.estado];
        cont.appendChild(h('div.con-item',
          h('div.con-cab', h('span.insignia' + (est[0] ? '.' + est[0] : ''), est[1]), h('span.con-tit', v.pregunta), h('span.con-meta', (v.origen === 'manual' ? 'Editada a mano' : v.agenteNombre) + ' · ' + App.fecha(v.creada))),
          h('div.con-resp', v.respuesta)));
      });
    }).catch(function (e) { App.vaciar(cont).appendChild(vacio(e.message)); });
  }

  /* tarjeta de una pregunta frecuente vigente */
  function tarjetaPregunta(p, refrescar) {
    var meta = [p.agenteNombre];
    if (p.deNombre) meta.push('le preguntó ' + p.deNombre);
    meta.push('confirmada ' + cuando(p.confirmada));
    var mas = [
      { texto: 'Editar', icono: 'lapiz', accion: function () { formPregunta(p, refrescar); } },
      p.versiones > 1 ? { texto: 'Historial', icono: 'reloj', nota: p.versiones + ' versiones', accion: function () { historial(p); } } : null,
      '-',
      { texto: 'Borrar', icono: 'papelera', peligro: true, accion: function () {
        App.confirmar('¿Borrar esta pregunta?', 'Deja de aparecer en las búsquedas de los agentes. Su historial queda guardado.', 'Borrar', true).then(function (si) {
          if (si) api.del('/api/conocimiento/preguntas/' + p.id).then(function () { refrescar(); vigilarEstado(); }).catch(App.fallo);
        });
      } }
    ].filter(Boolean);
    var acciones = App.acciones(null, [
      h('button.btn.chico' + (p.vencida ? '.primario' : ''), { onclick: function () {
        api.post('/api/conocimiento/preguntas/' + p.id + '/confirmar').then(function () { App.aviso('Confirmada.'); refrescar(); vigilarEstado(); }).catch(App.fallo);
      } }, 'Sigue valiendo'),
      masBoton(mas)]);
    acciones.classList.add('con-acciones');
    return h('div.con-item',
      h('div.con-cab', h('span.con-tit', p.pregunta), p.vencida ? h('span.insignia.aviso', 'Vencida') : null, p.tema ? h('span.con-tema', p.tema) : null),
      h('div.con-resp', p.respuesta),
      h('div.con-meta', { style: { marginTop: '6px' } }, meta.join(' · ')),
      acciones);
  }

  /* ---------------- pestañas ---------------- */
  function pintarBuscar(cuerpo, estado) {
    var inp = h('input.campo', { value: estado.q || '', placeholder: '¿Qué querés saber? Ej.: precio del curso, calendario de diciembre', autofocus: true });
    var res = h('div');
    App.add(cuerpo, h('div.con-barra', h('div', { style: { flex: 1, minWidth: '220px' } }, inp)), res);
    function buscar() {
      var q = inp.value.trim(); estado.q = q;
      if (!q) {
        App.vaciar(res).appendChild(h('div.ayuda', { style: { padding: '8px 2px' } },
          'Busca en la memoria común, las decisiones, las notas de cada agente, las actas de reuniones, las fichas de la biblioteca, los entregables y las respuestas de los agentes a sus colegas. Lo más nuevo aparece primero. Los agentes consultan lo mismo cuando necesitan saber algo.'));
        return;
      }
      App.vaciar(res).appendChild(cargando('Buscando…'));
      api.get('/api/conocimiento/buscar', { q: q }).then(function (r) {
        if (inp.value.trim() !== q) return;
        App.vaciar(res);
        if (!r.resultados.length) { res.appendChild(vacio('No encontré nada escrito sobre eso.')); return; }
        r.resultados.forEach(function (x) {
          var marcar = x.obsoleto
            ? h('button.btn.chico', { onclick: function () { api.del('/api/conocimiento/obsoleto?ref=' + encodeURIComponent(x.ref)).then(buscar).catch(App.fallo); } }, 'Quitar marca')
            : h('button.btn.chico.fantasma', { onclick: function () {
              App.preguntar('Marcar como desactualizado', 'Por qué ya no vale').then(function (motivo) {
                if (motivo === null) return;
                api.post('/api/conocimiento/obsoleto', { ref: x.ref, motivo: motivo }).then(function () { App.aviso('Marcado como desactualizado.'); buscar(); }).catch(App.fallo);
              });
            } }, 'Está desactualizado');
          res.appendChild(h('div.con-item' + (x.obsoleto ? '.obsoleto' : ''),
            h('div.con-cab', h('span.insignia', TIPOS[x.tipo] || x.tipo), h('span.con-tit', x.titulo || App.humano.ruta(x.ruta).corta),
              x.vencida ? h('span.insignia.aviso', 'Vencida') : null,
              h('span.con-meta', (x.autorNombre ? x.autorNombre + ' · ' : '') + x.fecha)),
            fragmento(x.fragmento),
            x.obsoleto ? h('div.ayuda', 'Desactualizado' + (x.obsoleto.motivo ? ': ' + x.obsoleto.motivo : '') + ' (marcado por ' + x.obsoleto.por + ', ' + x.obsoleto.fecha + ')') : null,
            h('div.con-acciones', h('span.con-ruta'), x.tipo === 'pregunta' ? null : botonAbrir(x.ruta), marcar)));
        });
      }).catch(function (e) { App.vaciar(res).appendChild(vacio(e.message)); });
    }
    var demorado = App.debounce(buscar, 350);
    inp.addEventListener('input', demorado);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') buscar(); });
    buscar();
  }

  function pintarPreguntas(cuerpo, estado) {
    var ag = App.elegir({ opciones: [{ valor: '', titulo: 'Todos' }].concat((App.E.oficina.agentes || []).map(function (a) { return { valor: a.id, titulo: a.nombre, retrato: a }; })),
      valor: estado.agente || '', etiqueta: 'Filtrar por agente', alCambiar: function () { cargar(); } });
    var filtro = h('input.campo', { value: estado.filtro || '', placeholder: 'Filtrar por palabra' });
    var lista = h('div');
    App.add(cuerpo, h('div.con-barra', h('div', { style: { flex: 1, minWidth: '160px' } }, filtro),
      h('button.btn.primario', { onclick: function () { formPregunta(null, cargar); } }, App.icono('mas'), 'Agregar')), h('div.con-barra', ag), lista);
    function cargar() {
      estado.agente = ag.valor(); estado.filtro = filtro.value.trim();
      App.vaciar(lista).appendChild(cargando('Trayendo las preguntas…'));
      api.get('/api/conocimiento/preguntas', { agente: estado.agente, q: estado.filtro }).then(function (r) {
        App.vaciar(lista);
        if (!r.preguntas.length) {
          lista.appendChild(vacio(estado.agente || estado.filtro ? 'No hay preguntas con ese filtro.'
            : 'Todavía no hay preguntas frecuentes. Se arman solas cuando un agente le consulta algo a un colega, y también las podés agregar a mano.'));
          return;
        }
        r.preguntas.forEach(function (p) { lista.appendChild(tarjetaPregunta(p, cargar)); });
      }).catch(function (e) { App.vaciar(lista).appendChild(vacio(e.message)); });
    }
    filtro.addEventListener('input', App.debounce(cargar, 300));
    cargar();
  }

  function pintarRevisar(cuerpo, alCambiar) {
    var cont = h('div', cargando('Trayendo lo que hay para revisar…'));
    cuerpo.appendChild(cont);
    function refrescar() { alCambiar(); cargar(); vigilarEstado(); }
    function cargar() {
      Promise.all([
        api.get('/api/conocimiento/preguntas', { estado: 'pendiente' }),
        api.get('/api/conocimiento/preguntas', { vencidas: '1' }),
        api.get('/api/conocimiento/sugerencias'),
        api.get('/api/conocimiento/obsoletos')
      ]).then(function (rs) {
        var pend = rs[0].preguntas, venc = rs[1].preguntas, sug = rs[2].sugerencias, obs = rs[3].obsoletos;
        App.vaciar(cont);
        if (!pend.length && !venc.length && !sug.length && !obs.length) { cont.appendChild(App.vacio('bombilla', 'Nada para revisar', 'Acá aparecen las respuestas que no coinciden, las vencidas y lo que los agentes sugieren sumar o sacar de lo que saben.')); return; }
        /* en todas las filas: la alternativa en fantasma, la principal a la derecha y el resto en «⋯» */
        if (pend.length) {
          var filasPend = pend.map(function (p) {
            var c = p.contradice || {};
            function resolver(q) { api.post('/api/conocimiento/preguntas/' + p.id + '/resolver', { quedarse: q }).then(refrescar).catch(App.fallo); }
            return h('div.con-item',
              h('div.con-cab', h('span.con-tit', p.pregunta)),
              h('div.con-dos',
                h('div.con-lado', h('h5', 'Antes · ' + (c.agenteNombre || '')), c.respuesta || '(ya no está)'),
                h('div.con-lado', h('h5', 'Ahora · ' + p.agenteNombre + ' · ' + App.fecha(p.creada)), p.respuesta)),
              App.acciones(null, [
                h('button.btn.chico.fantasma', { onclick: function () { resolver('anterior'); } }, 'Vale la anterior'),
                h('button.btn.chico.primario', { onclick: function () { resolver('nueva'); } }, 'Vale la nueva'),
                masBoton([{ texto: 'Valen las dos', accion: function () { resolver('ambas'); } }])]));
          });
          cont.appendChild(App.seccion('Respuestas que no coinciden', filasPend, { cuenta: String(pend.length), ayuda: 'Dos agentes contestaron distinto a lo mismo. Elegí cuál vale.' }));
        }
        if (venc.length) {
          cont.appendChild(App.seccion('Respuestas vencidas', venc.map(function (p) { return tarjetaPregunta(p, refrescar); }), { cuenta: String(venc.length), ayuda: '¿Siguen valiendo?' }));
        }
        if (sug.length) {
          var filasSug = sug.map(function (s) {
            var agregar = s.tipo === 'agregar';
            function decidir(aceptar) {
              api.post('/api/conocimiento/sugerencias', { agente: s.agente, tema: s.tema, tipo: s.tipo, aceptar: aceptar }).then(function (r) {
                if (aceptar && r.oficina) App.actualizar(r.oficina);
                refrescar();
              }).catch(App.fallo);
            }
            return App.filaDecision({
              marca: App.agente(s.agente) || 'bombilla',
              titulo: (agregar ? 'Sumar «' : 'Sacar «') + s.tema + '»',
              sub: (agregar ? 'A lo que sabe ' + s.agenteNombre + ' · respondió ' + s.veces + ' preguntas sobre esto' : 'De lo que sabe ' + s.agenteNombre + ' · hace meses que nadie le pregunta por esto'),
              principal: [
                h('button.btn.chico.fantasma', { onclick: function () { decidir(false); } }, 'Ahora no'),
                h('button.btn.chico.primario', { onclick: function () { decidir(true); } }, agregar ? 'Sumar' : 'Sacar')]
            });
          });
          cont.appendChild(App.seccion('Sugerencias para «Sabe de»', filasSug, { cuenta: String(sug.length) }));
        }
        if (obs.length) {
          var filasObs = obs.map(function (o) {
            var r = App.humano.ruta(o.ref);
            return h('div.con-item.obsoleto',
              h('div.con-cab', h('span.con-tit', o.titulo || r.corta), h('span.con-meta', (o.por ? App.humano.quien(o.por) : 'Vos') + ' · ' + App.hace(o.ts))),
              h('div.con-frag', o.fragmento),
              o.motivo ? h('div.ayuda', 'Motivo: ' + o.motivo) : null,
              App.acciones(null, [botonAbrir(o.ref), h('button.btn.chico.primario', { onclick: function () {
                api.del('/api/conocimiento/obsoleto?ref=' + encodeURIComponent(o.hash)).then(refrescar).catch(App.fallo);
              } }, 'Sigue valiendo')]));
          });
          cont.appendChild(App.seccion('Marcado como desactualizado', filasObs, { cuenta: String(obs.length) }));
        }
      }).catch(function (e) { App.vaciar(cont).appendChild(vacio(e.message)); });
    }
    cargar();
  }

  function pintarQuien(cuerpo, hj) {
    var inp = h('input.campo', { placeholder: '¿Quién sabe de…? Ej.: presupuesto de anuncios', autofocus: true });
    var res = h('div'), tabla = h('div', cargando('Trayendo al equipo…'));
    App.add(cuerpo, h('div.con-barra', h('div', { style: { flex: 1, minWidth: '220px' } }, inp)), res, h('div.con-sec-tit', 'Lo que sabe cada uno'), tabla);
    function buscar() {
      var t = inp.value.trim();
      if (!t) { App.vaciar(res); return; }
      api.get('/api/conocimiento/quien-sabe', { tema: t }).then(function (r) {
        if (inp.value.trim() !== t) return;
        App.vaciar(res);
        if (!r.expertos.length) { res.appendChild(h('div.ayuda', { style: { padding: '0 2px 8px' } }, 'Nadie tiene ese tema marcado ni respondió sobre eso todavía.')); return; }
        r.expertos.forEach(function (e, i) {
          res.appendChild(h('div.con-item', h('div.con-cab', i === 0 ? h('span.insignia.ok', 'Mejor opción') : null, h('span.con-tit', e.nombre + ' · ' + e.rol)),
            h('div.ayuda', e.motivos.join(' · ')), e.ejemplo ? h('div.ayuda', 'Por ejemplo: «' + e.ejemplo + '»') : null));
        });
      }).catch(App.fallo);
    }
    inp.addEventListener('input', App.debounce(buscar, 300));
    api.get('/api/conocimiento/preguntas').then(function (r) {
      var cuenta = {};
      (r.preguntas || []).forEach(function (p) { cuenta[p.agente] = (cuenta[p.agente] || 0) + 1; });
      App.vaciar(tabla);
      var ags = App.E.oficina.agentes || [];
      if (!ags.length) { tabla.appendChild(vacio('Todavía no hay agentes.')); return; }
      ags.forEach(function (a) {
        var temas = a.sabeDe || [];
        tabla.appendChild(h('div.con-item', h('div.con-cab', h('span.con-tit', a.nombre + ' · ' + a.rol),
          h('span.con-meta', cuenta[a.id] ? cuenta[a.id] + (cuenta[a.id] === 1 ? ' respuesta guardada' : ' respuestas guardadas') : ''),
          h('button.btn.chico.fantasma', { onclick: function () { hj.cerrar(); App.Agente.abrir(a.id, 'perfil'); } }, App.icono('lapiz'), 'Editar')),
          temas.length ? h('div.con-temas', temas.map(function (t) { return h('span.con-tema', t); }))
            : h('div.ayuda', 'Sin temas marcados. Editalo en su perfil («Sabe de») o aceptá las sugerencias en «Sugerencias».')));
      });
    }).catch(function (e) { App.vaciar(tabla).appendChild(vacio(e.message)); });
  }

  /* `busqueda` (opcional): texto con el que abre la pestaña Buscar (lo usa ⌘K). También se puede dejar en
     App.Conocimiento.busquedaPendiente antes de navegar a #/archivos/conocimiento. */
  function abrir(pestanaInicial, busqueda) {
    if (App.Agente && App.Agente.alCerrar) App.Agente.alCerrar();
    var hj = App.hojaEnPanel({ titulo: 'Conocimiento', icono: 'bombilla', sinPie: true }, 'conocimiento');
    var pend = busqueda || (App.Conocimiento && App.Conocimiento.busquedaPendiente) || '';
    if (App.Conocimiento) App.Conocimiento.busquedaPendiente = '';
    var pestana = pestanaInicial || 'buscar';
    var estado = pend ? { q: pend } : {};
    var tabs = h('div.pestanas'), cuerpo = h('div.con-cuerpo');
    App.add(hj.cuerpo, h('div.con', tabs, cuerpo));
    hj.cuerpo.style.padding = '0';
    function contarRevisar() {
      api.get('/api/conocimiento/estado').then(function (st) {
        var n = contar(st);
        var b = tabs.querySelector('[data-p="revisar"] .insignia');
        if (b) { b.textContent = n; b.className = 'insignia' + (st.pendientes ? ' aviso' : '') + (n ? '' : ' oculto'); }
      }).catch(function () {});
    }
    function pintar() {
      App.vaciar(tabs);
      [['buscar', 'Buscar'], ['preguntas', 'Preguntas frecuentes'], ['revisar', 'Sugerencias'], ['quien', 'Quién sabe qué']].forEach(function (p) {
        tabs.appendChild(h('button.pestana' + (pestana === p[0] ? '.activa' : ''), { 'data-p': p[0], onclick: function () { pestana = p[0]; pintar(); } },
          p[1], p[0] === 'revisar' ? h('span.insignia.oculto', { style: { marginLeft: '6px' } }) : null));
      });
      App.vaciar(cuerpo);
      if (pestana === 'buscar') pintarBuscar(cuerpo, estado);
      else if (pestana === 'preguntas') pintarPreguntas(cuerpo, estado);
      else if (pestana === 'revisar') pintarRevisar(cuerpo, contarRevisar);
      else pintarQuien(cuerpo, hj);
      contarRevisar();
      var f = cuerpo.querySelector('[autofocus]'); if (f) setTimeout(function () { f.focus(); }, 30);
    }
    pintar();
  }

  App.Conocimiento = { abrir: abrir, vigilarEstado: vigilarEstado, busquedaPendiente: '' };
})();
