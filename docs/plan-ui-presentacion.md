# Presentación de opciones, listas y ajustes: segunda pasada

La primera pasada (`plan-coherencia-ui.md`) ordenó **dónde** vive cada cosa. Esta mira **cómo se presenta**: opciones
escondidas, listas que piden decisiones escritas como prosa, ajustes técnicos a la vista. Tres ejemplos reportados
(pendientes de una reunión, permisos del agente, «Nueva corrida») resultaron ser casos de ocho problemas que se repiten
en toda la app. Rutas relativas a `oficina/ui/`.

## Resumen

| # | Problema | Casos | Solución tipo |
|---|---|---|---|
| 1 | La decisión principal está escondida | 20 | `App.elegir`: opciones a la vista (chips o lista) y catálogos visibles |
| 2 | Lo que espera una decisión está escrito como prosa | 12 | `App.filaDecision` + secciones por quién tiene que actuar |
| 3 | Se ve la configuración cruda (ids, reglas, JSON, rutas) | 15 | `App.humano` (traductor único) + «Detalle técnico» plegado |
| 4 | Listas de textos cortos en tarjetas pesadas | 6 | `App.chipsEditables` y filas plegadas |
| 5 | Guardado y espera sin regla | 20+ | Ajustes que se guardan solos con «Deshacer»; `App.cargando(texto)` |
| 6 | El trabajo principal ocurre en ventanas apiladas | 6 | Pantalla con ruta (`hojaEnPanel`) |
| 7 | Menús y búsqueda sin forma | 7 | `App.menu` con tope, teclado y filtro; ⌘K agrupado |
| 8 | Ayuda mal ubicada o que depende de la pantalla | 8 | La ayuda va como bajada de la etiqueta, antes del campo |

## 1. La decisión principal está escondida

Un conjunto chico de opciones, que es *la* decisión de la pantalla, queda en un `<select>`, en un menú que abre otro
menú o detrás de una ventana. No sabés qué existe hasta abrirlo.

| Dónde | Qué pasa hoy |
|---|---|
| Nueva corrida (flujos.js:385, app.js:262, paleta) | Ventana con un select de flujos; la descripción cambia al elegir |
| Panel Flujos (flujos.js:73) | Lista corridas, nunca los flujos definidos; están detrás de «Editar los flujos…» |
| Editor de flujos (flujos.js:472) | El flujo se elige en un select; «Flujo nuevo» es una opción más del select |
| Llamar a reunión (reunion.js:58-65) | Tipo de reunión (5 patrones, la explicación aparece al cambiarlo), rondas y líder en selects |
| Paso de un flujo (flujos.js:506) | «Quién hace» es un select de texto «Nombre · rol» |
| Departamento (contratar.js:97,150; deptos.js:87; entregables.js:367) | Select, sin el color de la sala |
| Modelo (contratar.js:98; ajustes.js:263) | Select de 4 opciones que cambia el costo; la lista está escrita dos veces, con textos distintos |
| Nueva tarea (tareas.js:201; app.js:260) | Un menú «¿Para quién?» y recién después la ventana; el tipo (se repite / una vez) es el cuarto campo |
| Filtros (entregables.js:76; conocimiento.js:148) | Chips de estado mezclados con selects de agente y origen |
| Conocimiento y Creador (conocimiento.js:49; creador.js:423,466) | Vence, modelo y aprobación en selects chicos |
| Permisos de los agentes (ajustes.js:304) | «Cambiar…» abre una segunda ventana encima de Ajustes para elegir entre 2 opciones |
| Tu perfil (app.js:425) | «Cambiar…» abre otra ventana encima de Ajustes |
| Otra oficina (app.js:402) | Un menú que abre una ventana con 4 opciones: dos saltos |
| Biblioteca (biblioteca.js:155) | La etiqueta «2 deptos» esconde cuáles son |

**Solución tipo.** `App.elegir({opciones:[{valor, titulo, sub, icono|retrato|color}], valor, alCambiar, forma})`:
chips de una sola elección si son 6 o menos y cortas; lista de opciones con título y bajada si cada una necesita
explicación (flujos, tipos de reunión, modo de permisos). Sale del `.opcion-paso` de flujos.js:350 y del `grupo()` de
agente.js:621, que hoy tienen estilos inline. Y **catálogos visibles**: el panel Flujos muestra los flujos de la oficina
como filas con «Correr» (`nuevaCorrida(flujoId)` ya acepta uno elegido); la edición, maestro-detalle sin select.

## 2. Lo que espera una decisión está escrito como prosa

Listas de cosas que te esperan pintadas como párrafos con botones sueltos debajo, con estilos distintos para la misma
jerarquía, referencias por número y sin agrupar por quién tiene que actuar.

| Dónde | Qué pasa hoy |
|---|---|
| Pendientes del acta (reunion.js:363-425) | «**Luis:** …» + «Te toca a vos.» suelto + «Ya lo hice»; «Hacelo ahora» botón y «Convertir en tarea» link; «Depende de 4» |
| «Encargar todo» y «Pasar a flujo» (reunion.js:316) | Sueltos debajo de la lista, con estilos distintos |
| «Esperan tu respuesta» (reunion.js:288) | Lista de texto, sin acción |
| Esperas entre agentes (entregables.js:224) | Una frase larga concatenada y botones debajo |
| Tareas en la ficha (agente.js:512) | 5 botones del mismo peso, «Borrar» en rojo siempre a la vista; en Trabajo la misma tarea usa botón + menú |
| Estado de una tarea (agente.js:543) | «Falló. Usá «Hacer ahora» para reintentar…» en prosa |
| Sugerencias de Conocimiento (conocimiento.js:186-235) | 4 secciones, cada una con sus botones; «Sigue valiendo» es normal en una y primario en otra |
| Preguntas frecuentes (conocimiento.js:86) | 4 botones en 3 estilos por pregunta |
| Patrones del parte (parte.js:100) | Una sección por patrón: el título se repite |
| Biblioteca (biblioteca.js:289, 307, 334, 403) | Sugerencias como frase con link; «Quitar» rojo y «Desvincular» fantasma; propuestas sin documento de origen |
| Creador (creador.js:314) | «Descartar» en rojo en cada tarjeta |
| Avisos (avisos.js:66) | Un aviso por vez con «1 de N»; lo pendiente nunca se ve junto |

**Solución tipo.** `App.filaDecision({marca, titulo, sub, estado, principal, mas})`: retrato o icono, el qué como
título, el estado y de quién depende como bajada, **un** botón principal y el resto en «⋯». Agrupada con
`App.seccion(titulo, filas, accionMasiva)` por quién actúa: «Te toca a vos», «Lo pueden hacer los agentes» (con
«Encargar todo» en el título de la sección), «En marcha», «Hecho». Las dependencias por nombre: «Después de «Armar el
calendario»». El banner de avisos pasa a un resumen («3 te necesitan · Ver») que lleva a Bandeja › Hoy.

## 3. Se ve la configuración cruda

| Dónde | Qué se ve |
|---|---|
| Permisos de la ficha (agente.js:351-372) | `Bash(cd:*)` debajo de «Correr cd…»; Edit y Write de una carpeta como dos filas con `//Users/…`; rutas en cajas monoespaciadas |
| Pedido de permiso (permisos.js:62,68) | «Siempre guarda: Bash(git pull:*) · Edit(//Users/…)»; «Quiere usar mcp__x__y» |
| Acción propuesta (entregables.js:293) | `JSON.stringify` en un `<pre>`, insignia `send_message` |
| Conectores (ajustes.js:146; agente.js:329) | Todas las herramientas como insignias, `mcp__…` en el title; «Leer/Actuar» como checkboxes |
| Chat (chat-rico.js:209) | «Usó list events» (nombre de la herramienta) |
| Rutas (app.js:56,424; carpetas.js:100; biblioteca.js:332; agente.js:428; reunion.js:69,310) | Rutas absolutas o internas como texto, «Archivo de salida» en el formulario principal |
| Ids de respaldo (flujos.js:509; tareas.js:153; creador.js:52; y otros 8) | Cuando falta el nombre, aparece el id |
| Creador (creador.js:61,80,406,435,452) | «Antes → Ahora» en JSON, color en hex, «una herramienta por línea», zona horaria IANA |
| Ficha y tareas (contratar.js:107; agente.js:653) | «Identificador» del agente; zona horaria como texto libre |
| Uso (uso.js:13,75) | «sesión de Claude Code», «corrida», «sem» |

**Solución tipo.** `App.humano`, un solo traductor compartido: `.regla(r)` («Puede correr git pull», Edit+Write de una
carpeta en un solo ítem), `.herramienta(n)` (nombre del conector y la acción), `.ruta(p)` (nombre corto, relativo a la
oficina, la ruta en el title y un botón «Mostrar»), `.quien(id)` («alguien que ya no está»). Lo técnico, si hace falta,
plegado en «Detalle técnico».

## 4. Listas de textos cortos en tarjetas pesadas

«Hace solo», «Deja como propuesta», las reglas guardadas, «Sabe de», los pedidos sugeridos y los pasos del editor de flujos
(todos abiertos con 8 campos). **Solución tipo:** `App.chipsEditables(items, {fijos, placeholder})`, chips con «×» y un
chip «+ Agregar» que se vuelve campo. Los pasos del editor, filas plegadas (nombre, quién, qué entrega) que se abren al
tocarlas.

## 5. Guardado y espera sin regla

- **Guardado:** en Permisos el tacho parece borrar al instante pero hace falta «Guardar permisos»; en Conectores el modo se
  guarda solo y la tabla pide «Guardar»; Modelos y Departamentos se guardan solos (Departamentos sin aviso); Reglas,
  General y Perfil piden botón.
- **Espera:** unos 15 spinners sin texto (flujos, entregables, parte, tareas, reunión, conocimiento, carpeta, nav);
  «Detectando tus conectores…» consulta cada 2 s sin decir cuánto tarda; importar solo muestra una tostada.

**Regla:** los ajustes se guardan solos, con un aviso «Guardado · Deshacer»; solo los formularios de *creación* llevan
botón. `App.cargando('Trayendo las corridas…')` en lugar de un `span.giro` suelto.

## 6. El trabajo principal ocurre en ventanas apiladas

El editor de flujos (720 px), Llamar a reunión (7 campos), la ventana de tarea, Contratar paso 2 (880 px) y el Creador
(1100 px, con «Editar» apilado encima). Con una ventana abierta se bloquean ⌘K, ⌘1–6 y N. **Solución tipo:** pantalla
con ruta (`hojaEnPanel`), como ya pasó con Biblioteca y Departamentos; las ventanas quedan para confirmar algo corto.

## 7. Menús y búsqueda sin forma

- `App.menu` sin alto máximo ni scroll ni teclado; menús largos (todos los agentes + reunión).
- ⌘K sin texto muestra 12 ítems sin grupos; repite «Ficha de X» por agente, tres entradas de flujos y Departamentos dos
  veces; no busca en charlas, documentos ni conocimiento.
- Tres buscadores con alcances distintos: Biblioteca dice «todos los documentos» pero respeta el departamento elegido.

**Solución tipo:** `App.menu` con tope, ↑↓ y filtro cuando pasa de 8 ítems. ⌘K agrupado por tipo, sin duplicados, que
sin texto muestra lo pendiente y lo reciente, y termina con «Buscar «…» en Conocimiento / Biblioteca / Charlas».

## 8. Ayuda mal ubicada o que depende de la pantalla

Ayudas debajo del control (flujos.js:537; agente.js:693; reunion.js:96; entregables.js:377), párrafos fijos al pie de las
listas de tareas (agente.js:489; tareas.js:193), «mirá las tarjetas arriba a la derecha» (agente.js:567). La única
entrada del chat a la ficha (el lápiz sobre la cara) solo se ve con hover. **Solución tipo:** la ayuda como bajada de la
etiqueta; los textos fijos al estado vacío o a la bajada de la cabecera; nada importante solo con hover.

## Orden propuesto

1. **Piezas comunes** (base.js, estilo.css): `App.elegir`, `App.filaDecision` + `App.seccion`, `App.humano`,
   `App.chipsEditables`, `App.cargando`, `App.menu` con tope y teclado.
2. **Los tres casos reportados** con esas piezas: pendientes de reunión, pestaña Permisos, Flujos con catálogo visible.
3. **Barrido por tipo** en el resto de la app (tablas de arriba).
4. **Ventanas a pantallas:** editor de flujos, Llamar a reunión, tarea, Contratar, Creador.

## Lo implementado

**Piezas comunes** (base.js, estilo.css): `App.elegir`, `App.filaDecision`, `App.seccion`, `App.chipsEditables`,
`App.humano` (regla/reglas/herramienta/conector/ruta/carpeta/quien), `App.ajuste`, `App.cargando`, `App.guardado`
(aviso con «Deshacer»), `App.menu` con tope, ↑↓, Enter y filtro desde 9 ítems. CSS por área: `ficha.css`, `archivos.css`.

**Pantallas con ruta** (antes ventanas): Llamar a reunión (`#/charlas/nueva-reunion`), editor de flujos
(`#/trabajo/flujos/editar/<id>`), Contratar (`#/equipo/contratar`), Creador (`#/equipo/creador`). La ventana de tarea
queda como ventana corta, ahora con el agente elegible arriba.

**Por área**
- Reuniones y Hoy: pendientes en secciones por quién actúa con un botón principal y «⋯», dependencias por nombre,
  «Encargar todo» en la sección; «Esperan tu respuesta» como chips; tipo de reunión, rondas y líder a la vista; el banner
  de avisos resume («N te necesitan · Ver»).
- Flujos, tareas y entregas: catálogo de flujos con «Correr»; «Nueva corrida» con el flujo ya elegido o una lista;
  editor maestro-detalle con pasos plegados; filtros de entregas con chips; esperas y tareas como filas de decisión;
  acción propuesta como tabla legible con «Detalle técnico».
- Ficha y ajustes: Permisos en lenguaje humano con chips y guardado automático; Perfil agrupado; modelos en una sola
  lista (`App.MODELOS`); conectores con resumen y detalle plegado; modo de permisos dentro de Ajustes; Departamentos con
  alta en línea y avisos de guardado; lápices siempre visibles.
- Archivos, Creador, chat y ⌘K: Sugerencias y Preguntas con el mismo orden de botones; filtros con chips; rutas cortas;
  «Usó Google Calendar: …»; ⌘K agrupado, sin duplicados, con pendientes primero y «Buscar en Conocimiento/Biblioteca»;
  «Otra oficina» en un solo paso; Recientes arriba en el inicio.

**Pendiente:** escala de radios y tipografía; spinners dentro de botones e insignias; el Perfil sigue con «Guardar
cambios» (es un formulario de varios campos).
