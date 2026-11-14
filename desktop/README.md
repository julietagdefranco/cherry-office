# Oficina de escritorio (Electron)

La misma oficina en Mac y Windows: una carcasa Electron alrededor del backend TypeScript (`../backend`) y del front
(`../oficina`). Reemplaza a la app Swift (`../app`) en Windows; en Mac la release sigue saliendo de la app Swift.

- `src/main.ts`: ventana, esquema `hq://app/` (estáticos + `/api/*` al router, en proceso), mensajes del front
  (`abrir`, `revelar`, `elegirCarpeta`, `login`…), notificaciones, insignia, bandeja y menú.
- `src/preload.ts`: expone `window.webkit.messageHandlers.hq.postMessage` (lo que espera el front) y la plataforma.
- `src/abrir.ts`, `src/estaticos.ts`: qué se puede abrir y qué se sirve (listas blancas).
- `scripts/build.mjs`: esbuild a `dist/` (el backend va adentro); con `--recursos` arma `build/recursos/oficina`.

```bash
npm ci --prefix ../backend && npm ci
npm start            # compila y abre la app (datos reales: usá HQ_DATA_DIR / HQ_OFICINAS_DIR para probar aparte)
npm run dist:win     # release/Oficina-Setup-<versión>.exe (también se puede armar desde una Mac)
npm run dist:mac     # release/Oficina-<versión>-arm64.dmg (sin firmar)
```

La versión de las releases sale de `app/Resources/Info.plist` (el workflow de release se la pone a `package.json`).
El instalador de Windows no está firmado: SmartScreen avisa la primera vez («Más información» → «Ejecutar de todas formas»).
`build/icon.png` se genera con `swift app/scripts/make-icon.swift app/Resources/icono.svg desktop/build/icon.png`.
