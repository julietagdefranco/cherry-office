/* Explorador de carpetas: en la app nativa usa el panel de macOS; en el navegador, uno propio sobre /api/fs/carpetas.
   También muestra los archivos de la oficina cuando no hay Finder a mano. */
(function () {
  'use strict';
  var h = App.h, api = App.api;

  /* op: {oficinas: true} marca y prioriza carpetas de oficina; {crear: true} permite crear carpetas */
  App.elegirCarpeta = function (titulo, op) {
    op = op || {};
    if (App.nativo.hay) {
      return App.nativo.elegirCarpeta(titulo, null, !!op.crear).then(function (r) { return r === undefined ? explorador(titulo, op) : r; });
    }
    return explorador(titulo, op);
  };

  /* un .zip (oficina exportada): panel de macOS en la app, explorador propio en el navegador */
  App.elegirZip = function (titulo) {
    if (App.nativo.hay) {
      return App.nativo.elegirArchivo(titulo).then(function (r) { return r === undefined ? explorador(titulo, { zip: true }) : r; });
    }
    return explorador(titulo, { zip: true });
  };

  function explorador(titulo, op) {
    return new Promise(function (resolver) {
      var elegida = null, actual = null;
      var hj = App.hoja({ titulo: titulo, ancho: 680, alCerrar: function () { resolver(elegida); } });
      var accesos = h('div.accesos'), carpetas = h('div.carpetas'), ruta = h('div.ruta-actual');
      var btn = h('button.btn.primario', { disabled: true, onclick: function () { elegida = actual; hj.cerrar(); } }, 'Elegir esta carpeta');
      if (op.zip) btn.style.display = 'none';
      var nueva = op.crear ? h('button.btn.izq', { onclick: crearCarpeta }, App.icono('mas'), 'Nueva carpeta') : null;
      App.add(hj.cuerpo, ruta, h('div.explorador', accesos, carpetas));
      if (nueva) App.add(hj.pie, nueva);
      App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);

      function ir(r) {
        App.vaciar(carpetas).appendChild(h('div.vacio', h('span.giro')));
        api.get('/api/fs/carpetas', { ruta: r || '', archivos: op.zip ? 'zip' : '' }).then(function (d) {
          actual = d.ruta;
          btn.disabled = false;
          btn.textContent = op.oficinas ? (d.esOficina ? 'Abrir esta oficina' : 'Elegir esta carpeta') : 'Elegir esta carpeta';
          App.add(App.vaciar(ruta), 
            d.padre ? h('button.btn.chico.fantasma', { onclick: function () { ir(d.padre); } }, App.icono('atras')) : null,
            App.icono('carpeta'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, d.ruta),
            d.esOficina ? h('span.insignia.ok', 'Oficina') : null);
          App.vaciar(accesos);
          (d.accesos || []).forEach(function (a) { accesos.appendChild(h('div.menu-item', { onclick: function () { ir(a.ruta); } }, a.nombre)); });
          App.vaciar(carpetas);
          var lista = (d.carpetas || []).slice();
          if (op.oficinas) lista.sort(function (a, b) { return (b.esOficina ? 1 : 0) - (a.esOficina ? 1 : 0); });
          var zips = op.zip ? (d.archivos || []) : [];
          if (!lista.length && !zips.length) carpetas.appendChild(h('div.vacio', op.zip ? 'No hay carpetas ni archivos .zip acá.' : 'No hay carpetas acá.'));
          lista.forEach(function (c) {
            carpetas.appendChild(h('div.carpeta' + (c.esOficina ? '.es-oficina' : ''), {
              onclick: function () { if (op.oficinas && c.esOficina) { elegida = c.ruta; hj.cerrar(); } else ir(c.ruta); },
              title: c.ruta
            }, App.icono(c.esOficina ? 'edificio' : 'carpeta'), h('span', { style: { flex: 1 } }, c.nombre), c.esOficina ? h('span.insignia.ok', 'Oficina') : App.icono('flecha')));
          });
          zips.forEach(function (z) {
            carpetas.appendChild(h('div.carpeta.es-oficina', { onclick: function () { elegida = z.ruta; hj.cerrar(); }, title: z.ruta },
              App.icono('importar'), h('span', { style: { flex: 1 } }, z.nombre), h('small', { style: { color: 'var(--tenue)' } }, App.tam(z.tam || 0))));
          });
        }).catch(function (e) { App.vaciar(carpetas).appendChild(h('div.vacio', e.message)); });
      }
      function crearCarpeta() {
        if (!actual) return;
        App.preguntar('Nueva carpeta', 'Nombre').then(function (n) {
          if (!n) return;
          api.post('/api/fs/carpetas', { padre: actual, nombre: n }).then(function (r) { ir(r.ruta || actual); }).catch(App.fallo);
        });
      }
      ir('');
    });
  }

  /* Archivos › Carpeta de la oficina: la carpeta navegable como pantalla, con su ruta (#/archivos/carpeta/<sub/carpeta>).
     En la app de escritorio suma «Mostrar en el Finder». Abrir un archivo: markdown en el visor, el resto como siempre. */
  var rutaActual = '';
  App.Carpeta = {
    ruta: function () { return rutaActual; },
    abrir: function (r) {
      rutaActual = (r || '').replace(/^\/+|\/+$/g, '');
      var modo = App.modoDerecho && App.modoDerecho();
      if (modo !== 'carpeta') App.abrirDerecho('carpeta'); else App.Nav.alAbrir('carpeta');
      pintar();
    }
  };
  App.verArchivosOficina = function () { App.Nav.ir('#/archivos/carpeta'); };
  function pintar() {
    var E = App.E, partes = rutaActual.split('/').filter(Boolean);
    var lista = h('div.carpetas.carpeta-panel', h('div.vacio', h('span.giro')));
    var migas = h('div.ruta-actual',
      h('button.btn.chico.fantasma', { onclick: function () { App.Carpeta.abrir(''); } }, App.icono('carpeta'), E.oficina.nombre),
      partes.map(function (p, i) {
        return [h('span.miga-sep', '/'), h('button.btn.chico.fantasma', { onclick: function () { App.Carpeta.abrir(partes.slice(0, i + 1).join('/')); } }, p)];
      }));
    var mostrar = App.nativo.hay ? h('button.btn.chico', { onclick: function () { App.nativo.revelar(E.carpeta.replace(/\/$/, '') + (rutaActual ? '/' + rutaActual : '')); } },
      App.icono('abrir'), 'Mostrar ' + App.nativo.enExplorador) : null;
    App.add(App.vaciar(App.dom.derecho),
      App.cabPanel({ icono: 'carpeta', titulo: 'Carpeta de la oficina', sub: E.carpeta, acciones: mostrar ? [mostrar] : null,
        volver: partes.length ? { texto: 'Subir', titulo: 'Carpeta de arriba', accion: function () { App.Carpeta.abrir(partes.slice(0, -1).join('/')); } } : null }),
      h('div.der-cuerpo', migas, lista));
    var pedida = rutaActual;
    api.get('/api/oficina/archivos', { ruta: rutaActual }).then(function (d) {
      if (pedida !== rutaActual || App.modoDerecho() !== 'carpeta') return;
      App.vaciar(lista);
      if (!d.archivos.length) lista.appendChild(h('div.vacio', 'Carpeta vacía.'));
      d.archivos.forEach(function (a) {
        lista.appendChild(h('div.carpeta', { title: a.rel, onclick: function () {
          if (a.esCarpeta) App.Carpeta.abrir(a.rel);
          else if (App.esMarkdown(a.rel)) App.abrirMarkdownOficina(a.rel);
          else if (App.nativo.hay) App.nativo.abrir(E.carpeta.replace(/\/$/, '') + '/' + a.rel);
          else api.get('/api/oficina/archivo', { ruta: a.rel }).then(App.abrirContenido).catch(App.fallo);
        } }, App.icono(a.esCarpeta ? 'carpeta' : 'libro'), h('span', { style: { flex: 1 } }, a.nombre), a.esCarpeta ? App.icono('flecha') : h('small', { style: { color: 'var(--tenue)' } }, App.tam(a.tam))));
      });
    }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
  }
})();
