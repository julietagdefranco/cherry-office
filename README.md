# Próspera HQ

Equipo de agentes de IA (Betty, Don Armando, Marce, Doña Catalina, Patricia, Doña Sofía, Mario y Nicolás Mora) más una oficina 3D de LEGO para chatear con cada uno.

- `agentes/` definiciones de los agentes para Claude Code
- `contexto/` contexto maestro de Betty y un ejemplo del estado actual
- `oficina/` la oficina 3D y el servidor de chat local
- `instalar.command` copia los agentes a `~/.claude`

## Instalar
1. Doble clic en `instalar.command`.
2. Abrí una sesión nueva de Claude Code (reconoce a los agentes recién ahí).
3. Doble clic en `oficina/Abrir Próspera HQ.command`.

Nota: las rutas apuntan a `/Users/julietadefranco/Próspera`. En otra compu hay que ajustarlas en `agentes/*.md` y `oficina/server.py`.
Repositorio privado recomendado: incluye contexto de negocio y el modelo `lego_man.json` (del repo 3d-lego-configurator, sin licencia).
