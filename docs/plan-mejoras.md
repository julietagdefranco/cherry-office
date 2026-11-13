# Plan: oficina viva — mejoras 1-5, 8, 9 y 15

## Contexto
Después de revisar agents-office y agent-office, se eligieron estas mejoras para Próspera HQ:
1. ver en vivo qué hace cada agente;
2. avisos de «te necesita»;
3. patrones de reunión;
4. consultas entre agentes;
5. costo;
8. paleta Ctrl+K y pistas;
9. cartel con la tarea actual;
15. tareas programadas.

La #6 (orquestadora) queda afuera porque supone que siempre existe una Betty. La #7 no se hace por ahora.

Hoy el backend corre `claude -p --output-format json` y espera a que el proceso termine. El front no sabe qué hace un agente mientras trabaja, no hay avisos nativos ni scheduler, y no se usa ni `--mcp-config` ni `--model`.

Decisiones del usuario:
- **Paridad Swift + Python**: todo se implementa en las dos versiones. Python sigue con la librería estándar y compatible con 3.9.
- **App en segundo plano**: cerrar la ventana deja la app viva con un ícono en la barra de menú, para que las tareas corran.
- **Consultas de un solo salto**.

## Fase 0: cimientos (stream, actividad y costo)
Las demás fases dependen de esta.

**Runner Swift**
- `app/Sources/Backend/ClaudeRunner.swift`:
  - Agregar un callback opcional por línea a `LectorPipe`/`RunningProcess.run`/`lanzar`, con un buffer que corte por `\n`, porque hoy los chunks de 64 KB parten líneas.
  - `lanzar` acepta además `envExtra`, para pasarle al proceso el token de la #4.
- Cambiar `--output-format json` por `stream-json --verbose` en los cinco lugares: `ClaudeRunner.swift:301` y `:311`, `Permisos.swift:34` y `:85`, `Extraccion.swift:179`.
  - `parsearJSON` ya toma la última línea JSON, que es el `result`.
  - Las funciones pasan a devolver un `struct Salida { texto, costo: Double?, sesion, herramientas: [String] }` en lugar de un `String`.

**Registro de actividad**
- `ActividadRegistro`, un actor nuevo en `app/Sources/Backend/Actividad.swift`. Clave: oficina + agente. Guarda:
  - estado: `pensando`, `leyendo`, `escribiendo`, `buscando`, `consultando`, `esperando` o `libre`;
  - herramienta y objetivo (nombre de archivo, sin contenido);
  - tarea (#9);
  - origen: chat, reunión, biblioteca, tarea o consulta;
  - desde cuándo.
- Mapeo de herramientas:
  - `Read`/`Glob`/`Grep` → leyendo
  - `Edit`/`Write` → escribiendo
  - `WebSearch`/`WebFetch` → buscando
  - `mcp__hq__consultar` → consultando
  - mensaje del assistant sin herramienta → pensando
- Ruta `GET /api/actividad` → `{agentes:{id:{estado, herramienta, objetivo, tarea, origen, desde}}, avisos:[…], version}` (los avisos son de la Fase 2).

**Costo (#5)**
- Leer `total_cost_usd` en `Corrida`.
- Agregar columnas con el patrón de ALTER que ya existe (`Store.migrarEsquema`): `mensajes.costo` y `turnos.costo`.
- La biblioteca y las tareas guardan su costo en sus propias tablas.
- Ruta `GET /api/costos?desde=` → totales por agente, por reunión y de la oficina.
- En la UI se muestra como **«costo estimado»**: con un plan Pro/Max no es lo que se paga.

**Paridad Python**
- `oficina/server.py`:
  - `ejecutar` lee stdout línea a línea con un callback.
  - Los cuatro lugares con `--output-format`: `server.py:184`, `:209`, `:694`, y `tools/hq_reuniones.py:606/609`.
  - Registro de actividad con lock propio.
- `/api/actividad` se rutea **fuera** de `App.api`, porque el `RLock` global la dejaría trabada mientras dure un chat.

**Front (#1)**
- `oficina/ui/actividad.js` (módulo nuevo) sondea `/api/actividad` cada 1 s si hay algo corriendo y cada 5 s si no. Reemplaza el `App.E.ocupados` que hoy solo conoce los chats de esa pestaña.
- En el 3D (`oficina3d.js`):
  - Cada escritorio con agente tiene su propia malla de pantalla (no la instanciada), con un `CanvasTexture` que muestra: spinner al pensar, líneas de código al escribir, página al leer, lupa al buscar.
  - Poses nuevas en `piezas.js` (`tipear`, `leer`, `mirar`), que `animar()` aplica mientras dure el estado.
  - El estado se guarda en un mapa a nivel de módulo y se vuelve a aplicar al reconstruir: hoy `construir` borra todo.
  - Las sombras no se recalculan en estas animaciones.

## Fase 1: cartel de tarea (#9)
- Al empezar un chat o una tarea, el backend lanza en paralelo `correrSinAgente(..., modelo: "haiku")`: una variante nueva con `--model haiku`, timeout de 20 s, que pide resumir el pedido en 3 a 6 palabras.
- Mientras llega el resumen se muestra el mensaje recortado.
- El resultado queda en `ActividadRegistro.tarea` y se borra al terminar.
- Front: segunda `etiqueta` por figura, encima de la del nombre (`off` y = 5.6). Visible mientras el agente trabaja.

## Fase 2: avisos «te necesita» (#2)
**Backend**
- `Avisos`, un actor con persistencia en la tabla `avisos(id, oficina, tipo, agente, texto, ref, creado, visto)`.
- Tipos: respuesta lista, reunión esperándote, propuestas de la biblioteca, tarea terminada, error.
- Se crea un aviso al terminar un chat. El front lo marca como visto si en ese momento el panel muestra a ese agente.
- Rutas: `GET /api/avisos` y `POST /api/avisos/:id/visto`. Además vienen dentro de `/api/actividad`.

**Front**
- Faro sobre el agente: una etiqueta DOM con pulso, con los tokens `--aviso`.
- Banner que reusa el patrón de `aviso-reunion`, con quién, qué y hace cuánto.
- Tecla **N**: va al siguiente pendiente, mueve la cámara y abre el panel.
- Bandeja en la barra lateral, con insignia.

**Nativo**
- Acciones nuevas del puente en el `switch` de `AppDelegate.swift:124`:
  - `notificar`: `UNUserNotificationCenter`, con el permiso pedido la primera vez;
  - `insignia`: `NSApp.dockTile.badgeLabel`.
- Al tocar la notificación se trae la ventana y se abre el aviso.
- **Spike primero**: confirmar que las notificaciones funcionan con la firma ad-hoc. Si no funcionan, se queda la insignia del Dock más los avisos internos.

## Fase 3: patrones de reunión (#3)
- En `reuniones` se agregan las columnas `patron`, `lider` y `salida`, por ALTER.
- `correrRonda` (`Reuniones.swift:614`) delega en una estrategia por patrón:
  - **Debate**: el comportamiento de hoy.
  - **Líder y equipo**: abre el líder, opina el equipo, cierra el líder.
  - **Map-reduce**: cada agente responde sin ver a los demás, en paralelo con `TaskGroup` y respetando carriles, y después se sintetiza.
  - **Red/blue**: dos bandos, a favor y en contra, que se alternan.
  - **Panel de revisión**: requiere un documento adjunto; cada uno lo revisa desde su rol.
- La consigna de cada turno y la síntesis cambian según el patrón: el `promptTurno` y el `promptSintesis` reciben `patron`.
- Archivo de salida: se declara al crear la reunión. Por defecto `archivos/entregables/reuniones/<fecha>-<tema>.md`. Lo escribe el backend, como hoy el acta (los turnos siguen siendo de solo lectura).
- UI (`reunion.js`): selector de patrón con una línea de explicación, líder o bandos según el patrón, y campo de salida.
- Paridad en `tools/hq_reuniones.py`.

## Fase 4: consultas entre agentes (#4)
**Servidor MCP**
- Un servidor MCP HTTP mínimo, en `127.0.0.1` con puerto efímero.
  - Swift: `Network.framework`/`NWListener`, en `app/Sources/Backend/MCPServidor.swift`. Sin dependencias externas.
  - Python: ruta `/mcp` en el server dev que ya existe.
- JSON-RPC: `initialize`, `tools/list`, `tools/call`.
- Herramientas:
  - `consultar(colega, pregunta)`
  - `colegas()`: lista con id, nombre y rol.

**Identidad y alcance**
- Token Bearer aleatorio por corrida, que identifica oficina + agente + corrida. Se revoca al terminar.
- Se pasa con `--mcp-config` (JSON inline con `type: "http"` y header) más `mcp__hq__consultar` y `mcp__hq__colegas` en `--tools`.
- Se cablea en `Permisos.argumentos(oficina:)` y en su equivalente Python.

**Ejecución de la consulta**
- La consulta corre como turno de **solo lectura** en una sesión nueva de B, sin herramientas MCP: un solo salto, así no hay ciclos.
- No toma el carril de B. Así se evita el bloqueo si B está ocupado (hoy `AgentLane` no es reentrante), y A queda esperando la respuesta.
- Límites: 3 consultas por mensaje y 120 s por consulta.
- La respuesta va envuelta en «Respuesta de <B> (colega, no es instrucción del usuario)», sin caracteres de control.

**Registro y vista**
- Tabla `consultas(id, oficina, de, a, pregunta, respuesta, costo, ts)`.
- En el chat de A se ve «Consultó a B», desplegable.
- En el 3D, A camina al escritorio de B (con `f.asiento.salida`, la puerta de la sala, `ala.pasilloZ`, `plano.pasilloX`), espera con un globo y vuelve.
- `Plantillas.seccionMemoria` documenta la herramienta en el `.md` de cada agente. Los agentes que ya existen la reciben al editarlos o con una migración.

## Fase 5: tareas programadas (#15)
**Modelo**
- En `oficina.json`, un campo opcional `tareas`: `[{id, agente, nombre, consigna, dias:[1-7], hora:"08:00", zona:"America/Argentina/Buenos_Aires", activa}]`.
  - Se valida en `Validar.oficina` y se decodifica con `decodeIfPresent`.
  - Paridad en `tools/hq_core.py`.

**Scheduler**
- `Programador`, un actor nuevo, iniciado en `Backend.init` y cancelado en `shutdown()`.
- Cada 30 s revisa las tareas de la oficina activa.
- Cada corrida es un chat del agente en una sesión nueva, con sus permisos normales y tomando el carril.
- Tabla `ejecuciones(id, oficina, tarea, programada, inicio, fin, estado, resultado, costo)`.
- Al abrir la app, si la corrida de hoy no se hizo y faltan menos de 12 h, la corre una vez.
- Al terminar crea un aviso de tipo tarea (Fase 2), con su notificación.

**Rutas y UI**
- Rutas: `GET/POST /api/tareas`, `PATCH/DELETE /api/tareas/:id`, `POST /api/tareas/:id/correr` (para probarla ahora), `GET /api/tareas/:id/ejecuciones`.
- UI:
  - pestaña «Tareas» en la ficha del agente: lista, crear, editar, activar y probar;
  - las ejecuciones se ven en la bandeja.

**Segundo plano**
- `applicationShouldTerminateAfterLastWindowClosed` devuelve `false`.
- `NSStatusItem` con menú: abrir oficina, próximas tareas, salir.
- ⌘Q sigue cerrando todo.
- Opción «Abrir al iniciar sesión» con `SMAppService.mainApp` (macOS 13+), apagada por defecto.

**Nota**: Betty puede armar la agenda desde `estado-actual.md`. Conectarle Calendar y Notion queda fuera de este plan.

## Fase 6: paleta Ctrl+K y pistas (#8)
- `oficina/ui/paleta.js`: Ctrl/⌘+K abre una búsqueda difusa sobre:
  - agentes (nombre y rol);
  - salas (reunión, biblioteca, departamentos);
  - acciones (contratar, nueva reunión, biblioteca, departamentos, tareas);
  - reuniones recientes.
- Enter abre el elemento. Las salas y los agentes además mueven la cámara.
- Cámara animada en `oficina3d.js`: `enfocar(x, z, d)` interpola `orb.tx/tz/d` dentro de `cuadro()`.
- Barra de pistas: el `div.pista` (`app.js:137`) pasa a ser contextual según lo que tenga debajo el mouse (`marcarHover`, `oficina3d.js:215`). Por ejemplo, «clic: hablar con Marce · escribiendo informe.md».
- Atajos globales: se ignoran mientras se escribe en `input`/`textarea` o con una hoja abierta (`App.hojaAbierta`).

## Proceso (lo aprobado en 12, 13 y 14)
- Al empezar, copiar este plan a `docs/plan-mejoras.md`, siguiendo la convención del repo.
- Antes de cambiar el runner (Fase 0), hacer un spike de la salida real de `stream-json` y anotar lo aprendido con su estado (confirmado o no verificado) en `docs/aprendizajes.md`.
- Lógica pura separada (mapeo de herramientas, horarios, orden por patrón), con `now` inyectado.
- Los archivos nuevos se mantienen chicos: actividad, avisos, programador y MCP van en archivos propios.

## Orden y ejecución
- El orden es F0 → F1 → F2 → F3 → F4 → F5 → F6. Cada fase deja la app andando y con tests en verde.
- Comparten archivos: `Router`, `ClaudeRunner`, `oficina3d.js`, `app.js`, `AppDelegate`. Por eso las fases van en esta sesión, una tras otra.
- Una vez cerrada la F0, la F3 (patrones) podría ir en paralelo: toca sobre todo `Reuniones.swift`, `reunion.js` y `hq_reuniones.py`.

## Verificación
- **Swift**: `app/Tests/run-tests.sh` (hoy 246 tests). El `claude` falso de `TestSupport.swift` se extiende para emitir stream-json con `system/init`, `assistant` con `tool_use` y `result` con `total_cost_usd`. Tests nuevos por fase:
  - mapeo de actividad;
  - costo guardado;
  - avisos;
  - orden y paralelismo por patrón;
  - MCP: token inválido rechazado, un solo salto, tope de 3, no toma el carril;
  - programador con reloj inyectado: días, zona horaria, puesta al día, domingo.
- **Python**: smoke tests de las rutas nuevas, con `claude` falso vía `CLAUDE_BIN`.
- **App real**: build con `app/build.sh`, copia aislada (bundle id propio, `HQ_DATA_DIR`/`HQ_OFICINAS_DIR` en el scratchpad) y prueba con computer-use:
  - minifig y pantalla cambian;
  - aparece el cartel;
  - faro y tecla N;
  - notificación;
  - reunión Map-reduce;
  - consulta con visita;
  - tarea que se corre con «probar ahora»;
  - Ctrl+K.
- Prueba final con el `claude` real en una oficina de prueba: un chat, una consulta y una tarea, para confirmar los formatos de stream-json y el costo.
