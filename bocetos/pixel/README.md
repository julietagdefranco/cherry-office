# Boceto: oficina en pixel art

Prueba de un estilo propio para la oficina, en pixel art isométrico 2.5D, para dejar de depender de las piezas LEGO.
Es un boceto: **no está conectado a la app** ni al backend, y usa datos de ejemplo.

Lo único que cambia es la oficina del centro, los retratos de los agentes y el editor de apariencia. El resto de la
interfaz es la de siempre (riel, lista, paneles), copiada de `oficina/ui/estilo.css`.

## Cómo verlo
Abrí `app-pixel.html` con un servidor local (los scripts de `v2/` se cargan aparte):
```bash
cd bocetos/pixel && python3 -m http.server 8790   # http://localhost:8790/app-pixel.html
```
`app-pixel-nav.html` y `app-pixel-tarjeta.html` llevan copiados adentro los scripts de `v2/`, así que se abren con doble
clic, sin servidor. Si cambiás algo en `v2/`, hay que volver a copiarlo en ellos.

Para ver otra hora del día sin esperar, agregá `#h19` (cualquier hora de 0 a 23) a la dirección.

## Qué hay
| Archivo | Qué es |
|---|---|
| `app-pixel.html` | La app con la oficina pixel nueva: 9 salas con paredes y puertas, muebles, personajes que caminan, luz según la hora, zoom y arrastre. |
| `app-pixel-tarjeta.html` | Variante: tocar un agente abre una tarjeta con su estado (qué hace, en qué tarea, último mensaje, entregas) y «Charlar» abre el chat en un panel lateral sobre la oficina. Tiene un control para comparar con la pantalla completa de hoy. |
| `app-pixel-nav.html` | Navegación nueva: la oficina nunca desaparece. Cada sección es una lista flotante a la izquierda; lo que elegís se abre en un solo panel a la derecha y, si es de una persona, la cámara la centra en el hueco libre. Si no queda lugar, la lista se pliega. Pantalla completa solo con ⤢. |
| `app-pixel-equipo.html` | Navegación tipo Slack: no hay Charlas; Equipo es la lista de contactos (con su estado y, abajo, las reuniones). Tocar a alguien, en la lista o en la oficina, abre su chat en una columna pegada a la lista, con un selector de charlas viejas. A la derecha del chat, una columna de detalles (tareas, archivos y notas: 3 de cada una y «Ver todos» con buscador); el lápiz la cambia por la ficha (perfil y apariencia, permisos). Todo crece desde el riel y la oficina queda a la derecha. Se abre con doble clic. |
| `v2/nucleo.js` | Primitivas de dibujo isométrico (solo `fillRect`, sin antialias). Baldosa de 60×30 px. |
| `v2/muebles.js` | Todos los muebles y objetos (`M.*`) y lo que va colgado en las paredes (`M.pared.*`). |
| `v2/personajes.js` | `drawChar`: personajes sin cara de unos 43 px, por capas recoloreables, con caminata y poses sentado. |
| `v2/oficina.js` | La planta, las paredes, el orden de dibujo isométrico, las caminatas y la cámara. Expone `window.OFI`. |
| `v2/render.mjs` | Vista previa sin navegador: dibuja una función y guarda un PNG agrandado. |
| `v2/preview-*.js` | Catálogos de personajes y muebles para `render.mjs`. |
| `v2/INVENTARIO.md` | Lista de salas, muebles, objetos y animaciones. |
| `ESPEC-SPRITES.md`, `PROMPTS-SPRITES.md` | Cómo pedir sprites a otra herramienta para que encajen. |
| `app-pixel-v1.html`, `oficina-pixel.html`, `personajes-pixel.html` | Etapas anteriores del boceto. |
| `sprites/` | Prueba de generar un `.aseprite` desde Python. |

Para revisar un sprite sin navegador:
```bash
cd bocetos/pixel/v2
node render.mjs /tmp/catalogo.png 520 520 3 PREVIEW_PJ personajes.js preview-personajes.js
```

## En la app
La oficina pixel ya está en la app: `oficina/ui/pixel/` (`App.OficinaPixel`, con la misma interfaz que
`App.Oficina3D`), elegible en Ajustes › Apariencia. Este boceto queda como banco de pruebas y origen de los sprites.
