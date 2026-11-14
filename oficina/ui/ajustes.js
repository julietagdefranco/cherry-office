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
  function reglas() {
    var hj = App.hoja({ titulo: 'Reglas de la oficina', ancho: 580 });
    var lista = h('div'), err = h('div.error-txt');
    var filas = [];     // [{id, origen, txt}]
    var guardar = h('button.btn.primario', { disabled: true, onclick: enviar }, 'Guardar');
    var mas = h('button.btn.izq', { onclick: function () { agregar({ texto: '' }, true); } }, App.icono('mas'), 'Nueva regla');
    App.add(hj.cuerpo, h('div.ayuda', { style: { marginTop: 0, marginBottom: '12px' } }, 'Valen para todos los agentes: se suman a sus instrucciones.'), lista, err);
    App.add(hj.pie, mas, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
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
  function conectores() {
    var vivo = true, reloj = null;
    var hj = App.hoja({ titulo: 'Conectores', ancho: 760, alCerrar: function () { vivo = false; clearTimeout(reloj); } });
    var cont = h('div'), err = h('div.error-txt');
    var datos = null;
    var cambios = {};      // agenteId -> { servidor -> { leer: bool, actuar: bool } } solo lo tocado
    var actualizar = h('button.btn.izq', { onclick: refrescar }, App.icono('recargar'), 'Actualizar');
    var guardar = h('button.btn.primario', { disabled: true, onclick: enviar }, 'Guardar');
    App.add(hj.cuerpo, cont, err);
    App.add(hj.pie, actualizar, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), guardar);
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

  return { reglas: reglas, conectores: conectores, nuevosConectores: nuevosConectores, delTipo: delTipo };
})();
