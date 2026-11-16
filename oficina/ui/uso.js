/* Medidor del uso del plan de Claude (ventana de 5 horas y semanal): un chip en la barra de herramientas que se abre
   en un popover con las barras, cuándo se reinicia cada ventana y a qué ritmo venís. Los datos salen de /api/uso-claude. */
(function () {
  'use strict';
  var h = App.h, api = App.api;
  var CADA_MS = 120000;
  var VENTANAS = [
    { clave: 'cinco_horas', corto: '5 horas', nombre: 'Últimas 5 horas', largo: 5 * 3600 },
    { clave: 'semana', corto: 'semana', nombre: 'Semana', largo: 7 * 86400 },
    { clave: 'semana_opus', corto: null, nombre: 'Semana, solo Opus', largo: 7 * 86400 },
  ];
  var MOTIVOS = {
    sin_sesion: 'No encontré tu cuenta de Claude en esta compu. Abrí «claude» en la terminal e iniciá sesión.',
    vencido: 'Tu sesión de Claude venció. Se renueva sola la próxima vez que trabaje un agente (o al abrir «claude» en la terminal).',
    error: 'Tu cuenta de Claude no respondió. Pruebo de nuevo en un rato.',
  };
  var uso = null, chip = null, txt = null;

  function pct(v) { return v && typeof v.pct === 'number' ? Math.round(v.pct) : null; }
  function clase(v) { return !v ? '' : v.estado === 'limite' ? 'limite' : v.estado === 'cerca' ? 'cerca' : ''; }

  /* «en 2 h 13 min» si falta menos de un día; si no, «el jueves 14:00» */
  function cuando(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var s = Math.max(0, (t - Date.now()) / 1000);
    var min = Math.max(1, Math.round(s / 60));
    if (min < 60) return 'en ' + min + ' min';
    if (min < 1440) return 'en ' + Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
    var d = new Date(t);
    return 'el ' + d.toLocaleDateString('es', { weekday: 'long' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }

  /* A este ritmo: con lo usado desde que empezó la ventana, ¿se termina antes del reinicio? */
  function ritmo(v, largo) {
    var p = v && v.pct, t = v && Date.parse(v.reinicia);
    if (typeof p !== 'number' || !t || isNaN(t)) return null;
    var resta = (t - Date.now()) / 1000, paso = largo - resta;
    if (p >= 100) return { txt: 'Llegaste al tope. Se libera ' + cuando(v.reinicia) + '.', mal: true };
    if (paso < largo * 0.05 || p <= 0) return null;
    var porSeg = p / paso, alFinal = p + porSeg * resta;
    if (alFinal < 100) return { txt: 'Si seguís a este ritmo, llegás al reinicio con ~' + Math.round(alFinal) + '% usado.' };
    return { txt: 'Si seguís a este ritmo, se termina ' + cuando(new Date(Date.now() + (100 - p) / porSeg * 1000).toISOString()) + ', antes del reinicio.', mal: true };
  }

  function pintarChip() {
    if (!txt) return;
    App.vaciar(txt);
    chip.classList.remove('cerca', 'limite');
    var partes = VENTANAS.filter(function (w) { return w.corto && uso && pct(uso[w.clave]) !== null; });
    if (!partes.length) { txt.appendChild(h('span.uso-nada', '—')); chip.title = 'Uso de Claude'; return; }
    var peor = '';
    partes.forEach(function (w, i) {
      var v = uso[w.clave], c = clase(v);
      if (c === 'limite' || (c === 'cerca' && peor !== 'limite')) peor = c;
      if (i) txt.appendChild(h('span.uso-sep.btn-txt', '·'));
      txt.appendChild(h('span.uso-val' + (c ? '.' + c : '') + (i ? '.btn-txt' : ''), h('span.btn-txt', w.corto + ' '), pct(v) + '%'));
    });
    if (peor) chip.classList.add(peor);
    chip.title = 'Uso de Claude: ' + partes.map(function (w) { return w.nombre.toLowerCase() + ' ' + pct(uso[w.clave]) + '%'; }).join(', ');
  }

  function contenido() {
    var filas = [];
    VENTANAS.forEach(function (w) {
      var v = uso && uso[w.clave], p = pct(v);
      if (p === null) return;
      var r = ritmo(v, w.largo), c = clase(v);
      filas.push(h('div.uso-fila',
        h('div.uso-cab', h('span', w.nombre), h('b' + (c ? '.' + c : ''), p + '%')),
        h('div.uso-barra' + (c ? '.' + c : ''), h('i', { style: { width: Math.min(100, p) + '%' } })),
        v.reinicia ? h('div.uso-nota', 'Vuelve a cero ' + cuando(v.reinicia)) : null,
        r ? h('div.uso-nota' + (r.mal ? '.mal' : ''), r.txt) : null));
    });
    var pie = [];
    if (uso && uso.fuente === 'corridas') pie.push('Según lo último que informó Claude en el trabajo de un agente (' + App.hace(uso.actualizado) + ').');
    else if (uso && uso.actualizado) pie.push('Actualizado ' + App.hace(uso.actualizado) + '.');
    if (uso && uso.motivo && (!filas.length || uso.fuente === 'corridas')) pie.unshift(MOTIVOS[uso.motivo] || MOTIVOS.error);
    var recargar = h('button.btn.chico.icono', { title: 'Actualizar', onclick: function () { refrescar(true); } }, App.icono('recargar'));
    return h('div',
      h('div.uso-tit', h('b', 'Uso de Claude'), recargar),
      filas.length ? filas : h('div.uso-nota', uso ? '' : App.cargando('Trayendo tu uso…')),
      pie.length ? h('div.uso-pie', pie.join(' ')) : null);
  }

  function abrir() {
    App.emergente(chip, contenido(), 'uso-pop');
    refrescar();
  }

  function repintarPop() {
    var el = document.querySelector('.emergente.uso-pop');
    if (el) App.vaciar(el).appendChild(contenido());
  }

  function refrescar(forzar) {
    return api.get('/api/uso-claude' + (forzar ? '?forzar=1' : '')).then(function (r) {
      uso = r; pintarChip(); repintarPop();
    }).catch(function () {});
  }

  /* El chip para la barra de herramientas. Se pide de nuevo cada 2 min con la ventana visible y al volver a ella. */
  function boton() {
    if (!chip) {
      txt = h('span.uso-txt');
      chip = h('button.btn.uso', { title: 'Uso de Claude', onclick: abrir }, App.icono('medidor'), txt);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refrescar(); });
      window.addEventListener('focus', function () { refrescar(); });
      setInterval(function () { if (!document.hidden) refrescar(); }, CADA_MS);
    }
    pintarChip();
    refrescar();
    return chip;
  }

  App.Uso = { boton: boton, refrescar: refrescar };
})();
