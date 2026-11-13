# Oficina para macOS (app nativa)

App en Swift (SwiftUI + WKWebView) que abre la misma oficina 3D y el mismo chat sin Terminal, sin server HTTP y sin Python. Plan completo en `docs/plan-app-macos.md`.

## Requisitos
- macOS 13 o superior.
- Command Line Tools con Swift (no hace falta Xcode). `notarytool` y `stapler` vienen con las CLT.
- Para chatear con los agentes: Claude Code instalado y con sesión iniciada (la app lo guía si falta).

## Compilar
```bash
app/build.sh
```
Compila en release y arma `app/build/Oficina.app` con firma ad-hoc. El front sale de `oficina/` (única fuente), más three.js y Poppins offline de `app/Resources/vendor`.

## Empaquetar (.dmg)
```bash
app/make-dmg.sh             # usa la .app existente (la compila si no existe)
app/make-dmg.sh --rebuild   # fuerza build.sh primero
```
Genera `app/build/Oficina <versión>.dmg` (UDZO, volumen "Oficina") con la .app y un acceso a Aplicaciones. La versión sale de `CFBundleShortVersionString` en `app/Resources/Info.plist`.

### Con Developer ID (sin avisos de Gatekeeper)
```bash
DEVELOPER_ID="Developer ID Application: Tu Nombre (TEAMID)" \
NOTARY_PROFILE="mi-perfil" \
app/make-dmg.sh --rebuild
```
- `DEVELOPER_ID`: firma la app con hardened runtime (`--options runtime --timestamp`) y los entitlements de `app/Resources/Oficina.entitlements`, y firma también el dmg.
- `NOTARY_PROFILE` (requiere `DEVELOPER_ID`): notariza con `xcrun notarytool submit --keychain-profile ... --wait` y hace `xcrun stapler staple`. El perfil se crea una vez con `xcrun notarytool store-credentials "mi-perfil"`.
- Sin ninguna de las dos variables queda la firma ad-hoc. El script nunca toma identidades del llavero por su cuenta.

Entitlements: vacíos a propósito. No hay App Sandbox (la app ejecuta `claude` y lee archivos del usuario). WKWebView corre en procesos de WebKit firmados por Apple, así que no se necesita JIT ni `allow-unsigned-executable-memory`. Si el hardened runtime rompiera algo, agregar solo el entitlement puntual en ese archivo.

> `build.sh` y `make-dmg.sh` no fueron probados con una identidad Developer ID real ni con notarización real.

## Instalar
1. Abrir el `.dmg`.
2. Arrastrar **Oficina** a **Aplicaciones**.
3. Expulsar el volumen y abrir la app desde Aplicaciones.

## Abrir una app sin firma de Developer ID
Con firma ad-hoc, macOS bloquea la primera apertura ("no se puede verificar el desarrollador"). Opciones:

1. **Clic derecho → Abrir.** En Aplicaciones, clic derecho (o Control+clic) sobre Oficina → Abrir → confirmar Abrir. Solo hace falta la primera vez. En macOS recientes (Sequoia en adelante) este atajo ya no alcanza.
2. **Ajustes del Sistema → Privacidad y seguridad.** Intentar abrir la app una vez, ir a esa sección, bajar hasta el aviso sobre "Oficina" y tocar **Abrir igualmente**. Confirmar con la contraseña o Touch ID.
3. **Quitar la cuarentena** (alternativa por Terminal):
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Oficina.app"
   ```

## Verificar el dmg a mano
```bash
hdiutil verify "app/build/Oficina 0.1.0.dmg"
codesign --verify --deep --strict "/Volumes/Oficina/Oficina.app"   # con el dmg montado
spctl -a -vv -t install "app/build/Oficina 0.1.0.dmg"                  # solo pasa si está notarizado
```

## Agentes y oficinas

El backend (`Sources/Backend`) maneja **oficinas**: cada una es una carpeta (por defecto `~/Oficinas/<Nombre>/`, o `HQ_OFICINAS_DIR`) con `oficina.json` como fuente de verdad, los agentes como agentes reales de Claude Code (`.claude/agents/<id>.md`), `conocimiento/` (`oficina.md`, `decisiones.md`, `agentes/<id>.md`), `reuniones/` y `archivos/`. La oficina activa y las recientes se guardan en `~/Library/Application Support/Próspera HQ/config.json` (`oficina_activa`, `oficinas_recientes`). El modo desarrollo (`oficina/server.py`) expone exactamente la misma API; la lógica común en Python está en `tools/hq_core.py`.

Sin oficina abierta, `/api/chat`, `/api/historial`, `/api/oficina`, `/api/departamentos*` y `/api/agentes*` responden `409 {"error":"No hay una oficina abierta"}`. Errores: `{"error": "mensaje en español"}`.

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/estado` | | `{app, version, claude, agentes:[ids de la oficina activa], auth, claudePath, oficina:{carpeta,nombre}\|null}` |
| GET | `/api/oficinas` | | `{oficinas:[{carpeta,nombre,activa}], activa: carpeta\|null}` (recientes; salta las que ya no existen) |
| POST | `/api/oficinas` | `{nombre, duenio?, carpeta?, departamentos?:[string \| {nombre, color?, id?}]}` | `{carpeta, oficina}`; queda activa. Sin `departamentos`: Dirección, Comunicación, Operaciones. Carpeta por defecto `<oficinasDir>/<Nombre>` (si existe: `Nombre 2`). 409 si ya hay `oficina.json` en `carpeta` |
| POST | `/api/oficinas/abrir` | `{carpeta}` | `{carpeta, oficina}`; 404 si no hay `oficina.json`, 400 si es inválido |
| POST | `/api/oficinas/importar-prospera` | `{origen?}` | `{carpeta, oficina, yaExistia, agentesImportados, faltantes, copiados}`; idempotente |
| GET / PATCH | `/api/oficina` | PATCH `{nombre?, duenio?}` | `{carpeta, oficina}` |
| POST | `/api/departamentos` | `{nombre, color?, id?}` | `{departamento, oficina}` |
| PATCH | `/api/departamentos/:id` | `{nombre?, color?}` | `{departamento, oficina}` |
| DELETE | `/api/departamentos/:id` | `{moverA?}` (o `?moverA=`) | `{ok, oficina}`; 409 si tiene agentes y no hay `moverA`, o si es el último departamento |
| GET | `/api/agentes` | | `{agentes:[AgenteDef]}` |
| POST | `/api/agentes/borrador` | `{descripcion, departamento}` | `{id, nombre, rol, description, prompt, chips[≤3], modelo, departamento}`; no escribe nada. 502 si Claude falla o no devuelve JSON usable |
| POST | `/api/agentes` | `{nombre, rol, prompt, departamento, id?, description?, chips?, modelo?, brief?, avatar?}` | `{agente, oficina}`; escribe el `.md` (plantilla fija con «Memoria de la oficina») y `conocimiento/agentes/<id>.md`. 409 si el id existe. `avatar.semilla` = id si no viene |
| GET | `/api/agentes/:id` | | `{agente, prompt (sin la sección de memoria), description, modelo?}` |
| PATCH | `/api/agentes/:id` | cualquiera de `{nombre, rol, departamento, avatar, prompt, description, chips, modelo, brief}` | `{agente, oficina}`; reescribe el `.md` solo si cambia `prompt`, `description` o `modelo` |
| DELETE | `/api/agentes/:id` | | `{ok, archivado: ".claude/agents/.archivados/<id>-<fecha>.md"\|null, oficina}`; `conocimiento/` queda |
| GET | `/api/agentes/:id/conocimiento` | | `{id, ruta, texto}` |
| POST | `/api/chat` | `{agent, message, session}` | `{reply}`; cwd = carpeta de la oficina; escritura solo en `conocimiento/agentes/<id>.md` (más `escritura` del agente en `oficina.json`, que solo pone el importador) |
| GET | `/api/historial?agent=&session=` | | igual que antes; las sesiones tienen clave por oficina |

Los ids son slugs (`^[a-z0-9][a-z0-9-]{0,40}$`). Los chats guardados antes de las oficinas quedan con oficina vacía y pasan a «Próspera HQ» al importarla (o al abrir una carpeta con la marca `.importada-prospera`).

**Importar Próspera sin la app:** `python3 tools/importar_prospera.py [--origen CARPETA]` crea `~/Oficinas/Próspera HQ/` (5 departamentos, 8 agentes) y copia, sin mover nada, `estado-actual.md` → `conocimiento/oficina.md`, `contexto-maestro.md` y `_equipo/` → `conocimiento/`.

**Para reuniones** (`Backend` expone): `backend.oficinas` (`Oficinas`: `activa() -> OficinaActiva?` con `carpeta`, `oficina`, `ruta(rel)`), `backend.runner` (`correrSinAgente(prompt:timeout:cwd:)` para la síntesis, `turnoSoloLectura(agente:prompt:cwd:timeout:)` con `Read,Glob,Grep`, `conCarril(oficina:agente:_:)`), `backend.registrarReuniones(SubRouter)` para atender `/api/reuniones*`, y `Plantillas.anexarDecisiones(carpeta:decisiones:fecha:)`.

## Reuniones

Varios agentes de la oficina activa opinan por **rondas** sobre un tema; el usuario puede intervenir, pedir otra ronda o cerrar. Al cerrar sale una síntesis (resumen, decisiones y pendientes). Código: `Sources/Backend/Reuniones.swift` (`ReunionesRouter`, registrado en `Backend.init` con `registrarReuniones`), paridad exacta (API, archivos y prompts) en `tools/hq_reuniones.py` (la usa `oficina/server.py`) y panel en `oficina/ui/reunion.js` (`App.Reunion.abrir()`). Si cambia una implementación, cambia la otra.

## Tareas programadas y segundo plano

Cada agente puede tener tareas (`tareas` en `oficina.json`: días ISO 1–7, hora `HH:MM`, zona IANA, consigna). El actor `Programador` (`Sources/Backend/Programador.swift`, iniciado en `Backend.init` y detenido en `shutdown()`) revisa cada 30 s la oficina activa y corre las que tocan como un chat del agente (carril, permisos, actividad y costo con origen «tarea»), en una sesión nueva que queda en el historial; las corridas se guardan en la tabla `ejecuciones`. La lógica de horarios es pura y está en `Sources/Backend/Tareas.swift` (`Programacion.proxima/debeCorrer`: una vez por horario, DST correcto, puesta al día si pasaron menos de 12 h). Rutas en `TareasRouter.swift` (`/api/tareas*`, registrado con `registrarTareas`); `programador.alTerminar { ejecucion in … }` es el gancho para avisos y notificaciones. Paridad en `tools/hq_tareas.py`; pestaña «Tareas» de la ficha en `oficina/ui/agente.js`.

La app sigue viva con la ventana cerrada (`applicationShouldTerminateAfterLastWindowClosed` = false; el Dock la vuelve a abrir) y tiene un ícono en la barra de menú (`Sources/App/BarraMenu.swift`): abrir, próximas tareas, «Abrir al iniciar sesión» (`SMAppService.mainApp`, apagado por defecto) y salir. ⌘Q cierra todo. Variables de prueba: `HQ_PROGRAMADOR=0` apaga el bucle, `HQ_PROGRAMADOR_INTERVALO` (segundos) lo acelera.

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/api/reuniones` | `{tema, agentes:[ids], rondas?=1}` (tema ≤ 500 car., 1-20 agentes de la oficina, rondas 1-3) | La reunión (abajo). Arranca en segundo plano |
| GET | `/api/reuniones` | | `{reuniones:[{id, tema, agentes, estado, creada, turnos:n}]}`, más nuevas primero (solo la oficina activa) |
| GET | `/api/reuniones/:id` | | `{id, tema, agentes, estado, hablando, rondas, creada, turnos:[{ronda, agente, texto, ts, error?}], sintesis?, errorSintesis?, cerrada?, acta?, actaRuta?, error?}` |
| POST | `/api/reuniones/:id/intervencion` | `{texto}` (≤ 5000) | La reunión. Queda como turno `agente:"usuario"` y lo leen los turnos siguientes (también si hay una ronda en curso). 409 si está cerrada |
| POST | `/api/reuniones/:id/ronda` | | La reunión, ya `en_curso`. 409 si hay una ronda en curso o está cerrada |
| POST | `/api/reuniones/:id/cerrar` | | La reunión `cerrada` con `sintesis` (la llamada espera a la síntesis, hasta 3 min). 409 si hay una ronda en curso o ya está cerrada |

- `estado`: `en_curso` (hay una ronda corriendo; `hablando` = id del agente o `null`), `esperando` (ronda terminada; el usuario decide), `cerrada`, `error` (en la última ronda no respondió nadie; se puede pedir otra ronda o cerrar). `ts`/`creada`/`cerrada` son ISO 8601 UTC. `ronda` del turno de usuario es la última ronda vista (0 si antes de todas).
- `sintesis`: `{resumen, decisiones:[string], pendientes:[{quien, que}]}`. Si falla la síntesis la reunión se cierra igual, sin `sintesis` y con `errorSintesis`. `acta` es la ruta relativa a la oficina y `actaRuta` la absoluta.
- Los ids son UUID. Una reunión de otra oficina responde 404; sin oficina abierta, 409. Errores: `{"error": "mensaje en español"}`.
- **Turnos:** secuenciales dentro de la reunión, un turno por participante y ronda. Cada uno es `turnoSoloLectura` (`Read,Glob,Grep`, sin escribir; en Python el equivalente con `claude -p --agent … --tools Read,Glob,Grep`) con cwd = carpeta de la oficina y el carril del agente (`conCarril(oficina:agente:)`, el mismo lock que el chat 1 a 1), timeout 180 s (`HQ_REUNION_TURNO_TIMEOUT`, y `HQ_REUNION_SINTESIS_TIMEOUT` para la síntesis). Un turno que falla (timeout, login, error de claude) queda registrado como turno con `error:true` y la ronda sigue.
- **Orden:** los agentes cuyo rol/departamento (peso 2) o brief/chips (peso 1) comparten más palabras con el tema hablan primero; a igual puntaje, el orden en que llegaron. El orden se guarda en `agentes` y se usa en todas las rondas.
- **Prompt del turno:** tema, participantes, memoria común (`conocimiento/oficina.md`, 2000 caracteres), últimas 15 decisiones, transcripción hasta ese momento y la consigna «Sos <nombre>, <rol>. Opiná desde tu rol en 120-180 palabras…».
- **Persistencia:** tablas `reuniones` y `turnos` en `hq.db` (con la carpeta de la oficina). Al arrancar, las reuniones que estaban `en_curso` pasan a `esperando` (la ronda interrumpida queda con los turnos que alcanzó a registrar).
- **Cierre:** `correrSinAgente` con el rol «secretario de actas» devuelve JSON estricto (se quitan los ```json y se recorta al primer `{` y último `}`). Se escribe `reuniones/AAAA-MM-DD-<tema>.md` (tema, participantes, transcripción, síntesis; si el nombre existe, `-2`, `-3`…) y las decisiones se anexan a `conocimiento/decisiones.md` con `Plantillas.anexarDecisiones`.
- **3D:** mientras hay una reunión abierta, `oficina/ui/reunion.js` consulta su estado cada 2 s y se lo pasa a la maqueta con `App.Oficina3D.reunion(agentes, hablando)`: los participantes caminan por los pasillos hasta la sala, quien habla gesticula y al cerrar vuelven a su escritorio (`App.Oficina3D.finReunion()`). Cerrar el panel no detiene una ronda en curso; se retoma desde «Reuniones».

## Biblioteca

Archivos y conocimiento de la oficina activa: se suben o se vinculan carpetas externas, un «bibliotecario» (un `claude -p` sin agente) ficha cada documento, y los agentes lo leen por rol. Código: `Sources/Backend/Biblioteca.swift` (`BibliotecaRouter`, registrado en `Backend.init` con `registrarBiblioteca`) y `Extraccion.swift`; paridad exacta (API, archivos, prompts) en `tools/hq_biblioteca.py` (la usa `oficina/server.py`) y panel en `oficina/ui/biblioteca.js` (`App.Biblioteca.abrir()`: botón «Biblioteca», estantería de la sala de la biblioteca en el 3D, o arrastrar archivos sobre el panel o la vista 3D). Si cambia una implementación, cambia la otra.

**Carpetas** (dentro de la oficina): `archivos/compartido/` (todos), `archivos/<departamento>/`, `archivos/entregables/<agente>/` (lo que produce cada agente), `archivos/.texto/<slug>.md` (texto extraído), `archivos/.papelera/` (nada se borra), `conocimiento/archivos.md` (catálogo, una línea por documento; lo leen todos al empezar) y `conocimiento/fuentes/<slug>.md` (ficha). Las crean `Plantillas.crearEstructura` / `completarEstructura` al crear o abrir la oficina. La sección «Memoria de la oficina» de los agentes nuevos menciona el catálogo, las fichas y `archivos/entregables/<id>/` (los agentes ya contratados conservan su `.md`).

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/archivos?q=&departamento=` | | `{archivos:[Archivo], q?}`. `q` busca en título, resumen, temas y texto (FTS5; sin FTS5, LIKE) y agrega `snippet` (la coincidencia entre `[ ]`). `departamento`: `compartido`, un id o `vinculo` |
| POST | `/api/archivos` | `{nombre, base64, departamento?="compartido", leer?}` | `{archivo, duplicado?, reemplazado?}`; queda `pendiente` y se procesa en segundo plano. 400 si el tipo no es soportado o el departamento no existe; 413 si pasa el máximo |
| GET | `/api/archivos/:slug` | | `{archivo (con rutaAbsoluta), texto (primeros 4000 car.)}` |
| GET | `/api/archivos/:slug/original` | | `{nombre, tipo, mime, tam, ruta, base64?}` (base64 solo hasta 8 MB) |
| DELETE | `/api/archivos/:slug` | | `{ok, papelera}`: los subidos se mueven a `archivos/.papelera/<slug>-<fecha>/` (con su ficha y su texto); los vinculados no se tocan |
| POST | `/api/archivos/:slug/leer` | `{agentes?:[ids]}` | `{archivo, agentes}`; lectura por rol (409 si todavía no tiene ficha o no hay a quién) |
| POST | `/api/archivos/:slug/reprocesar` | | `{archivo}` (vuelve a extraer y fichar) |
| GET | `/api/vinculos` | | `{vinculos:[{id, ruta, alcance, archivos, pendientes, existe}]}` |
| POST | `/api/vinculos` | `{ruta, alcance?="oficina", id?}` | `{vinculo}`. `alcance`: `"oficina"`, `{departamentos:[ids]}` o `{agentes:[ids]}`. 400 si es `/`, `~` entero, no es carpeta o ya es parte de la oficina; 404 si no existe; 409 si ya está vinculada |
| POST | `/api/vinculos/:id/escanear` | | `{nuevos, actualizados, sinCambios, quitados, omitidos, tope, aviso?}` |
| DELETE | `/api/vinculos/:id` | | `{ok, quitados}` (sus archivos van a la papelera de la biblioteca; la carpeta del usuario no se toca) |
| GET | `/api/biblioteca/estado` | | `{cola:[{slug, nombre, estado, error?, aviso?, leer?}] (todo lo que no está `listo`), pendientes, total, leyendo:[ids de agentes], propuestas, fts}` |
| GET | `/api/biblioteca/propuestas?todas=1` | | `{propuestas:[{id, archivo, titulo, actual, nuevo, sugerencia, estado, creada}]}` (solo pendientes salvo `todas=1`) |
| POST | `/api/biblioteca/propuestas/:id` | `{aceptar: bool}` | `{propuesta}`. Aceptar anexa a `conocimiento/oficina.md` una sección «Actualizado AAAA-MM-DD» con la sugerencia; rechazar la descarta. Nunca se aplica solo. 409 si ya estaba resuelta |
| GET / PATCH | `/api/biblioteca/config` | PATCH `{lecturaAutomatica?, maxMB?, maxArchivos?, maxTotalMB?}` | `{lecturaAutomatica, maxMB, maxArchivos, maxTotalMB, extensiones}`; se guarda en `oficina.json` → `biblioteca` |
| GET | `/api/biblioteca/entregables?agente=` | | `{agente, carpeta, entregables:[{nombre, ruta, tam, tipo, modificado}]}` (lo de `archivos/entregables/<agente>/`) |
| GET | `/api/biblioteca/entregable?agente=&ruta=` | | como `/original` |

`Archivo`: `{slug, nombre, titulo, departamento, tipo, tam, hash, estado, error?, aviso?, origen:"subido"\|"vinculo", vinculo?, ruta, creado, actualizado, fichaRuta, textoRuta, ficha?:{titulo, resumen, datos_clave[], temas[], util_para:[ids de departamento], fechas[]}, leer?:[ids pendientes], lectura?:{id:"ok"\|"error: …"}, snippet?}`. `estado`: `pendiente`, `extrayendo`, `fichando`, `leyendo`, `listo` o `error` (queda buscable por su texto; `error`/`aviso` dicen por qué: PDF escaneado, sin `claude`, ficha mal formada…). `slug` = nombre sin extensión como slug (`-2`, `-3`… si se repite).

**Subida y límites.** JSON con el archivo en base64 (compatible con `hq://`). Tipos: `.pdf .docx .doc .rtf .pages .odt .txt .md .csv .tsv .json .png .jpg .jpeg .gif .webp .heic`. Tamaño máximo por archivo 25 MB (`oficina.json` → `biblioteca.maxMB`, o `HQ_BIBLIOTECA_MAX_MB`); el nombre se sanea (sin rutas, `..`, caracteres de control ni `:`, hasta 120 car.) y se registra el SHA-256. Mismo contenido en la misma carpeta = «duplicado» (no se vuelve a procesar); mismo nombre con otro contenido = se reemplaza y se reprocesa. Carpetas vinculadas: tope de 200 archivos y 500 MB por carpeta (`biblioteca.maxArchivos` / `maxTotalMB`, `HQ_BIBLIOTECA_MAX_ARCHIVOS` / `HQ_BIBLIOTECA_MAX_TOTAL_MB`); solo extensiones soportadas, sin ocultos ni enlaces simbólicos; no se copia nada: se extrae y se ficha en su lugar (la ficha guarda la ruta original) y el escaneo (`escanear`, botón «Actualizar») recalcula el hash: si cambió se reprocesa, si ya no está se manda a la papelera. **No hay escaneo automático al abrir la oficina**: lo dispara el front con «Actualizar».

**Pipeline** (un solo trabajador en segundo plano; el estado vive en SQLite, tablas `archivos`, `propuestas` y `archivos_fts` de `hq.db`; al arrancar, lo que estaba a medio hacer vuelve a `pendiente`). 1) Extraer texto: PDF con PDFKit (Python: `pdftotext` si existe o `mdimport` en macOS, si no aviso); `.docx/.doc/.rtf/.odt/.pages` con `textutil -convert txt -stdout` (los `.pages` modernos no los lee `textutil`: queda el aviso); texto plano tal cual; imágenes con `claude -p --tools Read` («describí la imagen…»). 2) Ficha: el bibliotecario recibe el texto (12 000 car.), los departamentos (id: nombre), `oficina.md` (3000) y las últimas decisiones (2000) y devuelve JSON estricto `{titulo, resumen, datos_clave, temas, util_para, fechas, contradicciones:[{actual, nuevo, sugerencia}]}` (se quitan los ```json y se recorta al primer `{` y último `}`). 3) Se escribe `conocimiento/fuentes/<slug>.md`, se regenera `conocimiento/archivos.md` y se indexa. 4) Cada contradicción queda como propuesta pendiente. 5) Lectura por rol si el archivo se subió con `leer:true` o `oficina.json` tiene `biblioteca:{lecturaAutomatica:true}` (default false), o con `POST …/leer`: cada agente de los departamentos de `util_para` (si no hay, los del departamento del archivo; con carpeta vinculada, solo los de su alcance; máximo 10) corre un turno **en su carril** con permiso de escritura **solo** en su `conocimiento/agentes/<id>.md` y la consigna «leé la ficha y el texto y anotá qué te sirve desde tu rol, breve, solo hechos». Mientras tanto `estado.leyendo` lista a esos agentes` genérico) y los trae de vuelta al terminar.

**Permisos.** `oficina.json` suma dos campos opcionales: `vinculos:[{id, ruta, alcance}]` y `biblioteca:{lecturaAutomatica?, maxMB?, maxArchivos?, maxTotalMB?}` (ausentes = nada). `Permisos.contexto` agrega a la escritura del agente `archivos/entregables/<id>/**` (solo en oficinas con la estructura de biblioteca, o sea con `archivos/entregables/`; el chat de una carpeta sin ella queda como antes) y `--add-dir` de cada vínculo cuyo alcance lo incluye (`Permisos.dirsVinculos`), en el chat 1 a 1 y en las reuniones (`turnoSoloLectura(…dirsExtra:)`); un agente sin acceso no recibe el `--add-dir`. Ojo: las fichas y el catálogo son memoria de la oficina (los lee cualquiera); el alcance controla el acceso a los originales externos.

**Reuniones.** `POST /api/reuniones` acepta `documentos:[slug]` (hasta 10, con ficha): su ficha (2500 car. c/u, 8000 en total) entra en el prompt de todos los turnos y la reunión devuelve `documentos`. 400 si un slug no existe o todavía no tiene ficha.

**Abrir el original en la app.** El `Router` devuelve JSON, así que `original` entrega el archivo en base64 (hasta 8 MB) y el front arma un Blob y lo abre; en un `WKWebView` eso puede no abrir nada (no hay `WKDownloadDelegate`), por eso la ficha siempre muestra la ubicación. Para abrirlo de verdad hace falta una acción nativa `abrir` en `AppDelegate.userContentController` (`NSWorkspace.shared.open(URL(fileURLWithPath:))` con la `ruta` del archivo), que no está hecha. En `server.py` también se sirve como JSON (misma forma).

**Variables de entorno:** `HQ_BIBLIOTECA_MAX_MB`, `HQ_BIBLIOTECA_MAX_ARCHIVOS`, `HQ_BIBLIOTECA_MAX_TOTAL_MB`, `HQ_BIBLIOTECA_TIMEOUT` (ficha, 180 s), `HQ_BIBLIOTECA_IMAGEN_TIMEOUT` (120 s), `HQ_BIBLIOTECA_SIN_FTS=1` (fuerza la búsqueda con LIKE).

## Abrir archivos y créditos (app nativa)
- El front manda `window.webkit.messageHandlers.hq.postMessage({accion: 'abrir' | 'revelar', ruta})` (`App.nativo` en `oficina/ui/base.js`). `app/Sources/App/Abrir.swift` valida la ruta (enlaces simbólicos resueltos) contra la carpeta de la oficina activa y las carpetas vinculadas (las pide al backend) y la abre con `NSWorkspace`; nunca abre aplicaciones, scripts ni archivos ejecutables. `revelar` sin ruta abre la carpeta de la oficina (menú «Oficina», ⇧⌘O, y botón en la barra lateral).
- «Acerca de Oficina» (menú de la app y enlace en la barra lateral): LDraw parts library (CC BY 4.0), three.js (MIT), Poppins (OFL) y aviso de que el proyecto no está afiliado a LEGO.

- Al importar Próspera, si `~/Próspera` existe se vincula (`id: prospera`) para mario, don-armando, nicolas y sofia, y las rutas absolutas de sus `.md` apuntan a esa carpeta. Al abrir una oficina se reescanean sus carpetas vinculadas en segundo plano.

## Explorador de carpetas y de la oficina
Para no escribir rutas a mano. Código: `Sources/Backend/Explorador.swift` (`ExploradorRouter`, registrado en `Backend.init` con `registrarExplorador`), paridad exacta en `tools/hq_explorador.py` (la usa `oficina/server.py`) y front en `oficina/ui/carpetas.js`. Si cambia una implementación, cambia la otra.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/fs/carpetas?ruta=&ocultas=0\|1` | `{ruta, padre\|null, esOficina, accesos:[{nombre,ruta}], carpetas:[{nombre,ruta,esOficina}], truncado}`. Sin `ruta`: `$HOME`. Solo subcarpetas (nunca contenido de archivos), ordenadas, tope 500. |
| POST | `/api/fs/carpetas` `{padre, nombre}` | Crea una subcarpeta (nombre saneado: sin `/ \ :`, controles ni puntos iniciales). 409 si ya existe. |
| GET | `/api/oficina/archivos?ruta=<rel>` | Lista de la carpeta de la oficina activa: `{carpeta, ruta, archivos:[{rel,nombre,esCarpeta,tam,mod}], truncado}`. Solo se ve `.claude/agents` entre los ocultos. |
| GET | `/api/oficina/archivo?ruta=<rel>` | Vista previa: `{texto, truncado}` (`.md .markdown .txt .json .csv .tsv .log`, tope 512 KB, se corta), `{base64, mime}` (`.png .jpg .jpeg .gif .webp`, tope 2 MB: 413) o `{sinVista:true}`; siempre `rel, nombre, tam, mod, ruta` (absoluta). |

**Seguridad.** `/api/fs/carpetas`: la ruta tiene que ser absoluta (400) y, ya con `realpath` (enlaces simbólicos resueltos), estar dentro de `$HOME` (403); los enlaces que salen de `$HOME` no se listan. `/api/oficina/archivo*`: ruta relativa a la oficina (403 con `..`, ruta absoluta, `\`, NUL, ocultos que no sean `.claude`, o enlaces simbólicos que salen de la carpeta; 404 si no existe; 409 sin oficina). Solo lectura; nunca se leen archivos fuera de la oficina.

**Front.** `App.elegirCarpeta(titulo, {oficinas?, crear?}) → Promise<ruta|null>` (`oficina/ui/carpetas.js`): en la app nativa manda `{accion:'elegirCarpeta', titulo, inicio, crear}` al handler `hq` y abre un `NSOpenPanel` (`Abrir.swift`, `elegirCarpeta`); en el navegador abre un explorador propio sobre `/api/fs/carpetas` (accesos rápidos, «Nueva carpeta» con `crear`, insignia y prioridad para carpetas de oficina con `oficinas`). Se usa en «Abrir una oficina existente», «Crear mi oficina» («Cambiar…») y «Vincular carpeta». Sin Finder (navegador), «Ver archivos de la oficina» usa `/api/oficina/archivos` y `/api/oficina/archivo`.

**Handler nativo con respuesta.** `AppDelegate` registra `hq` con `addScriptMessageHandler(_:contentWorld:name:)` (`WKScriptMessageHandlerWithReply`, macOS 11+): `postMessage` devuelve una Promise. Las acciones existentes (`abrir`, `revelar`, `acerca`, `open`, `login`, `spike`) siguen igual y contestan `nil`; `elegirCarpeta` contesta la ruta o `null` si se cancela (solo desde páginas `hq://`). El diálogo no se puede automatizar sin clicarlo: probarlo a mano (Crear/Abrir oficina → «Buscar…»).
