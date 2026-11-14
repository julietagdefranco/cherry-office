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
    del: function (r, c) { return pedido('DELETE', r, c); }
  };

  /* ---------------- app nativa (WKWebView) ---------------- */
  var puente = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.hq;
  App.nativo = {
    hay: !!puente,
    /* abre un archivo o carpeta con la app predeterminada de macOS (solo rutas dentro de la oficina o vínculos) */
    abrir: function (ruta) { if (puente) puente.postMessage({ accion: 'abrir', ruta: ruta }); },
    revelar: function (ruta) { if (puente) puente.postMessage({ accion: 'revelar', ruta: ruta }); },
    acerca: function () { if (puente) puente.postMessage({ accion: 'acerca' }); },
    /* número en el ícono del Dock (avisos pendientes); 0 lo saca */
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
    parte: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7'
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

  /* Markdown mínimo y seguro: se escapa todo y después se aplican pocas marcas. Sin enlaces ni HTML crudo. */
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function enLinea(s) {
    return esc(s)
      .replace(/`([^`\n]{1,200})`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]{1,300})\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]{1,200})\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  }
  App.markdown = function (texto) {
    var lineas = String(texto || '').split('\n'), out = [], lista = null, pre = null, parrafo = [];
    function cerrarP() { if (parrafo.length) { out.push('<p>' + parrafo.map(enLinea).join('<br>') + '</p>'); parrafo = []; } }
    function cerrarL() { if (lista) { out.push('</' + lista + '>'); lista = null; } }
    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i];
      if (pre !== null) { if (/^```/.test(l)) { out.push('<pre>' + esc(pre.join('\n')) + '</pre>'); pre = null; } else pre.push(l); continue; }
      if (/^```/.test(l)) { cerrarP(); cerrarL(); pre = []; continue; }
      var m;
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) { cerrarP(); if (lista !== 'ul') { cerrarL(); out.push('<ul>'); lista = 'ul'; } out.push('<li>' + enLinea(m[1]) + '</li>'); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { cerrarP(); if (lista !== 'ol') { cerrarL(); out.push('<ol>'); lista = 'ol'; } out.push('<li>' + enLinea(m[1]) + '</li>'); continue; }
      if ((m = /^#{1,6}\s+(.*)$/.exec(l))) { cerrarP(); cerrarL(); out.push('<h4>' + enLinea(m[1]) + '</h4>'); continue; }
      if (!l.trim()) { cerrarP(); cerrarL(); continue; }
      cerrarL(); parrafo.push(l);
    }
    if (pre !== null) out.push('<pre>' + esc(pre.join('\n')) + '</pre>');
    cerrarP(); cerrarL();
    return out.join('');
  };
  App.htmlSeguro = function (el, html) { el.innerHTML = html; return el; };   // solo con salida de App.markdown

  /* abre un {nombre, mime, base64, ruta} devuelto por el backend */
  App.abrirContenido = function (c) {
    if (App.nativo.hay && c.ruta) { App.nativo.abrir(c.ruta); return; }
    if (!c.base64) { App.aviso('El archivo es muy grande para abrirlo desde el navegador. Está en: ' + (c.ruta || ''), true); return; }
    var bin = atob(c.base64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([arr], { type: c.mime || 'application/octet-stream' }));
    var w = window.open(url, '_blank');
    if (!w) { var a = h('a', { href: url, download: c.nombre || 'archivo' }); document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
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
