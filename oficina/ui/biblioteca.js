/* Biblioteca: archivos de la oficina (subidos o de carpetas vinculadas), su ficha y el conocimiento que generan. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var relojEstado = null, estadoPrevio = null;
  var PROCESANDO = { pendiente: 'En cola', extrayendo: 'Leyendo el texto', fichando: 'Haciendo la ficha', leyendo: 'Los agentes lo están leyendo' };

  function etiquetaEstado(f) {
    if (f.estado === 'listo') return h('span.insignia.ok', 'Listo');
    if (f.estado === 'error') return h('span.insignia.error', { title: f.error || '' }, 'Error');
    return h('span.insignia.aviso', PROCESANDO[f.estado] || f.estado);
  }

  /* estado de la cola: insignia en la barra lateral y aviso cuando termina algo */
  function vigilarEstado() {
    clearTimeout(relojEstado);
    api.get('/api/biblioteca/estado').then(function (st) {
      var b = App.dom && App.dom.navBib;
      if (b) {
        var trabajo = st.pendientes || (st.cola || []).length;
        b.classList.toggle('oculto', !trabajo && !st.propuestas);
        b.className = 'insignia' + (trabajo ? ' aviso' : st.propuestas ? ' ok' : '') + (!trabajo && !st.propuestas ? ' oculto' : '');
        b.textContent = trabajo ? 'Procesando ' + trabajo : st.propuestas ? st.propuestas + (st.propuestas === 1 ? ' propuesta' : ' propuestas') : '';
      }
      var cambio = estadoPrevio && (estadoPrevio.pendientes !== st.pendientes || estadoPrevio.total !== st.total || estadoPrevio.propuestas !== st.propuestas);
      estadoPrevio = st;
      if (cambio) App.emit('biblioteca');
      relojEstado = setTimeout(vigilarEstado, st.pendientes || (st.cola || []).length ? 2500 : 15000);
    }).catch(function () { relojEstado = setTimeout(vigilarEstado, 20000); });
  }

  function abrir() {
    var hj = App.hoja({ titulo: 'Biblioteca', ancho: 1000, alto: 'min(720px, 92vh)', sinPie: true });
    var vista = 'archivos', sel = null, archivos = [];
    var buscar = h('input.campo', { placeholder: 'Buscar en todos los documentos…', style: { maxWidth: '320px' } });
    var dep = h('select.campo', { style: { width: 'auto', minWidth: '200px', flex: 'none' } }, h('option', { value: '' }, 'Todos los departamentos'),
      App.E.oficina.departamentos.map(function (d) { return h('option', { value: d.id }, d.nombre); }), h('option', { value: 'compartido' }, 'Compartido'));
    var input = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: function () { subir(input.files); input.value = ''; } });
    var tabs = h('div.pestanas', { style: { padding: '0 18px', marginBottom: '0' } });
    var lista = h('div.biblio-lista'), det = h('div.biblio-det');
    var biblio = h('div.biblio', lista, det);
    var zona = h('div', { style: { position: 'relative', flex: 1, minHeight: 0 } }, biblio);
    hj.cuerpo.style.cssText = 'padding:0;display:flex;flex-direction:column;overflow:hidden';
    App.add(hj.cuerpo, 
      h('div.biblio-barra', App.icono('buscar'), buscar, dep, h('span', { style: { flex: 1 } }),
        h('button.btn', { onclick: vincular }, App.icono('enlace'), 'Vincular carpeta'),
        h('button.btn.primario', { onclick: function () { input.click(); } }, App.icono('subir'), 'Subir archivos'), input),
      tabs, zona);

    function pintarTabs(np) {
      App.add(App.vaciar(tabs), [['archivos', 'Archivos'], ['vinculos', 'Carpetas vinculadas'], ['propuestas', 'Propuestas' + (np ? ' (' + np + ')' : '')]].map(function (t) {
        return h('button.pestana' + (vista === t[0] ? '.activa' : ''), { onclick: function () { vista = t[0]; sel = null; pintarTabs(np); cargar(); } }, t[1]);
      }));
    }
    pintarTabs(estadoPrevio && estadoPrevio.propuestas);

    var cargar = App.debounce(function () {
      if (vista === 'archivos') cargarArchivos();
      else if (vista === 'vinculos') cargarVinculos();
      else cargarPropuestas();
    }, 150);
    buscar.addEventListener('input', function () { if (vista !== 'archivos') { vista = 'archivos'; pintarTabs(); } cargar(); });
    dep.addEventListener('change', cargar);

    /* ---- archivos ---- */
    function cargarArchivos() {
      det.style.display = '';
      api.get('/api/archivos', { q: buscar.value.trim(), departamento: dep.value }).then(function (r) {
        archivos = r.archivos || [];
        App.vaciar(lista);
        if (!archivos.length) {
          lista.appendChild(h('div.vacio', buscar.value.trim() ? 'No encontré nada con eso.' : h('div', h('p', 'Todavía no hay archivos.'), h('p.ayuda', 'Arrastrá documentos acá o tocá «Subir archivos». Se leen, se fichan y los agentes que les sirve los anotan en su conocimiento.'))));
        }
        archivos.forEach(function (f) {
          var d = App.depto(f.departamento);
          lista.appendChild(h('div.archivo' + (sel === f.slug ? '.sel' : ''), { onclick: function () { sel = f.slug; cargarArchivos(); } },
            h('div.tipo', (f.tipo || '').slice(0, 4)),
            h('div.archivo-txt', h('div.archivo-tit', f.titulo),
              h('div.archivo-meta', [f.nombre, d ? d.nombre : (f.departamento || 'Compartido'), f.origen === 'vinculo' ? 'vinculado' : null, App.fecha(f.actualizado)].filter(Boolean).join(' · ')),
              f.snippet ? h('div.archivo-snip', f.snippet.replace(/[\[\]]/g, '')) : null),
            etiquetaEstado(f)));
        });
        biblio.classList.toggle('con-sel', !!sel);
        if (sel) detalle(sel); else App.vaciar(det).appendChild(h('div.vacio', 'Elegí un archivo para ver su ficha.'));
      }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
    }
    function detalle(slug) {
      api.get('/api/archivos/' + encodeURIComponent(slug)).then(function (r) {
        if (sel !== slug) return;
        var f = r.archivo, fi = f.ficha || {};
        function sec(t, c) { return c ? h('div.det-sec', h('h4', t), c) : null; }
        function ul(l) { return l && l.length ? h('ul', l.map(function (x) { return h('li', x); })) : null; }
        App.add(App.vaciar(det),
          h('button.btn.chico.fantasma.solo-angosto', { style: { marginBottom: '8px' }, onclick: function () { sel = null; cargarArchivos(); } }, App.icono('atras'), 'Todos los archivos'),
          h('h3', { style: { fontSize: '15px', marginBottom: '4px' } }, f.titulo),
          h('div.ayuda', { style: { marginBottom: '12px' } }, f.nombre + ' · ' + App.tam(f.tam || 0)),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' } },
            h('button.btn.chico', { onclick: function () { api.get('/api/archivos/' + encodeURIComponent(slug) + '/original').then(App.abrirContenido).catch(App.fallo); } }, App.icono('abrir'), 'Abrir'),
            f.estado === 'listo' ? h('button.btn.chico', { onclick: function () { api.post('/api/archivos/' + encodeURIComponent(slug) + '/leer', {}).then(function () { App.aviso('Los agentes lo van a leer.'); cargar(); }).catch(App.fallo); } }, 'Que lo lean') : null,
            f.estado === 'error' ? h('button.btn.chico', { onclick: function () { api.post('/api/archivos/' + encodeURIComponent(slug) + '/reprocesar', {}).then(cargar).catch(App.fallo); } }, App.icono('recargar'), 'Reintentar') : null,
            f.origen !== 'vinculo' ? h('button.btn.chico.peligro', { onclick: function () {
              App.confirmar('¿Quitar ' + f.nombre + '?', 'Va a la papelera de la oficina (no se borra) y sale del catálogo.', 'Quitar', true).then(function (si) {
                if (si) api.del('/api/archivos/' + encodeURIComponent(slug)).then(function () { sel = null; cargar(); }).catch(App.fallo);
              });
            } }, 'Quitar') : null),
          f.error ? h('div.error-txt', { style: { marginBottom: '12px' } }, f.error) : null,
          f.aviso ? h('div.ayuda', { style: { marginBottom: '12px' } }, f.aviso) : null,
          sec('Resumen', fi.resumen ? h('p', fi.resumen) : (f.estado !== 'listo' ? h('p.ayuda', PROCESANDO[f.estado] || 'Sin ficha todavía.') : null)),
          sec('Datos clave', ul(fi.datos_clave)),
          sec('Temas', fi.temas && fi.temas.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, fi.temas.map(function (t) { return h('span.insignia', t); })) : null),
          sec('Útil para', fi.util_para && fi.util_para.length ? h('div', fi.util_para.map(function (d) { var x = App.depto(d); return x ? x.nombre : d; }).join(', ')) : null),
          sec('Texto', r.texto ? h('div.texto-largo', r.texto) : null));
      }).catch(function (e) { App.vaciar(det).appendChild(h('div.vacio', e.message)); });
    }

    /* ---- subir (arrastrar o botón) ---- */
    function subir(files) {
      files = Array.prototype.slice.call(files || []);
      if (!files.length) return;
      var depSubir = dep.value || '';
      var i = 0;
      App.aviso('Subiendo ' + files.length + (files.length === 1 ? ' archivo…' : ' archivos…'));
      (function siguiente() {
        if (i >= files.length) { cargar(); vigilarEstado(); return; }
        var f = files[i++];
        var lector = new FileReader();
        lector.onload = function () {
          var b64 = String(lector.result).split(',')[1] || '';
          api.post('/api/archivos', { nombre: f.name, departamento: depSubir || undefined, base64: b64 })
            .then(function (r) { if (r.duplicado) App.aviso(f.name + ' ya estaba en la biblioteca.'); })
            .catch(function (e) { App.aviso(f.name + ': ' + e.message, true); })
            .then(siguiente);
        };
        lector.onerror = function () { App.aviso('No pude leer ' + f.name, true); siguiente(); };
        lector.readAsDataURL(f);
      })();
    }
    var capaSoltar = null;
    zona.addEventListener('dragover', function (e) { e.preventDefault(); if (!capaSoltar) { capaSoltar = h('div.soltar', 'Soltá para subir a la biblioteca'); zona.appendChild(capaSoltar); } });
    zona.addEventListener('dragleave', function (e) { if (capaSoltar && !zona.contains(e.relatedTarget)) { capaSoltar.remove(); capaSoltar = null; } });
    zona.addEventListener('drop', function (e) { e.preventDefault(); if (capaSoltar) { capaSoltar.remove(); capaSoltar = null; } subir(e.dataTransfer.files); });

    /* ---- carpetas vinculadas ---- */
    function cargarVinculos() {
      det.style.display = 'none'; biblio.classList.remove('con-sel');
      api.get('/api/vinculos').then(function (r) {
        App.vaciar(lista);
        lista.appendChild(h('p.ayuda', { style: { padding: '12px 18px 4px' } }, 'Carpetas que ya tenés en la compu (por ejemplo, de Drive). No se copian: se leen en su lugar y los agentes con acceso pueden consultarlas.'));
        if (!r.vinculos.length) lista.appendChild(h('div.vacio', 'No hay carpetas vinculadas.'));
        r.vinculos.forEach(function (v) {
          var alc = v.alcance === 'oficina' || !v.alcance ? 'Toda la oficina' : v.alcance.departamentos ? v.alcance.departamentos.map(function (d) { var x = App.depto(d); return x ? x.nombre : d; }).join(', ') : (v.alcance.agentes || []).map(function (a) { var x = App.agente(a); return x ? x.nombre : a; }).join(', ');
          lista.appendChild(h('div.archivo', App.icono('carpeta'),
            h('div.archivo-txt', h('div.archivo-tit', v.ruta), h('div.archivo-meta', alc + ' · ' + (v.archivos || 0) + ' archivos')),
            h('button.btn.chico', { onclick: function () { api.post('/api/vinculos/' + encodeURIComponent(v.id) + '/escanear', {}).then(function () { App.aviso('Buscando cambios en la carpeta…'); vigilarEstado(); cargar(); }).catch(App.fallo); } }, App.icono('recargar'), 'Actualizar'),
            h('button.btn.chico.fantasma', { onclick: function () {
              App.confirmar('¿Desvincular la carpeta?', 'La carpeta y sus archivos no se tocan; solo deja de estar en la biblioteca.', 'Desvincular', true).then(function (si) {
                if (si) api.del('/api/vinculos/' + encodeURIComponent(v.id)).then(cargar).catch(App.fallo);
              });
            } }, 'Desvincular')));
        });
      }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
    }
    function vincular() {
      App.elegirCarpeta('Elegí la carpeta a vincular').then(function (ruta) {
        if (!ruta) return;
        var alcance = dep.value && dep.value !== 'compartido' ? { departamentos: [dep.value] } : 'oficina';
        api.post('/api/vinculos', { ruta: ruta, alcance: alcance }).then(function () {
          App.aviso('Carpeta vinculada. Se van a leer sus archivos.');
          vista = 'vinculos'; pintarTabs(); cargar(); vigilarEstado();
        }).catch(App.fallo);
      });
    }

    /* ---- propuestas de cambio al conocimiento ---- */
    function cargarPropuestas() {
      det.style.display = 'none'; biblio.classList.remove('con-sel');
      api.get('/api/biblioteca/propuestas').then(function (r) {
        App.vaciar(lista);
        lista.appendChild(h('p.ayuda', { style: { padding: '12px 18px 8px' } }, 'Cuando un documento contradice lo que la oficina tiene anotado, el bibliotecario propone un cambio. Nada se modifica sin tu OK.'));
        if (!r.propuestas.length) lista.appendChild(h('div.vacio', 'No hay propuestas pendientes.'));
        r.propuestas.forEach(function (p) {
          lista.appendChild(h('div.propuesta', h('b', p.titulo || 'Propuesta'), p.sugerencia ? h('p.ayuda', p.sugerencia) : null,
            h('div.difs', h('div', h('div.ayuda', 'Hoy dice'), p.actual || '—'), h('div', h('div.ayuda', 'Propuesta'), p.nuevo || '—')),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button.btn.chico', { onclick: function () { resolver(p.id, false); } }, 'Rechazar'),
              h('button.btn.chico.primario', { onclick: function () { resolver(p.id, true); } }, 'Aceptar'))));
        });
      }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
    }
    function resolver(id, ok) {
      api.post('/api/biblioteca/propuestas/' + encodeURIComponent(id), { aceptar: ok }).then(function () { App.aviso(ok ? 'Cambio aplicado.' : 'Propuesta descartada.'); vigilarEstado(); cargar(); }).catch(App.fallo);
    }

    var alCambiar = function () { if (document.body.contains(hj.el)) { pintarTabs(estadoPrevio && estadoPrevio.propuestas); cargar(); } };
    App.on('biblioteca', alCambiar);
    cargar();
  }

  App.Biblioteca = { abrir: abrir, vigilarEstado: vigilarEstado };
})();
