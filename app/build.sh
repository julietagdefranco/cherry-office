#!/bin/bash
# Compila Oficina en release y arma "build/Oficina.app" (firma ad-hoc).
# Uso: app/build.sh   (desde cualquier carpeta)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
OUT="$APP_DIR/build"
APP="$OUT/Oficina.app"
EXE="Oficina"

cd "$APP_DIR"
echo "==> swift build -c release"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/$EXE"
[ -x "$BIN" ] || { echo "No encuentro el ejecutable $BIN" >&2; exit 1; }

echo "==> Armando $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/oficina"
cp "$BIN" "$APP/Contents/MacOS/$EXE"
# Sparkle (actualizaciones): el framework va en Contents/Frameworks y el ejecutable lo busca ahí.
SPARKLE="$(dirname "$BIN")/Sparkle.framework"
[ -d "$SPARKLE" ] || { echo "No encuentro $SPARKLE" >&2; exit 1; }
mkdir -p "$APP/Contents/Frameworks"
ditto "$SPARKLE" "$APP/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/$EXE"
cp "$APP_DIR/Resources/Info.plist" "$APP/Contents/Info.plist"

# oficina/ es la única fuente del front; se excluye lo que es solo del modo desarrollo o datos locales.
rsync -a \
  --exclude 'server.py' --exclude 'lanzar.py' --exclude '*.command' \
  --exclude 'config*' --exclude '.datos' --exclude '.sesiones.json' \
  --exclude 'Agentes imagenes' --exclude '__pycache__' --exclude '.DS_Store' \
  --exclude 'README.md' --exclude 'vendor' \
  --exclude '_lab*' --exclude '_fig.html' --exclude '_cara*' --exclude '_figuras_demo.html' \
  --exclude '_labvendor' --exclude '_ldraw' --exclude 'lego_man.json' --exclude 'personajes' \
  --exclude '/js' --exclude 'ui/_*' \
  "$REPO_DIR/oficina/" "$APP/Contents/Resources/oficina/"
# three.js y Poppins offline (versionados en app/Resources/vendor).
rsync -a --exclude '.DS_Store' "$APP_DIR/Resources/vendor/" "$APP/Contents/Resources/oficina/vendor/"

# El bundle tiene que llevar el front modular, las piezas LDraw con sus licencias y el LDrawLoader; y ninguna página de laboratorio.
RES="$APP/Contents/Resources/oficina"
for f in index.html ui/estilo.css ui/piezas.js ui/oficina3d.js ui/bandeja3d.js ui/base.js ui/actividad.js ui/avisos.js ui/entregables.js ui/paleta.js ui/carpetas.js ui/contratar.js ui/yo.js ui/agente.js ui/deptos.js ui/reunion.js ui/biblioteca.js ui/app.js \
         ldraw/catalogo.json ldraw/minifigs.mpd ldraw/LICENSE-LDraw.txt vendor/three.min.js vendor/LDrawLoader.js \
         vendor/LICENSE-three.txt vendor/LICENSE-Poppins-OFL.txt; do
  [ -f "$RES/$f" ] || { echo "Falta en el bundle: oficina/$f" >&2; exit 1; }
done
for f in "$RES"/_* "$RES"/ui/_* "$RES/js" "$RES/lego_man.json" "$RES/personajes"; do
  [ -e "$f" ] && { echo "No debería estar en el bundle: $f" >&2; exit 1; }
done

# Ícono desde app/Resources/icono.svg (si falla, la app queda sin ícono).
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
if swift "$APP_DIR/scripts/make-icon.swift" "$APP_DIR/Resources/icono.svg" "$ICON_TMP/icon.png" 2>/dev/null; then
  SET="$ICON_TMP/AppIcon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_TMP/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ICON_TMP/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  if iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"; then
    echo "==> Ícono generado"
  else
    echo "AVISO: iconutil falló; la app queda sin ícono" >&2
  fi
else
  echo "AVISO: no pude generar el ícono; la app queda sin ícono" >&2
fi

echo "==> Firma ad-hoc"
codesign -s - --force --deep "$APP"
codesign --verify --deep --strict "$APP"
echo "Listo: $APP"
