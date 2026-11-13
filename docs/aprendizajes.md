# Aprendizajes sobre Claude Code

Comportamientos de Claude Code que la app da por sentados. Cada uno lleva su estado:
- **CONFIRMADO**: lo vimos en una corrida real, con la versión indicada.
- **NO VERIFICADO**: es una suposición razonable que todavía no probamos.
- **FALSO**: lo creíamos y resultó no ser así.

Regla: antes de construir sobre un comportamiento de Claude Code, se prueba y se anota acá.

## Salida `stream-json` (spike del 13/11/2026, claude-haiku-5-5)

- **CONFIRMADO.** `claude -p --output-format stream-json --verbose` escribe un objeto JSON por línea. Sin `--verbose`, `-p` no acepta `stream-json`.
- **CONFIRMADO.** El orden observado fue:
  1. `system/hook_started` y `system/hook_response`: los hooks del usuario (`~/.claude/settings.json`) **también corren dentro de los agentes de la oficina**;
  2. `system/init`, con `session_id`, `model`, `tools`, `mcp_servers`, `cwd`;
  3. `system/thinking_tokens`;
  4. un `assistant` por bloque de contenido: `thinking`, `tool_use` o `text`;
  5. `user` con el `tool_result`;
  6. `rate_limit_event`;
  7. al final, `result`.
- **CONFIRMADO.** `tool_use` trae `name` (por ejemplo `Read`) e `input`, que para `Read` es `{file_path}`. Para mostrar actividad alcanza con `name` y el nombre del archivo, sin contenido.
- **CONFIRMADO.** La última línea es `{"type":"result", "subtype":"success", "is_error", "result", "total_cost_usd", "num_turns", "session_id", ...}`. Por eso `parsearJSON`, que toma la última línea JSON si el todo no parsea, sigue funcionando.
- **CONFIRMADO.** Con haiku, una lectura de archivo más una respuesta de una palabra costó `total_cost_usd` ≈ 0,019. Ese número es un estimado de precio de API, no lo que se cobra en un plan Pro/Max: en la UI se muestra como «costo estimado».
- **NO VERIFICADO.** Que con `--output-format json` también venga `total_cost_usd`. Da igual: la app pasa toda a `stream-json`.
- **CONFIRMADO (Fase 4).** Los nombres de las herramientas MCP en `tool_use` son `mcp__<servidor>__<herramienta>` (ver la sección del servidor MCP propio).

## Entorno del proceso hijo

- **CONFIRMADO (en agents-office).** Si `claude` hereda `CLAUDECODE` o `CLAUDE_CODE_*` de una sesión padre, se comporta como sesión anidada y no guarda el transcript. `ClaudeLocator.childEnvironment` y `server.entorno_hijo` las quitan, salvo `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*` y la config del usuario.
- **CONFIRMADO.** Desde una app gráfica, `claude` puede no estar en el PATH: se busca con `$SHELL -ilc` (shell de login interactivo), leyendo la ruta entre marcadores.

## Servidor MCP propio (spike de la Fase 4, 13/11/2026, claude 2.1.323, haiku)

Probado con un servidor HTTP de juguete en `127.0.0.1` y `claude -p --model haiku --output-format stream-json --verbose --mcp-config <json> --tools mcp__hq__colegas --allowedTools mcp__hq__colegas`; después, de punta a punta, con el servidor de verdad (modo dev Python) y dos agentes con modelo haiku (marce le consultó a nico y citó su respuesta).

- **CONFIRMADO.** `--mcp-config` acepta JSON inline: `{"mcpServers":{"hq":{"type":"http","url":"http://127.0.0.1:PUERTO/mcp","headers":{"Authorization":"Bearer TOKEN"}}}}`. El servidor aparece en `system/init` → `mcp_servers` como `{"name":"hq","status":"connected","source":"dynamic"}`. Los servidores MCP del usuario (`~/.claude`) se cargan igual: lo que limita al agente es `--tools`.
- **CONFIRMADO.** El header se expande con variables de entorno: `"Authorization":"Bearer ${HQ_MCP_TOKEN}"` y el token en el entorno del proceso. La app lo usa así para que el token no aparezca en los argumentos (`ps`).
- **CONFIRMADO.** Secuencia de pedidos de claude, todos `POST /mcp` con `Content-Type: application/json` y `Accept: application/json, text/event-stream`:
  1. `server/discover` (id string `server-discover-probe-1`, `Mcp-Protocol-Version: 2026-07-28`): un sondeo previo. Contestarle error `-32601` (método no soportado) o un resultado vacío alcanza; después sigue;
  2. `initialize` con `protocolVersion: "2025-11-25"` (más `capabilities` y `clientInfo` de claude-code);
  3. `notifications/initialized` (sin `id`): se contesta `202` sin cuerpo;
  4. un `GET /mcp` con `Accept: text/event-stream` (canal SSE del servidor al cliente): contestar `405` está bien;
  5. `tools/list` (id 1) y, cuando el modelo la usa, `tools/call` con `params: {name, arguments, _meta}`.
- **CONFIRMADO.** Basta contestar `Content-Type: application/json` simple, sin SSE. La versión que pide claude es `2025-11-25`; el servidor la repite en `initialize` (acepta también `2025-06-18`, `2025-03-26` y `2024-11-05`).
- **CONFIRMADO.** El nombre en el `tool_use` de stream-json es `mcp__<servidor>__<herramienta>`: `mcp__hq__colegas` (y, por lo mismo, `mcp__hq__consultar`; el estado «consultando» y el 3D se apoyan en ese prefijo). Su `input` trae los argumentos tal cual los escribió el modelo, así que `colega` puede venir como id («nico») o como nombre («Nico»).
- **CONFIRMADO.** `--tools mcp__hq__colegas` hace visible la herramienta y `--allowedTools mcp__hq__colegas` la deja correr sin pedir permiso (en `-p` no hay a quién preguntarle).
- **CONFIRMADO.** Una herramienta que devuelve `{"content":[{"type":"text","text":...}],"isError":true}` llega al modelo como error de herramienta y puede seguir.
- **NO VERIFICADO.** Qué hace claude con un `401` en medio de una corrida (token revocado): solo probamos que el servidor lo devuelve; en la app el token se revoca recién cuando termina el chat.
- **NO VERIFICADO.** Que `claude` reuse la conexión (keep-alive): el servidor de la app cierra cada conexión (`Connection: close`) y funciona.
