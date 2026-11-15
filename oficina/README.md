# oficina/ (el front)

La interfaz de Oficina: la maqueta 3D (three.js + piezas LDraw) y todas las pantallas. Es la única fuente del front
para las dos apps: la de Mac (`app/`) y la de Windows (`desktop/`) la sirven tal cual.

- `index.html`: punto de entrada.
- `ui/`: un módulo por pantalla (`app.js` arma la base; `oficina3d.js` la maqueta; `contratar.js` el editor de
  agentes y minifigs; `flujos.js`, `reunion.js`, `biblioteca.js`, `parte.js`, `entregables.js`, `creador.js`…) y los
  estilos (`estilo.css` y uno por módulo grande).
- `ldraw/`: piezas LDraw empaquetadas y `catalogo.json` (caras, peinados, ropa y demás opciones del editor).
- `personajes/`, `Agentes imagenes/`: retratos de los agentes de Próspera.

Para probarla en el navegador: `cd app && swift run oficina-dev` y abrir http://localhost:8765 (ver el README de la raíz).
