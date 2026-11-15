/* Base: API del backend, puente con la app nativa, utilidades de DOM, hojas, menús y avisos. */
window.App = window.App || {};
/* estado compartido entre módulos */
App.E = { estado: null, carpeta: null, oficina: null, ocupados: {}, reunion: null };
(function () {
  'use strict';

  /* ---------------- API ---------------- */
  function pedido(metodo, ruta, cuerpo) {
    var op = { method: metodo, headers: {} };
    if (cuerpo !== undefined) { op.headers['Content-Type'] = 'application/json'; op.body = JSON.stringify(cuerpo); }
    return fetch(ruta, op).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : {}; } catch (e) { d = null; }
        if (!r.ok) {
          var err = new Error((d && d.error) || ('Error ' + r.status));
          err.status = r.status; err.datos = d;
          throw err;
        }
        return d || {};
      });
    });
  }
  function qs(o) {
    var p = [];
    Object.keys(o || {}).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); });
    return p.length ? '?' + p.join('&') : '';
  }
  App.api = {
    get: function (r, q) { return pedido('GET', r + qs(q)); },
    post: function (r, c) { return pedido('POST', r, c === undefined ? {} : c); },
    patch: function (r, c) { return pedido('PATCH', r, c); },
    put: function (r, c) { return pedido('PUT', r, c); },
    del: function (r, c) { return pedido('DELETE', r, c); }
  };

  /* ---------------- app nativa (WKWebView) ---------------- */
  var puente = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.hq;
  var plataforma = (window.oficinaApp && window.oficinaApp.plataforma) || 'darwin';
  App.nativo = {
    hay: !!puente,
    /* «en Finder» (Mac) o «en el Explorador» (Windows) */
    enExplorador: plataforma === 'win32' ? 'en el Explorador' : plataforma === 'darwin' ? 'en Finder' : 'en la carpeta',
    /* abre un archivo o carpeta con la app predeterminada del sistema (solo rutas dentro de la oficina o vínculos) */
    abrir: function (ruta) { if (puente) puente.postMessage({ accion: 'abrir', ruta: ruta }); },
    revelar: function (ruta) { if (puente) puente.postMessage({ accion: 'revelar', ruta: ruta }); },
    acerca: function () { if (puente) puente.postMessage({ accion: 'acerca' }); },
    /* número en el ícono del Dock o de la barra de tareas (avisos pendientes); 0 lo saca */
    insignia: function (n) { if (puente) puente.postMessage({ accion: 'insignia', n: n | 0 }); },
    /* selector de un .zip (importar una oficina); undefined si no hay app nativa o falla, null si se cancela */
    elegirArchivo: function (titulo) {
      if (!puente) return Promise.resolve(undefined);
      try {
        return Promise.resolve(puente.postMessage({ accion: 'elegirArchivo', titulo: titulo }))
          .then(function (r) { return typeof r === 'string' && r ? r : null; });
      } catch (e) { return Promise.resolve(undefined); }
    },
    elegirCarpeta: function (titulo, inicio, crear) {
      if (!puente) return Promise.resolve(undefined);
      try {
        return Promise.resolve(puente.postMessage({ accion: 'elegirCarpeta', titulo: titulo, inicio: inicio || null, crear: !!crear }))
          .then(function (r) { return typeof r === 'string' && r ? r : null; });
      } catch (e) { return Promise.resolve(undefined); }
    }
  };

  /* ---------------- DOM ---------------- */
  /* h('div.clase', {onclick, title, ...}, hijos...) — los textos van siempre como texto, nunca como HTML */
  function h(sel, attrs) {
    var partes = sel.split('.'), el = document.createElement(partes[0] || 'div');
    if (partes.length > 1) el.className = partes.slice(1).join(' ');
    var hijos = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) { hijos.unshift(attrs); attrs = null; }
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    agregar(el, hijos);
    return el;
  }
  function agregar(el, hijos) {
    hijos.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) agregar(el, c);
      else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }
  function vaciar(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  App.h = h; App.vaciar = vaciar;
  App.add = function (el) { agregar(el, Array.prototype.slice.call(arguments, 1)); return el; };   // como append, pero ignora null/false y aplana listas

  /* íconos de trazo fino (SVG inline) */
  var ICONOS = {
    mas: 'M12 5v14M5 12h14',
    cerrar: 'M6 6l12 12M18 6L6 18',
    menu: 'M4 7h16M4 12h16M4 17h16',
    personas: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.2a3 3 0 0 1 0 5.6',
    reunion: 'M4 6h16v9H8l-4 4zM8 10h8',
    libro: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
    capas: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    carpeta: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    subir: 'M12 16V4M7 9l5-5 5 5M5 20h14',
    buscar: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    enviar: 'M5 12h13M13 6l6 6-6 6',
    flecha: 'M9 6l6 6-6 6',
    atras: 'M15 6l-6 6 6 6',
    abrir: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    edificio: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M3 21h18',
    chispa: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    dado: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 9h.01M15 15h.01M15 9h.01M9 15h.01',
    papelera: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    importar: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    enlace: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
    recargar: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
    flujo: 'M5 4h4v4H5zM15 16h4v4h-4zM9 6h3a3 3 0 0 1 3 3v7M12 10h0',
    regla: 'M4 6h16M4 12h10M4 18h6M17 14l2 2 3-4',
    enchufe: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
    escudo: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4',
    parte: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
    lapiz: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    bandeja: 'M3 13h5l1.5 3h5l1.5-3h5M5.5 5h13L21 13v6H3v-6z',
    clip: 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7.1'
  };
  /* «hace 5 min»: acepta segundos epoch, milisegundos, un Date o una fecha ISO */
  App.hace = function (fecha) {
    var ms = fecha instanceof Date ? fecha.getTime() : typeof fecha === 'number' ? (fecha < 1e12 ? fecha * 1000 : fecha) : Date.parse(fecha);
    if (isNaN(ms)) return '';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
    return 'hace ' + Math.round(s / 86400) + ' d';
  };
  App.icono = function (n) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONOS[n] || ''); s.appendChild(p);
    return s;
  };
  /* logo: un ladrillo 2x2 visto en perspectiva, en gris oscuro */
  App.logo = function () {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('class', 'logo');
    s.innerHTML = '<rect x="2" y="9" width="28" height="19" rx="3" fill="#c4372f"/><rect x="2" y="9" width="28" height="5" rx="2" fill="#d6463d"/>' +
      '<ellipse cx="10" cy="9" rx="4.5" ry="2" fill="#e05a50"/><rect x="5.5" y="5" width="9" height="4" fill="#d6463d"/><ellipse cx="10" cy="5" rx="4.5" ry="2" fill="#ea6c62"/>' +
      '<ellipse cx="22" cy="9" rx="4.5" ry="2" fill="#e05a50"/><rect x="17.5" y="5" width="9" height="4" fill="#d6463d"/><ellipse cx="22" cy="5" rx="4.5" ry="2" fill="#ea6c62"/>';
    return s;
  };

  /* ---------------- avisos ---------------- */
  var tostadas = null;
  App.aviso = function (texto, error) {
    if (!tostadas) { tostadas = h('div.tostadas'); document.body.appendChild(tostadas); }
    var t = h('div.tostada' + (error ? '.error' : ''), texto);
    tostadas.appendChild(t);
    setTimeout(function () { t.remove(); }, error ? 6500 : 3200);
  };
  App.fallo = function (e) { App.aviso((e && e.message) || String(e), true); };

  /* ---------------- hojas modales (apiladas; Esc cierra la de arriba) ---------------- */
  var pila = [];
  App.hoja = function (op) {
    var cuerpo = h('div.hoja-cuerpo'), pie = h('div.hoja-pie');
    var cab = h('div.hoja-cab', h('h2', op.titulo || ''), h('button.btn.fantasma.icono', { title: 'Cerrar', onclick: function () { cerrar(); } }, App.icono('cerrar')));
    var caja = h('div.hoja', { style: { width: (op.ancho || 560) + 'px', height: op.alto || null } }, cab, cuerpo, op.sinPie ? null : pie);
    var velo = h('div.velo', caja);
    velo.addEventListener('mousedown', function (e) { if (e.target === velo && !op.modal) cerrar(); });
    document.body.appendChild(velo);
    var obj = { el: caja, cuerpo: cuerpo, pie: pie, cab: cab, cerrar: cerrar, titulo: function (t) { cab.firstChild.textContent = t; } };
    pila.push(obj);
    var cerrada = false;
    function cerrar() {
      if (cerrada) return; cerrada = true;
      velo.remove();
      pila.splice(pila.indexOf(obj), 1);
      if (op.alCerrar) op.alCerrar();
    }
    setTimeout(function () { var f = caja.querySelector('[autofocus]') || caja.querySelector('input,textarea,select'); if (f) f.focus(); }, 30);
    return obj;
  };
  App.hojaAbierta = function () { return pila.length > 0; };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (emergente) { cerrarEmergente(); return; }
    if (pila.length) { pila[pila.length - 1].cerrar(); e.preventDefault(); return; }
    if (App.alEscape) App.alEscape();
  });

  App.confirmar = function (titulo, texto, boton, peligro) {
    return new Promise(function (ok) {
      var res = false;
      var hj = App.hoja({ titulo: titulo, ancho: 420, alCerrar: function () { ok(res); } });
      hj.cuerpo.appendChild(h('p', { style: { color: 'var(--suave)' } }, texto));
      hj.pie.appendChild(h('button.btn', { onclick: function () { hj.cerrar(); } }, 'Cancelar'));
      hj.pie.appendChild(h('button.btn.primario' + (peligro ? '.peligro' : ''), {
        autofocus: true, style: peligro ? { background: 'var(--peligro)', borderColor: 'var(--peligro)', color: '#fff' } : null,
        onclick: function () { res = true; hj.cerrar(); }
      }, boton || 'Aceptar'));
    });
  };

  App.preguntar = function (titulo, etiqueta, valor) {
    return new Promise(function (ok) {
      var res = null, inp = h('input.campo', { value: valor || '', autofocus: true });
      var hj = App.hoja({ titulo: titulo, ancho: 400, alCerrar: function () { ok(res); } });
      function listo() { res = inp.value.trim() || null; hj.cerrar(); }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') listo(); });
      App.add(hj.cuerpo, h('label.etiqueta-campo', etiqueta || ''), inp);
      App.add(hj.pie, h('button.btn', { onclick: hj.cerrar }, 'Cancelar'), h('button.btn.primario', { onclick: listo }, 'Aceptar'));
    });
  };

  /* ---------------- menús emergentes ---------------- */
  var emergente = null;
  function cerrarEmergente() { if (emergente) { emergente.remove(); emergente = null; } }
  App.emergente = function (ancla, contenido, clase) {
    cerrarEmergente();
    var r = ancla.getBoundingClientRect();
    emergente = h('div.emergente' + (clase ? '.' + clase : ''), contenido);
    document.body.appendChild(emergente);
    var w = emergente.offsetWidth, hh = emergente.offsetHeight;
    var x = Math.min(r.left, window.innerWidth - w - 8), y = r.bottom + 6;
    if (y + hh > window.innerHeight - 8) y = Math.max(8, r.top - hh - 6);
    emergente.style.left = Math.max(8, x) + 'px'; emergente.style.top = y + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', function fuera(e) {
        if (emergente && !emergente.contains(e.target)) { cerrarEmergente(); }
        document.removeEventListener('mousedown', fuera, true);
      }, true);
    }, 0);
    return { cerrar: cerrarEmergente };
  };
  App.menu = function (ancla, items) {
    var m = App.emergente(ancla, h('div', items.map(function (it) {
      if (it === '-') return h('div.menu-sep');
      if (it.titulo) return h('div.menu-tit', it.titulo);
      return h('button.menu-item', { onclick: function () { m.cerrar(); it.accion(); } }, it.icono ? App.icono(it.icono) : null, it.texto, it.nota ? h('small', it.nota) : null);
    })), 'menu');
    return m;
  };

  /* ---------------- utilidades ---------------- */
  App.uuid = function () {
    if (window.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function (n) { return (n < 16 ? '0' : '') + n.toString(16); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  };
  App.slug = function (s, usados) {
    var base = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'agente';
    var c = base, n = 2;
    for (var i = 0; i < 200 && usados && usados.indexOf(c) >= 0; i++) c = base.slice(0, 36) + '-' + (n++);
    return c;
  };
  App.fecha = function (iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    var hoy = new Date(), mismo = d.toDateString() === hoy.toDateString();
    return mismo ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  };
  App.tam = function (b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; };
  App.debounce = function (fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; };

  /* Markdown seguro: se escapa todo y después se aplican las marcas. Sin HTML crudo; los enlaces solo http(s) y mailto
     (los abre el navegador del sistema). Soporta títulos, párrafos, listas anidadas y de tareas, citas, tablas,
     código, separadores, negrita, cursiva, tachado y enlaces. */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function enlace(u, texto) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + texto + '</a>'; }
  function enLinea(s) {
    var guardado = [];
    function guardar(html) { guardado.push(html); return '\u0000' + (guardado.length - 1) + '\u0000'; }
    s = String(s).replace(/\u0000/g, '')
      .replace(/`([^`\n]{1,500})`/g, function (_, c) { return guardar('<code>' + esc(c) + '</code>'); })
      .replace(/!?\[([^\]\n]{1,300})\]\(\s*<?((?:https?:\/\/|mailto:)[^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, function (_, t, u) { return guardar('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">') + t + guardar('</a>'); })
      .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, function (_, u) { return guardar(enlace(u, esc(u))); })
      .replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])/g, function (_, a, u) { return a + guardar(enlace(u, esc(u))); });
    return esc(s)
      .replace(/\*\*(?=\S)([^\n]{1,300}?\S)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^\w])__(?=\S)([^\n]{1,300}?\S)__(?!\w)/g, '$1<b>$2</b>')
      .replace(/~~(?=\S)([^~\n]{1,300}?\S)~~/g, '<s>$1</s>')
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]{0,200}?[^\s*])?\*(?![\w*])/g, function (m, a, t, i) { return t === undefined ? m : a + '<i>' + t + '</i>'; })
      .replace(/(^|[^\w])_(?=\S)([^_\n]{1,200}?\S)?_(?!\w)/g, function (m, a, t) { return t === undefined ? m : a + '<i>' + t + '</i>'; })
      .replace(/\u0000(\d+)\u0000/g, function (_, n) { return guardado[+n]; });
  }
  function celdas(l) {
    l = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return l.replace(/\\\|/g, '\u0001').split('|').map(function (c) { return c.trim().replace(/\u0001/g, '|'); });
  }
  var RE_SEP_TABLA = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  var RE_ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  App.markdown = function (texto) {
    var lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n'), out = [], parrafo = [], listas = [];
    function cerrarP() { if (parrafo.length) { out.push('<p>' + parrafo.map(enLinea).join('<br>') + '</p>'); parrafo = []; } }
    function cerrarL(hasta) {
      hasta = hasta || 0;
      while (listas.length > hasta) out.push('</li></' + listas.pop().tipo + '>');
    }
    function cerrarTodo() { cerrarP(); cerrarL(); }
    function item(m) {
      var ind = m[1].replace(/\t/g, '    ').length, tipo = /\d/.test(m[2]) ? 'ol' : 'ul', cont = m[3];
      while (listas.length && ind < listas[listas.length - 1].ind) cerrarL(listas.length - 1);
      var tope = listas[listas.length - 1];
      if (tope && ind === tope.ind && tope.tipo !== tipo) { cerrarL(listas.length - 1); tope = listas[listas.length - 1]; }
      if (!tope || ind > tope.ind) {
        var ini = tipo === 'ol' ? parseInt(m[2], 10) : 1;
        out.push('<' + tipo + (ini !== 1 ? ' start="' + ini + '"' : '') + '>');
        listas.push({ tipo: tipo, ind: ind });
      } else out.push('</li>');
      var t = /^\[([ xX])\]\s+(.*)$/.exec(cont);
      if (t) out.push('<li class="tarea"><input type="checkbox" disabled' + (t[1] !== ' ' ? ' checked' : '') + '> ' + enLinea(t[2]));
      else out.push('<li>' + enLinea(cont));
    }
    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i], m;
      if ((m = /^\s*(```+|~~~+)/.exec(l))) {
        cerrarTodo();
        var cerca = m[1], cod = [];
        for (i++; i < lineas.length && lineas[i].trim().indexOf(cerca) !== 0; i++) cod.push(lineas[i]);
        out.push('<pre><code>' + esc(cod.join('\n')) + '</code></pre>');
        continue;
      }
      if (!l.trim()) { cerrarP(); if (listas.length && !(i + 1 < lineas.length && (RE_ITEM.test(lineas[i + 1]) || /^\s{2,}\S/.test(lineas[i + 1])))) cerrarL(); continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { cerrarTodo(); var n = Math.min(m[1].length + 1, 5); out.push('<h' + n + '>' + enLinea(m[2]) + '</h' + n + '>'); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { cerrarTodo(); out.push('<hr>'); continue; }
      if (/^\s{0,3}>/.test(l)) {
        cerrarTodo();
        var cita = [];
        for (; i < lineas.length && /^\s{0,3}>/.test(lineas[i]); i++) cita.push(lineas[i].replace(/^\s{0,3}>\s?/, ''));
        i--;
        out.push('<blockquote>' + App.markdown(cita.join('\n')) + '</blockquote>');
        continue;
      }
      if (l.indexOf('|') >= 0 && i + 1 < lineas.length && RE_SEP_TABLA.test(lineas[i + 1]) && lineas[i + 1].indexOf('-') >= 0) {
        cerrarTodo();
        var cab = celdas(l), alin = celdas(lineas[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''; });
        function fila(cs, tag) {
          return '<tr>' + cab.map(function (_, k) { var a = alin[k] ? ' style="text-align:' + alin[k] + '"' : ''; return '<' + tag + a + '>' + enLinea(cs[k] || '') + '</' + tag + '>'; }).join('') + '</tr>';
        }
        var filas = [];
        for (i += 2; i < lineas.length && lineas[i].trim() && lineas[i].indexOf('|') >= 0; i++) filas.push(fila(celdas(lineas[i]), 'td'));
        i--;
        out.push('<div class="md-tabla"><table><thead>' + fila(cab, 'th') + '</thead><tbody>' + filas.join('') + '</tbody></table></div>');
        continue;
      }
      if ((m = RE_ITEM.exec(l))) { cerrarP(); item(m); continue; }
      if (listas.length && /^\s+\S/.test(l)) { out.push('<br>' + enLinea(l.trim())); continue; }
      cerrarL(); parrafo.push(l);
    }
    cerrarTodo();
    return out.join('');
  };
  App.htmlSeguro = function (el, html) { el.innerHTML = html; el.classList.add('md'); return el; };   // solo con salida de App.markdown

  /* visor de documentos dentro de la app: markdown formateado (con opción de ver el texto) o texto plano */
  App.esMarkdown = function (nombre) { return /\.(md|markdown|mdown|mkd)$/i.test(nombre || ''); };
  App.verDocumento = function (op) {
    var md = op.markdown !== false && App.esMarkdown(op.nombre), crudo = !md;
    var hj = App.hoja({ titulo: op.titulo || op.nombre || 'Documento', ancho: 820, alto: '86vh' });
    hj.el.classList.add('hoja-doc');
    var vista = h('div.md-doc');
    function pintar() {
      App.vaciar(vista);
      if (crudo) { vista.classList.remove('md'); vista.appendChild(h('pre.md-crudo', op.texto || '')); }
      else App.htmlSeguro(vista, App.markdown(op.texto || ''));
      if (op.truncado) vista.appendChild(h('div.ayuda', { style: { marginTop: '12px' } }, 'El archivo es largo: se muestra solo el principio.'));
      if (alternar) alternar.textContent = crudo ? 'Ver formateado' : 'Ver texto';
    }
    var alternar = md ? h('button.btn.izq', { onclick: function () { crudo = !crudo; pintar(); hj.cuerpo.scrollTop = 0; } }) : null;
    hj.cuerpo.appendChild(vista);
    App.add(hj.pie, alternar,
      h('button.btn', { onclick: function () {
        (navigator.clipboard ? navigator.clipboard.writeText(op.texto || '') : Promise.reject()).then(function () { App.aviso('Copiado.'); }, function () { App.aviso('No se pudo copiar.', true); });
      } }, 'Copiar'),
      App.nativo.hay && op.ruta ? h('button.btn', { onclick: function () { App.nativo.abrir(op.ruta); } }, App.icono('abrir'), 'Abrir con otra app') : null,
      h('button.btn.primario', { onclick: hj.cerrar }, 'Cerrar'));
    pintar();
    return hj;
  };
  function textoDe(c) {
    if (typeof c.texto === 'string') return c.texto;
    if (!c.base64) return null;
    try {
      var bin = atob(c.base64), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(arr);
    } catch (e) { return null; }
  }
  /* abre un .md de la oficina (ruta relativa) en el visor */
  App.abrirMarkdownOficina = function (rel) {
    return App.api.get('/api/oficina/archivo', { ruta: rel }).then(App.abrirContenido).catch(App.fallo);
  };

  /* abre un {nombre, mime, base64 | texto, ruta} devuelto por el backend */
  App.abrirContenido = function (c) {
    if (App.esMarkdown(c.nombre)) {
      var t = textoDe(c);
      if (t !== null) { App.verDocumento({ nombre: c.nombre, texto: t, ruta: c.ruta, truncado: c.truncado }); return; }
    }
    if (App.nativo.hay && c.ruta) { App.nativo.abrir(c.ruta); return; }
    if (typeof c.texto === 'string') { App.verDocumento({ nombre: c.nombre, texto: c.texto, ruta: c.ruta, truncado: c.truncado, markdown: false }); return; }
    if (!c.base64) { App.aviso('El archivo es muy grande para abrirlo desde el navegador. Está en: ' + (c.ruta || ''), true); return; }
    var bin = atob(c.base64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([arr], { type: c.mime || 'application/octet-stream' }));
    var w = window.open(url, '_blank');
    if (!w) { var a = h('a', { href: url, download: c.nombre || 'archivo' }); document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  };

  /* ---------- archivos para un agente («hacé algo con esta foto») ----------
     En el chat, al arrancar una corrida y en las tareas. Se eligen con el botón, se arrastran o se pegan; viajan en base64
     (`archivos: [{nombre, base64}]`) y el backend los guarda en archivos/adjuntos/ y le pasa las rutas al agente. */
  var ADJ_MAX = 10, ADJ_MB = 25, ADJ_ENCABEZADO = 'Archivos adjuntos (leelos con Read antes de responder):';
  var ADJ_IMAGEN = /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i;
  /* tipos que la Biblioteca sabe leer (TipoArchivo.soportados del backend) */
  var ADJ_BIBLIOTECA = /\.(pdf|docx?|rtf|pages|odt|txt|md|csv|tsv|json|png|jpe?g|gif|webp|heic)$/i;
  var ADJ_CLAVE_BIBLIOTECA = 'hq-adjuntos-biblioteca';
  App.Adjuntos = function (opc) {
    opc = opc || {};
    var archivos = [], urls = [];
    var err = opc.error || h('div.error-txt');
    var sel = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    var lista = h('div.adjuntos');
    /* «Guardar también en la biblioteca»: se recuerda entre envíos; solo aparece si hay algún archivo que la Biblioteca lee */
    var aBiblioteca = false;
    try { aBiblioteca = localStorage.getItem(ADJ_CLAVE_BIBLIOTECA) === '1'; } catch (x) { /* sin almacenamiento: apagada */ }
    var casilla = h('input', { type: 'checkbox', checked: aBiblioteca, onchange: function () {
      aBiblioteca = casilla.checked;
      try { localStorage.setItem(ADJ_CLAVE_BIBLIOTECA, aBiblioteca ? '1' : '0'); } catch (x) { /* no se recuerda */ }
    } });
    var filaBiblioteca = h('label.adjuntos-biblioteca', { title: 'Además de pasárselos al agente, quedan en la Biblioteca (con su ficha) para que los consulte todo el equipo.' },
      casilla, App.icono('libro'), 'Guardar también en la biblioteca');
    var boton = h('button.btn' + (opc.texto ? '' : '.icono'), { type: 'button', title: 'Adjuntar archivos (también podés arrastrarlos o pegarlos)',
      onclick: function () { sel.click(); } }, App.icono('clip'), opc.texto || null);
    function total() { return archivos.reduce(function (n, f) { return n + f.size; }, 0); }
    function agregar(files) {
      err.textContent = '';
      Array.prototype.forEach.call(files || [], function (f) {
        if (archivos.length >= (opc.max || ADJ_MAX)) { err.textContent = 'Máximo ' + (opc.max || ADJ_MAX) + ' archivos por vez.'; return; }
        if (total() + f.size > ADJ_MB * 1048576) { err.textContent = 'Los archivos pueden pesar hasta ' + ADJ_MB + ' MB en total.'; return; }
        archivos.push(f);
      });
      pintar();
      if (opc.alCambiar) opc.alCambiar();
    }
    function pintar() {
      urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = [];
      App.vaciar(lista);
      archivos.forEach(function (f, i) {
        var mini = null;
        if (/^image\//.test(f.type)) { var u = URL.createObjectURL(f); urls.push(u); mini = h('img', { src: u, alt: '' }); }
        lista.appendChild(h('div.adjunto', { title: f.name + ' · ' + App.tam(f.size) }, mini || App.icono('clip'), h('span', f.name),
          h('button.btn.fantasma.chico.icono', { type: 'button', title: 'Sacar', onclick: function () { archivos.splice(i, 1); pintar(); if (opc.alCambiar) opc.alCambiar(); } }, App.icono('cerrar'))));
      });
      if (archivos.some(function (f) { return ADJ_BIBLIOTECA.test(f.name); })) lista.appendChild(filaBiblioteca);
      lista.style.display = archivos.length ? '' : 'none';
    }
    /* después de mandarlos: copia en la Biblioteca (compartido) los que sabe leer, uno por uno, y avisa cómo fue */
    function guardarEnBiblioteca(leidos) {
      if (!aBiblioteca || !leidos || !leidos.length) return Promise.resolve();
      var sirven = leidos.filter(function (a) { return ADJ_BIBLIOTECA.test(a.nombre); });
      var otros = leidos.length - sirven.length, ok = 0, ya = 0, reemplazados = [], fallas = [];
      return sirven.reduce(function (p, a) {
        return p.then(function () {
          return App.api.post('/api/archivos', { nombre: a.nombre, base64: a.base64 })
            .then(function (r) { if (r.duplicado) ya++; else if (r.reemplazado) reemplazados.push(a.nombre); else ok++; })
            .catch(function (e) { fallas.push(a.nombre + ': ' + e.message); });
        });
      }, Promise.resolve()).then(function () {
        var partes = [];
        if (ok) partes.push(ok === 1 ? 'Guardé 1 archivo en la biblioteca.' : 'Guardé ' + ok + ' archivos en la biblioteca.');
        if (ya) partes.push(ya === 1 ? '1 ya estaba.' : ya + ' ya estaban.');
        if (reemplazados.length) partes.push('Reemplacé en la biblioteca ' + reemplazados.join(', ') + ' (había otro con el mismo nombre).');
        if (otros) partes.push(otros === 1 ? '1 no es de un tipo que la biblioteca lea.' : otros + ' no son de un tipo que la biblioteca lea.');
        if (fallas.length) partes.push('No pude guardar ' + fallas.join(' · '));
        if (partes.length) App.aviso(partes.join(' '), fallas.length > 0);
      });
    }
    sel.addEventListener('change', function () { agregar(sel.files); sel.value = ''; });
    function leer(f) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { var s2 = String(fr.result || ''); res({ nombre: f.name || 'archivo', base64: s2.slice(s2.indexOf(',') + 1) }); };
        fr.onerror = function () { rej(new Error('No pude leer «' + f.name + '».')); };
        fr.readAsDataURL(f);
      });
    }
    /* arrastrar y soltar (y pegar, en un campo de texto) sobre `el` */
    function zona(el, campo) {
      el.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); el.classList.add('soltando'); }
      });
      el.addEventListener('dragleave', function (e) { if (!el.contains(e.relatedTarget)) el.classList.remove('soltando'); });
      el.addEventListener('drop', function (e) {
        el.classList.remove('soltando');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); agregar(e.dataTransfer.files); }
      });
      if (campo) campo.addEventListener('paste', function (e) {
        var fs = e.clipboardData && e.clipboardData.files;
        if (fs && fs.length) {
          e.preventDefault();
          // una captura pegada llega como «image.png»: le ponemos fecha para que no se pisen los nombres
          agregar(Array.prototype.map.call(fs, function (f) {
            if (f.name && f.name !== 'image.png') return f;
            var n = 'captura-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
            try { return new File([f], n, { type: f.type }); } catch (x) { return f; }
          }));
        }
      });
    }
    pintar();
    return {
      boton: boton, lista: lista, input: sel, error: err, zona: zona, agregar: agregar,
      hay: function () { return archivos.length > 0; },
      nombres: function () { return archivos.map(function (f) { return f.name; }); },
      leer: function () { return Promise.all(archivos.map(leer)); },
      guardarEnBiblioteca: guardarEnBiblioteca,
      vaciar: function () { archivos = []; pintar(); }
    };
  };
  /* separa el bloque de adjuntos que el backend agrega al final de un mensaje: {texto, rutas} */
  App.Adjuntos.separar = function (t) {
    t = String(t || '');
    var i = t.indexOf(ADJ_ENCABEZADO);
    if (i < 0) return { texto: t, rutas: [] };
    var rutas = t.slice(i + ADJ_ENCABEZADO.length).split('\n').filter(function (l) { return /^- archivos\/adjuntos\//.test(l); })
      .map(function (l) { return l.slice(2).trim(); });
    return { texto: t.slice(0, i).replace(/\s+$/, ''), rutas: rutas };
  };
  /* chips de archivos ya guardados en la oficina (rutas relativas): miniatura si es imagen; clic para abrir */
  App.Adjuntos.chips = function (rutas, quitar) {
    return h('div.adjuntos', (rutas || []).map(function (r) {
      var nombre = r.split('/').pop(), mini = null;
      if (ADJ_IMAGEN.test(nombre)) {
        mini = h('img', { alt: '' });
        App.api.get('/api/oficina/archivo', { ruta: r }).then(function (c) { if (c.base64) mini.src = 'data:' + c.mime + ';base64,' + c.base64; }).catch(function () {});
      }
      return h('div.adjunto.guardado', { title: r, onclick: function () {
        App.api.get('/api/oficina/archivo', { ruta: r }).then(function (c) {
          App.abrirContenido({ nombre: nombre, mime: c.mime, base64: c.base64, ruta: c.ruta });
        }).catch(function () { App.aviso('No pude abrir ' + nombre + '. Está en la carpeta de la oficina: ' + r, true); });
      } }, mini || App.icono('clip'), h('span', nombre),
      quitar ? h('button.btn.fantasma.chico.icono', { type: 'button', title: 'Sacar de la tarea', onclick: function (e) { e.stopPropagation(); quitar(r); } }, App.icono('cerrar')) : null);
    }));
  };

  /* imagen de retrato con carga diferida */
  App.retratoImg = function (agente, clase, tam) {
    var img = h('img.' + (clase || 'retrato'), { alt: '' });
    App.Piezas.retrato(agente.avatar, agente.id, tam || 96).then(function (u) { img.src = u; }).catch(function () {});
    return img;
  };

  /* eventos simples */
  var subs = {};
  App.on = function (ev, fn) { (subs[ev] = subs[ev] || []).push(fn); };
  App.emit = function (ev, d) { (subs[ev] || []).slice().forEach(function (fn) { try { fn(d); } catch (e) { console.error(e); } }); };
})();
