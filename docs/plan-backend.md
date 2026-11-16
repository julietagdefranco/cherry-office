# Plan: backend robusto de Próspera HQ

Objetivo: misma interacción para Juli (la oficina 3D y el chat se ven y se usan igual), backend más robusto, seguro y mantenible.

## Reglas generales
- La UI no cambia. `index.html` solo recibe el cambio mínimo de "recuperar historial desde el server si el localStorage está vacío".
- Server sin dependencias externas: solo librería estándar de Python. Compatible con **Python 3.9** (el `python3` de las Command Line Tools de macOS): nada de `match` ni `X | Y` en anotaciones de tipos.
- Compatibilidad hacia atrás: sin `config.json`, el comportamiento por defecto en la compu de Juli es idéntico al actual (mismas rutas, mismos agentes, mismos permisos).
- Nunca mover ni borrar datos reales de Juli: `~/Próspera/_betty/estado-actual.md` se queda donde está.

## Instancias (trabajo en paralelo, cada una dueña de sus archivos)

### Instancia A: server (`oficina/server.py`, `oficina/config.ejemplo.json`, `.gitignore`, cambio mínimo en `oficina/index.html`)
1. Seguridad: `--` antes del mensaje en el comando de `claude`; validar `session` como UUID; servir estáticos solo desde una lista blanca (index.html, lego_man.json, logo-prospera.svg, `personajes/*`); validar `Host` (localhost/127.0.0.1 + puerto); Origin obligatorio en POST y dentro de la lista.
2. Configuración: `oficina/config.json` opcional (ignorado por git) + `config.ejemplo.json`. Variables de entorno pisan al archivo. Defaults = valores actuales derivados de `$HOME`.
3. Persistencia: SQLite en `oficina/.datos/hq.db` (tablas `sesiones`, `mensajes`), migración automática desde `.sesiones.json` si existe. Escrituras transaccionales.
4. Ejecución de `claude`: `Popen` con timeout configurable y kill del proceso (y su grupo) al vencer; verificación al arrancar (`claude` existe, `auth status`); errores clasificados.
5. Logs: `oficina/.datos/hq.log` rotativo (RotatingFileHandler), sin contenido de mensajes.
6. Permisos por agente desde config (perfil Betty pasa a ser data).

### Instancia B: lanzador (`oficina/Abrir Próspera HQ.command`, `oficina/lanzar.py` nuevo)
- No matar procesos ajenos: si el puerto responde `/api/estado` con `app == "prospera-hq"`, reutilizar; si está ocupado por otra cosa, elegir otro puerto libre.
- Lógica en `lanzar.py` (multiplataforma); el `.command` queda como envoltorio fino para macOS.

### Instancia C: memoria compartida (`agentes/*.md`, `contexto/`, `instalar.command`, plantillas `_equipo/`)
- Carpeta `~/Próspera/_equipo/` con `decisiones.md` y `agentes/<id>.md`.
- Cada agente lee estado + decisiones al arrancar y puede escribir solo su `_equipo/agentes/<id>.md`. Betty además escribe `decisiones.md` (y su `_betty/estado-actual.md`, como hoy).
- `instalar.command` reemplaza `/Users/julietadefranco` por `$HOME` al copiar, no pisa agentes ni archivos existentes sin respaldo.

### Instancia D (después de A): tests (`oficina/tests/`)
- `pytest` con un `claude` falso vía `CLAUDE_BIN`. Cubre sesiones, resume/session-id, errores, timeout, seguridad (estáticos, Host, Origin, UUID, `--`), historial, permisos por agente, migración desde `.sesiones.json`.

### Integración (al final)
- Correr tests, levantar el server, probar la oficina en el navegador, revisar diff completo.

## Contratos entre instancias
- `GET /api/estado` → `{"app": "prospera-hq", "version": "<semver>", "claude": bool, "agentes": [ids]}`.
- `GET /api/historial?agent=<id>&session=<uuid>` → `{"msgs": [{"r": "u"|"a", "t": "...", "e": true?}]}` (mismo formato que el localStorage del front).
- `POST /api/chat` sin cambios: `{agent, message, session}` → `{reply}` o `{error}`.
- Puerto: env `PORT` (default 8765). El server imprime `Próspera HQ en http://localhost:<puerto>`.
- Permisos de escritura por defecto (rutas relativas al proyecto `~/Próspera`):
  - todos: `_equipo/agentes/<id>.md`
  - betty: además `_betty/estado-actual.md` y `_equipo/decisiones.md`
- Herramientas por defecto: `Read,Glob,Grep,Skill,WebFetch,WebSearch` + `Edit,Write` solo si el agente tiene rutas de escritura (acotadas con `--allowedTools Edit(//ruta)` / `Write(//ruta)`).
