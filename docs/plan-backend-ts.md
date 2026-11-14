# Plan: backend en TypeScript (etapa 1 de la app multiplataforma)

## Contexto
La app pasa a ser multiplataforma (Mac y Windows) con un solo código:
- **Etapa 1 (este plan):** portar el backend Swift (`app/Sources/Backend`, ~13 mil líneas) a TypeScript sobre Node, con **la misma API**, y verificarlo contra la oficina sin cambios en el navegador, como hoy `oficina-dev`.
- **Etapa 2:** carcasa Electron que reemplaza a `app/Sources/App` y genera `.dmg` y `.exe`. Se suma el job de Windows a `.github/workflows/release.yml`.
- `instalar.command` quedó obsoleto y no se porta.

La app Swift sigue siendo la que se publica hasta que la etapa 2 la reemplace. Mientras dure el port, cualquier cambio de comportamiento en el backend Swift se replica en TS (o se congela el backend Swift).

## Objetivo de la etapa
`npm run dev` en `backend/` levanta `http://localhost:8765` con la oficina, y:
- la oficina se usa de punta a punta (oficinas, agentes, chat, reuniones, tareas, biblioteca, flujos, entregas, creador, exportar e importar);
- lee los datos existentes de un usuario (`hq.db`, `config.json`, carpetas de oficina) sin migrarlos ni romperlos, y la app Swift los sigue pudiendo abrir después;
- la suite de paridad pasa igual contra el backend Swift y contra el TS;
- corre en Windows (al menos: abrir oficina, chatear, una tarea programada, subir un PDF).

## Decisiones
- **Ubicación:** carpeta nueva `backend/` en la raíz (`package.json`, `tsconfig.json`, `src/`, `test/`). `oficina/` no se toca salvo bugs.
- **Runtime:** Node ≥ 22.13, TypeScript estricto, ESM. Tests con vitest.
- **SQLite:** `node:sqlite` (viene con Node ≥ 22.13, trae FTS5 con `remove_diacritics`, sin dependencias nativas: nada que recompilar para Electron ni Windows) detrás de una interfaz de tres métodos (`exec/run/query`, `src/sqlite.ts`). Mismos PRAGMA: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- **Dependencias externas** (solo donde Node no alcanza): zip con `yauzl`/`yazl` (o `fflate`), PDF con `unpdf`, docx con `mammoth`, fechas con el polyfill de `Temporal`. `rtf` y `odt` con parsers chicos propios; `doc` y `pages` siguen usando `textutil` en Mac y dan "formato no soportado" en Windows.
- **Contrato:** el mismo de Swift, `handle(method, path, query, body) → {status, json}`. Todo es JSON, sin streaming. El servidor HTTP y, después, Electron son adaptadores finos encima.
- **API para la etapa 2:** `createBackend({datosDir, claudePath?, env})` devuelve `{handle, shutdown, avisos (EventEmitter), validarRutaAbrir}`. Sin `process.exit` ni estado global adentro del backend.
- **`oficina.json`:** serializador propio que reproduce el formato de Swift (claves ordenadas, indentado de 2, `"clave" : valor`, sin escapar `/`), así no aparece un diff en cada oficina la primera vez que se guarda.
- **Mensaje a `claude` por stdin**, no en los argumentos: Windows corta la línea de comandos en ~32 mil caracteres y el mensaje puede llegar a 100 KB más el system prompt. Requiere un spike (ver Riesgos).

## Etapas de trabajo

Cada paso termina con sus tests de paridad pasando contra los dos backends.

### 0. Arnés de paridad (primero)
- Extraer el `claude` falso de `app/Tests/BackendTests/TestSupport.swift` a `backend/test/fixtures/claude-fake.sh`, y escribir una versión en Node (`claude-fake.js` + shim `.cmd`) para Windows.
- Suite vitest de caja negra por HTTP contra una URL base. Cada test arma su sandbox (`HOME`, `HQ_DATA_DIR`, `HQ_OFICINAS_DIR`, `CLAUDE_BIN`, timeouts cortos) y levanta `swift run oficina-dev` o `node dist/dev.js` con `PORT`. Manda `Host`, `Origin` y `Content-Type` correctos.
- Portar primero los tests mayormente de API: Agentes, Oficinas, Paquete, Pendientes, Perfil, Avisos, Reuniones, Biblioteca, Flujos, Gobierno, Entregas, Creador, CasoProspera. Los tests de internals (Config, Permisos, Store, Migracion…) se reescriben como unit tests de los módulos TS a medida que se portan.
- **Listo cuando:** la suite corre en verde contra el backend Swift.

### 1. Infraestructura
`ErrorAPI`, helpers JSON, `Validar`/`Slug`/`uuidValido`, Config (con `datosDir` inyectable y rutas con `path.*`), Log (archivo rotativo de 1 MB × 3), wrapper SQLite, esqueleto del Router con **el mismo orden de subrouters** que Swift (lo no portado devuelve 404 `{"error":"no"}`), y servidor dev:
- estáticos por lista blanca con contención por realpath;
- chequeos de Host, Origin y Content-Type;
- **sin timeout de request** (el Swift corta a los 120 s y eso mata chats largos: se arregla acá).

### 2. Oficinas
Modelo de oficina, `OficinaStore`, `Oficinas` (recientes en `config.json`), Plantillas, tipos de ModeloFlujos (se decodifican dentro de `oficina.json`), Explorador. Endpoints: estado, oficinas*, oficina, perfil, departamentos, GET agentes.
**Listo cuando:** la oficina carga en el navegador y se puede abrir y crear una oficina.

### 3. Chat (primer corte de punta a punta)
ClaudeLocator, ClaudeRunner (spawn, separador de líneas stream-json, una cola por agente, semáforo `HQ_MAX_CLAUDE`, timeout y kill del árbol de procesos, `auth status`), Stream, Actividad, Permisos + Instrucciones, Store (sesiones, mensajes, costos, meta), avisos, `Entregas.registrar`. Endpoints: `/api/chat`, `/api/historial`, `/api/actividad`, `/api/avisos*`.
**Listo cuando:** se chatea con un agente real desde el navegador, en Mac, y el historial se ve también desde la app Swift.

### 4. Resto, en este orden
1. Servidor MCP propio (`/mcp`, JSON-RPC a mano, token Bearer por corrida) y Consultas.
2. Agentes: contratar, borrador, editar, despedir, conocimiento.
3. Entregas y costos.
4. Tareas y Programador (con `Temporal`, `disambiguation: 'compatible'`, igual que la regla actual de cambio de horario).
5. Reuniones y Pendientes.
6. Biblioteca, Extraccion, vínculos y FTS5 (con el fallback sin FTS).
7. Flujos (motor y corridas), Coordinador, Acciones, Gobierno, Conectores, Parte, Creador.
8. Paquete (zip con chequeos de zip-slip y tamaño total), Importar (solo Mac), Migracion (mínima: se saltea si `meta.migracion_legacy_v1` ya está).

### 5. Windows
Hecho:
- `claude` falso en Node (`backend/test/fixtures/claude-fake.cjs`): la misma suite corre en macOS (contra Swift y TS), Linux y Windows. Los fixtures de zip usan `fflate` (sin ditto, zipinfo ni python3).
- El runner manda el mensaje por la entrada estándar en Windows (probado con el claude real en Mac: mismo resultado y mismo tiempo que por argumento). `HQ_MENSAJE_STDIN=1` fuerza ese camino en Mac/Linux.
- Un `.js`/`.cjs` como `claude` se lanza con node; un shim `.cmd` de npm se resuelve a `node …/cli.js`; el árbol de procesos se mata con `taskkill /T`.
- CI: `.github/workflows/backend.yml` corre tipos y la suite contra TS en `windows-latest` y `ubuntu-latest` (en Linux, también con el mensaje por stdin).

Pendiente, a mano en una PC con Windows y Claude Code con sesión iniciada (`cd backend && npm ci && npm run dev`, abrir http://localhost:8765):
1. Que encuentre `claude` (instalador nativo `claude.exe` y, aparte, instalación por npm) y que `/api/estado` diga `auth: true`.
2. Crear una oficina, contratar un agente y chatear (dos mensajes: el segundo retoma la sesión). Un mensaje largo (más de 40 mil caracteres) también tiene que andar.
3. Permisos de escritura: pedirle al agente que actualice sus notas (`conocimiento/agentes/<id>.md`) y que deje un archivo en `archivos/entregables/<id>/`. Si Claude Code no toma las reglas `Edit(//C:/…)`, ajustar `regla()` en `backend/src/permisos.ts` (riesgo 2).
4. Consultar a un colega (servidor MCP), una reunión corta, una tarea programada con «Probar ahora», subir un PDF a la biblioteca, exportar e importar la oficina.
5. Cerrar el servidor con Ctrl+C en pleno chat: no tiene que quedar ningún `claude` vivo (Administrador de tareas).

## Riesgos (de mayor a menor)
1. **Ejecutar `claude` en Windows.** Los shims `.cmd` necesitan `shell: true` y ahí el quoting del JSON y los saltos de línea se rompen; preferir `claude.exe` o resolver el shim a `node …/cli.js`. Límite de línea de comandos. Kill del árbol con `taskkill /T /F`. `Path` vs `PATH` en el entorno. **Spike al inicio del paso 3:** mensaje por stdin con `-p` (sin la espera de 3 s que hoy se evita con stdin vacío) y lanzamiento en Windows.
2. **Reglas `Edit(//ruta)` con rutas de Windows** (`C:\…`): no sabemos cómo las interpreta Claude Code. Spike con el `claude` real.
3. **Concurrencia.** Los actores de Swift serializan solos; en JS hay que poner un mutex para leer, modificar y escribir `oficina.json`, una cadena de promesas por agente y un semáforo para los procesos.
4. **Identidad de oficina por ruta absoluta** (es la clave en todas las tablas): normalizar igual que Swift en Mac (`/private`) y pensar mayúsculas y letra de unidad en Windows.
5. **Escritura atómica en Windows:** `rename` sobre un archivo abierto (antivirus, claude) puede fallar; reintentar con espera.
6. **Largos de texto:** Swift cuenta grafemas y JS cuenta unidades UTF-16; los límites y recortes pueden diferir en emojis.
7. **Extracción de texto:** el texto de `unpdf` no va a ser idéntico al de PDFKit; la paridad acá es "extrae algo razonable", no byte a byte.

## Fuera de alcance
Carcasa Electron, puente nativo (`window.webkit.messageHandlers.hq`: abrir, revelar, insignia, elegir archivo o carpeta, login), notificaciones nativas, firma e instaladores. Todo eso es la etapa 2. La etapa 1 deja `createBackend` y el EventEmitter de avisos listos para enchufarlos.
