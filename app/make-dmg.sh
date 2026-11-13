#!/bin/bash
# Empaqueta "build/Oficina.app" en "build/Oficina <versión>.dmg" (UDZO).
# Uso: app/make-dmg.sh [--rebuild]
#   --rebuild        fuerza correr build.sh aunque la .app ya exista.
# Variables de entorno (opcionales):
#   DEVELOPER_ID     "Developer ID Application: Nombre (TEAMID)" -> firma con hardened runtime + timestamp.
#   NOTARY_PROFILE   perfil de `xcrun notarytool store-credentials` -> notariza y hace staple (requiere DEVELOPER_ID).
# Sin DEVELOPER_ID queda la firma ad-hoc de build.sh.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$APP_DIR/build"
APP="$OUT/Oficina.app"
ENTITLEMENTS="$APP_DIR/Resources/Oficina.entitlements"
VOLNAME="Oficina"

REBUILD=0
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    *) echo "Uso: $0 [--rebuild]" >&2; exit 2 ;;
  esac
done

if [ -n "${NOTARY_PROFILE:-}" ] && [ -z "${DEVELOPER_ID:-}" ]; then
  echo "NOTARY_PROFILE requiere DEVELOPER_ID (no se puede notarizar una firma ad-hoc)." >&2
  exit 2
fi

if [ "$REBUILD" = 1 ] || [ ! -d "$APP" ]; then
  "$APP_DIR/build.sh"
fi
[ -d "$APP" ] || { echo "No existe $APP" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG="$OUT/Oficina $VERSION.dmg"

if [ -n "${DEVELOPER_ID:-}" ]; then
  echo "==> Firma Developer ID con hardened runtime"
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" -s "$DEVELOPER_ID" "$APP"
fi
codesign --verify --deep --strict "$APP"

echo "==> Armando $DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# ditto conserva firma, xattrs y symlinks mejor que cp.
ditto "$APP" "$STAGE/Oficina.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ -n "${DEVELOPER_ID:-}" ]; then
  echo "==> Firmando el dmg"
  codesign --force --timestamp -s "$DEVELOPER_ID" "$DMG"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizando (puede tardar unos minutos)"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
  else
    echo "AVISO: sin NOTARY_PROFILE el dmg no queda notarizado; Gatekeeper lo va a advertir." >&2
  fi
else
  echo "AVISO: firma ad-hoc (sin DEVELOPER_ID). Ver app/README.md para abrirla sin firma." >&2
fi

echo "Listo: $DMG"
