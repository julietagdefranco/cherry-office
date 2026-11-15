# Plan: dependencias entre agentes (pedir, esperar, relanzar)

## Contexto
Caso real: Marce recibió un encargo que dependía del Arquitecto. Lo consultó con `consultar` (`backend/src/consultas.ts`). El Arquitecto contestó «todavía no tengo el mapeo ni la prueba». Marce entregó una v1 con columnas «pendiente» y escribió «cuando deje su archivo, hago la versión 2». **Nada en la oficina hace que eso pase.**

Lo que ya existe y se reusa:
- consultas de un salto (`ConsultasMCP.consultar`);
- encargos (`Programador.encargarLibre`, ids `encargo:`/`coord:`/`flujo:`…) con su entrega, carril, costo y token MCP por corrida;
- «pedir cambios», que retoma la sesión y encadena con `padre` (`Programador.pedirCambios`/`correrCambios`);
- pendientes de reunión y «Hacelo ahora» (`ReunionesRouter.encargar`, `estadoPendientes`);
- bloqueos del parte (`Bloqueos.calcular`, `Parte.bloqueos`), que también lee el coordinador;
- avisos calculados (`s.avisos.fuentes`);
- flujos con `recibeDe` (`modelo-flujos.ts`, `motor-flujos.ts`) y el editor de flujos (`oficina/ui/flujos.js`).

Objetivo: cerrar el ciclo **consulta → pedido → v1 parcial + espera → el otro entrega → v2 automática**. El mismo mecanismo de esperas se reusa para las dependencias entre pendientes de una reunión, y una cadena que se repite se puede pasar a flujo.

**Paridad:** no hay backend paralelo que mantener. La app Swift (`app/Sources/Backend`) se borró en `b18c163`: la carpeta `app/` que queda está vacía y sin trackear. Los `tools/hq_*.py` tampoco existen ya. Todo se hace en `backend/` (TS) y `oficina/ui/` (front, el mismo en Electron y en dev). `desktop/` no cambia: las notificaciones de entregas nuevas ya salen por `canal 'aviso'`.

## Conceptos
- **Pedido**: un agente (A) le pide a otro (B) algo que todavía no existe. Se crea un encargo de B con id de tarea `pedido:<n>`, que corre enseguida. Lo que B entrega es una entrega normal para la persona, con origen `pedido`.
- **Espera**: A avisa que entregó (o va a entregar) una versión parcial porque le falta algo de B. Queda persistida en SQLite. **Siempre está atada a una ref de entrega concreta**: `pedido:<n>` o `encargo:<reunión>:<m>`. Así no hace falta un LLM para decidir si «llegó».
- **Grupo de esperas**: las esperas abiertas de una misma corrida (mismo agente + misma `sid`) o de un mismo pendiente de reunión. El relanzamiento sale cuando **todas** las del grupo están listas.
- **Relanzamiento**:
  - Esperas `continuar` (de MCP): se retoma la conversación de la v1 (`--resume`) con lo nuevo como material. La entrega nueva tiene origen `espera`, `padre = v1` y ref `espera:<id>`.
  - Esperas `encargar` (de reunión): se lanza el encargo del pendiente dependiente, con el material de sus dependencias.
- **Estados de una espera**:
  - `esperando`: nada llegó todavía;
  - `lista`: llegó lo esperado y falta relanzar;
  - `relanzada`: la v2 está corriendo;
  - `hecha`: la v2 se entregó;
  - `fallida`: la v2 falló;
  - `cancelada`.

  «Vencida» no es un estado: es `esperando` con más de `plazo_dias` desde `creada`. Se calcula al leer.

## Decisiones de diseño
1. **Dos herramientas MCP separadas, `pedir` y `quedo_esperando`**, en lugar de extender `consultar`. La consulta sigue siendo de solo lectura, barata y de un salto. Si no hay un pedido abierto de A a B, `quedo_esperando` lo crea solo: ninguna espera queda colgada de nada.
2. **Qué satisface una espera (determinístico):** una entrega `E` satisface la espera `X` si cumple todo esto:
   - la ref de la raíz de `E` (se sube por `padre`, hasta 10 niveles) es igual a `X.ref`;
   - `E.agente` es `X.espera_a`, salvo cuando `espera_a = 'persona'`;
   - `E` no es parcial.

   `E` es parcial cuando hay una espera abierta de `E.agente` con `sid = E.sid` y `entrega_parcial = E.id`. En ese caso hay que esperar la v2 de B, que tiene `padre = E` y por lo tanto la misma raíz.

   Si B entregó por otro lado (por ejemplo, en un chat), la persona puede vincular a mano: `POST /api/esperas/:id/resolver {entrega}`.
3. **La v1 se vincula por `sid`.** Cuando se llama a `quedo_esperando`, la v1 todavía no existe: la entrega se crea al final de la corrida. Al registrarse una entrega de A con `sid = S`, las esperas abiertas de (A, S) sin `entrega_parcial` la toman como v1.
4. **El gancho es central: `Entregas.registrar`** (`backend/src/entregas.ts`), no `Programador.alEntregar`. Las entregas de chat (`rutas-chat.ts`) y las de reuniones no pasan por el programador, y la v1 puede venir de un chat.
5. **La v2 retoma la sesión de la v1.** Se generaliza `correrCambios` a `retomar`, con origen `espera`. Así el agente recuerda lo que hizo, la v2 reemplaza a la v1 en la bandeja y en un paso de flujo que espera aprobación (`MotorFlujos.alEntregar` con `ej` undefined ya lo resuelve), y la cadena de versiones queda armada con `padre`. Si no hay v1 ni `sid`, se lanza un encargo nuevo `espera:<id>`.
6. **Relanzamiento automático, con topes** (decisión del usuario):
   - hasta 2 rondas por cadena (v2, v3);
   - hasta 2 pedidos por corrida;
   - un solo pedido abierto por par A→B: se deduplica;
   - hasta 10 pedidos abiertos por oficina y 20 por día (`HQ_MAX_PEDIDOS_DIA`);
   - profundidad de pedidos de hasta 2 (A→B→C);
   - sin ciclos.
7. **Solo corre en la oficina activa**, como el programador y el motor. Lo que queda `lista` en otra oficina se relanza al abrirla (`s.alAbrir`) o en el barrido.
8. **Dependencias de reunión en la síntesis:** `depende_de` va con números 1-based en el prompt y se guarda 0-based dentro del JSON de la síntesis. Se descartan los autoreferentes, los fuera de rango y los ciclos al parsear. No hace falta migración porque la síntesis ya es JSON en texto.
9. **Pasar a flujo, alcance mínimo:** un endpoint arma un **borrador** determinístico de `FlujoDef`, sin LLM y sin guardar nada. El front abre el editor de flujos ya cargado y la persona guarda con el `POST /api/flujos` que ya existe. Pulirlo con el Creador queda para después.

## Fase D0: infraestructura (sin cambios de comportamiento)
**Entregas** (`backend/src/entregas.ts`)
- `Entregas` suma `readonly alRegistrar: ((e: Entrega) => void)[] = []`. `registrar()` los llama después de `crear` y de `avisos.emitir`, cada uno en `try/catch`. Tienen que ser síncronos: el trabajo lento se dispara con `void promesa`.
- Métodos nuevos:
  - `porRef(oficina, ref)`: la más nueva;
  - `hijas(oficina, id)`;
  - `raiz(oficina, e)`: sube por `padre`, máximo 10;
  - `vigente(oficina, e)`: la última descendiente, por si la persona ya pidió cambios sobre la v1.
- Índice nuevo en el constructor: `CREATE INDEX IF NOT EXISTS entregas_ref ON entregas(oficina, ref)`.

**Programador** (`backend/src/programador.ts`)
- `static readonly prefijoPedido = 'pedido:'` y `prefijoEspera = 'espera:'`.
- `origenEntrega`: `pedido:` → `'pedido'`, `espera:` → `'espera'`.
- `nombreCorrida`: `pedido:` → «Pedido de un colega», `espera:` → «Versión completa».
- `Ejecuciones.porSid(sid)`, con `CREATE INDEX IF NOT EXISTS ejecuciones_sid ON ejecuciones(sid)` en `preparar()`.
- Refactor: `correrCambios` pasa a ser `retomar(act, def, e: Entrega | undefined, p)`, con `p` = `{sid, pedido, origen, actividad, titulo, ref, clave}`. Devuelve `Promise<{entrega?: Entrega; error?: string}>`.
  - `pedirCambios` sigue igual hacia afuera: llama a `retomar` con origen `cambios`, `ref = sid` y clave `cambios:<id>`.
  - `retomar` registra la entrega con `padre = e?.id`. Solo con origen `cambios` pasa la anterior a `cambios`. Con origen `espera`, la anterior pasa a `cambios` solo si estaba `sin_revisar`; si ya estaba `revisada`, queda así.
  - Llama a `ganchosEntregar(nueva, undefined)` igual que hoy.
  - Si falla, crea el aviso `error` con el texto que corresponda al origen.
- `encargarLibre` ya alcanza para los pedidos y para los encargos de pendientes.

**Tests:** la suite actual tiene que seguir en verde (`pedirCambios` no cambia).

## Fase D1: modelo de datos (`backend/src/dependencias.ts`, módulo nuevo)
`registrarModulo('dependencias', 75, instalar)`. Va después de coordinador (74), así que ya están programador, entregas, reuniones, flujos y parte. Las tablas se crean en `instalar` con `CREATE TABLE IF NOT EXISTS`, como `consultas`. No hay `ALTER`.

```sql
CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oficina TEXT NOT NULL,
    de TEXT NOT NULL,                 -- agente que pide
    a TEXT NOT NULL,                  -- agente al que se le pide
    que TEXT NOT NULL,                -- ≤ 2000
    contexto TEXT NOT NULL DEFAULT '',-- ≤ 4000
    sid TEXT NOT NULL DEFAULT '',     -- conversación/corrida desde la que se pidió
    ejecucion INTEGER,                -- corrida `pedido:<id>` de `a`
    entrega INTEGER,                  -- entrega (completa) de `a` que lo cumplió
    estado TEXT NOT NULL,             -- corriendo | entregado | fallido | cancelado
    cadena INTEGER NOT NULL,          -- id del pedido raíz (= id si es raíz)
    profundidad INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    creado REAL NOT NULL,
    actualizado REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pedidos_oficina ON pedidos(oficina, estado, id);

CREATE TABLE IF NOT EXISTS esperas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oficina TEXT NOT NULL,
    agente TEXT NOT NULL,             -- quien espera
    espera_a TEXT NOT NULL,           -- id de agente | 'persona'
    que TEXT NOT NULL,                -- ≤ 500
    ref TEXT NOT NULL,                -- ref (raíz) de la entrega que la satisface: 'pedido:<n>' | 'encargo:<reu>:<m>'
    pedido INTEGER,
    grupo TEXT NOT NULL,              -- 'sid:<sid>' (mcp) | 'reunion:<id>:<n>'
    accion TEXT NOT NULL,             -- continuar | encargar
    sid TEXT NOT NULL DEFAULT '',
    entrega_parcial INTEGER,          -- v1
    entrega_llegada INTEGER,          -- lo que entregó el esperado
    entrega_nueva INTEGER,            -- v2 / la del pendiente que arrancó
    tarea TEXT, nombre TEXT, consigna TEXT,  -- solo accion=encargar (id de tarea, nombre y consigna base)
    estado TEXT NOT NULL,             -- esperando | lista | relanzada | hecha | fallida | cancelada
    ronda INTEGER NOT NULL DEFAULT 1,
    plazo_dias REAL NOT NULL DEFAULT 2,
    origen TEXT NOT NULL,             -- mcp | reunion
    reunion TEXT, pendiente INTEGER,
    motivo TEXT,                      -- por qué se canceló / falló
    vista INTEGER,                    -- aviso de vencida ya visto
    creada REAL NOT NULL,
    actualizada REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS esperas_oficina ON esperas(oficina, estado, id);
CREATE INDEX IF NOT EXISTS esperas_ref ON esperas(oficina, ref, estado);
CREATE INDEX IF NOT EXISTS esperas_grupo ON esperas(oficina, grupo, estado);
```

- `PedidosStore` y `EsperasStore` siguen el mismo patrón que `CorridasStore`: `deFila`, `una`, `lista(filtros)` y `actualizar`.
- Tomar el grupo es atómico: `UPDATE esperas SET estado='relanzada' … WHERE oficina=? AND grupo=? AND estado='lista'`. Si cambian 0 filas, otro ya lo tomó.
- `esperaJSON(x, oficina)`:
  ```
  {id, agente, agenteNombre, esperaA, esperaANombre, que, estado, accion, ref,
   pedido: {id, estado, entrega}|null, entregaParcial, entregaLlegada, entregaNueva,
   plazoDias, ronda, origen, reunion?, pendiente?, motivo?, creada (ISO), actualizada (ISO),
   vencida, dias}
  ```
- Accesor: `export const dependenciasDe = (s) => s.huecos.dependencias as Dependencias | undefined`.
- Las esperas y los pedidos no viajan en el `.oficina.zip`: viven en `hq.db`, como entregas y avisos. Hay que sumarlo a «Qué no viaja» en `API.md`.

## Fase D2: herramienta MCP `pedir` (pieza 1)
Hay una fábrica `herramientasDependencias(s, token, ident)` registrada con `mcpDe(s)?.registrarHerramientas(...)`. Devuelve undefined si `ident.perfil === 'creador'`. La clase `HerramientasDependencias` implementa `MCPHerramientas`, como `HerramientasCoordinador`.

**Permisos** (`backend/src/permisos.ts`)
- Se suma `export const Dependencias = { nombresMCP: ['pedir', 'quedo_esperando', 'cancelar_espera'] }`.
- En `HerramientasMCPAgente.lista` se agregan después de `herramientasMCP`, para todo agente: van en `--tools` y en `--allowedTools`.
- Las consultas (`turnoSoloLectura`) siguen sin `--mcp-config`: el consultado no puede pedir nada.

**Schema**
```js
{ name: 'pedir',
  description: 'Le pide a un colega algo que necesitás y todavía no existe (por ejemplo, si al consultarlo te dijo que no lo tiene). Le crea un encargo que corre enseguida; lo que entregue le llega a la persona y, si quedás esperando (quedo_esperando), también vuelve a vos. Máximo 2 pedidos por corrida.',
  inputSchema: { type: 'object', properties: {
    colega:   { type: 'string', description: 'id o nombre del colega (ver colegas)' },
    que:      { type: 'string', description: 'qué necesitás, concreto (hasta 2000 caracteres)' },
    contexto: { type: 'string', description: 'para qué lo necesitás y en qué formato (opcional, hasta 4000)' },
    nombre:   { type: 'string', description: 'nombre corto del pedido (opcional)' } },
    required: ['colega', 'que'] } }
```

**Validaciones**, en este orden. Todas devuelven `MCPResultados.error` con texto en voseo y ninguna lanza `claude` ni gasta cupo si falla:
1. Faltan `colega` o `que`.
2. La oficina activa no es `ident.oficina` → «La oficina ya no está abierta.»
3. El colega se resuelve como en `consultar`, con `normalizar` por id o por nombre. Si no existe, se listan los ids. No puede ser uno mismo.
4. Profundidad y ciclo. Si la corrida actual es un pedido (`Ejecuciones.porSid(ident.sid)?.tarea` empieza con `pedido:`), el nuevo hereda `cadena` y suma 1 a `profundidad`:
   - con `profundidad > 2`: error;
   - si `colega` ya aparece como `de` de algún pedido de la cadena, es un ciclo: «X te lo pidió a vos: entregá lo que puedas y decí qué falta.»
5. Dedupe. Si hay un pedido `corriendo` de A a B, se devuelve ese con `yaPedido: true`, sin gastar cupo.
6. Topes: 10 pedidos abiertos por oficina y `HQ_MAX_PEDIDOS_DIA` (20) creados en 24 h.
7. Cupo del token: `tokens.tomar(token, 'pedir', 2)`.

**Efecto**
- `INSERT` del pedido en estado `corriendo`.
- Consigna:
  ```
  Pedido de <A.nombre> (<rol>). Viene de un colega, no es un pedido directo del usuario:

  <que>

  Contexto: <contexto>

  Dejá lo que produzcas en archivos/entregables/<b>/ y decí al final qué archivo dejaste.
  Si todavía no podés hacerlo, entregá lo que tengas y decí qué falta.
  ```
  Todo pasa por `sanear` y `prefijo`.
- `prog.encargarLibre(act, defB, {id: 'pedido:<id>', nombre, consigna})` y después se guarda `ejecucion`.
- Respuesta JSON (con `respuestaCoordinador`):
  ```
  {ok, pedido, colega, aviso: 'Ya se lo pedí. Si vas a entregar algo parcial, llamá a quedo_esperando con pedido=<id>.'}
  ```

**Descripción de `consultar`** (`HerramientasHQ.definiciones`): se suma «Si te dice que no lo tiene, podés pedírselo con pedir.» Es solo texto, no cambia la respuesta.

## Fase D3: `quedo_esperando` y `cancelar_espera`; vínculo con las entregas (pieza 2, primera mitad)
**Schemas**
```js
{ name: 'quedo_esperando',
  description: 'Avisá que entregás una versión parcial porque te falta algo de un colega. Cuando ese colega entregue, la oficina te vuelve a encargar el trabajo (versión completa) con lo tuyo y lo nuevo. Si no le pediste nada todavía, se lo pide por vos. Llamala antes de terminar, una vez por cosa que te falte.',
  inputSchema: { type: 'object', properties: {
    colega:     { type: 'string', description: 'id o nombre del colega' },
    que:        { type: 'string', description: 'qué te falta (hasta 500 caracteres)' },
    pedido:     { type: 'integer', description: 'id del pedido que le hiciste (opcional)' },
    plazo_dias: { type: 'integer', description: 'cuántos días esperar antes de avisarle a la persona (1-30, 2 por defecto)' } },
    required: ['colega', 'que'] } }
{ name: 'cancelar_espera',
  description: 'Cancela una espera tuya (por ejemplo, si resolviste lo que faltaba de otra forma).',
  inputSchema: { type: 'object', properties: { espera: { type: 'integer' }, motivo: { type: 'string' } }, required: ['espera'] } }
```

**Validaciones de `quedo_esperando`**
- Colega y oficina, igual que en `pedir`. `plazo_dias` es un entero entre 1 y 30.
- `pedido`, si viene, tiene que ser de esta oficina, con `de = yo`, `a = colega` y estado distinto de `cancelado`. Si no viene, se usa el último `corriendo` de A a B. Si no hay ninguno, se llama a la lógica de `pedir` con `que`: aplican los mismos topes y el mismo cupo.
- Antideadlock: un DFS sobre las esperas abiertas de la oficina (arista agente → `espera_a`). Si B ya espera, directa o transitivamente, a A, da error: «B ya te está esperando a vos: entregá lo que tengas sin esperar.»
- Ronda:
  - si en la misma `sid` hay una espera cerrada de A (`hecha`, `relanzada` o `fallida`), o la corrida es `espera:<id>`, entonces `ronda = anterior + 1`;
  - con `ronda > 2`: «Ya van dos versiones esperando a B: entregá lo que tengas y contale a la persona qué falta.»
- Hasta 5 esperas abiertas por agente y cupo de 3 por token (`tokens.tomar(token, 'esperar', 3)`).

**Efecto**
- `INSERT` con estos valores:
  - `accion = 'continuar'`, `origen = 'mcp'`;
  - `grupo = 'sid:' + ident.sid`, `sid = ident.sid`;
  - `ref = 'pedido:<n>'`;
  - `estado = 'esperando'`, o `'lista'` si el pedido ya está `entregado`, con `entrega_llegada = pedido.entrega`.
- Responde `{ok, espera, pedido, aviso: 'Entregá tu versión parcial marcando lo que falta; cuando B entregue, te la vuelvo a encargar.'}`.

**Gancho al registrar entregas**: `Dependencias.alRegistrarEntrega(e)`, que se agrega en `instalar` a `s.entregas.alRegistrar`. Es síncrono y hace esto en orden:
1. **Vincula la v1.** Si `e.sid !== ''`: `UPDATE esperas SET entrega_parcial=e.id WHERE oficina=e.oficina AND agente=e.agente AND sid=e.sid AND estado IN ('esperando','lista') AND entrega_parcial IS NULL`.
2. **Cumple pedidos.** Con `r = raiz(e).ref`: si empieza con `pedido:`, la entrega no es parcial y el pedido está `corriendo`, el pedido pasa a `entregado` y guarda `entrega`.
3. **Satisface esperas.** Las esperas `esperando` con `ref = r` (y `espera_a = e.agente`, o `'persona'` si `e.origen === 'persona'`) pasan a `lista` con `entrega_llegada = e.id`, si `e` no es parcial (definición en «Decisiones de diseño», punto 2).
4. **Cierra la v2.** Si `e.origen === 'espera'` y `e.ref = 'espera:<id>'`: las esperas `relanzada` de ese grupo pasan a `hecha` con `entrega_nueva`. Si `e.ref` es `encargo:<reu>:<n>` y hay esperas `relanzada` con `tarea = e.ref`, también pasan a `hecha`.
5. Al final, `void this.procesarListas(e.oficina)`.

**Gancho al terminar corridas**: `prog.alTerminar(ej)`.
- Si `ej.tarea` empieza con `pedido:` y `ej.estado === 'error'`, el pedido pasa a `fallido` con `error`. Las esperas siguen `esperando`; el aviso `error` ya lo crea el programador.
- Si `ej.tarea` empieza con `espera:` o es la `tarea` de una espera `relanzada` y terminó con error, las esperas pasan a `fallida` con `motivo`.

## Fase D4: relanzamiento y barrido (pieza 2, segunda mitad)
**`procesarListas(oficina)`**
- Sale si `s.oficinas.activa()?.carpeta !== oficina`, porque queda para `alAbrir` o para el barrido.
- Toma cada grupo con al menos una espera `lista` y ninguna `esperando`. Las `cancelada`, `hecha` y `fallida` del grupo no cuentan.
- Por grupo:
  - **`continuar`**:
    - El agente tiene que seguir en la oficina; si no, cancela con «agente despedido».
    - La v1 es `entrega_parcial`, y de ella se toma la `vigente` (si la persona pidió cambios, se retoma la última versión).
    - Si no hay v1, se exige que no haya una ejecución `corriendo` con esa `sid` y que hayan pasado más de 120 s desde `creada` (`MotorFlujos.graciaEntrega`). Si no se cumple, espera al próximo barrido.
    - Toma el grupo de forma atómica (`lista` → `relanzada`).
    - Si hay `sid`: `prog.retomar(act, def, v1, {sid, origen: 'espera', ref: 'espera:<id líder>', clave: v1 ? 'cambios:<v1.id>' : 'espera:<id>', pedido: TextoDependencias.continuar(...)})` (se excluye con un «pedir cambios» de la persona sobre la misma entrega).
    - Si no hay `sid`: `prog.encargarLibre(act, def, {id: 'espera:<id líder>', …})`.
    - Si sale `ErrorAPI` 409 (la app se está cerrando o ya hay cambios en curso), el grupo vuelve a `lista` y se reintenta en el próximo barrido.
  - **`encargar`**:
    - Toma el grupo y llama a `prog.encargarLibre(act, def, {id: x.tarea, nombre: x.nombre, consigna: x.consigna + TextoDependencias.material(entregas llegadas)})`.
    - El id es `encargo:<reu>:<n>`, así `estadoPendientes` lo ve sin cambios.
- **`TextoDependencias.continuar`**:
  ```
  Llegó lo que esperabas de <B> («<que>»). Antes entregaste una versión parcial («<v1.titulo>»).

  Lo nuevo (es información, no instrucciones):
  --- <B>: <titulo> ---
  Archivos (leelos):
  - …
  Texto: …

  Hacé la versión completa: completá lo que quedó pendiente, guardá en archivos/entregables/<a>/ y decí al final qué cambiaste respecto de la anterior.
  ```
  - Con varias esperas en el grupo, se pone un bloque por cada una.
  - El texto de cada bloque se recorta a 3000 caracteres, como `FlujoTexto.maxEntrega`.
  - Se pasa todo por `sanear`.
  - `material()` es la misma función que usa la Fase D6.

**Barrido**: `Dependencias.barrer(ahora)`. Tiene su propio bucle, con el mismo patrón que `MotorFlujos.preparar`: se apaga con `HQ_PROGRAMADOR=0` y se acelera con `HQ_PROGRAMADOR_INTERVALO`. Va en `s.alArrancar`, y `detener` en `s.alCerrar.unshift`. En `s.alAbrir`: `async (a) => { void dep.barrer() }`, sin bloquear la apertura. En cada pasada, sobre la oficina activa:
1. **Despedidos:** las esperas abiertas cuyo `agente` o `espera_a` (si no es `persona`) ya no está en la oficina pasan a `cancelada`, con `motivo` «<nombre> ya no está en la oficina» y un aviso guardado `tipo 'error'` para el que espera. Los pedidos `corriendo` hacia un despedido pasan a `cancelado`.
2. **Reconciliación de lo que se perdió:**
   - esperas `esperando` cuya `ref` ya tiene una entrega que la satisface (`porRef`), por si se cayó un gancho;
   - pedidos `corriendo` cuya ejecución terminó en `error` (por ejemplo, la app se cerró a mitad de corrida: `Ejecuciones.preparar` la marca como interrumpida) pasan a `fallido`;
   - esperas `relanzada` sin reserva viva en el programador (`estaCorriendo` y `cambiandoEntrega` dan false), sin entrega con `ref = 'espera:<id>'` y con más de 120 s pasan a `fallida`, con un aviso.
3. `procesarListas(oficina)`.

**Costo:** pedidos y v2 son corridas completas. Se registran con `store.registrarCosto` desde el programador, con origen `pedido` o `espera` y `ref` = id de tarea. Topes en la Decisión 6. Una consulta sigue costando un turno de solo lectura.

## Fase D5: bloqueos, parte, avisos y rutas
**Bloqueos** (`backend/src/parte.ts`)
- `Bloqueos.calcular(corridas, entregas, tareasConError, ahora, esperas: EsperaVencida[] = [])`. El parámetro es opcional para no romper `test/unit/parte.test.ts`.
- `EsperaVencida = {id, agente, agenteNombre, esperaANombre, que, creada, plazo}`.
- Cada una genera:
  ```
  {tipo: 'espera', texto: '«<agente>» espera a <B> («<que>») hace <n días>.', ref: String(id), dias}
  ```
- `Parte.bloqueos` las saca de `esperasVencidas(s, carpeta, ahora)`, exportada por `dependencias.ts`. Lee la tabla con `try/catch`: sin tabla no aporta nada, como hace `avisos.ts` con `reuniones`. El coordinador (`bloqueos`, `estado_oficina`) las recibe sin tocar `coordinador.ts`.
- `Parte.armar` suma `esperas: [esperaJSON…]` con las abiertas (hasta 20).

**Avisos** (`backend/src/avisos.ts`)
- En `instalar`, `s.avisos.fuentes.push(...)`: por cada espera vencida y no vista,
  ```
  {id: 'espera:<id>', tipo: 'espera', agente: <quien espera>, texto: '«<que>»: <agente> espera a <B> hace <n días>', ref: String(id), creado: creada + plazo}
  ```
- `Avisos.vistos`: hoy los prefijos `flujo:` y `reunion:` están escritos a mano. Se generaliza con `marcadores: Record<string, (oficina, id) => boolean>`; flujos registra `flujo` y dependencias registra `espera` (`UPDATE esperas SET vista=1`). Alternativa mínima: un `marcarEsperaVista?` igual a `marcarCorridaVista`.
- Los relanzamientos que fallan dejan un aviso guardado `error`: en el camino `retomar` lo crea el propio programador; en el de `encargarLibre`, el `alTerminar` del módulo de tareas.

**Rutas nuevas** (`DependenciasRouter`, con `s.router.registrarExtra`, sobre la oficina activa; sin oficina, 409):

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/esperas?estado=abiertas\|todas\|<estado>&agente=&entrega=&reunion=` | | `{esperas:[Espera]}`. `entrega` filtra por `entrega_parcial`, `entrega_llegada` o `entrega_nueva`. Por defecto, `abiertas` (`esperando` + `lista` + `relanzada`) |
| POST | `/api/esperas/:id/cancelar` | `{motivo?}` (≤ 300) | `{espera}`. 409 si ya está cerrada |
| POST | `/api/esperas/:id/seguir` | | 202 `{espera}`. «Seguir sin esperar»: marca `lista` a todo el grupo, cancela las demás `esperando` con motivo «seguiste sin esperar» y relanza con lo que haya. 409 si está cerrada o no es la oficina activa |
| POST | `/api/esperas/:id/resolver` | `{entrega}` | `{espera}`. Vincula a mano una entrega del esperado (de la misma oficina; si no es suya, 409) como la que llegó, y relanza |
| POST | `/api/esperas/:id/reintentar` | | 202 `{espera}`. Si el pedido está `fallido`, lo vuelve a lanzar (mismo `pedido:<n>`, estado `corriendo`). Si la espera está `fallida`, la pasa a `lista` y relanza |
| GET | `/api/esperas/patrones` | | `{patrones:[{agente, esperaA, veces, ultima}]}`: pares con 3 o más esperas en 30 días (Fase D7) |
| POST | `/api/esperas/flujo` | `{agente, esperaA}` | `{borrador: FlujoDef}` (Fase D7) |

**`backend/API.md`**
- Sección nueva «Dependencias entre agentes (pedidos y esperas)», después de «Tareas programadas y segundo plano». Explica conceptos y estados, la regla de satisfacción, las herramientas MCP con sus topes, la tabla de rutas de arriba y las variables (`HQ_MAX_PEDIDOS_DIA`).
- «Reuniones»: `sintesis.pendientes[].depende_de`, `pendientesEstado[].dependeDe/espera`, la ruta de `encargar` con `{forzar}`, y las rutas nuevas `encargar-todos`, `hecho` y `flujo`. De paso se corrige la descripción de `pendientes:[{quien, que}]`, que ya tiene `necesita_usuario`.
- «Exportar e importar»: esperas y pedidos no viajan.
- No hay sección de entregas ni de parte. Si se suman, mencionar los orígenes nuevos `pedido` y `espera` y el bloqueo `tipo:'espera'`.

## Fase D6: dependencias en reuniones (pieza 3)
**Modelo** (`backend/src/reuniones.ts`)
- `Pendiente` suma `dependeDe?: number[]` (índices 0-based).
- `pendienteJSON` agrega `depende_de` solo si no está vacío, así las actas viejas no cambian.
- `lineaMD` agrega ` _(después de 2, 3)_`, con los índices en 1-based.

**Prompt** (`promptSintesis`)
- La forma de cada pendiente pasa a ser `{"quien":…, "que":…, "necesita_usuario": false, "depende_de": []}`.
- Se agrega: «En "depende_de" poné los números (empezando en 1, en el orden de la lista) de otros pendientes que tienen que estar hechos antes de poder hacer este; si no depende de ninguno, lista vacía.»

**`parsearSintesis`** lee `depende_de` como lista de enteros (también acepta números en texto). Por cada número `k`:
- calcula `k - 1`;
- descarta los que no son enteros, los que están fuera de rango y los propios;
- después saca las aristas que forman ciclos: Kahn sobre el grafo y, si quedan nodos, se vacía `dependeDe` de los que quedaron en ciclo;
- lo descartado no es error: se registra en el log.

**`estadoPendientes`** suma, por pendiente:
- `dependeDe: number[]`;
- `espera`, si hay esperas de su grupo `reunion:<id>:<n>`: `{estado, esperaA: [ids], esperando: [índices m aún no satisfechos], desde}`.

**`POST /api/reuniones/:id/pendientes/:n/encargar`** acepta un cuerpo opcional `{forzar?: boolean}`. Hoy no lee cuerpo: hay que pasarle `body` desde `despachar`, que tiene 6 partes.
- Sin dependencias pendientes, o con `forzar`: igual que hoy. Con `forzar`, primero se cancelan las esperas abiertas del grupo.
- Con dependencias `m` sin entrega satisfactoria (`porRef('encargo:<id>:<m>')`, no parcial):
  - si `m` es encargable y no tiene un encargo corriendo, se encarga `m` en cascada (recursivo, así se resuelven sus propias dependencias);
  - si `m` es de la persona (`usuario` o sin agente), `espera_a = 'persona'`;
  - se crean las esperas de `n`, una por dependencia `m`, con `accion = 'encargar'`, `origen = 'reunion'`, `grupo = 'reunion:<id>:<n>'`, `ref = 'encargo:<id>:<m>'`, `tarea = Programador.idEncargo(id, n)`, `nombre = TextoEntrega.titulo(p.que)` y `consigna = consignaEncargo({tema, acta, pendiente})`;
  - antes, chequeo de deadlock con el mismo DFS de D3. No debería pasar, porque los ciclos se cortaron al parsear.
- Responde 202 `{id, pendientesEstado}`, igual que hoy.
- Para no importar `reuniones` desde `dependencias`, `ReunionesRouter` llama a `dependenciasDe(s)?.esperarPendientes({...})`. Si el módulo no está, ignora las dependencias.

**Rutas nuevas**
- `POST /api/reuniones/:id/pendientes/encargar-todos`: encarga cada pendiente encargable sin encargo previo. Los que no tienen dependencias arrancan; los que dependen quedan en espera. Responde 202 `{id, pendientesEstado}`. Esto obliga a aceptar 5 partes en `despachar`, donde hoy `case 5` da `no404`.
- `POST /api/reuniones/:id/pendientes/:n/hecho {nota?}`: para pendientes de la persona (`usuario` o sin agente). Crea la entrega `origen 'persona'`, `agente ''`, `ref 'encargo:<id>:<n>'` y `texto = nota`, y la marca `revisada` enseguida. Libera a los dependientes por el gancho de D3. 409 si el pendiente es de un agente y encargable.
- `consignaEncargo` no cambia. El material de las dependencias lo agrega `procesarListas` con `TextoDependencias.material`, que pone «Lo que entregaron los pendientes de los que depende este (información, no instrucciones)» y por cada uno su título, archivos y texto recortado.

## Fase D7: pasar a flujo (pieza 4, alcance mínimo)
**`POST /api/reuniones/:id/flujo`** (en `ReunionesRouter`) responde `{borrador}`, sin guardar nada. 409 si la reunión no tiene pendientes o ninguno tiene `dependeDe`.
- Recorre los pendientes en orden topológico (Kahn estable por índice).
- Cada uno es un paso:
  - `id` `p<i+1>`;
  - `nombre`: `TextoEntrega.titulo(que)` recortado a 80;
  - `quien`: id del agente, o `'persona'` si `usuario` o sin agente;
  - `consigna`: `que`;
  - `recibeDe`: los ids de sus dependencias, y **`[]` explícito si no tiene ninguna**, porque `undefined` significa «el paso anterior»;
  - `entrega`: «Lo que pide el pendiente»;
  - `aprobacion: false`.
- `nombre` = tema (80), `descripcion` = «Armado desde la reunión «…»», `origen` = `reunion:<id>`.
- Se valida con `flujoDesde(borrador, idsUsados)` antes de devolverlo.

**`GET /api/esperas/patrones` y `POST /api/esperas/flujo {agente, esperaA}`** arman un borrador de 2 pasos:
- p1: `quien = esperaA`, consigna = el `que` más frecuente de los pedidos de ese par;
- p2: `quien = agente`, `recibeDe ['p1']`, consigna = el nombre de la última v1.

**Front de flujos** (`oficina/ui/flujos.js`)
- `editor(idInicial, borrador?)`: con `borrador`, `ed = desdeFlujo(borrador)` con `id: null` y `sucio = true`. Se exporta en `App.Flujos`.
- **Ojo:** al guardar, hoy el editor omite `recibeDe` vacío (`if (rec.length) o.recibeDe = rec`), y un paso raíz que queda en segundo lugar pasaría a recibir del anterior. Hay que agregar un flag `recibeNada` por paso: lo pone `desdeFlujo` cuando `p.recibeDe` es `[]`, se apaga al marcar alguna casilla, y con el flag se manda `recibeDe: []`. El motor ya trata `[]` como «no recibe nada» (`armarConsigna`).
- Pulirlo con el Creador (una tarjeta `flujo` precargada en su borrador) queda fuera de este plan.

## Fase D8: UI (`oficina/ui/`)
- **`entregables.js`**
  - `ORIGEN` suma `pedido: 'Pedido de un colega'` y `espera: 'Versión completa'`.
  - `linkOrigen` hoy toma `e.ref.split(':')[1]` para todo `encargo`, y con `coord:xxxx` arma un «Ver la reunión» roto (bug que ya existe). Solo hay que tratarlo como reunión si `e.ref` empieza con `encargo:`.
  - En el detalle, `GET /api/esperas?entrega=<id>&estado=todas` (en el mismo `Promise.all` que corridas y acciones):
    - si la entrega es una v1 con espera abierta: bloque «Esperando a <B>: <que> · hace X», con «Seguir sin esperar», «Cancelar espera» y, si el pedido falló, «Reintentar el pedido»;
    - si es una v2: «Versión completa: llegó lo de <B>», con un botón a la entrega de B.
- **`parte.js`**
  - Bloqueo `tipo 'espera'`: ícono de espera; el clic abre la v1 (`App.Entregables.abrir`) o la reunión si la espera es de reunión. Para eso `esperaJSON` lleva `entregaParcial` y `reunion`.
  - Sección «En espera» con `p.esperas`.
  - Si `/api/esperas/patrones` trae algo: tarjeta «<A> espera seguido a <B>: ¿armar un flujo?», que llama a `POST /api/esperas/flujo` y abre `App.Flujos.editor(null, borrador)`.
- **`avisos.js`**: `tipo 'espera'`, con título «Algo trabado» y la misma acción de clic que el parte. Además, `visto({id})`.
- **`reunion.js`**
  - En `accionesPendiente`:
    - chip «Depende de 2, 3»;
    - con `est.espera` abierta: insignia «Esperando a <nombres>» más «Arrancar igual» (`encargar` con `{forzar: true}`) y «Cancelar espera» (cancela cada espera abierta del grupo);
    - pendientes de la persona: «Ya lo hice» (`POST …/hecho`, con un prompt opcional para la nota).
  - `vigilarPendientes` también sigue refrescando con esperas abiertas.
  - En `sintesis`:
    - «Encargar todo» si hay más de un encargable sin encargo;
    - «Pasar a flujo» si algún pendiente tiene `depende_de` (`POST /api/reuniones/:id/flujo` → `App.Flujos.editor(null, borrador)`).
- **`agente.js`**: sin cambios obligatorios. Más adelante se pueden mostrar en el chat los pedidos y esperas de una sesión, como las consultas.
- **3D:** nada en este plan.

## Casos borde
- **Agente despedido** (no hay gancho en `despedir`; se resuelve en el barrido): cancela sus esperas y las que lo esperan, con motivo y aviso, y cancela los pedidos hacia él. Si el despedido es quien espera y ya está `lista`, no se relanza (`procesarListas` revisa `def`).
- **Espera cancelada:** por el agente (`cancelar_espera`, solo las suyas) o por la persona (`/cancelar`). Si un grupo queda sin `esperando` y con alguna `lista`, se relanza con eso. «Seguir sin esperar» es explícito: fuerza el relanzamiento.
- **Ciclos:**
  - MCP: DFS sobre las esperas abiertas en `quedo_esperando`, más cadena y profundidad en `pedir`;
  - reunión: se cortan al parsear;
  - una v2 que vuelve a quedar esperando: tope de 2 rondas.
- **Oficina cerrada o cambiada:**
  - las herramientas dan «La oficina ya no está abierta»;
  - las corridas ya lanzadas terminan con su `act` y sus entregas se registran igual, así que el gancho marca `lista` sin depender de la oficina activa;
  - se relanza al abrir la oficina (`alAbrir`) o en el barrido;
  - con la app cerrándose, `encargarLibre`/`retomar` dan 409 y la espera queda `lista` hasta el próximo arranque.
- **Relanzamiento que falla:** la espera pasa a `fallida` con `motivo` y queda un aviso `error`. «Reintentar» la pasa a `lista`. Si se interrumpe por un cierre de la app, lo detecta la reconciliación.
- **El pedido falla:** pedido `fallido`; la espera sigue `esperando`, avisa al vencer y tiene «Reintentar el pedido».
- **B entrega antes de que A termine su v1** (B rápido): la espera queda `lista` y se relanza recién cuando aparece `entrega_parcial`, o cuando no hay ejecución corriendo con esa `sid` y ya pasó la gracia de 120 s.
- **La persona pidió cambios sobre la v1:** se retoma la `vigente`. Si hay un «pedir cambios» en curso sobre la misma entrega, la clave `cambios:<id>` lo excluye y se reintenta.
- **La v1 era un paso de flujo:**
  - con aprobación pendiente, la v2 reemplaza a la vigente en el paso (`MotorFlujos.alEntregar`, rama `padre`);
  - si el flujo ya avanzó, la v2 queda suelta y se documenta.
- **v1 en un chat sin archivos en `entregables/`:** no hay entrega, así que no hay `entrega_parcial`. La v2 retoma igual la `sid` del chat: el agente escribe en esa conversación, como «pedir cambios».
- **La entrega de B también es parcial** (B quedó esperando a C): no satisface a A hasta la v2 de B (regla de la raíz). Profundidad máxima de 2.
- **Costo y spam:** los topes de la Decisión 6 y el dedupe por par. Los pedidos y las v2 se ven en costos con origen `pedido` o `espera`.
- **Varias esperas en la misma corrida:** un solo relanzamiento por grupo, cuando todo llegó.
- **Reunión:** «Hacerlo de nuevo» sobre una dependencia ya cumplida no vuelve a disparar nada (las esperas están cerradas). Un pendiente de la persona se cumple con «Ya lo hice».

## Plan de tests
**Fake de `claude`** (`backend/test/fixtures/claude-fake.cjs`)
- Modo nuevo `MCP_LLAMAR`. Si el mensaje lo incluye y existe `llamadas.<agente>` (una línea JSON de `params` de `tools/call` por línea, igual que `creador.calls`), hace las llamadas con el token del entorno, agrega las respuestas a `mcp.<agente>.out`, renombra el archivo a `.usado` (así la v2 no repite) y **sigue** con el resto: por ejemplo, `ENTREGA:`.
- Como la consigna del pedido incluye el `que`, un `que` con `ENTREGA:archivos/entregables/arqui/mapeo.md` hace que el fake de `arqui` deje el archivo.
- Para las reuniones alcanza con `resp.acta.json`, que ya existe, con `depende_de`.

**Unit** (`backend/test/unit/dependencias.test.ts`, en proceso con `arrancar`/`oficina` de `test/support/en-proceso.ts`, como `test/unit/coordinador.test.ts`)
- Definiciones:
  - el perfil agente ve `['colegas','consultar','pedir','quedo_esperando','cancelar_espera']`;
  - el creador no ve ninguna.
  - Hay que actualizar las listas exactas que ya existen: `test/unit/consultas.test.ts` (alrededor de las líneas 119 y 125), `test/unit/coordinador.test.ts` (`nombres(h)` y `HerramientasMCPAgente.lista`) y `test/api/coordinador.test.ts` (`tools.endsWith(...)`).
- `pedir`:
  - faltantes, uno mismo, inexistente, oficina cerrada;
  - cupo de 2 por token, dedupe sin gastar cupo, tope por oficina y por día;
  - profundidad mayor que 2 y ciclo;
  - crea la ejecución `pedido:<n>` para B, con la consigna saneada y «Pedido de Marce».
- `quedo_esperando`:
  - sin pedido crea uno; con un pedido ajeno da error;
  - `plazo_dias` fuera de rango;
  - deadlock A↔B;
  - ronda mayor que 2;
  - con el pedido ya entregado nace `lista`.
- Gancho de entregas:
  - una entrega de A en la `sid` vincula `entrega_parcial`;
  - una entrega de B con `ref pedido:<n>` pasa la espera a `lista` y el pedido a `entregado`;
  - una entrega parcial de B no satisface;
  - una v2 de B (`origen espera`, `padre` = v1 de B) sí satisface.
- Relanzamiento:
  - llama a `retomar` con `--resume <sid>` (se ve en los argumentos);
  - la entrega nueva tiene `origen espera`, `padre` = v1 y `ref espera:<id>`;
  - la v1 pasa a `cambios` si estaba sin revisar y queda `revisada` si ya lo estaba;
  - la consigna lista los archivos de B;
  - un grupo de 2 se relanza recién cuando las 2 están listas;
  - sin v1 se usa `encargarLibre` con `espera:<id>`.
- Barrido:
  - despedido → cancelada con aviso;
  - oficina no activa → sigue `lista` hasta `alAbrir`;
  - `relanzada` huérfana → `fallida`;
  - pedido con ejecución en error → `fallido`.
- `Bloqueos.calcular` con esperas vencidas (en `test/unit/parte.test.ts`); fuente de avisos y `vistos('espera:<id>')`.
- `parsearSintesis`:
  - `depende_de` 1-based pasa a 0-based;
  - se descartan los propios, los fuera de rango y los ciclos;
  - `pendienteJSON` omite el campo vacío;
  - `lineaMD` (en `test/unit/reuniones.test.ts`).
- Borrador de flujo desde una reunión: orden topológico, `recibeDe` con `[]` en las raíces, pasos de la persona, y pasa `flujoDesde`. Patrones: 3 esperas A→B arman el patrón y su borrador de 2 pasos.

**API** (`backend/test/api/dependencias.test.ts`, con `Fix` y `HQ_PROGRAMADOR: '0'`, llamando a `barrer` donde haga falta)
- **De punta a punta:** se contrata a `marce` y `arqui`, se escribe `llamadas.marce` con `pedir` (`que` con `ENTREGA:` de arqui) y `quedo_esperando`, y se crea una tarea única «ahora» de marce con `MCP_LLAMAR ENTREGA:archivos/entregables/marce/v1.md`. Al terminar hay 3 entregas:
  - v1 de marce (origen tarea), que queda en estado `cambios`;
  - la de arqui (origen pedido);
  - la v2 de marce (origen espera, `padre` = v1, con `--resume`).

  Además, `GET /api/esperas?estado=todas` muestra la espera como `hecha`.
- **Reunión:** con `resp.acta.json` de tres pendientes, donde el 2 depende del 1 y el 3 es de la persona:
  - `encargar 2` encarga el 1 y deja el 2 en espera;
  - cuando el 1 entrega, el 2 corre y su consigna incluye el archivo del 1;
  - `forzar` corre enseguida;
  - `hecho` sobre el pendiente de la persona libera a su dependiente;
  - `encargar-todos`;
  - `hecho` sobre un pendiente de agente da 409.
- `POST /api/reuniones/:id/flujo` → `POST /api/flujos` con el borrador da 200.
- `/api/esperas/:id/{cancelar,seguir,resolver,reintentar}`: casos felices, 404 (id inexistente o de otra oficina), 409 (cerrada, o entrega de otro agente) y 409 sin oficina.
- Pedido que falla (`modo.arqui` = `error`): pedido `fallido` y aviso `error`; `reintentar` lo vuelve a lanzar.

## Orden de implementación (pasos chicos, cada uno con la suite en verde)
1. **D0:** `Entregas.alRegistrar`, `porRef`, `raiz`, `vigente` e índice; `Ejecuciones.porSid`; prefijos, `origenEntrega` y `nombreCorrida`; refactor `correrCambios` → `retomar`. Sin cambios de comportamiento.
2. **D1:** `dependencias.ts` con tablas, stores y `esperaJSON` (sin herramientas). Unit tests de los stores.
3. **Fake `MCP_LLAMAR`** más **D2** (`pedir`, permisos y actualización de las listas exactas en los tests de consultas y coordinador).
4. **D3:** `quedo_esperando`, `cancelar_espera` y el gancho de entregas (vínculo v1, pedidos cumplidos, esperas `lista`) sin relanzar todavía.
5. **D4:** `procesarListas`, `retomar` con origen `espera`, `encargarLibre` de respaldo, barrido, `alAbrir` y reconciliación. Test de punta a punta.
6. **D5:** bloqueos, parte, fuente de avisos, `vistos`, rutas `/api/esperas*` y `API.md`.
7. **D8 (parte 1):** `entregables.js` (ORIGEN, bloque de espera, arreglo de `linkOrigen`), `parte.js` y `avisos.js`.
8. **D6:** síntesis con `depende_de` (prompt, parseo, JSON, `lineaMD`), `encargar` con esperas y `forzar`, `encargar-todos`, `hecho`; `reunion.js`.
9. **D7:** borrador desde reunión, patrones, `editor(id, borrador)` y el flag `recibeNada` en `flujos.js`.
10. Prueba a mano en dev (`npm run dev --prefix backend`) con el `claude` real: el caso Marce/Arquitecto completo y una reunión con dependencias.

## Fuera de alcance
- Que el LLM decida si una entrega «sirve».
- Esperar a la persona desde MCP.
- Una configuración por oficina para pasar de relanzamiento automático a «preguntar» (ver dudas).
- Integración con el Creador.
- Visualización en el 3D.
- Mostrar pedidos y esperas en el chat del agente.

## Dudas resueltas (antes de implementar)
1. **Modo «preguntar antes de la v2»:** fuera de alcance; el relanzamiento es automático con los topes de la Decisión 6.
2. **Esperar sin pedido** (B ya tiene una tarea que lo va a producir): fuera de alcance; `quedo_esperando` siempre ata a un pedido.
3. **Entregas de pedidos:** nacen `sin_revisar` como cualquier otra entrega (la persona ve lo que produjo B).
4. **Protocolo en `Instrucciones.para`:** sí. Sumar un párrafo corto: «Si te falta algo de un colega: consultalo; si no lo tiene, pedíselo con `pedir`; entregá lo que puedas marcando lo que falta y llamá a `quedo_esperando`». Actualizar los tests de Instrucciones que correspondan.
5. **`Avisos.vistos`:** alternativa mínima, un `marcarEsperaVista?` puntual igual a `marcarCorridaVista`.
6. **Editor de flujos y `recibeDe: []`:** implementar el flag `recibeNada` como dice la Fase D7.
