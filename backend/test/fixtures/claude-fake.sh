#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
if [[ "$1" == "auth" ]]; then
  echo "AUTH" >> "$D/events.log"
  if [[ -f "$D/noauth" ]]; then echo '{"loggedIn":false}'; exit 1; fi
  echo '{"loggedIn":true}'; exit 0
fi
agent=""; prev=""
for a in "$@"; do
  if [[ "$prev" == "--agent" ]]; then agent="$a"; fi
  prev="$a"
done
msg="${@: -1}"
rec="$(printf '%s\x1f' "$@")"
n=0; until mkdir "$D/args.lock" 2>/dev/null || [[ $n -gt 500 ]]; do sleep 0.01; n=$((n+1)); done   # corridas paralelas no se mezclan
printf '%s\x1e' "$rec" >> "$D/args.log"; rmdir "$D/args.lock" 2>/dev/null
echo "S $agent" >> "$D/events.log"
fin() { echo "E $agent" >> "$D/events.log"; }
has() { [[ " $* " == *" $1 "* ]]; }
echo "$PWD" >> "$D/cwd.log"
kind=""
if [[ -z "$agent" ]]; then
  if [[ "$msg" == *"ador de equipos"* ]]; then kind=borrador
  elif [[ "$msg" == *"secretario de actas"* ]]; then kind=acta
  elif [[ "$msg" == *"Sos el bibliotecario"* ]]; then kind=ficha
  elif [[ "$msg" == *"imagen que est"* ]]; then kind=imagen
  elif [[ "$msg" == *"en 3 a 6 palabras"* ]]; then kind=resumen
  fi
else
  if [[ "$msg" == *"en una reuni"* ]]; then kind=turno
  elif [[ "$msg" == *"documento a la biblioteca"* ]]; then kind=lectura
  elif [[ "$msg" == *"consulta de un colega"* ]]; then kind=consulta
  fi
fi
modo=""
if [[ -n "$agent" && -f "$D/modo.$agent" ]]; then modo="$(cat "$D/modo.$agent")"
elif [[ -n "$kind" && -f "$D/modo.$kind" ]]; then modo="$(cat "$D/modo.$kind")"; fi
case "$modo" in
  lento) sleep 300 & echo $! > "$D/child.pid"; wait; fin; exit 0;;
  error) echo '{"type":"result","result":"fallo raro","is_error":true}'; fin; exit 0;;
  vacio) echo '{"type":"result","result":"","is_error":false}'; fin; exit 0;;
  nojson) echo "esto no es json"; fin; exit 0;;
  puerta) n=0; while [[ ! -f "$D/go" && $n -lt 300 ]]; do sleep 0.05; n=$((n+1)); done;;
esac
if [[ "$msg" == *LENTO* ]]; then
  sleep 300 &
  echo $! > "$D/child.pid"
  wait
  fin; exit 0
fi
if [[ "$msg" == *DORMIR* ]]; then sleep 1; fi
if [[ "$msg" == *USADA* && " $* " == *" --session-id "* ]]; then
  echo '{"type":"result","result":"Error: Session ID is already in use","is_error":true}'; fin; exit 1
fi
if [[ "$msg" == *NOCONV* && " $* " == *" --resume "* ]]; then
  echo '{"type":"result","result":"No conversation found with session ID","is_error":true}'; fin; exit 1
fi
if [[ "$msg" == *NOTFOUND* && " $* " == *" --resume "* ]]; then
  echo '{"type":"result","result":"Error: session not found","is_error":true}'; fin; exit 1
fi
if [[ "$msg" == *LOGINERR* ]]; then
  echo '{"type":"result","result":"Please run /login","is_error":true}'; fin; exit 1
fi
if [[ "$msg" == *NOJSON* ]]; then echo "esto no es json"; fin; exit 0; fi
if [[ "$msg" == *SALE3* ]]; then echo "boom" >&2; fin; exit 3; fi
if [[ "$msg" == *ISERR* ]]; then echo '{"type":"result","result":"fallo raro","is_error":true}'; fin; exit 0; fi
if [[ "$msg" == *VACIO* ]]; then echo '{"type":"result","result":"","is_error":false}'; fin; exit 0; fi
if [[ -n "$kind" ]]; then
  if [[ -n "$agent" && -f "$D/resp.$kind.$agent.json" ]]; then cat "$D/resp.$kind.$agent.json"; fin; exit 0; fi
  if [[ -f "$D/resp.$kind.json" ]]; then cat "$D/resp.$kind.json"; fin; exit 0; fi
  case "$kind" in
    borrador) echo '{"type":"result","result":"Acá va el borrador:\n```json\n{\"id\":\"valentina\",\"nombre\":\"Valentina\",\"rol\":\"Analista de datos\",\"description\":\"Analista de datos. Usala cuando haga falta medir resultados.\",\"prompt\":\"Sos Valentina, analista de datos.\",\"chips\":[\"¿Cómo vamos?\",\"Armame un informe\",\"¿Qué medimos?\"],\"modelo\":\"sonnet\"}\n```","is_error":false}';;
    acta) echo '{"type":"result","result":"{\"resumen\":\"Se acordó avanzar con el plan.\",\"decisiones\":[\"Lanzar en diciembre\",\"Priorizar los reels\"],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Armar el calendario\"}]}","is_error":false}';;
    ficha) echo '{"type":"result","result":"{\"titulo\":\"Ficha de prueba\",\"resumen\":\"Resumen de prueba del documento.\",\"datos_clave\":[\"dato uno\"],\"temas\":[\"pruebas\"],\"util_para\":[\"direccion\"],\"fechas\":[],\"contradicciones\":[]}","is_error":false}';;
    imagen) echo '{"type":"result","result":"Una imagen de prueba con el texto HOLA MUNDO.","is_error":false}';;
    resumen) echo '{"type":"result","result":"«Armando el plan de diciembre.»","is_error":false,"total_cost_usd":0.001}';;
    turno) echo "{\"type\":\"result\",\"result\":\"Opinión de $agent sobre el tema.\",\"is_error\":false,\"total_cost_usd\":0.02}";;
    lectura) mkdir -p conocimiento/agentes; echo "- leyó el documento (prueba)" >> "conocimiento/agentes/$agent.md"; echo '{"type":"result","result":"listo","is_error":false}';;
    consulta) echo "{\"type\":\"result\",\"result\":\"Mi mirada de $agent sobre la consulta.\",\"is_error\":false,\"total_cost_usd\":0.03}";;
  esac
  fin; exit 0
fi
if [[ -n "$kind" ]]; then
  if [[ -n "$agent" && -f "$D/resp.$kind.$agent.json" ]]; then cat "$D/resp.$kind.$agent.json"; fin; exit 0; fi
  if [[ -f "$D/resp.$kind.json" ]]; then cat "$D/resp.$kind.json"; fin; exit 0; fi
  case "$kind" in
    borrador) echo '{"type":"result","result":"Acá va el borrador:\n```json\n{\"id\":\"valentina\",\"nombre\":\"Valentina\",\"rol\":\"Analista de datos\",\"description\":\"Analista de datos. Usala cuando haga falta medir resultados.\",\"prompt\":\"Sos Valentina, analista de datos.\",\"chips\":[\"¿Cómo vamos?\",\"Armame un informe\",\"¿Qué medimos?\"],\"modelo\":\"sonnet\"}\n```","is_error":false}';;
    acta) echo '{"type":"result","result":"{\"resumen\":\"Se acordó avanzar con el plan.\",\"decisiones\":[\"Lanzar en diciembre\",\"Priorizar los reels\"],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Armar el calendario\"}]}","is_error":false}';;
    ficha) echo '{"type":"result","result":"{\"titulo\":\"Ficha de prueba\",\"resumen\":\"Resumen de prueba del documento.\",\"datos_clave\":[\"dato uno\"],\"temas\":[\"pruebas\"],\"util_para\":[\"direccion\"],\"fechas\":[],\"contradicciones\":[]}","is_error":false}';;
    imagen) echo '{"type":"result","result":"Una imagen de prueba con el texto HOLA MUNDO.","is_error":false}';;
    resumen) echo '{"type":"result","result":"«Armando el plan de diciembre.»","is_error":false,"total_cost_usd":0.001}';;
    turno) echo "{\"type\":\"result\",\"result\":\"Opinión de $agent sobre el tema.\",\"is_error\":false,\"total_cost_usd\":0.02}";;
    lectura) mkdir -p conocimiento/agentes; echo "- leyó el documento (prueba)" >> "conocimiento/agentes/$agent.md"; echo '{"type":"result","result":"listo","is_error":false}';;
  esac
  fin; exit 0
fi
if [[ "$msg" == *CONSULTAR:* ]]; then
  # llama a `consultar` del servidor MCP con el token del entorno, como haría claude (xN: N veces)
  colega="${msg#*CONSULTAR:}"; colega="${colega%% *}"
  veces=1; [[ "$msg" == *x4* ]] && veces=4
  cfg=""; prev=""
  for a in "$@"; do if [[ "$prev" == "--mcp-config" ]]; then cfg="$a"; fi; prev="$a"; done
  url="$(echo "$cfg" | grep -o 'http://127[^"]*')"
  echo "$HQ_MCP_TOKEN" >> "$D/token.log"
  echo "$url" >> "$D/url.log"
  for i in $(seq 1 $veces); do
    body="{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"consultar\",\"arguments\":{\"colega\":\"$colega\",\"pregunta\":\"Como vamos con lo tuyo?\"}}}"
    curl -s -m 20 -H "Authorization: Bearer $HQ_MCP_TOKEN" -H 'Content-Type: application/json' -d "$body" "$url" >> "$D/mcp.$agent.out"
    echo >> "$D/mcp.$agent.out"
  done
  echo "{\"type\":\"result\",\"result\":\"consulte\",\"is_error\":false,\"total_cost_usd\":0.01}"
  fin; exit 0
fi
if [[ "$msg" == *CREADOR_LLAMAR* ]]; then
  # hace las llamadas de $D/creador.calls al servidor MCP con el token del entorno, como haría el Creador de verdad
  cfg=""; prev=""
  for a in "$@"; do if [[ "$prev" == "--mcp-config" ]]; then cfg="$a"; fi; prev="$a"; done
  url="$(echo "$cfg" | grep -o 'http://127[^"]*')"
  echo "$HQ_MCP_TOKEN" >> "$D/token.log"
  echo "$url" >> "$D/url.log"
  i=0
  if [[ -f "$D/creador.calls" ]]; then
    while IFS= read -r linea || [[ -n "$linea" ]]; do
      [[ -z "$linea" ]] && continue
      i=$((i+1))
      body="{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":$linea}"
      curl -s -m 20 -H "Authorization: Bearer $HQ_MCP_TOKEN" -H 'Content-Type: application/json' -d "$body" "$url" >> "$D/creador.out"
      echo >> "$D/creador.out"
    done < "$D/creador.calls"
  fi
  echo "{\"type\":\"result\",\"result\":\"Listo, armé las tarjetas.\",\"is_error\":false,\"total_cost_usd\":0.02}"
  fin; exit 0
fi
if [[ "$msg" == *ENTREGA:* ]]; then
  # escribe el archivo pedido (relativo a la carpeta de trabajo) y lo informa como un Write de claude
  rel="${msg#*ENTREGA:}"; rel="${rel%% *}"
  mkdir -p "$(dirname "$PWD/$rel")"; echo "entregado por $agent" > "$PWD/$rel"
  echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Write\",\"input\":{\"file_path\":\"$PWD/$rel\",\"content\":\"x\"}}]}}"
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/fuera/de/la/oficina.md"}}]}}'
  echo "{\"type\":\"result\",\"result\":\"Listo, dejé $rel\",\"is_error\":false,\"total_cost_usd\":0.03}"
  fin; exit 0
fi
if [[ "$msg" == *STREAM* ]]; then
  echo '{"type":"system","subtype":"hook_started","hook_name":"x"}'
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-$agent\"}"
  echo '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}'
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x/conocimiento/oficina.md"}}]}}'
  if [[ "$msg" == *PAUSA* ]]; then n=0; while [[ ! -f "$D/go" && $n -lt 300 ]]; do sleep 0.05; n=$((n+1)); done; fi
  echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"secreto"}]}}'
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"listo"}]}}'
  echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"stream $agent\",\"is_error\":false,\"total_cost_usd\":0.25}"
  fin; exit 0
fi
echo "{\"type\":\"result\",\"result\":\"hola $agent\",\"is_error\":false,\"total_cost_usd\":0.01}"
fin
exit 0
