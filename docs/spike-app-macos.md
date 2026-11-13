# Spike del contenedor macOS (riesgos del plan)

Hecho con `HQ_SPIKE=1` (página `__spike.html` embebida en `app/Sources/App/Pages.swift`, backend stub). macOS 27 / Swift 6.4, WKWebView con `WKWebsiteDataStore.default()`. Probado tanto con el ejecutable suelto como dentro de `Próspera HQ.app`.

| # | Riesgo | Resultado |
|---|--------|-----------|
| 1 | Body de POST en `WKURLSchemeHandler` | **OK.** `fetch('/api/echo',{method:'POST',body})` llega en `request.httpBody` (56 bytes de un JSON con tildes; 300 014 bytes en uno grande). `httpBodyStream` no hizo falta; el handler igual lo lee como respaldo. **Plan B (WKUserScript + message handler) no se implementó.** |
| 2 | XHR síncrono de `lego_man.json` sobre `hq://` | **OK.** `status 200`, 449 731 bytes, JSON parseable. |
| 3 | `localStorage` entre reinicios | **OK.** El contador pasó de 1 a 2 en dos arranques seguidos (ejecutable suelto y .app, cada uno con su store). Requiere data store persistente (`.default()`). |
| 4 | `claude auth login` sin TTY | No lo verifica A. El onboarding abre Terminal con un `.command` temporal que corre `<claudePath> auth login`. |

Extra: `GET` con query (`/api/historial?agent=..&session=..`) llega con `query` bien parseado; los fetch relativos `/api/...` resuelven a `hq://app/api/...`.

## Cómo repetirlo
```
cd app && swift build
HQ_SPIKE=1 HQ_SPIKE_EXIT=1 HQ_LOG_REQUESTS=1 HQ_WEB_ROOT=../oficina .build/debug/Oficina
```

## Variables de entorno del contenedor (desarrollo)
`HQ_STUB_API=1` (backend falso; `HQ_STUB_CLAUDE=0` / `HQ_STUB_AUTH=0` fuerzan el onboarding), `HQ_LOG_REQUESTS=1`, `HQ_WEB_ROOT` y `HQ_VENDOR_ROOT` (estáticos sin empaquetar; vendor vive en `app/Resources`), `HQ_INSPECTABLE=1`.
