/* Contratar: descripción -> borrador de Claude (o a mano) -> editar -> confirmar. Incluye el editor de agente
   (datos + avatar con retrato en vivo), que también usa la ficha del agente. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  /* Los modelos para elegir, una sola lista para toda la app (Ajustes › Modelos y la ficha de cada agente) */
  App.MODELOS = [
    { valor: 'sonnet', titulo: 'Sonnet', sub: 'Equilibrado: la mejor opción para casi todo.' },
    { valor: 'opus', titulo: 'Opus', sub: 'El más capaz, para trabajos difíciles. Gasta más.' },
    { valor: 'haiku', titulo: 'Haiku', sub: 'Rápido y barato, para cosas simples.' },
    { valor: 'inherit', titulo: 'El de Claude Code', sub: 'El que tengas elegido en tu Claude Code.' },
  ];
  /* Cuánto piensa antes de responder (`--effort`). Lo que piensa se cobra como texto escrito: más esfuerzo, más tokens.
     '' = el que tengas en tu Claude Code. Una sola lista: la ficha del agente, el selector de cada charla y las reuniones. */
  App.ESFUERZOS = [
    { valor: '', titulo: 'El de Claude Code', sub: 'El que tengas elegido en tu Claude Code.' },
    { valor: 'low', titulo: 'Bajo', sub: 'Responde rápido y gasta poco. Para charlas y pedidos simples.' },
    { valor: 'medium', titulo: 'Medio', sub: 'Piensa un poco. Buen equilibrio para el día a día.' },
    { valor: 'high', titulo: 'Alto', sub: 'Piensa más antes de responder. Gasta más.' },
    { valor: 'xhigh', titulo: 'Muy alto', sub: 'Para problemas difíciles. Gasta bastante más.' },
    { valor: 'max', titulo: 'Máximo', sub: 'Todo lo que pueda pensar. El que más gasta.' },
  ];
  App.tituloModelo = function (v) { var m = App.MODELOS.filter(function (x) { return x.valor === v; })[0]; return m ? m.titulo : 'Sonnet'; };
  App.tituloEsfuerzo = function (v) { var m = App.ESFUERZOS.filter(function (x) { return x.valor === (v || ''); })[0]; return m ? m.titulo : ''; };

  /* Opciones de consumo que se pueden prender o apagar (Ajustes › Consumo de IA, cada charla y cada reunión nueva).
     Una sola lista, con lo que cuesta cada una, para que se entienda qué se gana al apagarla. */
  App.OPCIONES_IA = [
    { clave: 'skills', titulo: 'Skills de tu Claude Code', completo: 'completas',
      sub: 'Las skills y plugins que tenés instalados. En cada paso el agente recibe la lista: completa pesa varios miles de tokens.',
      opciones: [
        { valor: 'resumidas', titulo: 'Todas, resumidas', sub: 'Puede usar cualquiera; la lista va con descripciones cortas. Menos de la mitad.' },
        { valor: 'completas', titulo: 'Todas, completas', sub: 'La lista entera, como Claude Code. La que más gasta.' },
        { valor: 'agente', titulo: 'Las de cada agente', sub: 'Solo las elegidas en la ficha de cada agente. Sin elegidas, ninguna.' },
        { valor: 'ninguna', titulo: 'Ninguna', sub: 'No usa skills.' }] },
    { clave: 'memoria', titulo: 'Memoria de la oficina', completo: 'completa',
      sub: 'Al empezar lee el contexto del negocio, las decisiones y el catálogo de documentos. Crecen con el uso: liviana ahorra, pero puede no tener presente alguna decisión.',
      opciones: [{ valor: 'completa', titulo: 'Leer al empezar' }, { valor: 'liviana', titulo: 'Solo si hace falta' }] },
    { clave: 'colegas', titulo: 'Consultar a colegas', completo: true,
      sub: 'Cada consulta es otro agente trabajando (hasta 3 por mensaje). Apagado, responde solo con lo suyo.',
      opciones: [{ valor: true, titulo: 'Puede' }, { valor: false, titulo: 'No puede' }] },
    { clave: 'mcpLocales', titulo: 'Servidores MCP de tu Claude Code', completo: true,
      sub: 'Los MCP que instalaste en Claude Code (no los conectores de claude.ai, que se asignan por agente). Cada uno suma sus herramientas en cada paso.',
      opciones: [{ valor: true, titulo: 'Usarlos' }, { valor: false, titulo: 'Solo los de la oficina' }] },
    { clave: 'carteles', titulo: 'Carteles con IA', completo: true, soloAjustes: true,
      sub: 'La frase corta sobre la cabeza de cada agente mientras trabaja («Armando el calendario…»). Es una llamada chica a Haiku por mensaje; apagado, el cartel muestra el comienzo del mensaje.',
      opciones: [{ valor: true, titulo: 'Con IA' }, { valor: false, titulo: 'El comienzo del mensaje' }] },
  ];
  /* lo de Ajustes › Consumo de IA, con los valores de siempre si todavía no llegó el estado */
  App.iaApp = function () { return Object.assign({ esfuerzo: '', skills: 'resumidas', memoria: 'completa', colegas: true, mcpLocales: true, carteles: true }, (App.E.estado && App.E.estado.ia) || {}); };
  App.opcionIA = function (clave) { return App.OPCIONES_IA.filter(function (o) { return o.clave === clave; })[0]; };
  App.tituloOpcionIA = function (o, v) { var x = o.opciones.filter(function (y) { return y.valor === v; })[0]; return x ? x.titulo : String(v); };

  /* Selector de una charla (como en Claude): un botón chico que abre un menú con modelo, esfuerzo y las opciones de
     consumo. Pisa lo del agente y lo de Ajustes solo en esa charla.
     op: {modelo, esfuerzo (los del agente), valor (lo elegido antes), soloModelo (sin opciones: el Creador), alCambiar(v)}.
     .valor() devuelve solo lo que difiere de lo de por defecto. */
  App.SelectorCharla = function (op) {
    var v = Object.assign({}, op.valor || {});
    var b = h('button.btn.chico.fantasma.selector-charla', { type: 'button', title: 'Modelo, esfuerzo y consumo de esta charla' });
    function defecto() {
      var ia = App.iaApp();
      return { modelo: op.modelo || 'sonnet', esfuerzo: op.esfuerzo || ia.esfuerzo || '', skills: ia.skills, memoria: ia.memoria, colegas: ia.colegas, mcpLocales: ia.mcpLocales };
    }
    function efectivo() { return Object.assign(defecto(), v); }
    function ahorros() {
      if (op.soloModelo) return 0;
      var e = efectivo();
      return App.OPCIONES_IA.filter(function (o) { return !o.soloAjustes && e[o.clave] !== o.completo; }).length;
    }
    function pintar() {
      var e = efectivo(), n = ahorros();
      App.vaciar(b);
      App.add(b, App.icono('deslizadores'), h('span', App.tituloModelo(e.modelo) + (e.esfuerzo ? ' · ' + App.tituloEsfuerzo(e.esfuerzo) : '') + (n ? ' · ' + n + (n === 1 ? ' ahorro' : ' ahorros') : '')));
      b.classList.toggle('cambiado', Object.keys(v).length > 0);
    }
    function cambiar(clave, valor) {
      var d = defecto();
      if (valor === d[clave]) delete v[clave]; else v[clave] = valor;
      pintar();
      if (op.alCambiar) op.alCambiar(b.valor());
    }
    b.addEventListener('click', function () {
      var e = efectivo(), d = defecto();
      var marca = function (si) { return si ? 'ok' : null; };
      var items = [{ titulo: 'Modelo' }].concat(App.MODELOS.map(function (m) {
        return { texto: m.titulo + (m.valor === d.modelo ? ' (por defecto)' : ''), nota: m.sub, icono: marca(e.modelo === m.valor), accion: function () { cambiar('modelo', m.valor); } };
      }), ['-', { titulo: 'Esfuerzo' }], App.ESFUERZOS.map(function (x) {
        return { texto: x.titulo + (x.valor === d.esfuerzo && d.esfuerzo ? ' (por defecto)' : ''), nota: x.sub, icono: marca(e.esfuerzo === x.valor), accion: function () { cambiar('esfuerzo', x.valor); } };
      }));
      if (!op.soloModelo) {
        App.OPCIONES_IA.forEach(function (o) {
          if (o.soloAjustes) return;
          items.push('-', { titulo: o.titulo });
          o.opciones.forEach(function (x) {
            items.push({ texto: x.titulo + (x.valor === d[o.clave] ? ' (por defecto)' : ''), nota: x.sub, icono: marca(e[o.clave] === x.valor),
              accion: function () { cambiar(o.clave, x.valor); } });
          });
        });
      }
      App.menu(b, items);
    });
    b.valor = function () { return Object.assign({}, v); };
    pintar();
    return b;
  };

  /* ---------------- editor de minifig (agentes y tu perfil) ----------------
     avatar: objeto inicial; semilla(): de dónde salen los valores que falten. Devuelve {el, valor(), retratar()}. */
  App.EditorAvatar = function (avatar, semilla, op) {
    op = op || {};
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
        galeria('Sombrero', 'sombrero', 'sombrero', 'cara'), galeria('Barba, moño o capa', 'cuello', 'cuello', 'busto'),
        conAccesorio ? colores('Color del sombrero, moño o capa', 'colorAccesorio', c.colores.accesorio) : null,
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
    /* `plegable`: la figura y «Otro aspecto» siempre a la vista; las piezas, detrás de «Apariencia» */
    var cuerpoControles = op.plegable ? h('details.ap-plegable', h('summary', 'Apariencia: piezas y colores'), controles) : controles;
    return { el: h('div.editor-avatar', img, azar, cuerpoControles), valor: function () { return av; }, retratar: retratar };
  };

  /* ---------------- editor ---------------- */
  /* «a, b, c» -> ["a", "b", "c"] sin vacíos ni repetidos (sin importar acentos ni mayúsculas) */
  function temas(texto) {
    var vistos = {}, out = [];
    String(texto || '').split(/[,;\n]/).forEach(function (t) {
      t = t.trim(); if (!t) return;
      var n = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (vistos[n]) return; vistos[n] = true; out.push(t);
    });
    return out;
  }
  App.temas = temas;

  /* chips de temas: lo que se pega separado por comas se parte en varios (sin repetidos) */
  function chipsTemas(items, op) {
    var caja = App.chipsEditables(items, Object.assign({}, op, { alCambiar: function (lista, c) {
      if (c && c.agregado && /[,;\n]/.test(c.agregado)) {
        lista.splice(lista.indexOf(c.agregado), 1);
        temas(lista.concat(c.agregado.split(/[,;\n]/))).forEach(function (t) { if (lista.indexOf(t) < 0) lista.push(t); });
        caja.repintar();
      }
    } }));
    return caja;
  }

  App.EditorAgente = function (dato, op) {
    op = op || {};
    var d = JSON.parse(JSON.stringify(dato || {}));
    d.avatar = d.avatar || { semilla: d.id || App.uuid().slice(0, 8) };
    var usados = App.E.oficina.agentes.map(function (a) { return a.id; });
    var idTocado = !!op.editar;
    /* la ayuda va antes del campo, como bajada de la etiqueta */
    function campo(etq, el, ayuda) { return h('div.fila-campo', h('label.etiqueta-campo', etq), ayuda ? h('div.ayuda', ayuda) : null, el); }
    function grupo(titulo, hijos) { return h('section.ficha-grupo', h('h4.ficha-grupo-tit', titulo), hijos); }
    var deptos = App.E.oficina.departamentos;
    var nombre = h('input.campo', { value: d.nombre || '', maxlength: 80, placeholder: 'Ej.: Lu' });
    var id = h('input.campo.chico.ficha-id-campo', { value: d.id || '', maxlength: 41, spellcheck: 'false' });
    var rol = h('input.campo', { value: d.rol || '', maxlength: 160, placeholder: 'Ej.: Analista de ventas' });
    var dep = App.elegir({ etiqueta: 'Departamento', valor: d.departamento || (deptos[0] && deptos[0].id),
      opciones: deptos.map(function (x) { return { valor: x.id, titulo: x.nombre, color: x.color }; }) });
    var modelo = App.elegir({ etiqueta: 'Modelo', forma: 'lista', valor: d.modelo || 'sonnet',
      opciones: App.MODELOS.map(function (m) { return { valor: m.valor, titulo: m.titulo, sub: m.sub }; }) });
    var esfuerzo = App.elegir({ etiqueta: 'Esfuerzo', forma: 'lista', valor: d.esfuerzo || '',
      opciones: App.ESFUERZOS.map(function (m) { return { valor: m.valor, titulo: m.titulo, sub: m.sub }; }) });
    /* skills que usa (cuentan con «Las de cada agente» en Ajustes › Consumo de IA): la lista sale de tu Claude Code */
    var skillsSel = (d.skills || []).slice();
    var skillsCaja = h('div', h('span.ayuda', 'Buscando tus skills…'));
    function pintarSkills(lista) {
      App.vaciar(skillsCaja);
      skillsSel.forEach(function (s) { if (lista.indexOf(s) < 0) lista.push(s); });   // las elegidas que ya no están, igual se ven
      if (!lista.length) { skillsCaja.appendChild(h('span.ayuda', 'No encontré skills instaladas en tu Claude Code.')); return; }
      skillsCaja.appendChild(App.elegir({ etiqueta: 'Skills', forma: 'chips', multiple: true, valor: skillsSel,
        opciones: lista.map(function (s) { return { valor: s, titulo: s.replace(/^[^:]+:/, '') , sub: s }; }),
        alCambiar: function (v) { skillsSel = v; } }));
    }
    App.api.get('/api/skills').then(function (r) { pintarSkills(r.skills || []); })
      .catch(function () { App.vaciar(skillsCaja).appendChild(h('span.ayuda', 'No pude traer la lista de skills.')); });
    var desc = h('input.campo', { value: d.description || '', maxlength: 1000, placeholder: 'En una línea, para qué sirve' });
    var prompt = h('textarea.campo', { rows: 9, maxlength: 20000 }); prompt.value = d.prompt || '';
    var sabeItems = temas((d.sabeDe || []).join(', '));
    var sabe = chipsTemas(sabeItems, { placeholder: 'Un tema, por ejemplo: Reels', max: 12, largo: 60 });
    var chipsItems = (d.chips || []).filter(Boolean).slice(0, 3);
    var pedidos = App.chipsEditables(chipsItems, { placeholder: 'Un pedido de ejemplo', max: 3, largo: 200 });
    var ava = App.EditorAvatar(d.avatar, function () { return d.avatar.semilla || id.value; }, { plegable: true });
    if (!op.editar) nombre.addEventListener('input', function () { if (!idTocado) id.value = App.slug(nombre.value, usados); ava.retratar(); });
    id.addEventListener('input', function () { idTocado = true; });
    /* el identificador es un dato técnico: texto chico y secundario (editable solo al contratar) */
    var idFila = op.editar
      ? h('div.ficha-id', 'Identificador: ', h('code', d.id || ''), ' · no se puede cambiar')
      : h('div.ficha-id', h('label', 'Identificador'), id, h('span', 'Así se llama el agente en Claude Code.'));

    var el = h('div.editor',
      ava.el,
      h('div',
        grupo('Quién es', [
          campo('Nombre', nombre),
          campo('Rol', rol),
          campo('Departamento', dep, 'La sala de la oficina donde trabaja.'),
          campo('Descripción corta', desc)]),
        grupo('Cómo trabaja', [
          campo('Instrucciones', prompt, 'Cómo trabaja, qué entrega y cómo habla. Es el texto que recibe Claude.'),
          campo('Modelo', modelo, 'Cambia cuánto gasta y qué tan bien resuelve. Vale desde la próxima vez que trabaje.'),
          campo('Esfuerzo', esfuerzo, 'Cuánto piensa antes de responder. Pensar también gasta tokens: para charlar, Bajo o Medio alcanza. En cada charla lo podés cambiar.'),
          campo('Skills que usa', skillsCaja, 'Solo cuentan si en Ajustes › Consumo de IA elegiste «Las de cada agente»: así no recibe la lista de todas.'),
          campo('Sabe de', sabe, 'Hasta 12 temas. Sus colegas los usan para saber a quién preguntarle.'),
          campo('Pedidos sugeridos', pedidos, 'Hasta 3 frases que aparecen como botones al abrir su charla.')]),
        idFila));

    return {
      el: el,
      valor: function () {
        return {
          id: id.value.trim() || d.id || '', nombre: nombre.value.trim(), rol: rol.value.trim(), departamento: dep.valor() || '', modelo: modelo.valor(), esfuerzo: esfuerzo.valor() || '', skills: skillsSel.slice(),
          description: desc.value.trim() || rol.value.trim(), prompt: prompt.value.trim(),
          chips: chipsItems.map(function (c) { return c.trim(); }).filter(Boolean), avatar: ava.valor(), brief: d.brief || undefined,
          sabeDe: sabeItems.slice()
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
        if (v.sabeDe.length > 12) return '«Sabe de» admite hasta 12 temas.';
        if (v.sabeDe.some(function (t) { return t.length > 60; })) return 'Cada tema de «Sabe de» tiene que tener hasta 60 caracteres.';
        return null;
      }
    };
  };

  /* ---------------- flujo de contratación ----------------
     Es una pantalla (#/equipo/contratar): primero se cuenta qué hace falta y después se revisa el perfil, en el mismo lugar. */
  App.Contratar = {
    abrir: function (op) {
      op = op || {};
      if (!App.E.oficina.departamentos.length) { App.aviso('Primero creá un departamento.', true); App.Nav.ir('#/equipo/departamentos'); return; }
      var hj = App.hojaEnPanel({ titulo: 'Contratar', icono: 'personas' }, 'contratar');
      var desc = h('textarea.campo', { rows: 5, autofocus: true, maxlength: 4000, placeholder: 'Ej.: alguien que mire las ventas de cada semana, me diga qué productos se mueven y arme un resumen corto para el lunes.' });
      var deptos = App.E.oficina.departamentos;
      var dep = App.elegir({ etiqueta: 'Departamento', valor: op.departamento || deptos[0].id,
        opciones: deptos.map(function (x) { return { valor: x.id, titulo: x.nombre, color: x.color }; }) });
      var err = h('div.error-txt'), estado = h('div');
      var pedir = h('button.btn.primario', { onclick: borrador }, App.icono('chispa'), 'Proponer con Claude');
      App.add(hj.cuerpo,
        h('p', { style: { color: 'var(--suave)', marginTop: '4px', marginBottom: '14px' } }, 'Contá con tus palabras qué necesitás. Claude arma el perfil del agente y lo revisás antes de contratarlo.'),
        h('div.fila-campo', h('label.etiqueta-campo', '¿Qué tiene que hacer?'), desc),
        h('div.fila-campo', h('label.etiqueta-campo', 'Departamento'), h('div.ayuda', 'Dónde se sienta en la oficina.'), dep), estado, err);
      App.add(hj.pie, App.acciones(
        [h('button.btn.fantasma', { onclick: function () { paso2({ departamento: dep.valor(), brief: desc.value.trim() }); } }, 'Completar a mano')],
        [h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), pedir]));
      function borrador() {
        err.textContent = '';
        if (desc.value.trim().length < 8) { err.textContent = 'Contá un poco más qué necesitás.'; desc.focus(); return; }
        pedir.disabled = true; App.add(App.vaciar(estado), App.cargando('Claude está armando el perfil… puede tardar unos segundos.'));
        api.post('/api/agentes/borrador', { descripcion: desc.value.trim(), departamento: dep.valor() })
          .then(function (b) { b.brief = desc.value.trim(); b.departamento = b.departamento || dep.valor(); paso2(b); })
          .catch(function (e) { err.textContent = e.message; pedir.disabled = false; App.vaciar(estado); });
      }
      function paso2(datos) {
        hj.titulo('Revisá el perfil');
        var ed = App.EditorAgente(datos, {});
        var err2 = h('div.error-txt');
        App.add(App.vaciar(hj.cuerpo), h('p', { style: { color: 'var(--suave)', marginTop: '4px', marginBottom: '14px' } }, 'Cambiá lo que quieras: después se puede editar en su ficha.'), ed.el, err2);
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
        App.add(App.vaciar(hj.pie), App.acciones(null, [h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), ok]));
      }
    }
  };
})();
