# Próspera HQ

Equipo de agentes de IA (Betty, Don Armando, Marce, Doña Catalina, Patricia, Doña Sofía, Mario y Nicolás Mora) más una oficina 3D de LEGO para chatear con cada uno.

- `agentes/` definiciones de los agentes para Claude Code
- `contexto/` contexto maestro de Betty y un ejemplo del estado actual
- `oficina/` la oficina 3D y el servidor de chat local
- `instalar.command` copia los agentes a `~/.claude` y prepara la memoria compartida

## Instalar
1. Doble clic en `instalar.command`.
2. Abrí una sesión nueva de Claude Code (reconoce a los agentes recién ahí).
3. Doble clic en `oficina/Abrir Próspera HQ.command`.

El instalador es seguro de repetir: reemplaza `/Users/julietadefranco` por tu `$HOME` al copiar (así funciona en cualquier usuario o compu), y si un agente ya instalado difiere, guarda antes un respaldo `.bak-AAAAMMDD-HHMMSS` junto al original. Nunca pisa tu `estado-actual.md` ni la memoria compartida.

## Memoria compartida del equipo
El instalador crea `~/Próspera/_equipo/` (solo si falta):
- `decisiones.md`: decisiones confirmadas por Juli, solo se agregan al final, con fecha. Las registra Betty.
- `agentes/<id>.md`: notas de trabajo de cada agente (en qué está, qué entregó, qué espera de quién). Cada agente escribe solo el suyo.

El estado principal sigue en `~/Próspera/_betty/estado-actual.md`. Al empezar, cada agente lee el estado, las decisiones y las notas de los demás que le sirvan. Los permisos de escritura los impone el servidor de la oficina.
Las plantillas están en `contexto/equipo/`.

Nota: en `oficina/server.py` las rutas por defecto se derivan de `$HOME`; los agentes de `agentes/*.md` quedan adaptados por el instalador.
Repositorio privado recomendado: incluye contexto de negocio y el modelo `lego_man.json` (del repo 3d-lego-configurator, sin licencia).
