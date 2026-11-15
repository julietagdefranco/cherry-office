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
| `oficina/` | El front (HTML, JS y three.js, con `vendor/` offline): la maqueta 3D y todas las pantallas. |
| `backend/` | El backend en TypeScript (Node): oficinas, agentes, chat, flujos, tareas, biblioteca. La API está en [backend/API.md](backend/API.md). |
| `desktop/` | La app de escritorio: carcasa Electron alrededor de `backend/` y `oficina/`. De acá salen el `.dmg` y el `.exe` de las releases. Ver [desktop/README.md](desktop/README.md). |
| `docs/` | Planes de diseño y `aprendizajes.md` (cómo se comporta el `claude` real). |
| `agentes/`, `contexto/`, `instalar.command` | El equipo original de Próspera (ver abajo). |
| `tools/` | Utilidades sueltas, como el empaquetado de piezas LDraw. |

Hasta la 0.7 la app de Mac era nativa en Swift, con su propio backend; se retiró al pasar las dos plataformas a
Electron (queda en el historial de git, antes de borrar `app/`).

## Desarrollo
La interfaz se prueba en el navegador con el backend, sin armar la app:
```bash
npm ci --prefix backend
npm run dev --prefix backend        # http://localhost:8765
```
Variables útiles: `PORT`, `HQ_DATA_DIR`, `HQ_OFICINAS_DIR`, `CLAUDE_BIN`, `HQ_UI_DIR` (ver `backend/src/dev.ts`).

Tests (con un `claude` falso, sin tocar tus datos ni tu cuenta):
```bash
npm test --prefix backend
```

App de escritorio (Mac o Windows):
```bash
npm ci --prefix backend && npm ci --prefix desktop
npm start --prefix desktop
```

### Releases
La versión sale de `desktop/package.json` (subirla también en `desktop/package-lock.json`, por ejemplo con
`npm version X.Y.Z --no-git-tag-version --prefix desktop`). Al subir una etiqueta `vX.Y.Z`, el workflow
`.github/workflows/release.yml` corre los tests, arma el `.dmg` y el `.exe` y los adjunta a la release de esa etiqueta.
Si la release no existe, la crea como borrador para completar las notas.

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
