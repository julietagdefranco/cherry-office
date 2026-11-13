# Plan: de la reunión al entregable revisado

## Contexto
Desde la 0.2.0 los agentes trabajan solos: tareas programadas y consultas. Quedan dos huecos:

1. **Los pendientes de una reunión no se ejecutan.** Al cerrar la reunión se anotan en las notas del agente (`conocimiento/agentes/<id>.md`), pero nadie le pide que los haga.
2. **Lo que producen los agentes queda disperso.** Está en la pestaña Tareas de cada agente, en `archivos/entregables/`, en las actas y en avisos que desaparecen al verlos. No hay un lugar único, ni forma de saber qué te falta revisar.

Objetivo: cerrar el ciclo **reunión → pendiente → tarea o encargo → entregable → revisado / pedir cambios**, con un contador de entregas sin revisar.

## Conceptos
- **Encargo**: corrida única de un agente a partir de un pendiente («Hacelo ahora»). Usa la maquinaria de las tareas (carril, permisos, actividad, costo, ejecución), pero no queda en `oficina.json`.
- **Entrega**: algo que un agente terminó y que la persona tiene que revisar. Estados:
  - `sin_revisar`: así nace;
  - `revisada`: la persona tocó «Listo»;
  - `cambios`: la persona pidió cambios; la reemplaza una entrega nueva.

  **Abrir una entrega no la marca como revisada.**
- **Qué genera una entrega**:
  - una ejecución de tarea terminada bien, sea programada, de prueba o un encargo;
  - el acta de una reunión cerrada;
  - un chat normal que **escribió archivos en `archivos/entregables/`**. Los chats que solo responden no generan entrega, para no llenar el muro de ruido.

  Una corrida que termina con error no genera entrega: sigue avisando como hoy.
- **Contador**: cuenta las entregas `sin_revisar` de la oficina activa.

## Fase E0: entregas (backend)
**Modelo y persistencia**
- `app/Sources/Backend/Entregas.swift`, archivo nuevo. Tabla `entregas`:

  ```
  id, oficina, agente, origen (tarea|encargo|reunion|chat|cambios),
  ref, titulo, resumen, sid, archivos (JSON),
  creada, estado, revisada, padre
  ```

  - `ref` apunta al origen: id de la ejecución, id de la reunión o `reunion:idx` del pendiente.
  - `resumen` guarda los primeros ~280 caracteres de la respuesta.
  - `padre` es la entrega anterior cuando se pidieron cambios.

**Archivos escritos**
- `CajaArchivos` junto a `CajaCosto` en `Stream.swift`: un observador que junta el `file_path` de los `tool_use` `Write`, `Edit` y `NotebookEdit`. `Stream.swift:51` ya extrae ese campo.
- Se guardan como rutas relativas a la carpeta de la oficina. Las rutas de afuera se descartan.

**Quién crea la entrega**
- `Programador.correr`, al terminar bien. Queda junto al gancho actual.
- `Reuniones`, al cerrar con acta. Los archivos son el acta y el archivo de salida del patrón.
- `Router.chat`, solo si `CajaArchivos` tiene algo bajo `archivos/entregables/`.

**Avisos y rutas**
- El aviso `tarea` deja de crearse: la entrega lo reemplaza en la bandeja.
  - La notificación de macOS se mantiene, con el texto «X te entregó "título"».
  - Los avisos `error` siguen igual.
- Rutas:
  - `GET /api/entregas?estado=&agente=&origen=&limite=`
  - `GET /api/entregas/:id`: detalle con el texto completo, que se lee de la sesión o de la ejecución;
  - `POST /api/entregas/:id/revisada`
  - `POST /api/entregas/:id/sin-revisar`
- `/api/actividad` suma `entregas_sin_revisar: N`. El sondeo que ya existe alimenta el contador, sin pedidos nuevos.

**Paridad Python**
- `tools/hq_entregas.py`, módulo nuevo: misma tabla y mismas rutas. Se conecta en `hq_tareas.py`, `hq_reuniones.py` y `oficina/server.py`.

## Fase E1: pendientes que se ejecutan
**Estado de cada pendiente**
- Tabla `pendientes_estado(oficina, reunion, idx, accion, ref, ts)`. `accion` puede ser `encargado` (ref = id de la ejecución) o `tarea` (ref = id de la tarea).
- El pendiente se identifica por su posición en `sintesis.pendientes`, que no cambia después del cierre.

**«Hacelo ahora»**
- `POST /api/reuniones/:id/pendientes/:idx/encargar`.
  - Resuelve el agente con `PendientesReunion.agente(de:en:)`.
  - Arma una consigna con el pendiente, el tema de la reunión y la ruta del acta como contexto.
  - Llama a `Programador.encargar(...)`, que reusa `lanzar` con una `TareaProgramada` efímera de id `encargo:<reunion>:<idx>`.
- Si el pendiente necesita a la persona o no tiene un agente que lo resuelva, el botón no aparece.

**«Convertir en tarea»**
- Abre la hoja de tarea (`hojaTarea` en `agente.js`) con el agente, el nombre y la consigna ya cargados.
- `TareaProgramada` suma un campo opcional `origen: {reunion, idx}`, decodificado con `decodeIfPresent` y validado en `Validar.oficina`. Paridad en `hq_core.py`.

**Cierre en las notas**
- Cuando la entrega de un pendiente pasa a `revisada`, su línea `- [ ]` en las notas del agente se marca `- [x]`. Así el agente deja de tenerlo como pendiente.

**UI**
- En `reunion.js` (el acta), cada pendiente muestra según su estado:
  - «Hacelo ahora» y «Convertir en tarea»;
  - «Encargado · corriendo» o «ver entrega»;
  - «Tarea: <nombre>».

## Fase E2: panel de entregables y contador
**Panel**
- `oficina/ui/entregables.js`, módulo nuevo. Panel lateral, con el mismo patrón que el del agente.
  - Lista de la más nueva a la más vieja. Filtro por defecto «Sin revisar», y además «Todas», por agente y por origen.
  - Cada fila muestra el agente con su color, el título, el origen (con enlace a la tarea, la reunión o el pendiente), hace cuánto, el costo y los archivos.
- Al abrir una entrega:
  - el texto en markdown y los archivos, con apertura vía el explorador que ya existe;
  - los botones **Listo**, **Pedir cambios** (Fase E4) y **Abrir en el chat**.

**Contador**
- Barra lateral: ítem «Entregables» con insignia (`dom.navEnt`), igual que `navReu` y `navBib`.
- Dock: avisos «te necesita» más entregas sin revisar, ya sin el aviso `tarea`, así que no se cuenta dos veces. Se calcula en `avisos.js:46`.
- Barra de menú (`BarraMenu.swift`): «N entregas sin revisar», que abre el panel. El nativo lo recibe por el puente, con una acción `entregas` o junto a `insignia`.
- Paleta ⌘K: «Entregables» y «Entregas sin revisar».
- Tecla **N**: recorre los avisos y después las entregas sin revisar.

## Fase E3: muro en el 3D
- `oficina/ui/muro3d.js`, archivo aparte, porque `oficina3d.js` ya tiene 1597 líneas. Exporta `construirMuro(escena, plano)` y `actualizarMuro(entregas)`.
- Es un tablero de corcho LEGO en una pared libre cerca de la entrada. Se elige por plano; si no hay lugar, va en la pared de la sala de reuniones.
- Muestra las 6 a 8 entregas más recientes como hojas (`CanvasTexture`), con título corto, inicial y color del agente. Las sin revisar llevan una chincheta roja.
- Arriba, un cartel con el número sin revisar, que se apaga en cero.
- Clic en el muro abre el panel. Clic en una hoja abre esa entrega. Hover muestra la pista contextual, por ejemplo «Informe semanal · Marce · sin revisar».
- Mismo cuidado que con las pantallas:
  - el estado se guarda a nivel de módulo y se vuelve a aplicar en `construir`;
  - las texturas se reusan;
  - las sombras no se recalculan al actualizar.
- Sin confeti.

## Fase E4: pedir cambios
- `POST /api/entregas/:id/cambios {texto}`.
  - Retoma la sesión de la entrega (`ejecutarChat` con `activa: true`) en el carril del agente, con origen de actividad `cambios`.
  - Al terminar crea una entrega nueva con `padre = id` y `origen = cambios`. La vieja pasa a `cambios`.
- Si la entrega no tiene sesión (las actas de reunión), el botón no aparece.
- En el panel, la entrega muestra su cadena de versiones: «v2 · pediste: …».

## Orden y paralelismo
- **E0 → E1 → E2 → E4** en esta sesión, porque comparten `Programador`, `Router`, `reunion.js` y `avisos.js`.
- **E3** puede ir en paralelo una vez cerrada E0: solo necesita la ruta `/api/entregas` y toca `muro3d.js` más dos líneas de `oficina3d.js`.
- Rama nueva `claude/entregables`, que sale de `main` (0.2.0).

## Verificación
**Swift** (`app/Tests/run-tests.sh`)
- `CajaArchivos`: Write, Edit y NotebookEdit; rutas fuera de la oficina descartadas.
- Entregas:
  - qué genera entrega y qué no (chat sin archivos, error);
  - transiciones de estado;
  - contador en `/api/actividad`.
- Encargo desde un pendiente: corre en el carril, crea la ejecución y la entrega, y marca `- [x]` en las notas al revisar.
- Pendiente que necesita a la persona: no se puede encargar (409).
- Convertir en tarea: `origen` se guarda y se valida.
- Pedir cambios: retoma con `--resume`, crea la cadena padre/hijo, y la vieja deja de contar.

**Python** (`tools/test_hq.py`)
- Las mismas rutas y los mismos casos, con el `claude` falso, que ahora emite `tool_use` `Write`.

**Navegador** (modo dev)
- Reunión, después «Hacelo ahora», después la entrega en el muro y el panel, después «Pedir cambios» (v2), después «Listo»: el contador baja y el pendiente queda tildado.

**App aislada**
- La insignia del Dock y la línea en la barra de menú.
- La notificación «te entregó».

## Fuera de alcance
- Confeti.
- Revisar archivos con un diff entre versiones: por ahora solo se abren.
- Que un agente revise el trabajo de otro.
