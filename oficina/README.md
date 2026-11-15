# oficina/ (el front)

La interfaz de Oficina: la maqueta 3D (three.js + piezas LDraw) y todas las pantallas. La app de escritorio
(`desktop/`, Mac y Windows) la sirve tal cual.

- `index.html`: punto de entrada.
- `ui/`: un módulo por pantalla (`app.js` arma la base; `oficina3d.js` la maqueta; `contratar.js` el editor de
  agentes y minifigs; `flujos.js`, `reunion.js`, `biblioteca.js`, `parte.js`, `entregables.js`, `creador.js`…) y los
  estilos (`estilo.css` y uno por módulo grande).
- `vendor/`: three.js, `LDrawLoader` y la fuente Poppins, offline (con sus licencias).
- `ldraw/`: piezas LDraw empaquetadas y `catalogo.json` (caras, peinados, ropa y demás opciones del editor).
- `personajes/`, `Agentes imagenes/`: retratos de los agentes de Próspera.

Para probarla en el navegador: `npm run dev --prefix backend` y abrir http://localhost:8765 (ver el README de la raíz).
