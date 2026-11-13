# Plan: el core de la oficina

## Qué es el producto
Una app de macOS donde armo **mi oficina** de agentes de Claude:
1. **Oficina propia:** nombre, mi nombre y departamentos que creo, renombro y borro. La oficina 3D se genera sola: una sala por departamento, escritorios según los agentes, sala de reuniones y recepción.
2. **Contratar agentes:** describo en palabras qué quiero y elijo el departamento. Claude redacta la definición y el agente se crea como **agente real de Claude Code** (`.claude/agents/<id>.md`). En la oficina aparece como un minifig LEGO genérico, con colores y peinado propios.
3. **Chat 1 a 1** con cada agente. Ya existe; ahora sirve con cualquier agente contratado.
4. **Conocimiento:** cada agente guarda lo que aprende. Además hay una memoria común y un registro de decisiones.
5. **Reuniones:** convoco a varios agentes sobre un tema. Opinan por **rondas**, cada uno desde su rol y leyendo lo anterior. Puedo intervenir o pedir otra ronda. Al cerrar sale una **síntesis con decisiones** que queda en la memoria.

Decisiones tomadas: la plataforma es la **app macOS** (el navegador queda como modo desarrollo); cada oficina vive en **una carpeta propia**; las reuniones funcionan por **rondas + síntesis**.

## Qué se reutiliza
- **Backend Swift** (`app/Sources/Backend`): la ejecución de `claude` (carril por agente, timeout, reintentos), SQLite, permisos por agente, logs y tests.
- **App nativa** (`app/Sources/App`): la ventana, el esquema `hq://`, el onboarding de Claude y el `.dmg`.
- **Front** (`oficina/index.html`): el motor 3D, el chat y las etiquetas. Se parte en módulos y se elimina todo lo fijo.
- **Minifig LDraw genérico:** pasa a ser el modelo de las personas (`oficina/ui/piezas.js`).

## Modelo de datos

### Carpeta de una oficina (por defecto `~/Oficinas/<Nombre>/`)
```
oficina.json                  ← definición de la oficina (fuente de verdad)
.claude/agents/<id>.md        ← agentes reales de Claude Code (generados)
conocimiento/
  oficina.md                  ← memoria común (contexto del negocio, lo edita el usuario y el backend)
  decisiones.md               ← decisiones confirmadas (append-only, con fecha; lo escribe el backend al cerrar reuniones)
  agentes/<id>.md             ← notas de trabajo de cada agente (solo ese agente escribe acá)
reuniones/AAAA-MM-DD-<tema>.md ← acta de cada reunión (transcripción resumida + síntesis)
archivos/                     ← material del usuario (cwd de claude = raíz de la oficina)
```

### `oficina.json`
```json
{
  "version": 1,
  "nombre": "Próspera HQ",
  "duenio": "Juli",
  "departamentos": [{ "id": "redes", "nombre": "Redes y estrategia digital", "color": "#a88bdc" }],
  "agentes": [{
    "id": "marce", "nombre": "Marce", "rol": "Directora creativa de redes",
    "departamento": "redes", "brief": "lo que pidió el usuario al contratarla",
    "modelo": "sonnet", "chips": ["¿Qué publico esta semana?"],
    "avatar": { "semilla": "marce", "pelo": "largo-lacio", "colorPelo": "#141414", "cara": "f-labios", "torso": "saco", "colorTorso": "#1a1a1f", "colorPiernas": "#0e0b0e" },
    "creado": "2026-11-13T12:00:00Z"
  }]
}
```
- Los ids son slugs: `^[a-z0-9][a-z0-9-]{0,40}$`, únicos dentro de la oficina.
- En el `.md` el agente se llama `name: <id>`. La app ejecuta `claude --agent <id>` con `cwd` en la carpeta de la oficina, así que el agente se resuelve dentro de su oficina.

### Datos de la app (`~/Library/Application Support/Próspera HQ/`)
- `hq.db`: chats (sesiones y mensajes, como hoy) y reuniones (reuniones y turnos), con clave por oficina.
- `config.json`: oficinas recientes y la oficina activa.

## API del backend (Swift `Router`; mismo JSON en `server.py` en modo desarrollo)
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/estado` | Como hoy, más `oficina: {carpeta, nombre} \| null` |
| GET | `/api/oficinas` | Recientes |
| POST | `/api/oficinas` | Crear `{nombre, duenio, carpeta?, departamentos?}`: arma la carpeta, `oficina.json` y las plantillas de conocimiento |
| POST | `/api/oficinas/abrir` | `{carpeta}`: valida `oficina.json` y la deja activa |
| GET/PATCH | `/api/oficina` | Leer o editar nombre y dueño |
| POST/PATCH/DELETE | `/api/departamentos[/:id]` | CRUD. Borrar exige que no tenga agentes, o recibir `{moverA}` |
| POST | `/api/agentes/borrador` | `{descripcion, departamento}`. Claude (`claude -p` sin agente, salida JSON) propone `{id, nombre, rol, description, prompt, chips, modelo}` sin escribir nada |
| POST | `/api/agentes` | Confirma un borrador, editable: escribe `.claude/agents/<id>.md` y `conocimiento/agentes/<id>.md` y actualiza `oficina.json` |
| PATCH | `/api/agentes/:id` | Nombre, rol, departamento, avatar o prompt. Reescribe el `.md` |
| DELETE | `/api/agentes/:id` | "Despedir": mueve el `.md` a `.claude/agents/.archivados/` (nunca borra) |
| GET | `/api/agentes/:id/conocimiento` | Lee sus notas |
| POST | `/api/chat` | Igual que hoy; los agentes válidos son los de la oficina activa |
| GET | `/api/historial` | Igual que hoy |
| POST | `/api/reuniones` | `{tema, agentes[], rondas?}`. Crea la reunión y arranca la ronda 1 en segundo plano |
| GET | `/api/reuniones/:id` | Estado (`en_curso` \| `esperando` \| `cerrada`), turnos `[{ronda, agente, texto, ts}]` y quién está hablando |
| POST | `/api/reuniones/:id/intervencion` | `{texto}` del usuario. Queda como turno y lo ven los siguientes |
| POST | `/api/reuniones/:id/ronda` | Otra ronda |
| POST | `/api/reuniones/:id/cerrar` | Síntesis: decisiones, pendientes y responsables. Escribe `reuniones/…md` y suma las decisiones a `decisiones.md` |
| GET | `/api/reuniones` | Lista de reuniones de la oficina |

### Cómo funciona una reunión
- **Cada turno** es `claude -p --agent <id>` en una sesión nueva, con un prompt que incluye el tema, la memoria común resumida, la transcripción hasta ese momento y la consigna "opiná desde tu rol, en 120-180 palabras, sin repetir lo ya dicho; decí con qué estás de acuerdo y con qué no".
- **Los agentes hablan en orden:** primero el más relacionado con el tema por departamento, después el resto. El front muestra en vivo quién habla, porque consulta `GET` periódicamente.
- **La síntesis** es un `claude -p` sin agente, con el rol de "secretario de actas". Devuelve JSON `{resumen, decisiones[], pendientes[{quien, que}]}`, y el backend escribe los archivos.
- **Permisos:** en una reunión los agentes no escriben archivos (solo `Read,Glob,Grep`). Los archivos los escribe el backend.

### Creación de un agente
- **El borrador** sale de un meta-prompt que recibe la descripción del usuario, el departamento, los agentes que ya existen (para que no se dupliquen roles) y el formato de salida.
- **El `.md` se genera con una plantilla fija.** Lleva el frontmatter (`name`, `description`, `model`), el cuerpo del prompt y una sección "Memoria de la oficina", con rutas relativas a la oficina, que dice qué leer al empezar y que escriba solo en `conocimiento/agentes/<id>.md`.
- **Permisos de escritura por defecto:** `conocimiento/agentes/<id>.md`.

## Front
> Rehecho de cero (nov. 2026): el primer front se descartó por cuelgues y por no parecer una oficina.

- **Módulos** en `oficina/ui/` (scripts clásicos, namespace `App`):
  - `piezas.js`: paquete LDraw (`ldraw/minifigs.mpd`), una geometría por pieza compartida entre figuras, armado de minifigs desde el avatar, poses y retratos en cola;
  - `oficina3d.js`: el edificio procedural, cámara, render bajo demanda, picking por cajas y caminatas;
  - `base.js` (API, puente nativo, DOM seguro, hojas, menús, markdown mínimo), `app.js` (arranque, inicio y barra lateral), `agente.js`, `contratar.js`, `deptos.js`, `reunion.js`, `biblioteca.js` y `carpetas.js`.
  
  `index.html` solo carga los scripts.
- **Edificio:** un solo rectángulo. Recepción a la izquierda y alas con fila de salas al fondo, pasillo y fila al frente (reuniones, biblioteca y una sala por departamento con piso de su color). Más departamentos alargan el pasillo y, pasado cierto largo, suman otra ala. Fachada del fondo alta con ventanas, laterales medianos y frente bajo (vista de maqueta).
- **Render:** PBR (plástico ABS), entorno de estudio generado con PMREM, ACES, sombras suaves. Se dibuja solo cuando algo cambia; ladrillos, baldosas y studs van en mallas instanciadas.
- **Interfaz sobria:** la maqueta pone el color. Equipo a la izquierda, panel del agente o de la reunión a la derecha sin tapar el 3D, hojas modales para contratar, departamentos, reuniones, biblioteca y carpetas.

## Migración de Próspera
- `tools/importar_prospera.py`, o el botón del onboarding: crea `~/Oficinas/Próspera HQ/` con sus 6 departamentos y sus 8 agentes. Usa los `agentes/*.md` actuales, con las rutas adaptadas.
- **El conocimiento se copia; los datos originales no se tocan.** `_betty/estado-actual.md` y `_equipo/` se copian a `conocimiento/`. Nunca se mueven ni se borran.

## Instancias (en paralelo, cada una dueña de sus archivos)
- **A, backend de oficina y agentes:**
  - Archivos: `app/Sources/Backend/` (nuevos `Oficina.swift`, `Agentes.swift` y rutas en `Router`), más la paridad en `oficina/server.py`.
  - Alcance: oficinas, departamentos, agentes (borrador con `claude -p`, plantillas, archivado) y chat por oficina.
- **B, front de la oficina:**
  - Archivos: `oficina/index.html` y `oficina/js/{escena,mundo,ui,api}.js`.
  - Alcance: onboarding, mundo procedural, departamentos, contratar, ficha y chat. Mientras A no esté, trabaja contra un mock de la API.
- **C, minifigs genéricos:**
  - Archivos: `oficina/js/figuras.js`, `tools/empaquetar_ldraw.py`, `oficina/ldraw/` y `app/Resources/vendor/LDrawLoader.js`.
  - API: `crearFigura(avatar) → {grupo, piernas[], brazos[]}` y `avatarDesdeSemilla(semilla)`.
- **D, reuniones** (backend y panel):
  - Archivos: `app/Sources/Backend/Reuniones.swift`, sus rutas, paridad en `server.py` y `oficina/js/reunion.js`.
- **E, tests** (después de A y D): `app/Tests/BackendTests/` para oficinas, agentes, reuniones y migración.
- **Integración:** importar Próspera, crear una oficina nueva de cero, contratar, chatear, hacer una reunión y armar el build de la app.

## Biblioteca: archivos y conocimiento (instancia F, después de B y D)

### Uso
- **Entrada:** se toca la biblioteca en la oficina 3D (sala o estantería con biblioratos por departamento) y se abre el panel de archivos.
- **Subir:** arrastrar, o el botón "Subir".
- **Vincular carpeta:** carpetas externas grandes o existentes, como Drive o `~/Próspera/Reels`, sin copiarlas.
- **Buscador.**
- **Por archivo:** ver su ficha, abrir el original y quitarlo (va a la papelera).

### Carpetas
```
archivos/compartido/            ← todos los agentes lo leen
archivos/<departamento>/        ← material de cada área
archivos/entregables/<agente>/  ← lo que producen los agentes (nuevo permiso de escritura por agente)
archivos/.texto/<slug>.md       ← texto extraído
archivos/.papelera/             ← nada se borra
conocimiento/archivos.md        ← catálogo: una línea por documento (lo leen todos al empezar)
conocimiento/fuentes/<slug>.md  ← ficha de cada documento
```
- **Carpetas vinculadas:** van en `oficina.json`, en `vinculos:[{id, ruta, alcance: "oficina" | {departamentos:[]} | {agentes:[]}}]`. Se pasan como `--add-dir` solo a quien tenga acceso, en chat y en reuniones.

### Pipeline al agregar un archivo
1. **Guardar:** copia con el nombre sanitizado, sin `..` y con tamaño máximo. Se registra un hash.
2. **Extraer texto:**
   - PDF: PDFKit en Swift; en Python, `pdftotext` si existe o `mdls`/`textutil`, o un aviso.
   - `.docx`, `.pages`, `.rtf` y `.doc`: `textutil -convert txt`.
   - `.md`, `.txt`, `.csv` y `.json`: tal cual.
   - Imágenes: `claude -p` las describe con `Read`.
3. **Fichar:** "bibliotecario", un `claude -p` sin agente que devuelve JSON `{titulo, resumen, datos_clave[], temas[], util_para:[departamentos], fechas[]}`. El backend escribe `conocimiento/fuentes/<slug>.md`.
4. **Indexar:** se actualiza `conocimiento/archivos.md` y la tabla FTS5 de SQLite para el buscador.
5. **Lectura por rol (opcional, por archivo o por defecto en la oficina):** los agentes de los departamentos `util_para` leen la ficha y el texto, y anotan en sus notas, con `conocimiento/agentes/<id>.md`, qué les sirve desde su rol. En el 3D caminan a la biblioteca.
6. **Contradicciones:** el bibliotecario compara con `conocimiento/oficina.md` y `decisiones.md`. Si hay diferencias, propone cambios que el usuario aprueba o rechaza. Nunca los aplica solo.
7. **Reindexar:** si cambia el hash. Las carpetas vinculadas se escanean al abrir la oficina o con "Actualizar", con un tope de archivos y tamaño configurable.

### API
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/archivos?q=&departamento=` | Listado y búsqueda (FTS5) |
| POST | `/api/archivos` | Subida. Body JSON `{nombre, departamento?, base64}` (simple y compatible con `hq://`), con tamaño máximo |
| GET | `/api/archivos/:slug` | Ficha y metadatos |
| GET | `/api/archivos/:slug/original` | Abrir o descargar |
| DELETE | `/api/archivos/:slug` | Mover a la papelera |
| POST | `/api/archivos/:slug/leer` | Lectura por rol |
| GET / POST / DELETE | `/api/vinculos[/:id]` | Carpetas vinculadas. Al crear, se valida que exista y no sea `/` ni `~` entero |
| POST | `/api/vinculos/:id/escanear` | Escanea una carpeta vinculada |
| GET | `/api/biblioteca/estado` | Cola de procesamiento (pendiente, extrayendo, fichando, leyendo, listo o error) |
| POST | `/api/biblioteca/propuestas/:id` | `{aceptar: bool}`: propuestas de cambio al conocimiento |

### Extras
- **Reuniones:** se pueden adjuntar documentos al tema. Su ficha entra en el prompt de todos.
- **Bibliotecario de fábrica:** cada oficina trae un agente opcional con escritorio en la biblioteca, para preguntarle "¿qué tenemos sobre X?".
- **Ficha del agente:** muestra sus entregables.

## Fuera de alcance por ahora
- Caras y pelos personalizados por foto: queda para después (las pruebas de laboratorio se descartaron).
- Varias oficinas abiertas a la vez.
- Streaming de respuestas.
