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

  function explorador(titulo, op) {
    return new Promise(function (resolver) {
      var elegida = null, actual = null;
      var hj = App.hoja({ titulo: titulo, ancho: 680, alCerrar: function () { resolver(elegida); } });
      var accesos = h('div.accesos'), carpetas = h('div.carpetas'), ruta = h('div.ruta-actual');
      var btn = h('button.btn.primario', { disabled: true, onclick: function () { elegida = actual; hj.cerrar(); } }, 'Elegir esta carpeta');
      var nueva = op.crear ? h('button.btn.izq', { onclick: crearCarpeta }, App.icono('mas'), 'Nueva carpeta') : null;
      App.add(hj.cuerpo, ruta, h('div.explorador', accesos, carpetas));
      if (nueva) App.add(hj.pie, nueva);
      App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), btn);

      function ir(r) {
        App.vaciar(carpetas).appendChild(h('div.vacio', h('span.giro')));
        api.get('/api/fs/carpetas', { ruta: r || '' }).then(function (d) {
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
          if (!lista.length) carpetas.appendChild(h('div.vacio', 'No hay carpetas acá.'));
          lista.forEach(function (c) {
            carpetas.appendChild(h('div.carpeta' + (c.esOficina ? '.es-oficina' : ''), {
              onclick: function () { if (op.oficinas && c.esOficina) { elegida = c.ruta; hj.cerrar(); } else ir(c.ruta); },
              title: c.ruta
            }, App.icono(c.esOficina ? 'edificio' : 'carpeta'), h('span', { style: { flex: 1 } }, c.nombre), c.esOficina ? h('span.insignia.ok', 'Oficina') : App.icono('flecha')));
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

  /* archivos de la oficina (solo navegador; en la app se usa el Finder) */
  App.verArchivosOficina = function () {
    var hj = App.hoja({ titulo: 'Archivos de la oficina', ancho: 640, sinPie: true });
    var ruta = h('div.ruta-actual'), lista = h('div.carpetas', { style: { border: '1px solid var(--linea)', borderRadius: 'var(--radio)', height: '400px' } });
    App.add(hj.cuerpo, ruta, lista);
    function ir(r) {
      App.vaciar(lista).appendChild(h('div.vacio', h('span.giro')));
      api.get('/api/oficina/archivos', { ruta: r }).then(function (d) {
        var partes = (d.ruta || '').split('/').filter(Boolean);
        App.add(App.vaciar(ruta), 
          partes.length ? h('button.btn.chico.fantasma', { onclick: function () { ir(partes.slice(0, -1).join('/')); } }, App.icono('atras')) : null,
          App.icono('carpeta'), h('span', (E_().oficina.nombre) + (d.ruta ? ' / ' + partes.join(' / ') : '')));
        App.vaciar(lista);
        if (!d.archivos.length) lista.appendChild(h('div.vacio', 'Carpeta vacía.'));
        d.archivos.forEach(function (a) {
          lista.appendChild(h('div.carpeta', {
            onclick: function () {
              if (a.esCarpeta) ir(a.rel);
              else api.get('/api/oficina/archivo', { ruta: a.rel }).then(App.abrirContenido).catch(App.fallo);
            }
          }, App.icono(a.esCarpeta ? 'carpeta' : 'libro'), h('span', { style: { flex: 1 } }, a.nombre), a.esCarpeta ? App.icono('flecha') : h('small', { style: { color: 'var(--tenue)' } }, App.tam(a.tam))));
        });
      }).catch(function (e) { App.vaciar(lista).appendChild(h('div.vacio', e.message)); });
    }
    function E_() { return App.E; }
    ir('');
  };
})();
