#!/usr/bin/env bash
# actualizar.sh — trae la última versión, recompila y reinicia el backend.
# Uso: bash actualizar.sh   (desde la carpeta del repo)
set -euo pipefail
export GIT_PAGER=cat

# Todo va entre llaves: bash lee el bloque entero antes de ejecutarlo, así un
# git pull que cambie este archivo no rompe la corrida en curso.
{

cd "$(dirname "$0")"
RAIZ=$(pwd)
LOG="$RAIZ/backend.log"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Hay cambios locales en archivos del repo. Guardalos o descartalos antes de actualizar:"
  git status --short --untracked-files=no
  exit 1
fi

antes=$(git rev-parse HEAD)
echo "Buscando cambios…"
git pull --ff-only
despues=$(git rev-parse HEAD)

if [ "$antes" = "$despues" ]; then
  echo "Ya estás en la última versión ($(git describe --tags --always))."
  exit 0
fi

echo "Cambios nuevos:"
git --no-pager log --oneline "$antes..$despues"

echo "Instalando dependencias del backend…"
npm ci --prefix backend

echo "Compilando…"
(cd backend && npx tsc)

# --- Reinicio ---
PID=$(pgrep -f "node .*dist/src/dev.js" | head -n1 || true)
VARS=()
if [ -n "$PID" ]; then
  # copiar la configuración del proceso viejo (PORT, HQ_*, CLAUDE_BIN)
  if [ -r "/proc/$PID/environ" ]; then
    while IFS= read -r linea; do VARS+=("$linea"); done < <(
      tr '\0' '\n' < "/proc/$PID/environ" | grep -E '^(PORT|CLAUDE_BIN|HQ_[A-Z_]*)=' || true
    )
  fi
  echo "Apagando el backend (pid $PID)…"
  kill "$PID"
  for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
else
  echo "No había un backend corriendo; lo arranco."
fi

echo "Arrancando el backend…"
cd "$RAIZ/backend"
nohup env "${VARS[@]}" node dist/src/dev.js >> "$LOG" 2>&1 &
NUEVO=$!
cd "$RAIZ"

PUERTO=8765
for v in "${VARS[@]}"; do case "$v" in PORT=*) PUERTO="${v#PORT=}";; esac; done

for _ in $(seq 1 30); do
  if ! kill -0 "$NUEVO" 2>/dev/null; then
    echo "El backend se cayó al arrancar. Últimas líneas de $LOG:"
    tail -n 30 "$LOG"
    exit 1
  fi
  codigo=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PUERTO/" || true)
  if [ "$codigo" != "000" ]; then
    echo
    echo "Listo: $(git describe --tags --always), corriendo en http://localhost:$PUERTO (pid $NUEVO)."
    echo "Log: $LOG"
    exit 0
  fi
  sleep 1
done

echo "El backend arrancó (pid $NUEVO) pero no responde en el puerto $PUERTO después de 30 s. Mirá $LOG."
exit 1
exit
}
