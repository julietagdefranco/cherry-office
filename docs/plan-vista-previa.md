# Plan: ver el entregable y marcarle los cambios encima

## Contexto
Hoy, al abrir una entrega en la bandeja (`oficina/ui/entregables.js`), los archivos son chips. Un `.md` se abre con el
lector de markdown; lo demás se abre con la app del sistema (en la app de escritorio) o con `/api/oficina/archivo`, que
solo previsualiza texto e imágenes. «Pedir cambios» (E4 de `plan-entregables.md`) es un cuadro de texto libre: para
pedir «achicá el título de la segunda sección» hay que describir de memoria dónde está.

El caso que lo dispara: alguien le pide a un agente una página (HTML), quiere **verla tal cual queda** y decir qué
cambiar **señalándolo**, sin salir de la bandeja.

Objetivo: cerrar mejor el ciclo **entrega → la veo → marco qué cambiar (o lo retoco yo) → v2 → Listo**.

### El límite (para no rehacer Claude ni un IDE)
Entra lo que sirve para **revisar lo que entregó un agente y devolvérselo**. Queda afuera lo que sirve para trabajar a
la par de un agente en una sola charla, porque eso ya lo hace Claude y mejor.

| Sí | No |
|---|---|
| Ver el entregable renderizado (HTML, markdown, imagen, PDF, CSV) | Editor de código, resaltado, autocompletado |
| Marcar sobre la vista y mandar las notas como «Pedir cambios» | Terminal, servidor de desarrollo, `npm run dev` |
| «Abrir con…» la app de siempre para editar en serio | Navegador general o sitios externos |
| Retocar un texto chico antes de aprobar | Maquetar: arrastrar bloques, cambiar estilos a mano |
| | Diff de cualquier archivo del repo |

Cada fase de abajo tiene que pasar esta prueba: ¿tiene sentido solo porque hay una entrega, un agente que la hizo y
una persona que la aprueba?

## Conceptos
- **Vista**: el archivo de una entrega renderizado dentro de la app, en un marco aislado. Nunca ejecuta nada con
  acceso a la app ni a la API local.
- **Nota**: un comentario de la persona anclado a un lugar del archivo. Ancla según el tipo:
  - HTML: el elemento señalado (selector CSS corto + el texto visible, recortado a ~120 caracteres);
  - markdown o texto: la cita seleccionada (+ el título de la sección donde está);
  - imagen: un punto en porcentaje (`x`, `y`);
  - sin ancla: nota general sobre el archivo.
- **Foto de retoque**: copia del archivo justo antes de un retoque, en `archivos/.papelera/retoques/<entrega>/`. La
  papelera ya queda afuera del explorador, del conocimiento y del paquete.
- **Retoque**: cambio de texto que hace la persona a mano, sin agente. Queda registrado y el agente se entera en el
  próximo pedido de cambios.

## Fase V0: vista segura (backend)
**Ruta nueva**
- `GET /api/entregas/:id/vista?ruta=<rel>` en `rutas-entregas.ts`. La ruta tiene que ser uno de los `archivos` de la
  entrega; mismas reglas de seguridad que `/api/oficina/archivo` (relativa, sin `..`, sin enlaces que salgan de la
  oficina). Devuelve según el tipo:
  - `{tipo:'html', html}`: la página **empaquetada** en un solo documento (ver abajo);
  - `{tipo:'markdown'|'texto', texto}`, como hoy;
  - `{tipo:'csv', filas, truncado}`: hasta 500 filas, para mostrarlas como tabla;
  - `{tipo:'imagen', base64, mime}`, como hoy;
  - `{tipo:'pdf', base64}`: tope 10 MB (413 si pasa);
  - `{tipo:'otro'}`: solo «Abrir con…».
  - Siempre `rel, nombre, tam, mod`.

**Empaquetar el HTML** (`backend/src/vista.ts`, archivo nuevo)
- Una página suele traer su `estilos.css`, sus imágenes y quizás un `.js` al lado. El iframe aislado no puede pedirlos
  a `hq://` (lo bloquea `will-frame-navigate` en `desktop/src/main.ts`, y está bien que siga así).
- Entonces el backend los mete adentro: `<link rel="stylesheet" href="rel">` → `<style>`, `<script src="rel">` →
  `<script>` en línea, `src`/`url()` de imágenes y fuentes → `data:`. Solo rutas relativas que caen dentro de la
  oficina; las `https:` quedan como están (la CSP del marco las permite, igual que en el chat).
- Topes: 5 MB el documento final, 2 MB por recurso. Si un recurso falta o pasa el tope, se deja el original y se
  suma a `avisos:[…]` («No encontré `img/logo.png`»), que la UI muestra arriba de la vista.

## Fase V1: la pantalla «Revisar» (front)
- Botón **Revisar** en el detalle de la entrega, al lado de «Listo». Abre una hoja ancha (mismo patrón que
  `hoja-artefacto` en `chat-rico.js`), no un panel lateral: la vista necesita lugar.
- Arriba: pestañas por archivo (los que tienen vista primero), el agente y la versión («v2 · pediste: …»).
  Abajo: **Listo**, **Pedir cambios (N notas)**, **Abrir con…** y **Mostrar en el Finder**.
- Vista por tipo:
  - HTML: iframe con `sandbox="allow-scripts allow-modals"` y la CSP del chat. Sacar `documento()` e `iframe()` de
    `chat-rico.js` a `oficina/ui/vista.js` para que los usen los dos. Selector de ancho: escritorio, tableta (768),
    teléfono (375). Botón para ver el código, solo lectura.
  - Markdown: el lector que ya existe (`App.abrirMarkdownOficina`), embebido en la hoja.
  - CSV: tabla con cabecera fija.
  - Imagen: ajustada al ancho, con zoom al hacer clic.
  - PDF: el visor de Chromium necesita `webPreferences.plugins: true` en `desktop/src/main.ts`. Probarlo primero:
    si no anda dentro de la hoja, el PDF queda solo con «Abrir con…». En PDF las notas van sin punto (generales).
- Tocar el chip de un archivo con vista abre «Revisar» en esa pestaña.

## Fase V2: notas sobre la vista
**Marcar**
- Botón **Marcar** (tecla `M`) en la hoja. Con el modo prendido:
  - HTML: un script chico, inyectado en el documento empaquetado, resalta el elemento bajo el mouse y al hacer clic
    manda `postMessage({selector, texto, rect})` al padre. El padre verifica que el mensaje venga de **ese** iframe
    (`ev.source === marco.contentWindow`) y descarta lo demás. Con el modo apagado el script no hace nada.
  - Markdown o texto: seleccionar y tocar «Comentar» en la burbuja.
  - Imagen: clic en un punto. PDF: nota general.
- Cada nota es un globito numerado sobre la vista y una fila en la columna de la derecha. Se edita o se borra ahí.
- Las notas en curso se guardan en `localStorage` por entrega: cerrar la hoja no las pierde. Al mandar se borran.

**Mandar**
- `POST /api/entregas/:id/cambios` suma un campo opcional `notas:[{archivo, ancla, texto}]` (hasta 30). `texto`
  pasa a ser opcional si hay notas. El backend arma el pedido para el agente:

  ```
  Cambios que te pide Ana sobre «Landing de otoño»:

  En archivos/entregables/diseno/landing.html:
  1. En «Nuestra colección» (h2 · section.coleccion h2): achicá el título, se ve enorme en el teléfono.
  2. En el botón «Comprar ahora»: que sea verde como el logo.

  En general: <texto libre, si hay>
  ```

- Las notas se guardan en la entrega vieja (columna nueva `notas`, JSON) para mostrar en la v2 «pediste: …» con la
  lista.

## Fase V4: retoques chicos
Para el «le cambio una coma y apruebo» sin despertar al agente.
- Markdown y texto: **Editar** abre el texto en un `textarea` con vista al lado. Guardar escribe el archivo.
- HTML: solo el **texto visible**. Con el modo Editar, doble clic sobre un texto lo hace editable en el marco; al
  confirmar, el backend reemplaza ese texto en el fuente **solo si aparece una sola vez**. Si aparece varias veces o
  cruza etiquetas, responde 409 y la UI dice «Esto pedíselo al agente» y lo convierte en nota.
- `POST /api/entregas/:id/retoque {archivo, antes, despues}` (HTML) o `{archivo, texto, mod}` (markdown/texto; `mod`
  evita pisar un archivo que cambió desde que se abrió). Antes de escribir saca una foto del archivo; nada se pierde.
- La entrega queda con `retoques:[{archivo, ts}]` y el próximo «Pedir cambios» le avisa al agente: «Ojo: retoqué a
  mano `landing.html` después de tu entrega; partí del archivo como está ahora.»
- `POST /api/entregas/:id/deshacer-retoque` vuelve el último retoque desde su foto.

## Orden
- **V0 → V1 → V2 → V4**, en ese orden: cada una usa la anterior.
- Comparar versiones (antes/ahora, diff) queda afuera por ahora: si hace falta, se suma después con fotos al registrar.

## Verificación
**Backend** (`npm test --prefix backend`, con el `claude` falso)
- Vista: cada tipo; ruta que no es de la entrega (400); `..` y enlaces fuera de la oficina (403); topes (413).
- Empaquetado: CSS, JS e imágenes relativas quedan en línea; `https:` intacto; recurso faltante va a `avisos`; una
  ruta `../../secreto.txt` en un `href` no se lee.
- Cambios con notas: el pedido armado tiene el formato de arriba; `notas` queda en la entrega vieja; 30 notas como
  máximo.
- Retoque HTML: texto único se reemplaza; repetido o que cruza etiquetas da 409; siempre deja foto; deshacer vuelve.
- Retoque de texto con `mod` viejo da 409.

**Navegador** (modo dev)
- Una entrega con `landing.html` + `estilos.css` + `img/`: se ve con estilos e imágenes en los tres anchos.
- Marcar dos elementos y un texto, cerrar y reabrir la hoja (las notas siguen), mandar: llega la v2 con «pediste».
- Retocar un título del HTML y un párrafo del markdown; deshacer. Listo: el contador baja.
- Una página con `fetch('/api/…')` o un `<form>`: la CSP los bloquea (consola), la app no se entera.

**App aislada**
- PDF dentro de la hoja con `plugins: true`; si no, queda en «Abrir con…».
- Un iframe que intenta navegar a `hq://` sigue bloqueado.

## Fuera de alcance
- Todo lo de la columna «No» de la tabla del principio.
- Páginas que necesitan compilarse (React, Vite, etc.): se ven solo si el agente entrega el HTML ya armado.
- Comparar versiones y re-anclar las notas viejas en la versión nueva.
- Notas de varias personas o comentarios en hilo: en Oficina dirige una sola persona.
- Que un agente revise la entrega de otro usando las notas (podría venir después: las notas ya tienen forma).
