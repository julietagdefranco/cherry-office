/* YO: quien dirige la oficina. Un perfil para toda la app (nombre y minifig, en /api/perfil) que es el dueño de cada
   oficina: los agentes te llaman por ese nombre. En la maqueta tenés tu despacho de Dirección, con tu bandeja de
   entregables sobre el escritorio; en la barra lateral, tu fila arriba del equipo. */
window.App = window.App || {};
App.Yo = (function () {
  'use strict';
  var h = function () { return App.h.apply(null, arguments); };

  function perfil() { return (App.E.estado && App.E.estado.perfil) || { nombre: '', avatar: null }; }
  function nombre() { return perfil().nombre || ''; }
  /* para los retratos: el mismo formato que un agente */
  function comoAgente() { var p = perfil(); return { id: 'yo', nombre: p.nombre || 'Vos', avatar: p.avatar || { semilla: 'yo' } }; }
  function retrato(clase, tam) { return App.retratoImg(comoAgente(), clase, tam); }

  /* fila de la barra lateral: grupo «Dirección» con vos y lo que tenés para revisar */
  function subtitulo() {
    var n = App.Entregables ? App.Entregables.sinRevisar() : 0;
    return n ? (n === 1 ? '1 entrega para revisar' : n + ' entregas para revisar') : 'Tu bandeja está al día';
  }
  function refrescar() { var el = document.querySelector('.persona.yo .persona-rol'); if (el) el.textContent = subtitulo(); }
  function fila() {
    var sub = subtitulo();
    return h('div',
      h('div.grupo-tit', h('span.punto', { style: { background: '#f5cd2f' } }), 'Vos'),
      h('div.persona.yo', { title: 'Tu despacho: abrir tu bandeja', onclick: function () { irAlDespacho(); App.Entregables.abrir(); } },
        retrato('retrato', 96),
        h('div.persona-txt', h('div.persona-nombre', nombre() || 'Vos'), h('div.persona-rol', sub)),
        h('button.yo-editar', { title: 'Cambiar tu nombre o tu minifig', onclick: function (e) { e.stopPropagation(); abrir(); } }, App.icono('lapiz'))));
  }

  function irAlDespacho() { if (App.Oficina3D && App.Oficina3D.enfocarLugar) App.Oficina3D.enfocarLugar('direccion'); }

  /* hoja «Quién dirige»: nombre y minifig */
  function abrir() {
    var p = perfil();
    var hj = App.hoja({ titulo: 'Quién dirige', ancho: 760 });
    var n = h('input.campo', { value: p.nombre || '', maxlength: 80, placeholder: 'Tu nombre', autofocus: true });
    var ava = App.EditorAvatar(p.avatar || { semilla: 'yo' }, function () { return 'yo'; });
    var err = h('div.error-txt');
    App.add(hj.cuerpo, h('div.editor', ava.el, h('div',
      h('div.fila-campo', h('label.etiqueta-campo', 'Tu nombre'), n,
        h('div.ayuda', 'Sos quien dirige todas tus oficinas. Los agentes te llaman por este nombre, te piden aprobaciones y te dejan lo que terminan en la bandeja de tu despacho.')),
      err)));
    var ok = h('button.btn.primario', {
      onclick: function () {
        if (!n.value.trim()) { err.textContent = 'Poné tu nombre.'; n.focus(); return; }
        ok.disabled = true;
        App.api.put('/api/perfil', { nombre: n.value.trim(), avatar: ava.valor() }).then(function (r) {
          hj.cerrar();
          App.E.estado = App.E.estado || {};
          App.E.estado.perfil = r.perfil;
          if (r.oficina) App.actualizar(r.oficina); else if (App.E.oficina) App.actualizar();
          App.aviso('Listo, ' + r.perfil.nombre + '.');
        }).catch(function (e) { err.textContent = e.message; ok.disabled = false; });
      }
    }, 'Guardar');
    App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok);
  }

  return { perfil: perfil, nombre: nombre, retrato: retrato, comoAgente: comoAgente, fila: fila, refrescar: refrescar, abrir: abrir, irAlDespacho: irAlDespacho };
})();
