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
    App.add(lista, h('div.vacio', h('span.giro')));

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

  /* ---------------- conectores ---------------- */
  function conectores(crear) {
    var vivo = true, reloj = null;
    var hj = (crear || App.hoja)({ titulo: 'Conectores', ancho: 760, alCerrar: function () { vivo = false; clearTimeout(reloj); } });
    var cont = h('div'), err = h('div.error-txt');
    var datos = null;
    var cambios = {};      // agenteId -> { servidor -> { leer: bool, actuar: bool } } solo lo tocado
    var actualizar = h('button.btn.izq', { onclick: refrescar }, App.icono('recargar'), 'Actualizar');
    var guardar = h('button.btn.primario', { disabled: true, onclick: enviar }, 'Guardar');
    App.add(hj.cuerpo, cont, err);
    App.add(hj.pie, actualizar, hj.enVentana ? null : h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
    App.add(cont, h('div.vacio', h('span.giro')));

    function cargar() {
      api().get('/api/conectores').then(function (r) {
        if (!vivo) return;
        var primera = !datos;
        datos = r;
        pintar(primera);
        // mientras detecta, se vuelve a preguntar cada 2 s
        clearTimeout(reloj);
        if (r.detectando) reloj = setTimeout(function () { if (vivo) cargar(); }, 2000);
      }).catch(function (e) { if (vivo) App.vaciar(cont).appendChild(h('div.error-txt', e.message)); });
    }
    function refrescar() {
      actualizar.disabled = true; err.textContent = '';
      // el POST espera a que termine la detección: mientras tanto se muestra «detectando»
      if (datos) { datos.detectando = true; pintar(false); }
      api().post('/api/conectores/actualizar').then(function (r) {
        if (!vivo) return;
        if (r.error) err.textContent = r.error;
        datos = r; pintar(false);
      }).catch(function (e) { if (vivo) { err.textContent = e.message; if (datos) { datos.detectando = false; pintar(false); } } })
        .then(function () { actualizar.disabled = false; });
    }

    function insigniaTipo(t) { return h('span.insignia.' + (t === 'leer' ? 'leer' : 'actuar'), t === 'leer' ? 'leer' : 'actuar'); }

    function pintar(primera) {
      App.vaciar(cont);
      var servs = (datos && datos.servidores) || [];
      if (datos.detectando) {
        cont.appendChild(h('div.ayuda', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '0 0 12px' } }, h('span.giro'), 'Mirando qué conectores tenés en claude.ai… puede tardar un minuto.'));
      } else if (datos.detectado) {
        cont.appendChild(h('div.ayuda', { style: { margin: '0 0 12px' } }, 'Detectado ' + App.hace(datos.detectado) + '.'));
      }
      if (!servs.length) {
        cont.appendChild(h('div.vacio', datos.detectando ? '' : 'No se detectó ningún conector. Conectalos en claude.ai y tocá «Actualizar».'));
        return;
      }
      servs.forEach(function (s) {
        var tools = s.herramientas || [];
        cont.appendChild(h('div.cx-serv' + (s.disponible ? '' : '.no'),
          h('div.cx-serv-cab', s.nombre,
            s.disponible ? null : h('span.insignia', s.estado === 'needs-auth' ? 'Falta autorizar' : 'No disponible'),
            s.disponible ? null : h('span.ayuda', 'Conectalo en claude.ai')),
          tools.length ? h('div.cx-herr', tools.map(function (t) { return h('span', { title: t.nombre }, insigniaTipo(t.tipo), t.corto); })) : null));
      });
      var disp = servs.filter(function (s) { return s.disponible; });
      var agentes = (App.E.oficina && App.E.oficina.agentes) || [];
      if (!disp.length || !agentes.length) return;
      cont.appendChild(h('div.separador'));
      cont.appendChild(eleccionAcceso());
      if (modoAcceso() === 'todos') return;
      cont.appendChild(h('h3', { style: { fontSize: '13px', marginBottom: '4px' } }, 'Qué puede usar cada agente'));
      cont.appendChild(h('div.ayuda', { style: { margin: '0 0 8px' } }, 'Leer asigna las herramientas que solo consultan. Actuar asigna las que hacen algo afuera, y siempre piden tu aprobación.'));
      var cab1 = h('tr', h('th', 'Agente'), disp.map(function (s) { return h('th', { colspan: 2 }, s.nombre); }));
      var cab2 = h('tr.cx-sub', h('th'), disp.map(function () { return [h('th', 'Leer'), h('th', 'Actuar')]; }));
      var filas = agentes.map(function (a) {
        return h('tr', h('td', h('span.cx-agente', App.retratoImg(a, 'retrato', 64), a.nombre)),
          disp.map(function (s) { return [celda(a, s, 'leer'), celda(a, s, 'actuar')]; }));
      });
      cont.appendChild(h('div.cx-tabla-caja', h('table.cx-tabla', h('thead', cab1, cab2), h('tbody', filas))));
    }

    /* `conectores_agentes` (toda la app, PUT /api/preferencias): «todos» = cada agente usa todos los conectores
       conectados (leer libre; actuar siempre como propuesta que aprobás); «por_agente» = la tabla de abajo. */
    function modoAcceso() { return (App.E.estado && App.E.estado.conectores_agentes) || 'por_agente'; }
    var ACCESOS = [
      { id: 'todos', titulo: 'Todos los agentes usan todos los conectores', nota: 'más simple',
        bajada: 'Cada agente puede leer con cualquier conector conectado. Mandar, publicar o crear algo afuera sigue siendo una propuesta que aprobás vos.' },
      { id: 'por_agente', titulo: 'Elegir por agente',
        bajada: 'Marcás en una tabla qué conectores usa cada agente, para leer y para actuar.' },
    ];
    function eleccionAcceso() {
      var caja = h('div', { style: { marginBottom: '12px' } });
      caja.appendChild(h('h3', { style: { fontSize: '13px', marginBottom: '8px' } }, 'Acceso de los agentes'));
      ACCESOS.forEach(function (m) {
        var b = h('button.opcion.modo-permiso' + (modoAcceso() === m.id ? '.elegida' : ''), { onclick: function () { elegirAcceso(m.id); } },
          h('div', h('b', m.titulo, m.nota ? h('span.modo-nota', m.nota) : null), h('div.ayuda', { style: { margin: '2px 0 0' } }, m.bajada)));
        caja.appendChild(b);
      });
      return caja;
    }
    function elegirAcceso(id) {
      if (id === modoAcceso()) return;
      err.textContent = '';
      api().put('/api/preferencias', { conectores_agentes: id }).then(function (r) {
        if (App.E && App.E.estado) App.E.estado.conectores_agentes = r.conectores_agentes;
        if (!vivo) return;
        App.aviso(id === 'todos' ? 'Todos los agentes usan todos los conectores.' : 'Elegí qué conectores usa cada agente.');
        pintar(false);
      }).catch(function (e) { if (vivo) err.textContent = e.message; });
    }

    function asignado(a, s) {
      return ((a.conectores || []).filter(function (c) { return c.servidor === s.nombre; })[0]) || { leer: [], actuar: [] };
    }
    function celda(a, s, tipo) {
      var todas = delTipo(s, tipo);
      var td = h('td');
      if (!todas.length) { td.appendChild(h('span', { style: { color: 'var(--tenue)' } }, '–')); return td; }
      var tocado = cambios[a.id] && cambios[a.id][s.nombre] && cambios[a.id][s.nombre][tipo];
      var asig = asignado(a, s), lista = (asig[tipo] || []);
      var tiene = todas.filter(function (n) { return lista.indexOf(n) >= 0; }).length;
      var ck = h('input', { type: 'checkbox', title: tipo === 'leer' ? 'Puede leer con ' + s.nombre : 'Puede actuar con ' + s.nombre });
      if (tocado !== undefined) ck.checked = tocado;
      else { ck.checked = tiene === todas.length; ck.indeterminate = tiene > 0 && tiene < todas.length; }
      ck.addEventListener('change', function () {
        ((cambios[a.id] = cambios[a.id] || {})[s.nombre] = cambios[a.id][s.nombre] || {})[tipo] = ck.checked;
        ck.indeterminate = false;
        guardar.disabled = false;
      });
      td.appendChild(ck);
      return td;
    }

    function enviar() {
      var ids = Object.keys(cambios);
      if (!ids.length) { hj.cerrar(); return; }
      guardar.disabled = true; err.textContent = '';
      var agentes = (App.E.oficina && App.E.oficina.agentes) || [];
      var pend = ids.map(function (id) {
        var a = agentes.filter(function (x) { return x.id === id; })[0]; if (!a) return Promise.resolve();
        return api().patch('/api/agentes/' + encodeURIComponent(id), { conectores: nuevosConectores(a, datos.servidores, cambios[id]) });
      });
      Promise.all(pend).then(function () { return App.recargarOficina(); }).then(function () {
        hj.cerrar(); App.aviso('Conectores guardados.');
      }).catch(function (e) { err.textContent = e.message; guardar.disabled = false; });
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
    { id: 'departamentos', grupo: 'oficina', texto: 'Departamentos', icono: 'capas', pintar: function (c) { App.Deptos.abrir(c); } },
    { id: 'reglas', grupo: 'oficina', texto: 'Reglas', icono: 'regla', pintar: function (c) { reglas(c); } },
    { id: 'conectores', grupo: 'oficina', texto: 'Conectores', icono: 'enchufe', pintar: function (c) { conectores(c); } },
    { id: 'avanzado', grupo: 'oficina', texto: 'Avanzado', icono: 'deslizadores', pintar: avanzado },
    /* la elige la persona la primera vez que abre la app (permisos.js); acá se ve y se cambia */
    { id: 'permisos', grupo: 'app', texto: 'Permisos de los agentes', icono: 'escudo', nota: modoPermisos,
      visible: function () { return !!(App.Permisos && (App.Permisos.pintarModo || App.Permisos.abrirModo)); }, pintar: permisos },
  ];

  function avanzado(crear) {
    var hj = crear({ titulo: 'Avanzado' });
    function fila(titulo, bajada, boton, accion, peligro) {
      return h('div.aj-fila', h('div', { style: { minWidth: 0 } }, h('div', { style: peligro ? { color: 'var(--peligro)' } : null }, titulo), h('div.ayuda', { style: { margin: '2px 0 0' } }, bajada)),
        h('button.btn.chico', { style: peligro ? { color: 'var(--peligro)' } : null, onclick: accion }, boton));
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
      h('div.aj-fila', h('div', h('div', 'Modo actual'), h('div.ayuda', { style: { margin: '2px 0 0' } }, modoPermisos() || 'Sin elegir')),
        h('button.btn.chico', { onclick: function () { App.Permisos.abrirModo(function () { hj.cerrar(); }); } }, 'Cambiar…')));
  }

  function abrir(id) {
    if (!App.E.oficina) return;
    var actual = null, idActual = null;
    var hj = App.hoja({ titulo: 'Ajustes', ancho: 860, alto: '620px', sinPie: true, alCerrar: function () { soltar(); } });
    hj.el.classList.add('hoja-ajustes');
    var nav = h('nav.aj-nav');
    var tit = h('h3.aj-tit'), cuerpo = h('div.aj-cuerpo'), pie = h('div.aj-pie');
    var atras = h('button.btn.fantasma.chico.aj-atras', { onclick: function () { caja.classList.remove('aj-dentro'); } }, App.icono('atras'), 'Ajustes');
    var sec = h('section.aj-sec', h('div.aj-cab', atras, tit), cuerpo, pie);
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
      App.vaciar(cuerpo); App.vaciar(pie); cuerpo.scrollTop = 0;
      tit.textContent = op.titulo || '';
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

  return { reglas: reglas, conectores: conectores, nuevosConectores: nuevosConectores, delTipo: delTipo, abrir: abrir, atajo: atajo };
})();
