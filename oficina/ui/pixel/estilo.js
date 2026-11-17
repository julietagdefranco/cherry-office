/* Elige cómo se dibuja la oficina según la preferencia `estilo_oficina` (pixel por defecto, o la maqueta LEGO).
   Cambia App.Oficina3D, los retratos y el editor de apariencia; el resto de la app los usa sin saber cuál es.
   Se llama una vez al arrancar, antes de montar la oficina; cambiar de estilo recarga la app. */
(function () {
  'use strict';
  var orig = { oficina: App.Oficina3D, retrato: App.Piezas && App.Piezas.retrato, editor: App.EditorAvatar, logo: App.logo };
  /* logo pixel: un edificio con ventanas encendidas (16×16, sin suavizado) */
  function logoPixel() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'logo'); s.setAttribute('shape-rendering', 'crispEdges');
    var r = function (x, y, w, h, c) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + c + '"/>'; }, v = '';
    v += r(2, 2, 9, 13, '#2a1f2e') + r(3, 3, 7, 12, '#e8a33d') + r(3, 3, 7, 1, '#f5c86a') + r(9, 3, 1, 12, '#c4822a');
    v += r(10, 6, 4, 9, '#2a1f2e') + r(11, 7, 2, 8, '#5d7da6') + r(11, 7, 2, 1, '#8eaed2');
    [[4, 5], [7, 5], [4, 8], [7, 8], [4, 11]].forEach(function (p) { v += r(p[0], p[1], 2, 2, '#fff3c4'); });
    v += r(7, 12, 2, 3, '#2a1f2e') + r(11, 9, 2, 1, '#fff3c4') + r(11, 12, 2, 1, '#fff3c4') + r(1, 15, 14, 1, '#2a1f2e');
    s.innerHTML = v; return s;
  }
  App.estiloOficina = 'lego';
  App.aplicarEstilo = function (estilo) {
    var pixel = estilo !== 'lego' && !!(App.OficinaPixel && App.Pixel);
    // sin WebGL la maqueta LEGO no puede dibujarse: se usa la pixel aunque esté elegida la otra
    if (!pixel && orig.oficina && orig.oficina.sinMotor && App.OficinaPixel && App.Pixel) pixel = true;
    App.estiloOficina = pixel ? 'pixel' : 'lego';
    App.Oficina3D = pixel ? App.OficinaPixel : orig.oficina;
    if (App.Piezas) App.Piezas.retrato = pixel ? App.Pixel.retrato : orig.retrato;
    App.EditorAvatar = pixel ? App.Pixel.editor : orig.editor;
    App.logo = pixel ? logoPixel : orig.logo;
    document.documentElement.dataset.estiloOficina = App.estiloOficina;
  };
})();
