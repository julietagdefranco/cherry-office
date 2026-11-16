# Coherencia de la interfaz: auditoría y plan

Revisión de todas las pantallas y menús de `oficina/ui/` (noviembre 2026). Tres pasos: qué patrones existen, dónde se
repiten o se apartan, y cómo se arreglan. Al final, la propuesta para reestructurar la navegación.

## 1. Patrones que ya existen (los canónicos)

| Pieza | Canónico hoy | Dónde está |
|---|---|---|
| Panel | `.der-cab` → `.der-cuerpo` → `.der-pie` | estilo.css:169-178 |
| Cabecera | icono 52px + `.der-tit` (h2 + `.sub`) + acciones + × | estilo.css:169-173 |
| Columna de contenido en una sección | 860px centrada, solo a hijos directos | estilo.css:755-758 |
| Pie de acciones | secundarias a la izquierda (`.izq`), principal a la derecha | `.hoja-pie` estilo.css:212 |
| Documento markdown | `.md-doc.md` (14px / 1.6) | estilo.css:651, `App.verDocumento` |
| Archivos | `App.Adjuntos.chips(rutas)`: nombre + miniatura, ruta en el title | base.js:600 |
| Estado vacío con acción | `.nav-vacio` (icono, título, texto, botón) | nav.js:100 |
| Modal | `App.hoja` + `.hoja-cab/.hoja-cuerpo/.hoja-pie` | base.js:184 |

## 2. Dónde se repiten o se apartan

### Cabeceras y botones
- `cabecera()` copiada 5 veces (entregables.js:62, flujos.js:49, parte.js:34, tareas.js:24, reunion.js:203), con el icono
  armado a mano con estilos inline en 4 de ellas. `hojaEnPanel` (biblioteca, conocimiento) no tiene icono ni subtítulo.
- Botón «volver» en 3 formas: carácter `←` a la derecha junto a la × (entregables.js:156, flujos.js:157), icono + texto a
  la izquierda (agente.js:91, ajustes.js:321), o solo en pantallas angostas (biblioteca.js:248).
- En una sección la × no cierra nada útil: deja el panel vacío con la lista al lado (app.js:445, nav.js:173).
- Pies rearmados con `style:{display:'flex'…}` y el truco `span{flex:1}` en ~15 lugares; flujos estira los botones.
- Botón de peligro relleno hecho a mano (base.js:234, deptos.js:90); `.peligro` y `.peligro-suave` conviven.
- Chip seleccionado con tres reglas distintas (`.sel` ×2, `.activo`).

### Ancho y lectura (la captura del acta)
- El cuerpo del entregable es una burbuja de chat (`div.msg.a`) con `maxWidth:'none'` inline (entregables.js:175): le gana a
  la regla de 860px y se estira a toda la pantalla, mientras la cabecera queda centrada y angosta. Igual en parte.js:187,
  agente.js:414,558, entregables.js:281.
- Los archivos del entregable son rutas completas en cajas (entregables.js:170) en vez de chips con el nombre; no hay
  «Mostrar en la carpeta». `abrirArchivo` duplica `ChatRico.abrirArchivo` sin imágenes ni HTML.
- El pie aparece tarde (espera tres pedidos) y en sección pierde el separador (estilo.css:760).
- Biblioteca y Conocimiento quedan fuera de la columna (`:not([data-modo])`) y Biblioteca tiene su propia columna de
  navegación dentro de una sección que ya tiene una.

### Acciones duplicadas
| Acción | Lugares | Juicio |
|---|---|---|
| Editar un agente | avatar con lápiz + lápiz suelto (misma cabecera, agente.js:82,85) + «Perfil» en Relacionado (nav.js:388) | ruidoso: 3 en una pantalla |
| Charla nueva | «Nueva» de la lista (con icono de lápiz, nav.js:249) + «Conversación nueva» al pie (agente.js:126) + «+ Nueva» en Relacionado (nav.js:390) | ruidoso, 3 nombres |
| Nueva tarea | «+ Tarea» en la lista (nav.js:343) + «Nueva tarea» al pie (tareas.js:203) | ruidoso |
| Nueva corrida / Creador | grupo «Atajos» (nav.js:348) repite los botones del panel Flujos | ruidoso |
| Buscar | ⌘K del riel + «Buscar» en la maqueta (app.js:303) | ruidoso |
| Cambiar de oficina | logo del riel + marca de la maqueta (app.js:278) | ruidoso |
| Yo / Quién dirige | lápiz invisible hasta hover, minifig, ⌘K, Ajustes; clic en «Vos» abre la bandeja (yo.js:25) | incoherente |
| Carpeta de la oficina | Archivos › En la compu + Ajustes › General | ok, falta en ⌘K |

### Nombres
- Lo que espera tu revisión: «Para revisar», «Entregables», «Tu bandeja», «bandeja de entregables». «Para revisar» es
  además una pestaña de Conocimiento y «Entregables» una sección de la ficha del agente.
- «Llamar a reunión» vs «Nueva reunión»; «Charla» vs «Conversación»; «Quién dirige» vs «Vos».

### Navegación
- Los detalles (entrega, corrida, pestaña de la ficha) no escriben la ruta: Atrás no vuelve y no se pueden enlazar
  (nav.js:155,159).
- «Sala de reuniones» (⌘K, maqueta) sin reunión en curso lleva a una Charlas vacía (reunion.js:34).
- En el celular no se llega a Ajustes ni a ⌘K (`.riel-extra` oculto).
- `App.Deptos.menu` es código muerto.

### Tokens
- Radios 6/8/9/12/14px fuera de los dos tokens; fuentes 10–16px sin escala (10.5, 11.5, 12.5); 19 anchos de hoja distintos;
  colores sueltos (`#e0a84a`, `#0a5fb4`, `#9a9a9a`). Colisiones de clases: `.paso-punto`, `.pasos`, `.archivo-fila`.

## 3. Arreglos

1. **Ancho de lectura único**: token `--ancho-lectura` (760px) para cabecera, cuerpo y pie; los documentos con `.md-doc`,
   nunca burbuja de chat ni inline. Pantallas de trabajo anchas (Biblioteca) se marcan con `.der-ancho`.
2. **`App.cabPanel({icono, titulo, sub, volver, acciones})`** en base.js; reemplaza las 5 copias y `hojaEnPanel`. Volver
   siempre a la izquierda con icono; en una sección no hay ×.
3. **`.acciones`** (pie): secundarias a la izquierda, principal a la derecha, separador arriba. Se pinta enseguida.
4. **Archivos del entregable** con chips por nombre + «Mostrar en la carpeta»; un solo `abrirArchivo`.
5. **Una entrada por acción en cada pantalla** (tabla de arriba): sacar el lápiz suelto, Perfil/Notas de Relacionado,
   «Conversación nueva», «+ Tarea» de la lista, «Atajos», «Buscar» y el menú de la marca en la maqueta.
6. **Rutas para los detalles** y «Sala de reuniones» que abra una reunión nueva si no hay ninguna.
7. **Nombres**: «Para revisar» en todos lados; «Llamar a reunión»; «Sugerencias» en Conocimiento.
8. **Tokens y limpieza**: `.btn.primario.peligro`, `.chip.sel` único, escala de radios y fuentes, colisiones, código muerto.

## 4. Recorrida en vivo: anchos y acceso

### Hoy hay cuatro anchos distintos sin regla
| Ancho | Pantallas |
|---|---|
| Columna de 860 centrada | chat, ficha del agente, reunión, tareas, flujos, lista de entregas |
| Todo el ancho | Biblioteca (3 columnas), Conocimiento, el texto del entregable (por el inline) |
| Botones en el borde derecho de la pantalla, lejos del contenido | «Guardar permisos», «Nueva tarea», «Nueva reunión», «Listo» |
| Modal flotante | Carpeta de la oficina, Creador, Ajustes, Contratar, editor de flujos, Yo |

**Regla propuesta, solo dos formatos:**
- **Lectura** (760px centrada, pie dentro de la misma columna): entregas, chat, reunión, ficha, tareas, flujos, parte.
- **Trabajo** (todo el ancho, con columnas propias): Biblioteca, Conocimiento, Carpeta de la oficina, Creador.
- Modal solo para cosas cortas que se confirman y se cierran (Contratar, Llamar a reunión, Yo, confirmar).

### Lo que hoy es de difícil acceso
| Qué | Hoy | Por qué cuesta |
|---|---|---|
| Lo que espera tu revisión | Archivos › Para revisar | está adentro de otra sección |
| Permisos pendientes | solo tarjetas flotantes | no hay lista donde volver a verlos |
| Parte del día | solo flotando en la maqueta | si no estás en Oficina, no existe |
| Archivos de una entrega | rutas largas, sin «Mostrar en la carpeta» | no se ve dónde quedaron |
| Carpeta de la oficina | modal chico desde un ítem de la lista | un ítem de sección abre un popup, no una pantalla |
| Archivos de un agente | Ficha › Notas › «Entregables» (texto) | escondido en una pestaña con otro nombre |
| Editar flujos | botón «Flujos de la oficina…» en el pie de Flujos → modal | sin ruta, sin ⌘K |
| Departamentos | Ajustes › Departamentos | es parte del equipo, no un ajuste |
| Ficha del agente | 3 accesos ruidosos desde el chat, ninguno en la lista | no hay un lugar "del equipo" |
| Ajustes y ⌘K en el celular | ocultos | la barra de abajo no los muestra |

## 5. Reestructura de la navegación

Recomendada: **A · Bandeja + Equipo**.

| Sección | Qué tiene | Formato |
|---|---|---|
| Bandeja | Para revisar · Te piden permiso · Pendientes de reuniones · Parte del día | lectura |
| Oficina | la maqueta 3D (sin panel flotante) | — |
| Charlas | charlas y reuniones | lectura |
| Equipo | Vos · agentes por departamento · Departamentos; la ficha (Perfil, Permisos, Notas, Tareas, Archivos) con ruta `#/equipo/<id>/<pestaña>` | lectura |
| Archivos | Carpeta de la oficina (pantalla, no modal) · Biblioteca · Conocimiento | trabajo |
| Trabajo | Tareas · Flujos (con «Definiciones» como subsección con ruta) | lectura |

En el celular la barra de abajo muestra Bandeja, Charlas, Equipo, Archivos y «Más» (Oficina, Trabajo, Buscar, Ajustes).
Tocar la cara de un agente en el chat lleva a su ficha en Equipo; el chat ya no tiene lápiz ni «Perfil».

## 6. Lo implementado

**Estructura**
- Riel: Bandeja · Oficina · Charlas · Equipo · Archivos · Trabajo (⌘1–6). Celular: 4 + «Más».
- Bandeja › **Hoy** (antes «Parte del día»): permisos con sus botones, lo que te necesita, para revisar, qué pasó.
  Subsecciones por tipo: Para revisar, Te piden permiso. Las rutas viejas `#/archivos/revisar/*` redirigen.
- Equipo: vos, agentes por departamento, Departamentos (salió de Ajustes). Ficha con ruta `#/equipo/<id>/<pestaña>`,
  pestaña nueva **Archivos** y acciones a la vista: Reunión, Tarea, Charlar.
- Archivos: **Carpeta de la oficina** como pantalla con ruta (`#/archivos/carpeta/<ruta>`), Biblioteca, Conocimiento.
- Detalles con ruta: entrega (`#/bandeja/revisar/<id>`) y corrida (`#/trabajo/flujos/<id>`): Atrás funciona.

**Primitivas** (base.js, estilo.css)
- `App.cabPanel` (cabecera única: volver a la izquierda, icono `.der-ico`, acciones; la × solo sobre la maqueta),
  `App.acciones` (pie: secundarias a la izquierda, principal a la derecha), `App.vacio` (vacío con botones).
- `--ancho-lectura: 760px` para cabecera, cuerpo y pie de todas las pantallas de lectura.
- Documentos con `.md-doc.doc-panel` (sin burbuja de chat); archivos como chips con «Mostrar/Ver la carpeta».
- `.chip.sel` único, `.btn.primario.peligro`.

**Duplicados quitados**: lápiz suelto del chat, Perfil/Notas y retrato de Relacionado, «Conversación nueva» del pie
(pasa a «+» en la cabecera), «+ Tarea» y «Atajos» de Trabajo, «Buscar» y menú de la marca en la maqueta,
Departamentos en Ajustes.

**Accesibilidad**: anillo de foco visible con teclado; filas clicables enfocables (Tab) y activables (Enter/Espacio);
botones de solo icono con nombre para lectores; `aria-current` en la sección activa; etiquetas del riel a 11px.

**Pendiente** (sección 3, punto 8): escala de radios y tipografía, anchos de hoja con tres tamaños, colisiones de clases
(`.paso-punto`, `.pasos`, `.archivo-fila`) y fila/tarjeta canónicas.
