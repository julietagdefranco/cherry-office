#!/bin/bash
# Corre los tests del backend. Con Command Line Tools (sin Xcode) el plugin de macros de swift-testing
# no está en la ruta por defecto del compilador: hay que pasarla.
cd "$(dirname "$0")/.." || exit 1
PLUGINS="$(dirname "$(xcrun --find swift 2>/dev/null || command -v swift)")/../lib/swift/host/plugins/testing"
exec swift test -Xswiftc -plugin-path -Xswiftc "$PLUGINS" "$@"
