# Plan: flujos, límites, reglas, coordinador, conectores, parte de llegada y el Creador

## Contexto
La oficina ya es general (ver `plan-core.md`): cada una crea departamentos y contrata agentes en palabras. Ya funcionan el chat 1 a 1, las reuniones por rondas, las tareas programadas, los encargos, las entregas (`sin_revisar` / `revisada` / `cambios`), los avisos «te necesita», las consultas entre agentes por el servidor MCP propio (`mcp__hq__*`), la memoria compartida y la biblioteca.

Lo que falta es lo que hace que una oficina **trabaje sola y en orden**:
1. **Flujos**: cadenas de pasos entre agentes y la persona, con aprobaciones en el medio.
2. **Límites por agente**: qué hace solo y qué deja como propuesta. Lo que sale de la oficina (un mail, un evento) siempre pasa por la persona.
3. **Reglas de la oficina**: valen para todos los agentes.
4. **Rol coordinador**: un permiso que se le da a cualquier agente.
5. **Conectores por agente**: los de la cuenta de claude.ai, asignados para leer o para actuar.
6. **Parte de llegada**: la primera pantalla al abrir.
7. **El Creador**: un agente especial de la recepción que arma y cambia la oficina charlando, proponiendo tarjetas que la persona aprueba.

**Nada es fijo.** No hay nombres, agentes ni flujos en el código: cada oficina arma los suyos. El caso de prueba es `docs/caso-prospera/texto-original.md` y la vara es `docs/caso-prospera/mapeo-esperado.md`.

## Conceptos
- **Flujo** (definición, en `oficina.json`): nombre y pasos ordenados. Cada paso dice quién lo hace (un agente o `"persona"`), qué recibe, qué entrega y si requiere aprobación para seguir.
- **Corrida** (en SQLite): una vez que se recorre un flujo, por ejemplo «Clase 7». Guarda una **copia de la definición** al arrancar: editar el flujo no rompe las corridas vivas.
- **Paso de agente**: se lanza como encargo (misma maquinaria que las tareas). Al terminar deja una entrega.
  - Sin aprobación: la entrega pasa sola al paso siguiente.
  - Con aprobación: espera el «Listo» de esa entrega. «Pedir cambios» vuelve al mismo agente, en la misma conversación (ya existe); la versión nueva reemplaza a la anterior en el paso.
- **Paso de la persona**: queda como aviso «te necesita» hasta que la persona sube archivos o toca «Hecho». Eso crea una entrega de la persona (ya revisada), así el paso siguiente siempre recibe una entrega.
- **Límites**: textos libres («hace solo» / «propone y espera») que se inyectan en las instrucciones del agente. **Lo que aplica el sistema son las herramientas**: las de actuar de un conector nunca están en una corrida normal.
- **Acción propuesta**: un agente con herramientas de actuar asignadas no las puede usar; llama a `mcp__hq__proponer_accion` y eso crea una entrega «Propuesta». Al tocar «Aprobar y ejecutar», el backend lanza una corrida nueva con **esa sola herramienta** habilitada.
- **Regla de la oficina**: texto corto que se inyecta en todos los agentes, en toda corrida (chat, tarea, encargo, paso, reunión, consulta).
- **Coordinador**: `permisos: ["coordinador"]` en un agente. Suma herramientas MCP para ver entregas, corridas y bloqueos de todos, y para repartir encargos. Puede redactar el parte.
- **Conector**: un servidor de claude.ai de la cuenta del usuario (Google Calendar, Gmail, Drive…). `claude -p` ya los hereda. La oficina los detecta, los clasifica en leer / actuar y los asigna por agente.
- **Tarjeta** (del Creador, en SQLite): una propuesta de departamento, agente, flujo, regla, conector o tarea. Estados: `borrador` (le falta algo), `lista`, `creada`, `descartada`, `error`. Siempre cita el fragmento de origen.

## Lo que confirmaron los spikes (ver `docs/aprendizajes.md`)
- **`--tools` NO limita las herramientas MCP.** Solo filtra las propias (Read, Bash…).
- **Sin `--permission-mode`, el hijo hereda `defaultMode` del usuario** (en esta máquina `auto`), y en `auto` una herramienta de conector que no está en `--allowedTools` corre igual. Con `--permission-mode dontAsk` se rechaza.
- **`--disallowedTools` sí saca herramientas MCP** de lo que ve el modelo. Acepta servidor (`mcp__claude_ai_Gmail`), comodín (`mcp__claude_ai_*`) o nombre exacto, y le gana a `--allowedTools`.
- Formato: `mcp__claude_ai_<Nombre con _>__<herramienta>`. En `system/init` → `mcp_servers` vienen `{name:"claude.ai Google Calendar", status:"connected"|"needs-auth", source:"claudeai"}` y en `tools` los nombres.
- Los conectores se conectan en segundo plano: hace falta `MCP_CONNECTION_NONBLOCKING=false` en el entorno del hijo para que estén al arrancar.

**Decisión:** toda corrida de agente de oficina pasa `--permission-mode dontAsk`. Lo permitido va explícito en `--allowedTools` (incluidas las herramientas base), y lo que no se asignó va en `--disallowedTools` para que ni lo vea. A un agente sin conectores se le pasa `--disallowedTools mcp__claude_ai_*`.

**Sin verificar** (se prueba en la ola 3 con el claude real y se anota en `aprendizajes.md`):
- Que `--append-system-prompt` se combine con `--agent` en `-p`. Si no anda, el plan B es anteponer las instrucciones al mensaje, dentro de `Permisos.argumentos`.
- Que `dontAsk` deje correr `Skill`. Por las dudas, las herramientas base van en `--allowedTools`.

## Modelo de datos

### §1 `oficina.json` (sigue en `version: 1`)
Todas las claves nuevas son **opcionales**. Una oficina vieja abre igual, y una oficina nueva abre en un build viejo. Lo que se pierde es que un build viejo, al reescribir, borra las claves nuevas: se acepta y se documenta, no se sube la versión.

```json
{
  "version": 1,
  "departamentos": [{ "id": "educacion", "nombre": "Educación", "color": "#7aa2e3",
                      "mision": "Convertir el conocimiento en experiencias educativas." }],
  "agentes": [{
    "id": "sofia", "nombre": "Sofía", "rol": "Directora académica", "departamento": "educacion",
    "limites": { "solo": ["Diseñar fichas de clase"], "proponer": ["Cambiar el plan curricular"] },
    "conectores": [{ "servidor": "Google Calendar",
                     "leer": ["mcp__claude_ai_Google_Calendar__list_events"],
                     "actuar": ["mcp__claude_ai_Google_Calendar__create_event"] }],
    "permisos": ["coordinador"]
  }],
  "reglas": [{ "id": "no-inventar", "texto": "No inventes datos: si falta algo, preguntalo.", "origen": "«No inventar…»" }],
  "flujos": [{
    "id": "clase", "nombre": "Producción de una clase", "descripcion": "…", "activo": true,
    "pasos": [
      { "id": "diseno", "nombre": "Diseño académico", "quien": "sofia",
        "consigna": "Diseñá la clase", "recibe": "El tema de la clase", "entrega": "Ficha, guion y ejercicios",
        "aprobacion": true, "plazoDias": 3 },
      { "id": "grabacion", "nombre": "Grabación", "quien": "persona", "recibe": "PPT y guion",
        "entrega": "El archivo de la grabación", "aprobacion": false },
      { "id": "edicion", "nombre": "Edición", "quien": "armando", "recibeDe": ["grabacion", "diseno"],
        "entrega": "Video final y .srt", "aprobacion": true, "esperaDias": null }
    ]
  }]
}
```

Tipos Swift: archivo nuevo `ModeloFlujos.swift`, salvo los cambios a `Oficina`, `AgenteDef` y `Departamento` en `Oficina.swift`.
- `Departamento.mision: String?`
- `AgenteDef.limites: LimitesAgente?` con `{solo: [String]?, proponer: [String]?}`
- `AgenteDef.conectores: [ConectorAsignado]?` con `{servidor: String, leer: [String], actuar: [String]}`. `leer` y `actuar` decodifican `[]` si faltan.
- `AgenteDef.permisos: [String]?`, cuyo único valor válido hoy es `"coordinador"`, más el computado `esCoordinador`.
- `Oficina.reglas: [Regla]?` con `{id, texto, origen?}`
- `Oficina.flujos: [FlujoDef]?` con `{id, nombre, descripcion?, pasos: [PasoFlujo], activo (default true), creado?, origen?}`
- `PasoFlujo`: `{id, nombre, quien, consigna?, recibe?, recibeDe: [String]?, entrega, aprobacion (default false), plazoDias: Int?, esperaDias: Int?}`
  - `quien` es un id de agente o `"persona"`.
  - `recibeDe` nil equivale al paso inmediato anterior. Si viene, son ids de pasos **anteriores** del mismo flujo (caso K5 del mapeo).
  - `plazoDias` marca bloqueo si el paso espera más que eso (default 2).
  - `esperaDias` hace que el paso arranque X días después de terminado el anterior (K8, la medición a los 7 días).

**`Oficina.init(from:)` es manual: cada clave nueva va en la propiedad, en `CodingKeys` y en un `decodeIfPresent`.** Hay un test de ida y vuelta que lo cuida.

**Validación** (`Validar.oficina` llama a `ValidarFlujos.validar(o)` y a `ValidarReglas.validar(o)`, y valida los campos nuevos del agente). Topes:

| Qué | Tope |
|---|---|
| Flujos | 30 |
| Pasos por flujo | 1 a 20 |
| Nombre | 80 caracteres |
| `consigna` | 4000 |
| `recibe` / `entrega` / `descripcion` | 600 |
| `plazoDias` | 1–60 |
| `esperaDias` | 1–90 |
| Reglas | 40, de 600 caracteres cada una |
| `mision` | 600 |
| `limites` | 12 por lista, de 300 caracteres |
| Conectores por agente | 12 servidores y 80 herramientas por lista; cada una empieza con `mcp__`, nunca con `mcp__hq__`, y tiene hasta 200 caracteres |

- Los ids son slugs únicos (los de los pasos, dentro de su flujo).
- `recibeDe` solo apunta a pasos anteriores.
- **Un paso cuyo agente no existe NO es error.** La oficina tiene que seguir abriendo después de despedir a alguien. El front lo muestra como «sin asignar» y el motor traba la corrida.
- `"persona"` y `"creador"` se suman a `Validar.reservados`: ningún agente contratado puede llevar esos ids.

### §2 SQLite (`hq.db`), tablas nuevas
Mismo patrón que `Entregas.swift`: `prepararX()` perezoso con `CREATE TABLE IF NOT EXISTS`, y la columna `oficina` es la carpeta.

```sql
CREATE TABLE IF NOT EXISTS corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, oficina TEXT NOT NULL, flujo TEXT NOT NULL,
  nombre TEXT NOT NULL, contexto TEXT NOT NULL DEFAULT '',
  definicion TEXT NOT NULL,            -- JSON del FlujoDef al arrancar
  paso INTEGER NOT NULL DEFAULT 0,     -- índice del paso actual
  estado TEXT NOT NULL,                -- en_curso|esperando_aprobacion|esperando_persona|trabada|terminada|cancelada
  creada REAL NOT NULL, actualizada REAL NOT NULL, terminada REAL, vista INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS corridas_oficina ON corridas(oficina, estado);

CREATE TABLE IF NOT EXISTS corrida_pasos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, corrida INTEGER NOT NULL, paso INTEGER NOT NULL,
  intento INTEGER NOT NULL DEFAULT 1, quien TEXT NOT NULL,
  estado TEXT NOT NULL,                -- pendiente|corriendo|esperando_aprobacion|esperando_persona|listo|error|saltado|cancelado
  ejecucion INTEGER, entrega INTEGER,  -- entrega = versión vigente (se actualiza tras «Pedir cambios»)
  inicio REAL NOT NULL, despues REAL,  -- despues = no lanzar antes de esta fecha (esperaDias)
  fin REAL, costo REAL, nota TEXT);
CREATE INDEX IF NOT EXISTS corrida_pasos_c ON corrida_pasos(corrida, paso, intento);
CREATE INDEX IF NOT EXISTS corrida_pasos_entrega ON corrida_pasos(entrega);

CREATE TABLE IF NOT EXISTS creador_tarjetas (
  id TEXT NOT NULL, oficina TEXT NOT NULL, sid TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL,                  -- departamento|agente|flujo|regla|conector|tarea
  accion TEXT NOT NULL,                -- crear|modificar|quitar
  objetivo TEXT,                       -- id existente (modificar/quitar)
  datos TEXT NOT NULL, faltantes TEXT NOT NULL DEFAULT '[]', origen TEXT NOT NULL,
  estado TEXT NOT NULL,                -- borrador|lista|creada|descartada|error
  error TEXT, creada_id TEXT, creada REAL NOT NULL, actualizada REAL NOT NULL,
  PRIMARY KEY (oficina, id));
CREATE INDEX IF NOT EXISTS creador_oficina ON creador_tarjetas(oficina, estado);

CREATE TABLE IF NOT EXISTS acciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, oficina TEXT NOT NULL, agente TEXT NOT NULL, sid TEXT NOT NULL,
  entrega INTEGER, herramienta TEXT NOT NULL, resumen TEXT NOT NULL, detalle TEXT NOT NULL DEFAULT '{}',
  estado TEXT NOT NULL,                -- pendiente|ejecutando|hecha|error|descartada
  resultado TEXT, ejecucion INTEGER, creada REAL NOT NULL, actualizada REAL NOT NULL);
CREATE INDEX IF NOT EXISTS acciones_entrega ON acciones(entrega);
```

Las firmas de `Store` están en los briefs de la ola 1 (`CorridasStore.swift`, `TarjetasStore.swift`, `AccionesStore.swift`). Tienen el mismo estilo que `entregaCrear` / `entrega` / `entregaMarcar`.

Ids nuevos de tareas sintéticas del programador (patrón `encargo:`):

| Id | Qué es | `origen` de la entrega |
|---|---|---|
| `flujo:<corrida>:<paso>:<intento>` | paso de flujo | `flujo` |
| `accion:<accionId>` | ejecución de una acción aprobada | `accion` |
| `coord:<8hex>` | encargo que repartió un coordinador | `encargo` |
| `parte:<AAAA-MM-DD>` | parte narrado por el coordinador | `parte` |

La entrega de la persona en un paso usa `origen: "persona"` y la propuesta de acción, `origen: "propuesta"`.

## Ejecución y permisos

### §3 Comando de `claude` para agentes de oficina
`ContextoOficina` suma estos campos (todos con default, así no cambia ningún llamador):
- `instrucciones: String?`
- `herramientasMCP: [String]?`: nil equivale a `Permisos.herramientasMCP`
- `herramientasBase: String?`: nil equivale a `cfg.herramientasAgente[id] ?? cfg.herramientas`
- `permitidas: [String]`: conectores asignados
- `vedadas: [String]`: van a `--disallowedTools`

`Permisos.argumentos(cfg, oficina:...)` arma los argumentos **en este orden**:
```
-p --agent <id> <flag> <sid> --output-format stream-json --verbose
--tools <base>[,Edit,Write][,<mcp...>]
--permission-mode dontAsk
[--mcp-config <json>]                 (si hay mcpUrl)
[--add-dir <d>]...
--allowedTools <cada herramienta base> [Edit(//p) Write(//p)]... [<mcp...> si hay mcpUrl] [<permitidas...>]
[--disallowedTools <vedadas...>]      (si no está vacía)
[--append-system-prompt <instrucciones>]  (si no está vacía)
-- <mensaje>
```
- `Permisos.contexto(a, agente:, dirsExtra:, actuar: [String] = [])` llena `instrucciones = Instrucciones.para(oficina, agente)` y `(permitidas, vedadas) = ConectoresAgente.herramientas(oficina, agente, catalogo:, actuar:)`.
- `Permisos.entorno(ctx)` devuelve `MCP_CONNECTION_NONBLOCKING=false` si alguna permitida empieza con `mcp__claude_ai_`. `ClaudeRunner` lo suma al entorno del hijo.
- `turnoSoloLectura` (reuniones y consultas) pasa a ser `--tools Read,Glob,Grep --permission-mode dontAsk --allowedTools Read Glob Grep --disallowedTools mcp__claude_ai_* [--append-system-prompt <i>]`, con un parámetro nuevo `instrucciones: String? = nil`.
- El modo legado (Próspera, `Permisos.argumentos(cfg, agente:)`) no se toca.

### §4 Instrucciones inyectadas (`Instrucciones.para(o, a) -> String?`)
Es un texto de hasta 8000 caracteres con estas secciones. Cada una aparece solo si tiene algo:
```
## Reglas de la oficina
- <regla>…
## Tus límites
Hacés solo: …
Dejás como propuesta y esperás la aprobación de <dueño>: …
Nunca hacés directo nada que salga de la oficina (mandar un mail, crear un evento, publicar, gastar): lo dejás como propuesta.
## Conectores
Podés leer con: Google Calendar (list_events, get_event).
Para actuar con Gmail (send_message) usá la herramienta proponer_accion: <dueño> la aprueba y recién ahí se ejecuta.
## Sos coordinador/a de la oficina
Ves entregas, flujos y bloqueos de todos (herramientas estado_oficina, entregas, corridas, bloqueos) y podés repartir encargos (encargar). No hacés el trabajo de otros: lo pedís.
```
Las reglas estructuradas reemplazan, para la inyección, a «Reglas permanentes» de `conocimiento/oficina.md`, que queda como contexto libre. No se tocan los `.md` de los agentes, así que esto llega también a los agentes importados.

### §5 Programador: pasos, acciones y encargos del coordinador
- `encargarLibre(act, def, id:, nombre:, consigna:, actuar: [String] = []) async throws -> Ejecucion` generaliza a `encargar`, que pasa a usarlo.
- `static func origenEntrega(_ tareaId) -> String`, según la tabla de §2. Se usa también para el origen de la actividad y del costo.
- `static func idFlujo(corrida:paso:intento:)` y `static func deFlujo(_:) -> (Int64, Int, Int)?`.
- **Ganchos como listas:** `alTerminar(_:)` agrega (ya no reemplaza) y se suma `alEntregar(_ f: (Entrega, Ejecucion?) async -> Void)`. Se llama con la entrega que devuelve `RegistroEntregas.registrar`, tanto en `correr` (con la ejecución) como en `correrCambios` (con nil).
- **MCP también fuera del chat:** las corridas del programador emiten token (perfil según el agente) y pasan `mcpUrl`, `herramientasMCP` y el token en el entorno, como ya hace `Router.chat`.

### §6 Servidor MCP por perfil
- `IdentidadMCP.perfil` puede ser `"agente"` (el default), `"coordinador"` o `"creador"`.
- `MCPTokens.emitir(..., perfil:)` suma un cupo genérico `tomar(token, clave:, max:)`.
- `ConsultasMCP.herramientas(token:identidad:)` compone según el perfil:
  - `creador` → `Creador.herramientas(...)`
  - cualquier otro → `HerramientasHQ` + `Coordinador.herramientas(...)` (solo con perfil coordinador) + `Acciones.herramientas(...)` (solo si el agente tiene herramientas de actuar asignadas)
- **El servidor filtra por identidad, no solo `--tools`.**

La lista para `--tools` y `--allowedTools` sale de `HerramientasMCPAgente.lista(o, a) = Permisos.herramientasMCP + Coordinador.herramientasMCP(o,a) + Acciones.herramientasMCP(o,a)`.

| Perfil | Herramientas (`mcp__hq__…`) |
|---|---|
| agente | `colegas`, `consultar` (+ `proponer_accion` si tiene herramientas de actuar) |
| coordinador | lo anterior + `estado_oficina`, `entregas`, `corridas`, `bloqueos`, `encargar` (máximo 3 por corrida) |
| creador | `ver_oficina`, `listar_conectores`, `proponer_departamento`, `proponer_agente`, `proponer_flujo`, `proponer_regla`, `proponer_conector`, `proponer_tarea`, `marcar_faltante`, `descartar_tarjeta` |

## Motor de flujos (§7, `MotorFlujos.swift`)
`actor MotorFlujos`, enganchado desde `Backend` (ganchos del programador y `alRevisar` de entregas).

1. **`iniciar(act, flujo, nombre, contexto)`**: inserta la corrida con la copia de la definición y avanza al paso 0.
2. **`avanzar(corrida, i, nota?)`**
   - Si `i == pasos.count`: la corrida pasa a `terminada` y se crea un aviso guardado `tipo:"flujo"` con «"Clase 7" terminó».
   - Si no, inserta `corrida_pasos` (intento = último + 1) en estado `pendiente`, con `despues = ahora + esperaDias` si corresponde, y llama a `lanzarPendientes`.
3. **`lanzarPendientes(oficina)`**: solo corre si es la oficina activa. Para cada paso `pendiente` con `despues` vencido:
   - de la persona: paso y corrida pasan a `esperando_persona`;
   - de un agente que existe: `programador.encargarLibre(id: flujo:c:p:i, consigna: FlujoTexto.consigna(...))`, y el paso pasa a `corriendo` con su `ejecucion`;
   - de un agente que no existe: el paso pasa a `error` («X ya no está en la oficina») y la corrida a `trabada`.
4. **`alEntregar(e, ej)`**
   - Si `ej` es un paso de flujo: se guarda `entrega = e.id` y se suma el costo. Con aprobación, paso y corrida pasan a `esperando_aprobacion`. Sin aprobación, el paso queda `listo` y se avanza.
   - Si `ej` es nil y `e.padre` es la entrega vigente de un paso: se actualiza `entrega = e.id` (versión con cambios) y sigue esperando.
5. **`revisada(e, act)`**: si `e.id` es la entrega **vigente** de un paso en `esperando_aprobacion`, el paso queda `listo` y se avanza. Si es una versión vieja, no pasa nada.
6. **`alTerminar(ej)`** con error de un paso: el paso pasa a `error` y la corrida a `trabada`. El aviso de error ya lo deja `Backend`, con el nombre «Paso de flujo».
7. **`barrer()`** cada 30 s, en un loop propio que arranca `preparar()`. No corre con `HQ_PROGRAMADOR=0`; los tests lo llaman a mano. Hace dos cosas:
   - llama a `lanzarPendientes` de la oficina activa;
   - **reconcilia** los pasos `corriendo`: si su ejecución terminó en error, los marca `error`; si ya hay una entrega con `ref` igual al id `flujo:…`, aplica `alEntregar`.
8. **Acciones de la persona** sobre la corrida: `hecho` (archivos opcionales en base64 → `archivos/entregables/persona/<corrida>-<paso>/`), `reintentar`, `saltar`, `cancelar` y `volver {paso, nota}`. `volver` reabre un paso anterior con un intento nuevo y la nota va en la consigna: es el «nueva toma vuelve a la persona» (K7), hecho a mano.

**Consigna de un paso** (`FlujoTexto.consigna`). Lleva:
- el flujo, la corrida y «paso N de M: <nombre>»;
- la consigna del paso, lo que recibe y el contexto de la corrida;
- por cada paso de `recibeDe` (o el anterior): el título, los archivos (rutas relativas, «leelos») y el texto recortado a 3000 caracteres, saneado con `ConsultasMCP.sanear` y marcado como información, no instrucción;
- lo que tiene que entregar, «dejá los archivos en `archivos/entregables/<id>/`», y la nota si el paso fue devuelto.

**Aviso calculado** en `avisosPendientes`: `Aviso(id:"flujo:<corrida>", tipo:"flujo", agente:"", texto:"«Clase 7» te necesita: Grabación", ref:"<corrida>")` para las corridas en `esperando_persona` con `vista = 0`. `avisosVistos("flujo:<id>")` pone `vista = 1`.

**`/api/actividad`** suma `corridas: [{id, nombre, flujo, paso, pasoNombre, quien, anterior, estado}]` con las corridas abiertas. El front anima la pieza cuando cambia `paso`.

## Acciones hacia afuera (§8, `Acciones.swift`)
1. `mcp__hq__proponer_accion {herramienta, resumen, detalle}` solo existe si el agente tiene alguna herramienta de **actuar** asignada, y `herramienta` tiene que estar entre ellas.
   - Crea una entrega `origen:"propuesta"`, con título «Propuesta: <resumen>» y texto = resumen + detalle legible.
   - Crea una fila `acciones` (`pendiente`) vinculada a esa entrega.
2. «Aprobar y ejecutar» llama a `POST /api/entregas/:id/ejecutar`.
   - Verifica que la acción esté `pendiente` y que la herramienta siga asignada como actuar.
   - Marca la entrega `revisada` y la acción `ejecutando`.
   - Lanza `encargarLibre(id: "accion:<id>", actuar: [herramienta], consigna: "<dueño> aprobó… ejecutá exactamente esto con <herramienta> y estos argumentos… no hagas nada más").
3. Al terminar: con `alEntregar` de `accion:` la acción pasa a `hecha` (resultado = texto); con `alTerminar` en error, a `error`.
4. `POST /api/entregas/:id/descartar-accion` deja la acción `descartada` y la entrega `revisada`.

## Conectores (§9, `Conectores.swift`)
- **Catálogo**: `CatalogoConectores.compartido` guarda en memoria la última detección `[ServidorConector{nombre, prefijo, estado, herramientas}]` y la fecha.
- **Detección**: `claude -p --model haiku --tools "" --permission-mode dontAsk --output-format stream-json --verbose -- "Respondé solo: ok"` con `MCP_CONNECTION_NONBLOCKING=false`. Del evento `system/init` se leen:
  - `mcp_servers` con `source=="claudeai"`;
  - `tools` que empiezan con `mcp__claude_ai_`, agrupadas por prefijo (`mcp__claude_ai_` + nombre sin «claude.ai » con espacios cambiados por `_`).

  Corre al pedirlo (`POST /api/conectores/actualizar`) y una sola vez en segundo plano con el primer `GET /api/conectores` (nunca al arrancar el backend, para no lanzar claude en los tests); mientras tanto el GET devuelve `detectando: true`. Los `needs-auth` se listan como no disponibles y no se pueden asignar.
- **Clasificación** `Conectores.clasificar(corto)`: devuelve `leer` si empieza con `list|get|search|read|find|fetch|download|query|lookup|suggest`; si no, `actuar`. Ante la duda, actuar. La persona puede mover una herramienta al asignarla.
- **Por agente**, `ConectoresAgente.herramientas(o, a, catalogo, actuar)`:
  - `permitidas` = todas las `leer` asignadas + (`actuar` pedido ∩ actuar asignadas).
  - Si `permitidas` queda vacía: `vedadas = ["mcp__claude_ai_*"]`.
  - Si no, `vedadas` = el prefijo de cada servidor del catálogo no asignado + el nombre exacto de cada herramienta de un servidor asignado que no esté en `permitidas`.
  - Sin catálogo: `vedadas = []`. Igual queda protegido por `dontAsk`.

## Coordinador y parte (§10, `Coordinador.swift` y `Parte.swift`)

### Parte determinista
`Parte.armar(servicios, act, desde) -> [String: Any]`:
```json
{ "desde": "ISO", "hasta": "ISO",
  "teNecesita": [Aviso.json…],
  "paraRevisar": { "total": 3, "entregas": [Entrega.json… máx 5] },
  "flujos": [{ "corrida": 4, "nombre": "Clase 7", "flujo": "clase", "flujoNombre": "…", "paso": 2,
               "pasoNombre": "Grabación", "quien": "persona", "estado": "esperando_persona",
               "desde": "ISO", "dias": 1.5 }],
  "paso": { "entregas": 5, "ejecucionesOk": 4, "ejecucionesError": 1, "reunionesCerradas": 1,
            "pasosTerminados": 3, "costo": 0.42 },
  "bloqueos": [{ "tipo": "corrida|entrega|tarea", "texto": "…", "ref": "4", "dias": 3.2 }],
  "proximas": [{ "tarea": "informe", "agente": "marce", "nombre": "Informe", "cuando": "ISO" }],
  "narrado": { "entrega": 12, "texto": "…" } }
```
- Si no viene `desde`, se usa `meta['parte:<carpeta>']` o, si no hay, las últimas 24 h.
- `Bloqueos.calcular(...)` es una función pura y se testea como `Programacion`. Marca:
  - corridas en `esperando_*` o `trabada` con más de `plazoDias` (default 2) desde `actualizada`;
  - entregas `sin_revisar` de más de 3 días;
  - tareas activas cuya última ejecución dio error.

### Coordinador
- Herramientas MCP (§6):
  - `estado_oficina` devuelve `Parte.armar` de las últimas 24 h;
  - `entregas {estado?, agente?, limite?}`;
  - `corridas {estado?}`;
  - `bloqueos`;
  - `encargar {agente, consigna, nombre?}` lanza `encargarLibre(id: coord:<8hex>)`, con un máximo de 3 por corrida.
- **Parte narrado**: `POST /api/parte/redactar` busca al primer coordinador y lanza `encargarLibre(id: parte:<fecha>)` con el JSON del parte en la consigna. Su entrega aparece como `narrado`.

## API nueva
Todas las rutas salen de routers «extra» que `Router.handle` prueba **antes** que los existentes (registro genérico de la ola 1).

| Ruta | Router | Qué hace |
|---|---|---|
| `GET /api/flujos` | Flujos | `{flujos:[FlujoDef + sinAsignar:[pasoId]]}` |
| `POST /api/flujos` | Flujos | crea `{nombre, descripcion?, pasos}` → `{flujo}` |
| `PATCH /api/flujos/:id` | Flujos | reemplaza campos → `{flujo}` |
| `DELETE /api/flujos/:id` | Flujos | borra la definición (las corridas vivas siguen) |
| `POST /api/flujos/:id/correr` | Flujos | `{nombre, contexto?}` → `{corrida}` |
| `GET /api/flujos/corridas?estado=abiertas\|terminadas\|todas&flujo=&entrega=&limite=` | Flujos | `{corridas:[…]}` |
| `GET /api/flujos/corridas/:id` | Flujos | `{corrida, pasos:[{indice, def, sinAsignar, intentos:[PasoCorrida.json + entrega:{id,titulo,estado}]}]}` |
| `POST /api/flujos/corridas/:id/hecho` | Flujos | `{nota?, archivos?:[{nombre, base64}]}` |
| `POST /api/flujos/corridas/:id/reintentar\|saltar\|cancelar` | Flujos | `{corrida}` |
| `POST /api/flujos/corridas/:id/volver` | Flujos | `{paso, nota?}` |
| `GET /api/reglas` · `PUT /api/reglas` | Gobierno | `{reglas:[{id?, texto, origen?}]}` (PUT reemplaza todas) |
| `GET /api/conectores` | Gobierno | `{detectado, servidores:[{nombre, prefijo, estado, disponible, herramientas:[{nombre, corto, tipo}]}]}` |
| `POST /api/conectores/actualizar` | Gobierno | detecta de nuevo y devuelve lo mismo |
| `GET /api/acciones?entrega=` · `?estado=` | Gobierno | `{accion}` · `{acciones}` |
| `POST /api/entregas/:id/ejecutar` | Gobierno | `{ejecucion}`; 409 si no hay acción pendiente |
| `POST /api/entregas/:id/descartar-accion` | Gobierno | `{accion}` |
| `GET /api/parte?desde=<epoch>` | Parte | el JSON de §10 |
| `POST /api/parte/visto` | Parte | `{ok}` |
| `POST /api/parte/redactar` | Parte | `{ejecucion}`; 409 si no hay coordinador |
| `POST /api/creador/chat` | Creador | `{message, session}` → **202** `{ok, session}` (corre en segundo plano) |
| `GET /api/creador/estado?session=` | Creador | `{corriendo, mensajes:[{rol, texto, ts}], version}` |
| `GET /api/creador/borrador` | Creador | `{version, tarjetas:[…], resumen:{borrador, lista, creada, error}}` |
| `PATCH /api/creador/tarjetas/:id` | Creador | `{datos}` → revalida → `{tarjeta}` |
| `DELETE /api/creador/tarjetas/:id` | Creador | la descarta |
| `POST /api/creador/aplicar` | Creador | `{ids, confirmarQuitar?}` → `{resultados:[{id, ok, creadaId?, error?}], oficina}` |

Además:
- `PATCH /api/agentes/:id` y `POST /api/agentes` aceptan `limites`, `conectores` y `permisos`.
- `PATCH /api/departamentos/:id` acepta `mision`.
- `POST /api/entregas/:id/revisada` devuelve 409 si la entrega está en `cambios`.
- `/api/actividad` suma `corridas` y `creadorVersion`.

## El Creador (§11, `Creador.swift` y `CreadorRouter.swift`)
- **No está en `oficina.agentes`.** Antes de cada corrida se regenera `.claude/agents/creador.md` desde `Plantillas.creadorMD(oficina:)` (modelo sonnet). Corre con:
  - `herramientasBase "Read,Glob,Grep"`, `escritura []` y `vedadas ["mcp__claude_ai_*"]`;
  - `herramientasMCP = Creador.nombresMCP` y un token de perfil `creador`;
  - el carril `(oficina, "creador")`;
  - sesión en las tablas de mensajes con `agente = "creador"`.
- **Un solo mecanismo:** el primer mensaje puede ser el texto entero o una frase. El chat corre en segundo plano (el modo dev corta a los 120 s) y el front sondea `estado` y `borrador`.
- **Prompt** (en `Plantillas`):
  - proponés y nunca creás: crear lo hace la persona con un botón;
  - antes de proponer cambios mirás `ver_oficina`, y si algo ya existe proponés `modificar` con `objetivo`;
  - una tarjeta por cosa; si algo se repite, va en un solo lugar (por ejemplo, una regla) y las demás no lo duplican;
  - todo lo que no dice el texto queda como faltante con una pregunta (`marcar_faltante`), nunca como un valor inventado;
  - `origen` es una cita **textual** de lo que dijo la persona;
  - al final de cada respuesta, máximo 3 preguntas, las más importantes primero;
  - las referencias a tarjetas se escriben `"tarjeta:<id>"`.
- **Herramientas `proponer_*`**:
  - argumentos comunes: `{accion: crear|modificar|quitar, objetivo?, ref? (id de tarjeta a actualizar), origen, datos}`;
  - el backend valida, calcula `faltantes:[{campo, pregunta}]` y el estado (`borrador` si falta algo, si no `lista`), guarda, sube `VersionCreador` y devuelve la tarjeta en JSON con sus faltantes.

  **Anti-invento:** `origen` normalizado (`ConsultasMCP.normalizar`) tiene que aparecer en los mensajes `u` de la sesión. Si no, `isError` con «citá textual lo que dijo la persona». El cupo es de 80 escrituras por mensaje.

  `datos` por tipo (con * los obligatorios; si falta uno, la tarjeta queda en borrador):

  | Tipo | `datos` |
  |---|---|
  | departamento | `{id?, nombre*, mision?, color?}` |
  | agente | `{id?, nombre*, rol*, departamento* (id o tarjeta:x), prompt*, description?, modelo?, chips?, limites?, conectores?, permisos?}` |
  | flujo | `{id?, nombre*, descripcion?, pasos*:[{id?, nombre*, quien* (id, tarjeta:x o persona), consigna?, recibe?, recibeDe?, entrega*, aprobacion* (tiene que venir explícita), plazoDias?, esperaDias?}]}` |
  | regla | `{id?, texto*}` |
  | conector | `{agente* (id o tarjeta:x), servidor*, leer?, actuar?}` |
  | tarea | `{agente*, nombre*, consigna*, dias*, hora*, zona?}` |

  - Un conector que no está disponible en el catálogo queda en borrador con «Conectá X en claude.ai».
  - Una periodicidad mensual o trimestral queda en borrador con su pregunta: está fuera de alcance (K13).
  - Las referencias (`departamento`, `quien`, `agente`) tienen que existir en la oficina o en una tarjeta no descartada del tipo correcto; si no, son faltantes.
- **Aplicar** (solo con el botón):
  1. Si alguna tarjeta está en `borrador`, 409 con sus faltantes.
  2. Se ordenan por tipo: departamento → agente → regla → conector → flujo → tarea.
  3. Se resuelven las referencias `tarjeta:x` con el `creada_id` de las ya creadas (o creadas en esta misma tanda).
  4. Se crean con lo que ya existe: `crearDepartamento` / `editarDepartamento` + `modificar` para la misión; `contratar` / `editarAgente`; `modificar` para reglas, conectores (en `agente.conectores`), flujos y tareas (validando con `ValidarTareas`).
  5. `quitar` exige `confirmarQuitar: true` y usa `despedir` / `borrarDepartamento`.
  6. Por cada tarjeta se guarda `creada` + `creada_id`, o `error` con el mensaje. Si una tarjeta falla, se sigue con las que no dependen de ella; no hay rollback global.
- **Diferencias:** la tarjeta `modificar` guarda `objetivo` y el front muestra «Antes → Ahora» con los datos actuales de `oficina.json`.

## Front (§12)
- **Módulos nuevos:**
  - `ui/parte.js` (`App.Parte`, panel derecho `parte`, se abre una vez por sesión al montar);
  - `ui/flujos.js` + `ui/flujos.css` (`App.Flujos = {abrir, verCorrida(id), alCerrarPanel}`, panel derecho `flujos`, con hoja de editor de definiciones y hoja «Nueva corrida»);
  - `ui/creador.js` + `ui/creador.css` (`App.Creador = {abrir}`, hoja de 1100 px con el chat a la izquierda y el borrador a la derecha);
  - `ui/ajustes.js` (`App.Ajustes = {reglas(), conectores()}`, hojas).
- **Cambios:**
  - `agente.js`: pestaña «Permisos» con límites, conectores leer/actuar y el check de coordinador;
  - `entregables.js`: insignia «Flujo · paso» y el bloque de acción con «Aprobar y ejecutar»;
  - `avisos.js`: tipo `flujo`;
  - `app.js`: nav «Parte» y «Flujos», botón «Armar con el Creador», ramas de `cerrarDerecho`, tercera opción en `inicio()` y lugares 3D `creador` y `flujos`;
  - `deptos.js`: misión;
  - `paleta.js`: entradas nuevas;
  - `base.js`: íconos `flujo`, `regla`, `enchufe`, `escudo` y `parte`, y `App.hace`;
  - `index.html`: los `<script>` y `<link>` nuevos;
  - `oficina3d.js`: `pieza(desdeId|null, haciaId|null)` (null = recepción) y el lugar clicable `creador` en el mostrador de la recepción.
- Textos en rioplatense, con voseo, cortos. Los botones dicen la acción concreta («Crear las 4 listas», «Mandar el mail», «Listo, seguí»).

## Cómo se cubre el caso de prueba (ver `docs/caso-prospera/mapeo-esperado.md`)

| Parte del mapeo | Cómo se cubre |
|---|---|
| §1 Departamentos (5 cambian o son nuevos, `video` no se toca) | tarjetas `departamento` crear/modificar con `mision`. D1 queda en borrador por la misión que falta |
| §2 Agentes (11 tarjetas, 5 cambian y 6 nuevos) | tarjetas `agente` crear/modificar con `limites`, `conectores` y `permisos:["coordinador"]` (Betty, A1). Los no mencionados no se tocan (`quitar` exige confirmación) |
| §3 Reglas (6) | tarjetas `regla` → `oficina.reglas`, inyectadas por §4. La R6 también aparece en los `limites.proponer` de los agentes que publican o invierten |
| §4 Flujos F1–F3 | tarjetas `flujo` con pasos de `persona` y `aprobacion`. F1 paso 4: dos pasos del mismo agente (plan con aprobación + render con aprobación, K6). `recibeDe` cubre K5. `esperaDias` cubre la medición de F2/F3 (K8). F3 paso 0 = paso de la persona que sube los datos. «Nueva toma» = `volver` a mano (K7) |
| §5 Tareas recurrentes (11) | tarjetas `tarea`. Las semanales quedan `lista`; las mensuales y trimestrales quedan en borrador con pregunta (K13 fuera de alcance) |
| §6 Conectores | Calendar disponible → `conector` lista. Notion, Instagram, Meta Ads y Skool → borrador «Conectá X en claude.ai» o «no hay conector» |
| §7 y §8 Huecos y preguntas | faltantes de cada tarjeta + preguntas del Creador al final de cada respuesta |
| §9 Conceptos | K1 (`mision`), K3, K4, K5, K6, K8, K11, K14 y K15 entran. K2 va en el prompt. K19 y K20 son texto del prompt o de los límites. K9, K12, K13, K16, K18 y K4-parcial quedan fuera de alcance |

Test de aceptación (ola 3): se simulan las llamadas `proponer_*` del caso (un subconjunto representativo) contra una oficina importada de Próspera. Se comprueba que los estados de las tarjetas coinciden con el mapeo, y que aplicar las listas deja un `oficina.json` válido con los flujos, las reglas y el coordinador.

## Fuera de alcance
- Tareas mensuales y trimestrales (K13); un paso que abre varias corridas (K4 parcial: se hace una corrida por pieza).
- Documentos vivos a cargo de un agente (K9), skills por agente (K12), herramientas locales como ffmpeg o pptx (K16), fusionar o dividir agentes (K18).
- «Pedir cambios» que vuelve sola a otro paso: se hace a mano con `volver`.
- Avanzar corridas de una oficina que no está abierta: esperan a que se abra.
- Animar con exactitud la pieza por los pasillos: alcanza con que vaya de un escritorio al otro.
- Paridad con Python: los `tools/hq_*.py` ya no existen.

## Olas de implementación
1. **Cimientos:** el modelo (§1), las tablas (§2), el comando (§3) y el cableado (§5, §6, los routers extra y los stubs de los módulos de la ola 2). Cada stub compila y no hace nada.
2. **Módulos:** el motor y la API de flujos (§7); el Creador (§11); el gobierno, que agrupa reglas, límites, conectores, instrucciones y acciones (§4, §8, §9); el coordinador y el parte (§10).
3. **Front e integración:** el front de la oficina (parte, permisos, ajustes, entregables, avisos y app); el front de flujos con el 3D; el front del Creador; la integración del backend con el caso de prueba y la verificación con el claude real.

## Verificación
- Toda instancia: `cd app && swift build` y `app/Tests/run-tests.sh` en verde. Los tests usan el claude falso de `TestSupport.swift` y nunca el real.
- Front: `cd app && HQ_OFICINAS_DIR=<scratch> swift run oficina-dev` en http://localhost:8765, con una oficina de prueba.
- A mano, con el claude real y haiku, en la ola 3, anotando en `aprendizajes.md`:
  1. que `--append-system-prompt` llega con `--agent`;
  2. que `dontAsk` deja correr Read, Glob, Grep y Skill;
  3. que un agente sin conectores no ve `mcp__claude_ai_*`;
  4. que un agente con Calendar en leer puede `list_events` y no `create_event`;
  5. que una acción aprobada corre con esa sola herramienta: **solo se verifica con los tests (claude falso), mirando los argumentos del comando**. Con el claude real no se ejecuta ninguna herramienta que cree, modifique, borre o mande algo en la cuenta del usuario, ni siquiera un borrador. Esa prueba la hace la persona a mano.
- Recorrido completo en dev:
  1. pegar el texto de Juli en el Creador;
  2. aplicar las listas;
  3. arrancar «Clase 7»;
  4. aprobar, pedir cambios y aprobar;
  5. hacer el paso de la persona subiendo un archivo;
  6. ver el parte al reabrir.
