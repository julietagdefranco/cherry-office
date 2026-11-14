/* Departamentos: cada uno es una sala del edificio. Crear, renombrar, cambiar color y borrar (moviendo a su gente). */
(function () {
  'use strict';
  var h = App.h, api = App.api;

  App.Deptos = {
    abrir: function () {
      var hj = App.hoja({ titulo: 'Departamentos', ancho: 520 });
      var lista = h('div.lista-ed');
      App.add(hj.cuerpo, h('p', { style: { color: 'var(--suave)', marginBottom: '12px' } }, 'Cada departamento es una sala del edificio. El edificio crece solo cuando sumás más.'), lista);
      App.add(hj.pie, h('button.btn.izq', { onclick: agregar }, App.icono('mas'), 'Nuevo departamento'), h('button.btn.primario', { onclick: hj.cerrar }, 'Listo'));

      function pintar() {
        var o = App.E.oficina;
        App.vaciar(lista);
        if (!o.departamentos.length) lista.appendChild(h('div.vacio', 'No hay departamentos.'));
        o.departamentos.forEach(function (d) {
          var n = o.agentes.filter(function (a) { return a.departamento === d.id; }).length;
          var muestra = h('button.muestra', { style: { background: d.color }, title: 'Cambiar color', onclick: function () {
            App.elegirColor(muestra, d.color, function (c) { guardar(d.id, { color: c }); });
          } });
          var inp = h('input.campo', { value: d.nombre, maxlength: 60 });
          var guardarNombre = function () { var v = inp.value.trim(); if (v && v !== d.nombre) guardar(d.id, { nombre: v }); else inp.value = d.nombre; };
          inp.addEventListener('blur', guardarNombre);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
          /* misión: una línea que dice para qué existe el departamento; se guarda al salir del campo.
             Si el backend la ignora, el campo simplemente queda vacío al reabrir. */
          var ultima = d.mision || '';
          var mis = h('textarea.campo', { rows: 2, maxlength: 600, placeholder: 'Misión: para qué existe este departamento', 'aria-label': 'Misión de ' + d.nombre });
          mis.value = ultima;
          mis.addEventListener('blur', function () {
            var v = mis.value.trim();
            if (v === ultima) return;
            api.patch('/api/departamentos/' + encodeURIComponent(d.id), { mision: v }).then(function (r) {
              ultima = v; if (r && r.oficina) App.actualizar(r.oficina);
            }).catch(function (e) { App.fallo(e); });
          });
          lista.appendChild(h('div.dep-bloque',
            h('div.fila-ed', muestra, inp,
              h('span.insignia', n + (n === 1 ? ' agente' : ' agentes')),
              h('button.btn.fantasma.icono', { title: 'Borrar', onclick: function () { borrar(d, n); } }, App.icono('papelera'))),
            mis));
        });
      }
      function guardar(id, cambios) {
        api.patch('/api/departamentos/' + encodeURIComponent(id), cambios).then(function (r) { App.actualizar(r.oficina); pintar(); }).catch(App.fallo);
      }
      function agregar() {
        var o = App.E.oficina;
        App.preguntar('Nuevo departamento', 'Nombre').then(function (nombre) {
          if (!nombre) return;
          api.post('/api/departamentos', { nombre: nombre, color: App.PALETA[o.departamentos.length % App.PALETA.length] })
            .then(function (r) { App.actualizar(r.oficina); pintar(); }).catch(App.fallo);
        });
      }
      function borrar(d, n) {
        var o = App.E.oficina;
        if (!n) {
          App.confirmar('¿Borrar ' + d.nombre + '?', 'La sala desaparece del edificio.', 'Borrar', true).then(function (si) {
            if (si) api.del('/api/departamentos/' + encodeURIComponent(d.id)).then(function (r) { App.actualizar(r.oficina); pintar(); }).catch(App.fallo);
          });
          return;
        }
        var otros = o.departamentos.filter(function (x) { return x.id !== d.id; });
        if (!otros.length) { App.aviso('Es el único departamento y tiene gente. Creá otro primero para moverlos.', true); return; }
        var hj2 = App.hoja({ titulo: '¿Borrar ' + d.nombre + '?', ancho: 420 });
        var sel = h('select.campo', otros.map(function (x) { return h('option', { value: x.id }, x.nombre); }));
        App.add(hj2.cuerpo, h('p', { style: { color: 'var(--suave)', marginBottom: '12px' } }, 'Tiene ' + n + (n === 1 ? ' agente' : ' agentes') + '. ¿A qué departamento los paso?'), sel);
        App.add(hj2.pie, h('button.btn', { onclick: hj2.cerrar }, 'Cancelar'), h('button.btn.primario', {
          style: { background: 'var(--peligro)', borderColor: 'var(--peligro)', color: '#fff' },
          onclick: function () {
            api.del('/api/departamentos/' + encodeURIComponent(d.id), { moverA: sel.value }).then(function (r) { hj2.cerrar(); App.actualizar(r.oficina); pintar(); }).catch(App.fallo);
          }
        }, 'Mover y borrar'));
      }
      pintar();
    }
  };
})();
