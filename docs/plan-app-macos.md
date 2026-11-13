# Plan: Próspera HQ como app nativa de macOS

Este plan reemplaza en parte a `docs/plan-backend.md`.
- **Se mantienen, portadas a Swift:** SQLite, permisos por agente, timeouts, logs, el `--` antes del mensaje, la validación del UUID y la memoria compartida.
- **Desaparecen en la app:** el lanzador, la lista blanca de estáticos y los chequeos de Host/Origin/puerto, porque ya no hay server HTTP.
- **`oficina/server.py` + `lanzar.py`** quedan como modo desarrollo en el navegador y como referencia de la lógica que hay que portar.

## Objetivo
`.dmg` → arrastrar a Aplicaciones → doble clic. Abre la misma oficina 3D, el mismo chat y los mismos 8 agentes, sin Terminal, sin server HTTP y sin Python.

## Entorno de build
- Command Line Tools con Swift 6.4, **sin Xcode** (no hay `xcodebuild`). Todo se compila con `swift build` sobre `app/Package.swift`.
- Target mínimo: macOS 13. Sin dependencias externas. SQLite con `import SQLite3`.
- `app/Package.swift` ya existe y define 3 targets. No cambiar su estructura sin coordinar:
  - `Backend`: librería en `app/Sources/Backend`, dueño **B**.
  - `ProsperaHQ`: ejecutable en `app/Sources/App`, depende de Backend, dueño **A**.
  - `BackendTests`: tests en `app/Tests/BackendTests`, dueño **E**.

## Arquitectura
- **Ventana:** AppKit/SwiftUI con un `WKWebView` que carga `hq://app/index.html`.
- **Esquema `hq://` con `WKURLSchemeHandler`:**
  - Sirve los archivos de `oficina/` copiados al bundle.
  - Atiende `/api/*` delegando en el `Router` del Backend. El `fetch('/api/chat')` relativo del front se resuelve solo.
- **Front:** `oficina/` sigue siendo la única fuente. `app/build.sh` la copia al bundle.
- **Assets offline:** three.js r128 y Poppins van dentro del bundle. En `index.html` solo cambian esas URLs y el texto de error que menciona el `.command`.
- **Datos:** `~/Library/Application Support/Próspera HQ/` (hq.db, hq.log, config.json opcional).
- **Ciclo de vida:** cerrar la ventana o ⌘Q termina los `claude` en curso (terminate y, si no responde, kill).

## Contratos
- `GET /api/estado` → `{"app":"prospera-hq","version":"x.y.z","claude":bool,"agentes":[ids]}`.
  - Para el onboarding se suma `"auth": bool|null` y `"claudePath": string|null`.
- `GET /api/historial?agent=<id>&session=<uuid>` → `{"msgs":[{"r":"u"|"a","t":"...","e":true?}]}`.
  - Sin `session`, devuelve la última sesión del agente: `{"session":sid,"msgs":[...]}`.
- `POST /api/chat` `{agent,message,session}` → `{reply}` o `{error}`.
- **Escritura por defecto** (relativo a `~/Próspera`):
  - todos los agentes: `_equipo/agentes/<id>.md`
  - Betty: además `_betty/estado-actual.md` y `_equipo/decisiones.md`
- **Herramientas por defecto:** `Read,Glob,Grep,Skill`. Se suman `Edit,Write` solo si el agente tiene rutas de escritura, con `--allowedTools Edit(//ruta) Write(//ruta)`.
- **Comando:** `claude -p --agent <id> (--session-id|--resume) <sid> --output-format json --tools ... --add-dir ~/.claude/betty [--allowedTools ...] -- <mensaje>`, con `cwd = ~/Próspera`.
- **Interfaz A↔B,** pública en el módulo Backend:

```swift
public protocol APIHandler: Sendable {
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)
}
// Backend expone:
public final class Backend { public static func makeDefault() throws -> Backend; public var router: APIHandler { get }; public func shutdown() async }
```

## Instancias
- **A, contenedor:** `app/Sources/App/`, `app/build.sh`, `app/Resources/` (Info.plist, ícono, vendor de three.js y Poppins), cambios mínimos de assets en `oficina/index.html`. **Primero el spike de riesgos.**
- **B, backend en Swift:** `app/Sources/Backend/`. Incluye ClaudeLocator, ClaudeRunner, Config, Permisos, Store, Router, Log y la migración.
- **C, memoria compartida:** ✅ hecha (`agentes/*.md`, `contexto/equipo/`, `instalar.command`).
- **D, empaquetado (después de A):** `app/make-dmg.sh`, hardened runtime, sin sandbox, firma ad-hoc o Developer ID si hay. Documentar la apertura sin firma.
- **E, tests (después de B):** `app/Tests/BackendTests/` con un `claude` falso.

## Onboarding
- **Si no encuentra Claude:** pantalla con el link para instalarlo.
- **Si no hay sesión iniciada:** botón "Iniciar sesión" que corre `claude auth login`. Si necesita una TTY, abrir Terminal con ese comando.

## Migración de datos de Juli
- Importar `oficina/.sesiones.json` y `oficina/.datos/hq.db` (si existen) a SQLite la primera vez.
- Importar los mensajes viejos best effort desde `~/.claude/projects/<cwd codificado>/<sid>.jsonl`. Ese formato es interno: tolerar fallos.

## Riesgos (spike de A)
1. ¿`WKURLSchemeHandler` recibe el body del POST? Plan B: `WKUserScript` que intercepta `fetch('/api/*')` y lo manda por `WKScriptMessageHandlerWithReply`.
2. ¿Funciona el XHR síncrono de `lego_man.json` sobre `hq://`?
3. ¿El `localStorage` persiste en `hq://` entre reinicios?
4. ¿`claude auth login` funciona sin TTY desde `Process`?

## Criterios de aceptación
- El `.dmg` abre la oficina sin ninguna Terminal.
- Chat con los 8 agentes. Betty escribe `estado-actual.md` y cada agente escribe solo su archivo de `_equipo/`.
- El historial sobrevive al reinicio. ⌘Q no deja procesos `claude` colgados.
- Sin internet, todo anda salvo las respuestas de Claude.
- Los tests de E pasan. `swift build` y `build.sh` corren limpios.
- No se mueve ni se borra ningún dato real de Juli.
