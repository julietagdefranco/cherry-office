# Oficina

Una oficina 3D estilo LEGO donde trabajan tus agentes de Claude Code. Cada minifig es un agente real
(`.claude/agents/<id>.md`): le hablás, lo llamás a reuniones, le das tareas y te deja lo que termina en tu bandeja.
Hay app para **Mac** y para **Windows**.

## Instalar
Bajá el instalador de la última release en GitHub:
- **Mac** (Apple Silicon, macOS 13+): `Oficina-<versión>-arm64.dmg`. Arrastrá Oficina a Aplicaciones. Como no está
  firmada con Developer ID, la primera vez macOS la bloquea: corré
  `xattr -dr com.apple.quarantine "/Applications/Oficina.app"` o andá a Ajustes del Sistema → Privacidad y
  seguridad → **Abrir igualmente**.
- **Windows** (x64): `Oficina-Setup-<versión>.exe`. No está firmado, así que SmartScreen avisa la primera vez:
  «Más información» → «Ejecutar de todas formas».

En los dos casos hace falta **Claude Code** instalado y con la sesión iniciada. Si falta, la app te avisa al abrir.

## Qué se puede hacer
- **Oficinas:** cada oficina es una carpeta (por defecto `~/Oficinas/<Nombre>/`) con su `oficina.json`, sus agentes,
  su conocimiento, sus reuniones y sus archivos. Podés crear una a mano, **armarla charlando con el Creador** (le contás
  cómo trabajás y te propone departamentos, agentes y flujos), abrir una existente o importar un `.zip` exportado.
- **Quién dirige:** tu nombre y tu minifig, guardados en cada oficina. Tenés tu despacho en la maqueta y una bandeja
  en el escritorio donde los agentes apilan lo que te entregan.
- **Agentes y departamentos:** cada departamento es una sala del edificio. A los agentes los vestís con el editor de
  minifigs (caras, peinados, ropa, sombreros, piel) y les ajustás modelo, permisos y conectores.
- **Chat y reuniones:** clic en un personaje para hablarle en privado, o «Llamar a reunión» para juntar a varios.
- **Flujos:** procesos de varios pasos que pasan de agente en agente, con aprobaciones tuyas donde haga falta. Ves
  cada corrida en vivo y una pieza viaja por la maqueta.
- **Tareas programadas, Parte del día y Biblioteca:** tareas repetidas o de una sola vez, un resumen de lo que pasó y
  qué está trabado, y una biblioteca de documentos con fichas que los agentes pueden consultar.
- **Tiempo libre:** cuando no tienen trabajo, los agentes van a la sala de juegos y café.

## Estructura del repo
| Carpeta | Qué hay |
|---|---|
| `oficina/` | El front (HTML, JS y three.js): la maqueta 3D y todas las pantallas. Única fuente para las dos apps. |
| `app/` | App de Mac en Swift (SwiftUI + WKWebView) con su backend. De acá sale el `.dmg` de las releases. Ver [app/README.md](app/README.md), que también documenta la API. |
| `backend/` | El mismo backend portado a TypeScript, con una suite de paridad que corre contra los dos. Ver [backend/PORTAR.md](backend/PORTAR.md). |
| `desktop/` | Carcasa Electron alrededor de `backend/` y `oficina/`: de acá sale el instalador de Windows. Ver [desktop/README.md](desktop/README.md). |
| `docs/` | Planes de diseño y `aprendizajes.md` (cómo se comporta el `claude` real). |
| `agentes/`, `contexto/`, `instalar.command` | El equipo original de Próspera (ver abajo). |
| `tools/` | Utilidades sueltas, como el empaquetado de piezas LDraw. |

## Desarrollo
La interfaz se prueba en el navegador con el backend Swift, sin compilar la .app:
```bash
cd app && swift run oficina-dev      # http://localhost:8765
```
Variables útiles: `PORT`, `HQ_DATA_DIR`, `HQ_OFICINAS_DIR`, `CLAUDE_BIN` (ver `app/Sources/Dev/main.swift`).

Tests:
```bash
app/Tests/run-tests.sh                 # Swift
npm run test:ts --prefix backend       # paridad contra el backend TS (test:swift, contra el Swift)
```

App de escritorio Electron (Windows o Mac):
```bash
npm ci --prefix backend && npm ci --prefix desktop
npm start --prefix desktop
```

### Releases
La versión sale de `CFBundleShortVersionString` en `app/Resources/Info.plist`; hay que subirla también en
`desktop/package.json` y `desktop/package-lock.json`. Al subir una etiqueta `vX.Y.Z`, el workflow
`.github/workflows/release.yml` corre los tests, arma el `.dmg` y el `.exe` y los adjunta a la release de esa etiqueta.
Si la release no existe, la crea como borrador para completar las notas.

### Actualizaciones automáticas
Las apps instaladas se actualizan solas desde las releases **publicadas** (los borradores no cuentan): publicar la
release es lo que la manda a todos. Las dos buscan al abrir y cada 6 horas, y tienen «Buscar actualizaciones…» en el
menú (Mac: menú Oficina; Windows: Ayuda).
- **Mac (Sparkle 2):** lee `appcast.xml` de la última release, baja `Oficina-<versión>-arm64.zip` y verifica la firma
  EdDSA contra `SUPublicEDKey` de `Info.plist`. Esa firma reemplaza al Developer ID que la app no tiene. Compara
  `CFBundleVersion`, así que **hay que subirlo en cada release** (además de `CFBundleShortVersionString`).
- **Windows (electron-updater):** lee `latest.yml` de la última release, baja el `.exe` en segundo plano (solo lo que
  cambió, con el `.blockmap`) y lo instala al salir o con «Reiniciar ahora».
- El workflow necesita el secret **`SPARKLE_PRIVATE_KEY`** (la clave privada EdDSA). Sin él, una etiqueta falla en vez
  de sacar una release que las Mac no pueden recibir. Si se pierde la clave, las Mac instaladas no aceptan más
  actualizaciones y hay que reinstalar a mano: guardala también en un gestor de contraseñas.
- La primera versión con actualizador hay que instalarla a mano una vez; de ahí en adelante, ya no.

## El equipo de Próspera
El repo nació como el equipo de agentes de Próspera (Betty, Don Armando, Marce, Doña Catalina, Patricia, Doña Sofía,
Mario y Nicolás Mora). Siguen en `agentes/`, con su contexto en `contexto/`.

- `instalar.command` copia los agentes a `~/.claude/agents/`, reemplazando `/Users/julietadefranco` por tu `$HOME`, y
  crea la memoria compartida `~/Próspera/_equipo/` (`decisiones.md` y `agentes/<id>.md`) solo si falta. Se puede repetir:
  si un agente ya instalado difiere, guarda antes un respaldo `.bak-AAAAMMDD-HHMMSS`, y nunca pisa tu
  `estado-actual.md` ni la memoria.
- `docs/caso-prospera/` tiene el texto con el que se probó armar esta oficina con el Creador.

Repositorio privado recomendado: incluye contexto de negocio y el modelo `lego_man.json` (del repo
3d-lego-configurator, sin licencia).
