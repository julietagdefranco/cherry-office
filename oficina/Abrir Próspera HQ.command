#!/bin/bash
# Doble clic para abrir la oficina. La primera vez te pide iniciar sesión (una sola vez).
cd "$(dirname "$0")"
CLAUDE=$(ls -t "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1)
if [ -z "$CLAUDE" ]; then CLAUDE=$(command -v claude); fi
if [ -z "$CLAUDE" ]; then echo "No encontré Claude Code en esta compu."; read -p "Enter para cerrar"; exit 1; fi
if ! "$CLAUDE" auth status >/dev/null 2>&1; then
  echo "Primera vez: se va a abrir el navegador para que autorices tu cuenta de Claude."
  "$CLAUDE" auth login
fi
# si ya había un servidor viejo en el puerto, lo cerramos
lsof -ti tcp:8765 | xargs kill 2>/dev/null
(sleep 1; open "http://localhost:8765") &
echo "Próspera HQ abierta en http://localhost:8765  (cerrá esta ventana para apagarla)"
exec python3 server.py
