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
- **NO VERIFICADO.** Los nombres de las herramientas MCP en `tool_use`. Se espera `mcp__<servidor>__<herramienta>`; se confirma en la Fase 4.

## Entorno del proceso hijo

- **CONFIRMADO (en agents-office).** Si `claude` hereda `CLAUDECODE` o `CLAUDE_CODE_*` de una sesión padre, se comporta como sesión anidada y no guarda el transcript. `ClaudeLocator.childEnvironment` y `server.entorno_hijo` las quitan, salvo `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*` y la config del usuario.
- **CONFIRMADO.** Desde una app gráfica, `claude` puede no estar en el PATH: se busca con `$SHELL -ilc` (shell de login interactivo), leyendo la ruta entre marcadores.
