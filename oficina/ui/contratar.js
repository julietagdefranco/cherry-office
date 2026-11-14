/* Contratar: descripción -> borrador de Claude (o a mano) -> editar -> confirmar. Incluye el editor de agente
   (datos + avatar con retrato en vivo), que también usa la ficha del agente. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var MODELOS = [['sonnet', 'Sonnet (equilibrado)'], ['opus', 'Opus (el más capaz)'], ['haiku', 'Haiku (rápido)'], ['inherit', 'El que use Claude Code']];

  /* ---------------- editor de minifig (agentes y tu perfil) ----------------
     avatar: objeto inicial; semilla(): de dónde salen los valores que falten. Devuelve {el, valor(), retratar()}. */
  App.EditorAvatar = function (avatar, semilla) {
    var av = JSON.parse(JSON.stringify(avatar || {}));
    var img = h('img.grande', { alt: '' }), controles = h('div'), catalogo = null;
    var retratar = App.debounce(function () {
      App.Piezas.retrato(av, av.semilla || semilla(), 236).then(function (u) { img.src = u; }).catch(function () {});
    }, 120);
    /* Selector con miniaturas: la fila muestra la opción elegida; al tocarla se abre una grilla con cada opción
       probada sobre la figura actual. Solo una grilla abierta a la vez, y sus miniaturas se generan al abrirla. */
    var abierto = null, scrollGrilla = 0;
    function miniatura(cambio, encuadre, tam) {
      var img = h('img', { alt: '' });
      App.Piezas.retrato(Object.assign({}, av, cambio), av.semilla || semilla(), tam || 112, encuadre)
        .then(function (u) { img.src = u; }).catch(function () {});
      return img;
    }
    function galeria(etq, clave, grupo, encuadre) {
      var claves = Object.keys(catalogo[grupo] || {});
      var actual = catalogo[grupo][av[clave]] || {};
      function cambio(k) { var o = {}; o[clave] = k; return o; }
      var cab = h('button.galeria-cab', { type: 'button', 'aria-expanded': abierto === clave ? 'true' : 'false',
        onclick: function () { abierto = abierto === clave ? null : clave; scrollGrilla = 0; pintarControles(); } },
        miniatura({}, encuadre, 96), h('span.galeria-nombre', actual.nombre || ''), h('span.galeria-flecha', abierto === clave ? '▴' : '▾'));
      var grilla = abierto !== clave ? null : h('div.galeria-grilla', { onscroll: function () { scrollGrilla = this.scrollTop; } }, claves.map(function (k) {
        return h('button', { type: 'button', class: k === av[clave] ? 'sel' : '', title: catalogo[grupo][k].nombre,
          onclick: function () { av[clave] = k; pintarControles(); retratar(); } }, miniatura(cambio(k), encuadre));
      }));
      if (grilla) requestAnimationFrame(function () { grilla.scrollTop = scrollGrilla; });
      return h('div.fila-campo', h('label.etiqueta-campo', etq), cab, grilla);
    }
    function colores(etq, clave, lista) {
      var p = h('div.paleta');
      lista.forEach(function (c) {
        p.appendChild(h('button', { class: c.hex.toLowerCase() === (av[clave] || '').toLowerCase() ? 'sel' : '', style: { background: c.hex }, title: c.id,
          onclick: function () {
            /* las mangas acompañan al torso mientras sean del mismo color */
            if (clave === 'colorTorso' && (av.colorBrazos || '').toLowerCase() === (av.colorTorso || '').toLowerCase()) av.colorBrazos = c.hex;
            av[clave] = c.hex;
            pintarControles(); retratar(); } }));
      });
      return h('div.fila-campo', h('label.etiqueta-campo', etq), p);
    }
    function pintarControles() {
      var c = catalogo;
      var conAccesorio = (c.sombrero[av.sombrero] || {}).parte || ((c.cuello[av.cuello] || {}).color === 'accesorio');
      App.add(App.vaciar(controles),
        colores('Piel', 'colorPiel', c.colores.piel),
        galeria('Cara', 'cara', 'cara', 'cara'),
        galeria('Peinado', 'pelo', 'pelo', 'cara'), colores('Color de pelo', 'colorPelo', c.colores.pelo),
        galeria('Sombrero', 'sombrero', 'sombrero', 'cara'), galeria('Barba o moño', 'cuello', 'cuello', 'busto'),
        conAccesorio ? colores('Color del sombrero o moño', 'colorAccesorio', c.colores.accesorio) : null,
        galeria('Ropa', 'torso', 'torso', 'torso'),
        colores('Color de la ropa', 'colorTorso', c.colores.torso), colores('Mangas', 'colorBrazos', c.colores.torso),
        galeria('Abajo', 'piernas', 'piernas', 'cuerpo'), colores((c.piernas[av.piernas] || {}).parte ? 'Color de la falda' : 'Color del pantalón', 'colorPiernas', c.colores.piernas));
    }
    App.Piezas.completar(av, semilla()).then(function (a) { av = a; return App.Piezas.catalogo(); })
      .then(function (c) { catalogo = c; pintarControles(); retratar(); }).catch(App.fallo);
    var azar = h('button.btn.chico', {
      onclick: function () {
        App.Piezas.completar({ semilla: App.uuid().slice(0, 8) }, null, true).then(function (a) { av = a; pintarControles(); retratar(); });
      }
    }, App.icono('dado'), 'Otro aspecto');
    return { el: h('div.editor-avatar', img, azar, controles), valor: function () { return av; }, retratar: retratar };
  };

  /* ---------------- editor ---------------- */
  App.EditorAgente = function (dato, op) {
    op = op || {};
    var d = JSON.parse(JSON.stringify(dato || {}));
    d.avatar = d.avatar || { semilla: d.id || App.uuid().slice(0, 8) };
    var usados = App.E.oficina.agentes.map(function (a) { return a.id; });
    var idTocado = !!op.editar;
    function campo(etq, el, ayuda) { return h('div.fila-campo', h('label.etiqueta-campo', etq), el, ayuda ? h('div.ayuda', ayuda) : null); }
    var nombre = h('input.campo', { value: d.nombre || '', maxlength: 80, placeholder: 'Ej.: Lu' });
    var id = h('input.campo', { value: d.id || '', maxlength: 41, disabled: !!op.editar, spellcheck: 'false' });
    var rol = h('input.campo', { value: d.rol || '', maxlength: 160, placeholder: 'Ej.: Analista de ventas' });
    var dep = h('select.campo', App.E.oficina.departamentos.map(function (x) { return h('option', { value: x.id, selected: x.id === d.departamento }, x.nombre); }));
    var modelo = h('select.campo', MODELOS.map(function (m) { return h('option', { value: m[0], selected: m[0] === (d.modelo || 'sonnet') }, m[1]); }));
    var desc = h('input.campo', { value: d.description || '', maxlength: 1000, placeholder: 'En una línea, para qué sirve' });
    var prompt = h('textarea.campo', { rows: 9, maxlength: 20000 }); prompt.value = d.prompt || '';
    var chips = [0, 1, 2].map(function (i) { return h('input.campo', { value: (d.chips || [])[i] || '', maxlength: 200, placeholder: i === 0 ? 'Pedido de ejemplo' : '', style: { marginBottom: '6px' } }); });
    var ava = App.EditorAvatar(d.avatar, function () { return d.avatar.semilla || id.value; });
    if (!op.editar) nombre.addEventListener('input', function () { if (!idTocado) id.value = App.slug(nombre.value, usados); ava.retratar(); });
    id.addEventListener('input', function () { idTocado = true; });

    var el = h('div.editor',
      ava.el,
      h('div',
        h('div.dos', campo('Nombre', nombre), campo('Identificador', id, op.editar ? 'No se puede cambiar.' : 'Así se llama el agente en Claude Code.')),
        campo('Rol', rol),
        h('div.dos', campo('Departamento', dep), campo('Modelo', modelo)),
        campo('Descripción corta', desc),
        campo('Instrucciones', prompt, 'Cómo trabaja, qué entrega y cómo habla. Es el texto que recibe Claude.'),
        campo('Pedidos sugeridos', h('div', chips))));

    return {
      el: el,
      valor: function () {
        return {
          id: id.value.trim(), nombre: nombre.value.trim(), rol: rol.value.trim(), departamento: dep.value, modelo: modelo.value,
          description: desc.value.trim() || rol.value.trim(), prompt: prompt.value.trim(),
          chips: chips.map(function (c) { return c.value.trim(); }).filter(Boolean), avatar: ava.valor(), brief: d.brief || undefined
        };
      },
      validar: function () {
        var v = this.valor();
        if (!v.nombre) return 'Falta el nombre.';
        if (!v.rol) return 'Falta el rol.';
        if (!v.prompt) return 'Faltan las instrucciones.';
        if (!op.editar && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(v.id)) return 'El identificador va en minúsculas, números y guiones.';
        if (!op.editar && usados.indexOf(v.id) >= 0) return 'Ya hay un agente con ese identificador.';
        if (!v.departamento) return 'Elegí un departamento (creá uno en Departamentos).';
        return null;
      }
    };
  };

  /* ---------------- flujo de contratación ---------------- */
  App.Contratar = {
    abrir: function (op) {
      op = op || {};
      if (!App.E.oficina.departamentos.length) { App.aviso('Primero creá un departamento.', true); App.Deptos.abrir(); return; }
      var hj = App.hoja({ titulo: 'Contratar', ancho: 620 });
      var desc = h('textarea.campo', { rows: 5, autofocus: true, maxlength: 4000, placeholder: 'Ej.: alguien que mire las ventas de cada semana, me diga qué productos se mueven y arme un resumen corto para el lunes.' });
      var dep = h('select.campo', App.E.oficina.departamentos.map(function (x) { return h('option', { value: x.id, selected: x.id === op.departamento }, x.nombre); }));
      var err = h('div.error-txt');
      var pedir = h('button.btn.primario', { onclick: borrador }, App.icono('chispa'), 'Proponer con Claude');
      App.add(hj.cuerpo, 
        h('p', { style: { color: 'var(--suave)', marginBottom: '14px' } }, 'Contá con tus palabras qué necesitás. Claude arma el perfil del agente y lo revisás antes de contratarlo.'),
        h('div.fila-campo', h('label.etiqueta-campo', '¿Qué tiene que hacer?'), desc),
        h('div.fila-campo', h('label.etiqueta-campo', 'Departamento'), dep), err);
      App.add(hj.pie, h('button.btn.izq.fantasma', { onclick: function () { paso2({ departamento: dep.value, brief: desc.value.trim() }); } }, 'Completar a mano'),
        h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), pedir);
      function borrador() {
        err.textContent = '';
        if (desc.value.trim().length < 8) { err.textContent = 'Contá un poco más qué necesitás.'; desc.focus(); return; }
        pedir.disabled = true; App.add(App.vaciar(pedir), h('span.giro'), 'Pensando el perfil…');
        api.post('/api/agentes/borrador', { descripcion: desc.value.trim(), departamento: dep.value })
          .then(function (b) { b.brief = desc.value.trim(); b.departamento = b.departamento || dep.value; paso2(b); })
          .catch(function (e) { err.textContent = e.message; pedir.disabled = false; App.add(App.vaciar(pedir), App.icono('chispa'), 'Proponer con Claude'); });
      }
      function paso2(datos) {
        hj.titulo('Revisá el perfil');
        hj.el.style.width = '880px';
        var ed = App.EditorAgente(datos, {});
        var err2 = h('div.error-txt');
        App.add(App.vaciar(hj.cuerpo), ed.el, err2);
        var ok = h('button.btn.primario', {
          onclick: function () {
            var m = ed.validar(); if (m) { err2.textContent = m; return; }
            ok.disabled = true; ok.textContent = 'Contratando…';
            api.post('/api/agentes', ed.valor()).then(function (r) {
              hj.cerrar();
              App.actualizar(r.oficina);
              App.aviso(r.agente.nombre + ' ya está en la oficina.');
              setTimeout(function () { App.Agente.abrir(r.agente.id); }, 400);
            }).catch(function (e) { err2.textContent = e.message; ok.disabled = false; ok.textContent = 'Contratar'; });
          }
        }, 'Contratar');
        App.add(App.vaciar(hj.pie), h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok);
      }
    }
  };
})();
