/* Ajustes de la oficina (docs/plan-creador-flujos.md §9 y §12): hojas «Reglas de la oficina» y «Conectores».
   Reglas: lista editable que se guarda entera con PUT /api/reglas. Conectores: lo que detectó claude en claude.ai y la tabla
   agente × servidor con Leer y Actuar (cada check asigna todas las herramientas de ese tipo). */
window.App = window.App || {};
App.Ajustes = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };
  var api = function () { return App.api; };
  var MAX_REGLAS = 40;

  /* App.api no tiene PUT (base.js no es de este módulo): mismo contrato de errores que App.api */
  function put(ruta, cuerpo) {
    return fetch(ruta, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : {}; } catch (e) { d = null; }
        if (!r.ok) { var e = new Error((d && d.error) || ('Error ' + r.status)); e.status = r.status; throw e; }
        return d || {};
      });
    });
  }

  /* Conectores nuevos de un agente. `porServ` = {servidor: {leer?: bool, actuar?: bool}} con lo que la persona tocó: eso se reemplaza
     por todas las herramientas de ese tipo; lo que no se tocó (y los servidores que ya no aparecen) queda como estaba. */
  function delTipo(s, tipo) { return (s.herramientas || []).filter(function (t) { return t.tipo === tipo; }).map(function (t) { return t.nombre; }); }
  function nuevosConectores(a, servidores, porServ) {
    porServ = porServ || {};
    var orig = a.conectores || [], salida = [];
    function serv(nom) { return (servidores || []).filter(function (x) { return x.nombre === nom; })[0]; }
    orig.forEach(function (c) {
      if (!serv(c.servidor) || !porServ[c.servidor]) salida.push({ servidor: c.servidor, leer: (c.leer || []).slice(), actuar: (c.actuar || []).slice() });
    });
    Object.keys(porServ).forEach(function (nom) {
      var s = serv(nom); if (!s) return;
      var o = orig.filter(function (c) { return c.servidor === nom; })[0] || { leer: [], actuar: [] };
      var t = porServ[nom], leer = (o.leer || []).slice(), actuar = (o.actuar || []).slice();
      if (t.leer !== undefined) leer = t.leer ? delTipo(s, 'leer') : [];
      if (t.actuar !== undefined) actuar = t.actuar ? delTipo(s, 'actuar') : [];
      if (t.leer !== undefined && t.actuar === undefined) actuar = actuar.filter(function (n) { return leer.indexOf(n) < 0; });
      if (t.actuar !== undefined && t.leer === undefined) leer = leer.filter(function (n) { return actuar.indexOf(n) < 0; });
      if (leer.length || actuar.length) salida.push({ servidor: nom, leer: leer, actuar: actuar });
    });
    return salida;
  }

  /* «claude_ai_Gmail» → «Gmail»: el nombre del servidor como se lo dirías a alguien */
  function nombreServidor(n) {
    var t = String(n || '').replace(/^claude[_ .-]?ai[_ .-]+/i, '').replace(/^plugin_[^_]+_/, '').replace(/[_-]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : String(n || '');
  }

  /* ---------------- reglas ---------------- */
  /* `crear` (opcional) reemplaza a App.hoja: la ventana de Ajustes lo usa para dibujar la sección adentro */
  function reglas(crear) {
    var hj = (crear || App.hoja)({ titulo: 'Reglas de la oficina', ancho: 580 });
    var lista = h('div'), err = h('div.error-txt');
    var filas = [];     // [{id, origen, txt}]
    var guardar = h('button.btn.primario', { disabled: true, onclick: enviar }, 'Guardar');
    var mas = h('button.btn.izq', { onclick: function () { agregar({ texto: '' }, true); } }, App.icono('mas'), 'Nueva regla');
    App.add(hj.cuerpo, h('div.ayuda', { style: { marginTop: 0, marginBottom: '12px' } }, 'Valen para todos los agentes: se suman a sus instrucciones.'), lista, err);
    App.add(hj.pie, mas, hj.enVentana ? null : h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
    App.add(lista, App.cargando('Trayendo las reglas…'));

    function vacia() {
      if (!filas.length) lista.appendChild(h('div.vacio', 'Todavía no hay reglas. Por ejemplo: «No inventes datos: si falta algo, preguntalo».'));
    }
    function agregar(r, foco) {
      var item = { id: r.id, origen: r.origen };
      item.txt = h('textarea.campo', { rows: 2, maxlength: 600, placeholder: 'Una regla corta y concreta, en segunda persona.' });
      item.txt.value = r.texto || '';
      item.el = h('div.regla-fila', h('div.regla-cuerpo', item.txt, r.origen ? h('div.regla-cita', r.origen) : null),
        h('button.btn.fantasma.icono', { title: 'Quitar', onclick: function () {
          filas.splice(filas.indexOf(item), 1); item.el.remove(); vacia();
        } }, App.icono('papelera')));
      if (!filas.length) App.vaciar(lista);
      filas.push(item); lista.appendChild(item.el);
      if (filas.length >= MAX_REGLAS) mas.disabled = true;
      if (foco) item.txt.focus();
    }
    function enviar() {
      var rs = filas.map(function (f) {
        var o = { texto: f.txt.value.trim() };
        if (f.id) o.id = f.id;
        if (f.origen) o.origen = f.origen;
        return o;
      }).filter(function (o) { return o.texto; });
      guardar.disabled = true; err.textContent = '';
      put('/api/reglas', { reglas: rs }).then(function () {
        hj.cerrar();
        App.aviso(rs.length ? 'Reglas guardadas.' : 'Sin reglas.');
      }).catch(function (e) { err.textContent = e.message; guardar.disabled = false; });
    }

    api().get('/api/reglas').then(function (r) {
      App.vaciar(lista);
      (r.reglas || []).forEach(function (x) { agregar(x); });
      vacia();
      guardar.disabled = false;
    }).catch(function (e) { App.vaciar(lista).appendChild(h('div.error-txt', e.message)); });
  }

  /* ---------------- conectores ----------------
     Arriba la decisión (todos usan todos / elegir por agente); después cada servidor detectado, con su detalle plegado; y,
     si se elige por agente, qué usa cada uno. Todo se guarda al tocarlo (con «Deshacer»). */
  function conectores(crear) {
    var vivo = true, reloj = null;
    var actualizar = h('button.btn.chico', { onclick: refrescar }, App.icono('recargar'), 'Actualizar');
    var hj = crear({ titulo: 'Conectores', ancho: 760, acciones: [actualizar], alCerrar: function () { vivo = false; clearTimeout(reloj); } });
    var cont = h('div'), err = h('div.error-txt');
    var datos = null;
    var cola = Promise.resolve();   // los guardados de a uno: cada uno parte de lo que quedó guardado
    App.add(hj.cuerpo, cont, err);
    /* en una ventana suelta (no en Ajustes) no hay cabecera de sección: «Actualizar» va en el pie */
    if (!hj.enVentana) App.add(hj.pie, actualizar, h('button.btn.primario', { onclick: hj.cerrar }, 'Listo'));
    App.add(cont, App.cargando('Trayendo los conectores…'));

    function cargar() {
      api().get('/api/conectores').then(function (r) {
        if (!vivo) return;
        datos = r;
        pintar();
        // mientras detecta, se vuelve a preguntar cada 2 s
        clearTimeout(reloj);
        if (r.detectando) reloj = setTimeout(function () { if (vivo) cargar(); }, 2000);
      }).catch(function (e) { if (vivo) App.vaciar(cont).appendChild(h('div.error-txt', e.message)); });
    }
    function refrescar() {
      actualizar.disabled = true; err.textContent = '';
      // el POST espera a que termine la detección: mientras tanto se muestra «detectando»
      if (datos) { datos.detectando = true; pintar(); }
      api().post('/api/conectores/actualizar').then(function (r) {
        if (!vivo) return;
        if (r.error) err.textContent = r.error;
        datos = r; pintar();
      }).catch(function (e) { if (vivo) { err.textContent = e.message; if (datos) { datos.detectando = false; pintar(); } } })
        .then(function () { actualizar.disabled = false; });
    }

    function insigniaTipo(t) { return h('span.insignia.' + (t === 'leer' ? 'leer' : 'actuar'), t === 'leer' ? 'leer' : 'actuar'); }

    /* «3 para leer · 2 para actuar» */
    function resumen(s) {
      var l = delTipo(s, 'leer').length, a = delTipo(s, 'actuar').length;
      return [l ? l + ' para leer' : null, a ? a + ' para actuar' : null].filter(Boolean).join(' · ') || 'Sin herramientas';
    }
    function filaServidor(s) {
      var tools = s.herramientas || [];
      return h('details.cx-fila' + (s.disponible ? '' : '.no'),
        h('summary',
          h('span.cx-nom', nombreServidor(s.nombre)),
          s.disponible ? null : h('span.insignia', s.estado === 'needs-auth' ? 'Falta autorizar' : 'No disponible'),
          h('span.cx-resumen', s.disponible ? resumen(s) : 'Conectalo en claude.ai')),
        tools.length ? h('div.cx-herr', tools.map(function (t) { return h('span', insigniaTipo(t.tipo), t.corto); })) : null);
    }

    function pintar() {
      App.vaciar(cont);
      var servs = (datos && datos.servidores) || [];
      if (datos.detectando) {
        cont.appendChild(h('div.ayuda.cx-estado', 'Mirando qué conectores tenés en claude.ai… puede tardar un minuto. Mientras tanto ves lo último que se detectó.'));
      } else if (datos.detectado) {
        cont.appendChild(h('div.ayuda.cx-estado', 'Detectado ' + App.hace(datos.detectado) + '.'));
      }
      var disp = servs.filter(function (s) { return s.disponible; });
      var agentes = (App.E.oficina && App.E.oficina.agentes) || [];
      if (!servs.length) {
        if (!datos.detectando) cont.appendChild(App.vacio('enchufe', 'No se detectó ningún conector', 'Conectalos en claude.ai y tocá «Actualizar».'));
        return;
      }
      if (disp.length && agentes.length) cont.appendChild(eleccionAcceso());
      cont.appendChild(App.seccion('Conectores detectados', h('div.cx-lista', servs.map(filaServidor)),
        { ayuda: 'Leer son las herramientas que solo consultan. Actuar son las que hacen algo afuera, y siempre piden tu aprobación.' }));
      if (!disp.length || !agentes.length || modoAcceso() === 'todos') return;
      var cab1 = h('tr', h('th', 'Agente'), disp.map(function (s) { return h('th', { colspan: 2 }, nombreServidor(s.nombre)); }));
      var cab2 = h('tr.cx-sub', h('th'), disp.map(function () { return [h('th', 'Leer'), h('th', 'Actuar')]; }));
      var filas = agentes.map(function (a) {
        return h('tr', h('td', h('span.cx-agente', App.retratoImg(a, 'retrato', 64), a.nombre)),
          disp.map(function (s) { return [celda(a, s, 'leer'), celda(a, s, 'actuar')]; }));
      });
      cont.appendChild(App.seccion('Qué usa cada agente', h('div.cx-tabla-caja', h('table.cx-tabla', h('thead', cab1, cab2), h('tbody', filas)))));
    }

    /* `conectores_agentes` (toda la app, PUT /api/preferencias): «todos» = cada agente usa todos los conectores
       conectados (leer libre; actuar siempre como propuesta que aprobás); «por_agente» = la tabla de abajo. */
    function modoAcceso() { return (App.E.estado && App.E.estado.conectores_agentes) || 'por_agente'; }
    var ACCESOS = [
      { valor: 'todos', titulo: 'Todos los agentes usan todos los conectores · más simple',
        sub: 'Cada agente puede leer con cualquier conector conectado. Mandar, publicar o crear algo afuera sigue siendo una propuesta que aprobás vos.' },
      { valor: 'por_agente', titulo: 'Elegir por agente',
        sub: 'Marcás en una tabla qué conectores usa cada agente, para leer y para actuar.' },
    ];
    function eleccionAcceso() {
      var el = App.elegir({ forma: 'lista', etiqueta: 'Acceso de los agentes', opciones: ACCESOS, valor: modoAcceso(), alCambiar: elegirAcceso });
      return App.seccion('Acceso de los agentes', el);
    }
    function elegirAcceso(id) {
      var antes = modoAcceso();
      if (id === antes) return;
      err.textContent = '';
      function poner(v, silencioso) {
        return api().put('/api/preferencias', { conectores_agentes: v }).then(function (r) {
          if (App.E && App.E.estado) App.E.estado.conectores_agentes = r.conectores_agentes;
          if (!vivo) return;
          if (!silencioso) App.guardado(v === 'todos' ? 'Todos los agentes usan todos los conectores.' : 'Elegís qué conectores usa cada agente.', function () { poner(antes, true); });
          pintar();
        }).catch(function (e) { if (vivo) { err.textContent = e.message; pintar(); } });
      }
      poner(id);
    }

    function asignado(a, s) {
      var ag = App.agente(a.id) || a;
      return ((ag.conectores || []).filter(function (c) { return c.servidor === s.nombre; })[0]) || { leer: [], actuar: [] };
    }
    function celda(a, s, tipo) {
      var todas = delTipo(s, tipo);
      var td = h('td');
      if (!todas.length) { td.appendChild(h('span', { style: { color: 'var(--tenue)' } }, '–')); return td; }
      var asig = asignado(a, s), lista = (asig[tipo] || []);
      var tiene = todas.filter(function (n) { return lista.indexOf(n) >= 0; }).length;
      var ck = h('input', { type: 'checkbox', title: (tipo === 'leer' ? 'Puede leer con ' : 'Puede actuar con ') + nombreServidor(s.nombre) });
      ck.checked = tiene === todas.length; ck.indeterminate = tiene > 0 && tiene < todas.length;
      ck.addEventListener('change', function () { ck.indeterminate = false; guardarCelda(a.id, s.nombre, tipo, ck); });
      td.appendChild(ck);
      return td;
    }

    /* se guarda al marcar: un PATCH por cambio, en fila, sobre lo último guardado */
    function guardarCelda(id, serv, tipo, ck) {
      var valor = ck.checked, previo = null, nombre = '';
      cola = cola.then(function () {
        var ag = App.agente(id); if (!ag) return null;
        nombre = ag.nombre;
        previo = JSON.parse(JSON.stringify(ag.conectores || []));
        var t = {}; t[tipo] = valor;
        var porServ = {}; porServ[serv] = t;
        return api().patch('/api/agentes/' + encodeURIComponent(id), { conectores: nuevosConectores(ag, datos.servidores, porServ) }).then(function (r) {
          App.actualizar(r.oficina);
          App.guardado(nombre + ': ' + nombreServidor(serv) + ' guardado.', function () {
            api().patch('/api/agentes/' + encodeURIComponent(id), { conectores: previo }).then(function (r2) { App.actualizar(r2.oficina); if (vivo) pintar(); }).catch(App.fallo);
          });
        });
      }).catch(function (e) { App.fallo(e); ck.checked = !valor; });
    }

    cargar();
  }

  /* ---------------- ventana de Ajustes ----------------
     Una sola hoja con las secciones a la izquierda (en el celular, la lista primero y al tocar se entra). Cada sección es
     la misma función que antes abría su propia hoja: recibe `crear` en lugar de App.hoja y dibuja adentro. Ahí, `cerrar`
     vuelve a dibujar la sección (después de guardar se ve lo guardado) y `enVentana` le avisa que no ponga «Cancelar». */
  var atajo = /Mac/.test(navigator.platform || navigator.userAgent) ? '⌘,' : 'Ctrl+,';

  function modoPermisos() {
    var m = App.E.estado && App.E.estado.modo_permisos;
    return m === 'auto' ? 'Automático' : m === 'preguntar' ? 'Preguntarme siempre' : '';
  }
  var SECCIONES = [
    { id: 'general', grupo: 'oficina', texto: 'General', icono: 'edificio', pintar: function (c) { App.editarOficina(c); } },
    { id: 'reglas', grupo: 'oficina', texto: 'Reglas', icono: 'regla', pintar: function (c) { reglas(c); } },
    { id: 'conectores', grupo: 'oficina', texto: 'Conectores', icono: 'enchufe', pintar: function (c) { conectores(c); } },
    { id: 'avanzado', grupo: 'oficina', texto: 'Avanzado', icono: 'deslizadores', pintar: avanzado },
    /* la elige la persona la primera vez que abre la app (permisos.js); acá se ve y se cambia */
    { id: 'permisos', grupo: 'app', texto: 'Permisos de los agentes', icono: 'escudo', nota: modoPermisos,
      visible: function () { return !!(App.Permisos && (App.Permisos.pintarModo || App.Permisos.abrirModo)); }, pintar: permisos },
    { id: 'modelos', grupo: 'app', texto: 'Modelos', icono: 'bombilla', pintar: modelos },
    { id: 'consumo', grupo: 'app', texto: 'Consumo de IA', icono: 'medidor', pintar: consumo },
    { id: 'apariencia', grupo: 'app', texto: 'Apariencia', icono: 'capas', nota: function () { return App.estiloOficina === 'lego' ? 'Maqueta LEGO' : 'Pixel'; }, pintar: apariencia },
  ];

  /* `estilo_oficina` (toda la app, PUT /api/preferencias): cómo se dibuja la oficina. Cambiarlo recarga la app. */
  var ESTILOS = [
    { valor: 'pixel', titulo: 'Pixel', sub: 'La oficina en pixel art, con salas, ventanales que siguen la hora y agentes que caminan.' },
    { valor: 'lego', titulo: 'Maqueta LEGO', sub: 'La maqueta 3D de antes. Queda como opción, pero no recibe novedades.' },
  ];
  function apariencia(crear) {
    var hj = crear({ titulo: 'Apariencia' }), err = h('div.error-txt');
    var el = App.elegir({ forma: 'lista', etiqueta: 'Estilo de la oficina', opciones: ESTILOS, valor: App.estiloOficina,
      alCambiar: function (v) {
        if (v === App.estiloOficina) return;
        err.textContent = '';
        api().put('/api/preferencias', { estilo_oficina: v }).then(function (r) {
          if (App.E && App.E.estado) App.E.estado.estilo_oficina = r.estilo_oficina;
          location.reload();
        }).catch(function (e) { err.textContent = e.message; el.poner(App.estiloOficina); });
      } });
    hj.cuerpo.appendChild(App.ajuste('Estilo de la oficina', 'Vale para todas tus oficinas. Al cambiarlo, la app se vuelve a abrir.', el));
    hj.cuerpo.appendChild(err);
  }

  /* `modelos` (toda la app, PUT /api/preferencias): los procesos que no son un agente de la oficina. El de cada agente se
     elige en su ficha. Se guarda al elegir; vale desde la próxima corrida. La lista de modelos es una sola (App.MODELOS). */
  var PROCESOS = [
    { clave: 'creador', titulo: 'Creador', bajada: 'El de la recepción, que arma y cambia la oficina charlando.' },
    { clave: 'internos', titulo: 'Tareas de fondo', bajada: 'Borradores de agentes nuevos, fichas e imágenes de la biblioteca y resúmenes de reuniones.' },
  ];
  function modelos(crear) {
    var hj = crear({ titulo: 'Modelos' });
    var err = h('div.error-txt');
    var actual = Object.assign({}, (App.E.estado && App.E.estado.modelos) || {});
    var lista = App.MODELOS || [];
    function titulo(v) { var m = lista.filter(function (x) { return x.valor === v; })[0]; return m ? m.titulo : v; }
    App.add(hj.cuerpo,
      h('div.ayuda', { style: { marginTop: 0 } }, 'Vale para todas tus oficinas. El modelo de cada agente se elige en su ficha.'),
      h('ul.modelos-leyenda', lista.map(function (m) { return h('li', h('b', m.titulo), ' · ' + m.sub); })));
    PROCESOS.forEach(function (p) {
      var el = App.elegir({ forma: 'chips', etiqueta: p.titulo, valor: actual[p.clave],
        opciones: lista.map(function (m) { return { valor: m.valor, titulo: m.titulo, sub: m.sub }; }),
        alCambiar: function (v) { poner(p, v, false); } });
      function poner(p2, v, silencioso) {
        var antes = actual[p2.clave];
        var cuerpo = { modelos: {} }; cuerpo.modelos[p2.clave] = v;
        err.textContent = '';
        api().put('/api/preferencias', cuerpo).then(function (r) {
          if (App.E && App.E.estado) App.E.estado.modelos = r.modelos;
          actual = Object.assign({}, (App.E.estado && App.E.estado.modelos) || actual);
          if (!silencioso) App.guardado(p2.titulo + ': ' + titulo(v) + '.', antes ? function () { el.poner(antes); poner(p2, antes, true); } : null);
        }).catch(function (e) { err.textContent = e.message; el.poner(actual[p2.clave]); });
      }
      hj.cuerpo.appendChild(App.ajuste(p.titulo, p.bajada, el));
    });
    hj.cuerpo.appendChild(err);
  }

  /* `ia` (toda la app, PUT /api/preferencias): esfuerzo y opciones de consumo por defecto. Valen para todo lo que usa la IA
     (charlas, reuniones, tareas, flujos, consultas y tareas de fondo); el esfuerzo de un agente (su ficha) le gana, y cada
     charla o reunión nueva puede cambiarlos para sí. Se guarda al elegir. */
  /* opciones de consumo con más de dos valores: su orden en el deslizador, de menos a más tokens */
  var ESCALAS_IA = { skills: ['ninguna', 'agente', 'resumidas', 'completas'] };
  function consumo(crear) {
    var hj = crear({ titulo: 'Consumo de IA' });
    var err = h('div.error-txt');
    App.add(hj.cuerpo, h('div.ayuda', { style: { marginTop: 0 } },
      'Vale para todas tus oficinas y para todo lo que hace la IA: charlas, reuniones, tareas, flujos y consultas entre colegas. ' +
      'Cada charla y cada reunión nueva lo pueden cambiar para sí, y el esfuerzo de un agente se elige en su ficha.'));
    function guardar(clave, valor, el, antes, texto) {
      var cuerpo = { ia: {} }; cuerpo.ia[clave] = valor;
      err.textContent = '';
      api().put('/api/preferencias', cuerpo).then(function (r) {
        if (App.E && App.E.estado) App.E.estado.ia = r.ia;
        App.guardado(texto + '.', function () { el.poner(antes); guardar(clave, antes, el, valor, texto); });
      }).catch(function (e) { err.textContent = e.message; el.poner(antes); });
    }
    var ia = App.iaApp();
    /* Esfuerzo y skills van en escala (deslizador), de lo que menos gasta a lo que más; las de sí o no, en interruptor */
    var esf = App.elegir({ forma: 'deslizador', etiqueta: 'Esfuerzo', valor: ia.esfuerzo,
      opciones: App.ESFUERZOS.map(function (m) { return { valor: m.valor, titulo: m.titulo, sub: m.sub, aparte: m.valor === '' }; }),
      alCambiar: function (v) { var antes = App.iaApp().esfuerzo; guardar('esfuerzo', v, esf, antes, 'Esfuerzo: ' + App.tituloEsfuerzo(v)); } });
    hj.cuerpo.appendChild(App.ajuste('Esfuerzo', 'Cuánto piensa antes de responder. Lo que piensa se cobra como texto escrito: para el día a día, Bajo o Medio alcanza.', esf));
    App.OPCIONES_IA.forEach(function (o) {
      var escala = ESCALAS_IA[o.clave];
      var opciones = escala ? escala.map(function (v) { return o.opciones.filter(function (x) { return x.valor === v; })[0]; }) : o.opciones;
      var el = App.elegir({ forma: escala ? 'deslizador' : o.opciones.length === 2 ? 'interruptor' : 'chips', etiqueta: o.titulo, valor: ia[o.clave],
        opciones: opciones.map(function (x) { return { valor: x.valor, titulo: x.titulo, sub: x.sub }; }),
        alCambiar: function (v) { var antes = App.iaApp()[o.clave]; guardar(o.clave, v, el, antes, o.titulo + ': ' + App.tituloOpcionIA(o, v)); } });
      hj.cuerpo.appendChild(App.ajuste(o.titulo, o.sub, el));
    });
    hj.cuerpo.appendChild(err);
  }

  function avanzado(crear) {
    var hj = crear({ titulo: 'Avanzado' });
    function fila(titulo, bajada, boton, accion, peligro) {
      return App.ajuste(peligro ? h('span.txt-peligro', titulo) : titulo, bajada, h('button.btn.chico' + (peligro ? '.peligro' : ''), { onclick: accion }, boton));
    }
    App.add(hj.cuerpo,
      fila('Exportar oficina', 'Un archivo .zip para compartirla o pasarla a otra compu.', 'Exportar…', function () { App.exportarOficina(); }),
      fila('Borrar oficina', App.nativo.hay ? 'Se borran sus conversaciones y tareas; la carpeta va a la papelera.' : 'Se borran sus conversaciones y tareas.', 'Borrar…', function () { App.borrarOficina(); }, true));
  }

  function permisos(crear) {
    if (App.Permisos.pintarModo) { App.Permisos.pintarModo(crear); return; }
    var hj = crear({ titulo: 'Permisos de los agentes' });
    App.add(hj.cuerpo,
      h('div.ayuda', { style: { marginTop: 0 } }, 'Vale para todas tus oficinas. Los agentes corren comandos y escriben archivos en tu compu: elegí cuánto querés que te pregunten.'),
      App.ajuste('Modo actual', modoPermisos() || 'Sin elegir',
        h('button.btn.chico', { onclick: function () { App.Permisos.abrirModo(function () { hj.cerrar(); }); } }, 'Cambiar…')));
  }

  function abrir(id) {
    if (!App.E.oficina) return;
    var actual = null, idActual = null;
    var hj = App.hoja({ titulo: 'Ajustes', ancho: 860, alto: '620px', sinPie: true, alCerrar: function () { soltar(); } });
    hj.el.classList.add('hoja-ajustes');
    var nav = h('nav.aj-nav');
    var tit = h('h3.aj-tit'), cuerpo = h('div.aj-cuerpo'), pie = h('div.aj-pie'), acc = h('div.aj-cab-acc');
    var atras = h('button.btn.fantasma.chico.aj-atras', { onclick: function () { caja.classList.remove('aj-dentro'); } }, App.icono('atras'), 'Ajustes');
    var sec = h('section.aj-sec', h('div.aj-cab', atras, tit, acc), cuerpo, pie);
    var caja = h('div.aj', nav, sec);
    hj.cuerpo.appendChild(caja);

    var visibles = SECCIONES.filter(function (s) { return !s.visible || s.visible(); });
    function grupo(g, titulo) {
      var ss = visibles.filter(function (s) { return s.grupo === g; });
      if (!ss.length) return;
      nav.appendChild(h('div.aj-grupo', titulo));
      ss.forEach(function (s) {
        var nota = s.nota ? s.nota() : '';
        nav.appendChild(h('button.aj-item', { 'data-id': s.id, onclick: function () { ir(s.id); } }, App.icono(s.icono), h('span', s.texto),
          s.nota ? h('small', nota) : null, h('span.aj-flecha', App.icono('flecha'))));
      });
    }
    grupo('oficina', App.E.oficina.nombre);
    grupo('app', 'Toda la app');
    if (App.nativo.hay) App.add(nav, h('div', { style: { flex: 1 } }), h('button.aj-item.aj-tenue', { onclick: App.nativo.acerca }, App.icono('chispa'), h('span', 'Acerca de')));

    function soltar() { if (actual && actual.alCerrar) actual.alCerrar(); actual = null; }
    /* reemplazo de App.hoja para las secciones */
    function crear(op) {
      soltar();
      App.vaciar(cuerpo); App.vaciar(pie); App.vaciar(acc); cuerpo.scrollTop = 0;
      tit.textContent = op.titulo || '';
      if (op.acciones) App.add(acc, op.acciones);   // botones de la sección en su cabecera (p. ej. «Actualizar»)
      var obj = { enVentana: true, el: sec, cuerpo: cuerpo, pie: pie, alCerrar: op.alCerrar,
        titulo: function (t) { tit.textContent = t; },
        cerrar: function () { if (actual === obj) ir(idActual); } };
      actual = obj;
      return obj;
    }
    function ir(sid) {
      var s = visibles.filter(function (x) { return x.id === sid; })[0] || visibles[0];
      idActual = s.id;
      nav.querySelectorAll('.aj-item[data-id]').forEach(function (b) {
        b.classList.toggle('sel', b.getAttribute('data-id') === s.id);
        /* la nota (p. ej. el modo de permisos) puede haber cambiado desde otra hoja */
        var x = visibles.filter(function (y) { return y.id === b.getAttribute('data-id'); })[0], small = b.querySelector('small');
        if (x && x.nota && small) small.textContent = x.nota();
      });
      caja.classList.add('aj-dentro');
      s.pintar(crear);
      pie.classList.toggle('oculto', !pie.children.length);
    }
    /* en el celular, sin sección pedida, se arranca por la lista */
    var angosto = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
    ir(id || 'general');
    if (angosto && !id) caja.classList.remove('aj-dentro');
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === ',' && App.E.oficina && !(App.hojaAbierta && App.hojaAbierta())) { e.preventDefault(); abrir(); }
  });

  return { reglas: reglas, conectores: conectores, nuevosConectores: nuevosConectores, delTipo: delTipo, nombreServidor: nombreServidor, abrir: abrir, atajo: atajo };
})();
