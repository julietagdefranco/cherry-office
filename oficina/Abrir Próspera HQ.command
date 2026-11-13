#!/bin/bash
# Doble clic para abrir la oficina. La primera vez te pide iniciar sesión (una sola vez).
cd "$(dirname "$0")"
PY=$(command -v python3)
if [ -z "$PY" ]; then
  echo "No encontré Python 3 en esta compu."
  echo "Abrí la Terminal, escribí: xcode-select --install   y volvé a probar."
  read -p "Enter para cerrar"
  exit 1
fi
exec "$PY" lanzar.py
