#!/usr/bin/env python3
"""Servidor local de Próspera HQ.

- Sirve la oficina (index.html) en http://localhost:8765
- POST /api/chat       -> habla con un agente real (Claude Code en modo no interactivo).
- GET  /api/historial  -> historial guardado (SQLite) para recuperarlo si el navegador lo perdió.
- GET  /api/estado     -> {"app", "version", "claude", "agentes", "oficina"}.
- Oficinas, departamentos y agentes: /api/oficinas*, /api/oficina, /api/departamentos*, /api/agentes* (misma
  API y mismo JSON que la app nativa: app/Sources/Backend/Router.swift; la lógica común está en tools/hq_core.py).
  Sin oficina abierta, /api/chat, /api/historial y /api/agentes* responden 409.

Solo escucha en 127.0.0.1. Solo librería estándar (Python 3.9+).
Configuración: oficina/config.json (opcional, ver config.ejemplo.json) y variables de entorno
(PORT, CLAUDE_BIN, HQ_CONFIG, HQ_PROYECTO, HQ_DIR_EXTRA, HQ_AGENTES, HQ_TIMEOUT, HQ_DATA_DIR, HQ_OFICINAS_DIR).
La oficina abierta y las recientes se guardan en <datos_dir>/config.json.
Las variables de entorno pisan al archivo; sin nada, los valores por defecto salen de $HOME.
"""
import glob
import json
import logging
import logging.handlers
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import hq_core  # noqa: E402  (lógica de oficinas compartida con tools/importar_prospera.py)
import hq_reuniones  # noqa: E402  (/api/reuniones*, misma lógica que app/Sources/Backend/Reuniones.swift)
import hq_explorador  # noqa: E402  (/api/fs/carpetas, /api/oficina/archivo*; app/Sources/Backend/Explorador.swift)
import hq_biblioteca  # noqa: E402  (/api/archivos*, /api/vinculos*, /api/biblioteca*; app/Sources/Backend/Biblioteca.swift)
import hq_vivo  # noqa: E402  (stream-json, /api/actividad, /api/costos; app/Sources/Backend/{Stream,Actividad}.swift)
import hq_mcp  # noqa: E402  (POST /mcp, /api/consultas; app/Sources/Backend/{MCPProtocolo,MCPServidor,Consultas}.swift)
from hq_core import ErrorAPI  # noqa: E402

VERSION = "1.0.0"
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 200_000
MAX_MENSAJE = 100_000

AGENTES_POR_DEFECTO = ["betty", "don-armando", "marce", "catalina", "patricia", "sofia", "mario", "nicolas"]
HERRAMIENTAS_BASE = "Read,Glob,Grep,Skill"
ESCRITURA_POR_DEFECTO = {
    "*": ["_equipo/agentes/{id}.md"],
    "betty": ["_betty/estado-actual.md", "_equipo/decisiones.md"],
}
ESTATICOS = {"index.html", "logo-prospera.svg"}
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MSG_LOGIN = ("Claude Code todavía no tiene la sesión iniciada para usarse desde la oficina. "
             "Cerrá la ventana negra y volvé a abrir 'Abrir Próspera HQ.command' para iniciar sesión.")

log = logging.getLogger("hq")


# ----------------------------------------------------------------------------- configuración

def _home():
    return os.path.expanduser("~")


def _ruta(p):
    return os.path.abspath(os.path.expanduser(str(p)))


def descubrir_agentes(home=None):
    """Ids de los agentes en ~/.claude/agents/*.md (modo "auto")."""
    base = os.path.join(home or _home(), ".claude", "agents", "*.md")
    ids = [os.path.splitext(os.path.basename(f))[0] for f in sorted(glob.glob(base))]
    return [i for i in ids if ID_RE.match(i)]


def buscar_claude(explicito=None, env=None):
    """CLAUDE_BIN (o config) -> `claude` en el PATH -> app de Claude en macOS (derivada de $HOME)."""
    env = os.environ if env is None else env
    if env.get("CLAUDE_BIN"):
        return env["CLAUDE_BIN"]
    if explicito:
        return _ruta(explicito)
    w = shutil.which("claude")
    if w:
        return w
    pat = os.path.join(_home(), "Library", "Application Support", "Claude", "claude-code",
                       "*", "*", "claude.app", "Contents", "MacOS", "claude")
    c = sorted(glob.glob(pat), key=os.path.getmtime)
    return c[-1] if c else None


def cargar_config(path=None, env=None):
    """Devuelve la configuración final (dict) mezclando defaults, archivo y variables de entorno."""
    env = os.environ if env is None else env
    cfg = {
        "proyecto": "~/Próspera",
        "dirs_extra": ["~/.claude/betty"],
        "agentes": list(AGENTES_POR_DEFECTO),
        "herramientas": HERRAMIENTAS_BASE,
        "herramientas_agente": {},
        "escritura": json.loads(json.dumps(ESCRITURA_POR_DEFECTO)),
        "timeout": 600,
        "puerto": 8765,
        "claude_bin": None,
        "datos_dir": os.path.join(ROOT, ".datos"),
        "oficinas_dir": "~/Oficinas",
        "oficina_dirs_extra": [],
    }
    path = path or env.get("HQ_CONFIG") or os.path.join(ROOT, "config.json")
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                datos = json.load(f)
            if not isinstance(datos, dict):
                raise ValueError("el archivo no es un objeto JSON")
            for k, v in datos.items():
                if k.startswith("_") or k not in cfg or v is None:
                    continue  # claves desconocidas, comentarios o null: se ignoran
                cfg[k] = v
        except Exception as e:
            print("Aviso: no pude leer %s (%s). Uso los valores por defecto." % (path, e), file=sys.stderr)
    if env.get("PORT"):
        cfg["puerto"] = env["PORT"]
    if env.get("HQ_PROYECTO"):
        cfg["proyecto"] = env["HQ_PROYECTO"]
    if env.get("HQ_DIR_EXTRA") is not None:
        cfg["dirs_extra"] = [p for p in env["HQ_DIR_EXTRA"].split(os.pathsep) if p]
    if env.get("HQ_AGENTES"):
        v = env["HQ_AGENTES"].strip()
        cfg["agentes"] = "auto" if v == "auto" else [a.strip() for a in v.split(",") if a.strip()]
    if env.get("HQ_TIMEOUT"):
        cfg["timeout"] = env["HQ_TIMEOUT"]
    if env.get("HQ_DATA_DIR"):
        cfg["datos_dir"] = env["HQ_DATA_DIR"]
    if env.get("HQ_OFICINAS_DIR"):
        cfg["oficinas_dir"] = env["HQ_OFICINAS_DIR"]
    # normalización
    cfg["puerto"] = int(cfg["puerto"])
    cfg["timeout"] = float(cfg["timeout"])
    cfg["proyecto"] = _ruta(cfg["proyecto"])
    extra = cfg["dirs_extra"]
    cfg["dirs_extra"] = [_ruta(p) for p in ([extra] if isinstance(extra, str) else extra or [])]
    cfg["datos_dir"] = _ruta(cfg["datos_dir"])
    cfg["oficinas_dir"] = _ruta(cfg["oficinas_dir"])
    extra2 = cfg["oficina_dirs_extra"]
    cfg["oficina_dirs_extra"] = [_ruta(p) for p in ([extra2] if isinstance(extra2, str) else extra2 or [])]
    if cfg["agentes"] == "auto":
        cfg["agentes"] = descubrir_agentes()
    cfg["agentes"] = [a for a in cfg["agentes"] if isinstance(a, str) and ID_RE.match(a)]
    cfg["claude_bin"] = buscar_claude(cfg["claude_bin"], env)
    return cfg


def rutas_escritura(cfg, agente):
    """Rutas absolutas donde `agente` puede escribir (comodín "*" + las propias)."""
    rel = list(cfg["escritura"].get("*", [])) + list(cfg["escritura"].get(agente, []))
    out = []
    for r in rel:
        r = str(r).replace("{id}", agente)
        p = r if os.path.isabs(os.path.expanduser(r)) else os.path.join(cfg["proyecto"], r)
        p = _ruta(p)
        if p not in out:
            out.append(p)
    return out


def regla_permiso(herramienta, ruta_abs):
    """`Edit(//abs/path)`: la doble barra marca una ruta absoluta para Claude Code."""
    return "%s(//%s)" % (herramienta, ruta_abs.lstrip("/"))


def construir_comando(cfg, agente, msg, sid, flag):
    """Comando exacto de `claude` para un mensaje. `--` evita que msg se lea como opción."""
    herr = cfg["herramientas_agente"].get(agente) or cfg["herramientas"]
    extra = []
    escribibles = rutas_escritura(cfg, agente)
    if escribibles:
        herr += ",Edit,Write"
        extra = ["--allowedTools"] + [regla_permiso(h, p) for p in escribibles for h in ("Edit", "Write")]
    cmd = [cfg["claude_bin"], "-p", "--agent", agente, flag, sid] + hq_vivo.FORMATO_SALIDA + ["--tools", herr]
    for d in cfg["dirs_extra"]:
        cmd += ["--add-dir", d]
    return cmd + extra + ["--", msg]


def contexto_oficina(carpeta, definicion):
    """Rutas absolutas donde un agente de la oficina puede escribir: sus notas, las extra de oficina.json y su
    carpeta de entregables (archivos/entregables/<id>/**, si la oficina tiene biblioteca)."""
    rel = ["conocimiento/agentes/%s.md" % definicion["id"]]
    rel += [r for r in (definicion.get("escritura") or []) if hq_core.ruta_escritura_valida(r)]
    out = [os.path.join(carpeta, r) for r in rel]
    e = hq_core.entregables(carpeta, definicion["id"])
    if e:
        out.append(e)
    return out


def construir_comando_oficina(cfg, carpeta, definicion, msg, sid, flag, oficina=None, mcp_url=None):
    """Como construir_comando pero para un agente de oficina: escritura solo en sus rutas; --add-dir de la config y de
    las carpetas vinculadas a las que el agente tiene acceso (`oficina` = oficina.json). `mcp_url`: URL del servidor MCP
    propio (consultas a colegas, Fase 4); el token va por la variable HQ_MCP_TOKEN del entorno, no en los argumentos."""
    agente = definicion["id"]
    herr = cfg["herramientas_agente"].get(agente) or cfg["herramientas"]
    escribibles = contexto_oficina(carpeta, definicion)
    herr += ",Edit,Write"
    if mcp_url:
        herr += "," + ",".join(hq_mcp.HERRAMIENTAS_MCP)
    cmd = [cfg["claude_bin"], "-p", "--agent", agente, flag, sid] + hq_vivo.FORMATO_SALIDA + ["--tools", herr]
    if mcp_url:
        cmd += ["--mcp-config", hq_mcp.config_mcp(mcp_url)]
    for d in list(cfg["oficina_dirs_extra"]) + hq_core.dirs_vinculos(oficina, definicion):
        cmd += ["--add-dir", d]
    cmd += ["--allowedTools"] + [regla_permiso(h, p) for p in escribibles for h in ("Edit", "Write")]
    if mcp_url:
        cmd += hq_mcp.HERRAMIENTAS_MCP
    return cmd + ["--", msg]


def uuid_valido(s):
    return isinstance(s, str) and bool(UUID_RE.match(s))


def _archivo_en(rel, carpeta):
    """True si rel es un archivo directo (sin subcarpetas ni ocultos) dentro de carpeta."""
    if not rel.startswith(carpeta) or rel.count("/") != 1:
        return False
    nombre = rel.split("/")[1]
    return bool(nombre) and ".." not in rel and not nombre.startswith(".")


def ruta_estatica(path, root=ROOT):
    """Archivo (ruta absoluta) a servir para una URL, o None. Solo lista blanca."""
    p = unquote(urlparse(path).path)
    if p == "/":
        p = "/index.html"
    if "\x00" in p or "\\" in p or not p.startswith("/"):
        return None
    rel = p[1:]
    base = root
    if rel in ESTATICOS:
        full = os.path.join(root, rel)
    elif _archivo_en(rel, "ui/") or _archivo_en(rel, "ldraw/"):
        full = os.path.join(root, rel)
    elif _archivo_en(rel, "vendor/"):
        # three.js y Poppins viven en app/Resources/vendor (los usa también la app nativa).
        base = os.path.join(os.path.dirname(root), "app", "Resources", "vendor")
        full = os.path.join(base, rel.split("/", 1)[1])
    else:
        return None
    full = os.path.realpath(full)
    if not full.startswith(os.path.realpath(base) + os.sep) or not os.path.isfile(full):
        return None
    return full


# ----------------------------------------------------------------------------- persistencia

SCHEMA = """
CREATE TABLE IF NOT EXISTS sesiones (
    sid TEXT PRIMARY KEY,
    agente TEXT NOT NULL,
    activa INTEGER NOT NULL DEFAULT 0,
    creada REAL NOT NULL,
    actualizada REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid TEXT NOT NULL REFERENCES sesiones(sid),
    agente TEXT NOT NULL,
    r TEXT NOT NULL,
    t TEXT NOT NULL,
    e INTEGER NOT NULL DEFAULT 0,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS mensajes_sid ON mensajes(sid, id);
CREATE INDEX IF NOT EXISTS sesiones_agente ON sesiones(agente, actualizada);
"""

# v2: sesiones.oficina (carpeta de la oficina; '' = chats anteriores a las oficinas, que se reclaman al importar Próspera)


class Datos:
    """SQLite con una conexión por operación (hilos del servidor), escrituras transaccionales."""

    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with self._con() as c:
            c.executescript(SCHEMA)
            cols = [r[1] for r in c.execute("PRAGMA table_info(sesiones)").fetchall()]
            if "oficina" not in cols:
                c.execute("ALTER TABLE sesiones ADD COLUMN oficina TEXT NOT NULL DEFAULT ''")
            c.execute("CREATE INDEX IF NOT EXISTS sesiones_oficina ON sesiones(oficina, agente)")

    def _con(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def _tx(self, fn):
        c = self._con()
        try:
            with c:
                return fn(c)
        finally:
            c.close()

    def agente_de(self, sid):
        c = self._con()
        try:
            r = c.execute("SELECT agente FROM sesiones WHERE sid=?", (sid,)).fetchone()
        finally:
            c.close()
        return r[0] if r else None

    def oficina_de(self, sid):
        """Oficina dueña de la sesión ('' = anterior a las oficinas), o None si la sesión no existe."""
        c = self._con()
        try:
            r = c.execute("SELECT oficina FROM sesiones WHERE sid=?", (sid,)).fetchone()
        finally:
            c.close()
        return r[0] if r else None

    def reclamar_legacy(self, oficina):
        """Pasa a `oficina` las sesiones anteriores a las oficinas. -> cuántas."""
        return self._tx(lambda c: c.execute("UPDATE sesiones SET oficina=? WHERE oficina=''", (oficina,)).rowcount)

    def esta_activa(self, sid):
        c = self._con()
        try:
            r = c.execute("SELECT activa FROM sesiones WHERE sid=?", (sid,)).fetchone()
        finally:
            c.close()
        return bool(r and r[0])

    def asegurar_sesion(self, sid, agente, oficina=""):
        ahora = time.time()
        self._tx(lambda c: c.execute(
            "INSERT OR IGNORE INTO sesiones(sid,agente,activa,creada,actualizada,oficina) VALUES(?,?,0,?,?,?)",
            (sid, agente, ahora, ahora, oficina)))

    def marcar_activa(self, sid):
        self._tx(lambda c: c.execute("UPDATE sesiones SET activa=1, actualizada=? WHERE sid=?", (time.time(), sid)))

    def agregar(self, sid, agente, r, t, e=False):
        ahora = time.time()

        def fn(c):
            c.execute("INSERT INTO mensajes(sid,agente,r,t,e,ts) VALUES(?,?,?,?,?,?)",
                      (sid, agente, r, t, 1 if e else 0, ahora))
            c.execute("UPDATE sesiones SET actualizada=? WHERE sid=?", (ahora, sid))
        self._tx(fn)

    def mensajes(self, sid, limite=500):
        c = self._con()
        try:
            filas = c.execute("SELECT r,t,e FROM (SELECT id,r,t,e FROM mensajes WHERE sid=? "
                              "ORDER BY id DESC LIMIT ?) ORDER BY id", (sid, limite)).fetchall()
        finally:
            c.close()
        out = []
        for r, t, e in filas:
            m = {"r": r, "t": t}
            if e:
                m["e"] = True
            out.append(m)
        return out

    def ultima_sesion(self, agente, oficina=""):
        """Sesión más reciente del agente (en esa oficina) que tenga mensajes, o None."""
        c = self._con()
        try:
            r = c.execute("SELECT s.sid FROM sesiones s WHERE s.agente=? AND s.oficina=? AND EXISTS "
                          "(SELECT 1 FROM mensajes m WHERE m.sid=s.sid) "
                          "ORDER BY (SELECT MAX(id) FROM mensajes m WHERE m.sid=s.sid) DESC LIMIT 1",
                          (agente, oficina)).fetchone()
        finally:
            c.close()
        return r[0] if r else None

    def migrar_json(self, path):
        """Importa el viejo .sesiones.json ({sid: agente}) como sesiones activas. Idempotente."""
        if not os.path.isfile(path):
            return 0
        try:
            with open(path, encoding="utf-8") as f:
                viejo = json.load(f)
        except Exception:
            return 0
        if not isinstance(viejo, dict):
            return 0
        ahora = time.time()
        filas = [(s, a, ahora, ahora) for s, a in viejo.items() if uuid_valido(s) and isinstance(a, str)]

        def fn(c):
            n = 0
            for f in filas:
                cur = c.execute("INSERT OR IGNORE INTO sesiones(sid,agente,activa,creada,actualizada) "
                                "VALUES(?,?,1,?,?)", f)
                n += cur.rowcount
            return n
        return self._tx(fn)


# ----------------------------------------------------------------------------- ejecución de claude

class TiempoAgotado(Exception):
    pass


def matar_grupo(p):
    """Mata el proceso y todo su grupo (claude puede lanzar hijos)."""
    try:
        if hasattr(os, "killpg"):
            os.killpg(p.pid, signal.SIGKILL)
        else:
            p.kill()
    except (ProcessLookupError, PermissionError, OSError):
        try:
            p.kill()
        except Exception:
            pass


_CONFIG_DE_USUARIO = {
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_SUBAGENT_MODEL",
}


def heredada_de_sesion(k):
    """Variables que una sesión de Claude Code inyecta a sus hijos (igual que ClaudeLocator.heredadaDeSesion).

    Si el server se lanza desde una sesión, el `claude` hijo las hereda, se cree anidado y no guarda el
    transcript. Se conservan CLAUDE_CODE_USE_* / CLAUDE_CODE_SKIP_* y la config puesta por el usuario.
    """
    if k in ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT") or k.startswith("CLAUDE_AGENT_SDK_"):
        return True
    if not k.startswith("CLAUDE_CODE_"):
        return False
    if k.startswith("CLAUDE_CODE_USE_") or k.startswith("CLAUDE_CODE_SKIP_"):
        return False
    return k not in _CONFIG_DE_USUARIO


def entorno_hijo(env=None):
    env = os.environ if env is None else env
    return {k: v for k, v in env.items() if not heredada_de_sesion(k)}


def ejecutar(cmd, cwd, timeout, al_linea=None, env_extra=None):
    """Corre cmd; devuelve (returncode, stdout, stderr). TiempoAgotado si vence (mata el grupo).
    `al_linea`: recibe cada línea de stdout apenas llega (stream-json). `env_extra`: variables extra para el hijo."""
    kw = {"start_new_session": True} if os.name == "posix" else {}
    env = entorno_hijo()
    env.update(env_extra or {})
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, text=True, env=env, **kw)
    if al_linea is not None:
        return _ejecutar_por_lineas(p, timeout, al_linea)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        matar_grupo(p)
        try:
            p.communicate(timeout=5)
        except Exception:
            pass
        raise TiempoAgotado()
    return p.returncode, out, err


def _ejecutar_por_lineas(p, timeout, al_linea):
    lineas, errores = [], []

    def leer_out():
        for linea in p.stdout:
            lineas.append(linea)
            try:
                al_linea(linea.rstrip("\n"))
            except Exception:
                log.exception("al_linea falló")

    def leer_err():
        errores.append(p.stderr.read())
    hilos = [threading.Thread(target=leer_out, daemon=True), threading.Thread(target=leer_err, daemon=True)]
    for h in hilos:
        h.start()
    try:
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        matar_grupo(p)
        try:
            p.wait(timeout=5)
        except Exception:
            pass
        raise TiempoAgotado()
    for h in hilos:
        h.join(timeout=5)
    for f in (p.stdout, p.stderr):
        try:
            f.close()
        except Exception:
            pass
    return p.returncode, "".join(lineas), "".join(errores)


def error_de(rc, stdout, stderr, out):
    """Texto de error de una corrida, o None si fue bien."""
    if out is not None and out.get("is_error"):
        return str(out.get("result") or "Error desconocido")
    if rc != 0:
        return (stdout or stderr or "Error desconocido")[-600:]
    return None


def clasificar_error(e):
    """-> (tipo, mensaje amigable). Tipos: login, claude."""
    if "login" in e.lower():
        return "login", MSG_LOGIN
    return "claude", e


# ----------------------------------------------------------------------------- aplicación

_DIFERIDO = object()  # _despachar devuelve (_DIFERIDO, fn): fn corre después de soltar self.mut


class App:
    def __init__(self, cfg, sesiones_json=None):
        self.cfg = cfg
        self.puerto = cfg["puerto"]
        self.hosts = {"localhost:%d" % self.puerto, "127.0.0.1:%d" % self.puerto}
        self.origenes = {"http://" + h for h in self.hosts}
        self.claude = cfg["claude_bin"]
        self.locks = {}
        self.locks_guard = threading.Lock()
        self.mut = threading.RLock()  # serializa lecturas-modificaciones-escrituras de oficina.json y del estado
        self.db = Datos(os.path.join(cfg["datos_dir"], "hq.db"))
        self.actividad = hq_vivo.Actividad()
        self.costos = hq_vivo.Costos(os.path.join(cfg["datos_dir"], "hq.db"))
        self.migrados = self.db.migrar_json(sesiones_json or os.path.join(ROOT, ".sesiones.json"))
        self.auth_ok = None
        self.home = _home()
        self.estado_path = os.path.join(cfg["datos_dir"], "config.json")
        self.activa_carpeta = None
        self.recientes = []
        self.reuniones = None  # hook para /api/reuniones*: callable(metodo, path, query, body) -> (code, obj) | None
        self.biblioteca = None  # hook para /api/archivos*, /api/vinculos*, /api/biblioteca*: igual que reuniones
        self.explorador = None  # hook para /api/fs/carpetas y /api/oficina/archivo*: igual que reuniones
        self.mcp = None  # servidor MCP propio (hq_mcp.MCP): consultas entre agentes. None = los chats corren sin consultas
        self._cargar_estado()

    # ---- estado de la app: oficina activa y recientes (<datos_dir>/config.json)

    def _leer_estado(self):
        try:
            with open(self.estado_path, encoding="utf-8") as f:
                o = json.load(f)
            return o if isinstance(o, dict) else None
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return None

    def _cargar_estado(self):
        o = self._leer_estado() or {}
        a = o.get("oficina_activa")
        self.activa_carpeta = a if isinstance(a, str) and a else None
        self.recientes = [r for r in (o.get("oficinas_recientes") or [])
                          if isinstance(r, dict) and isinstance(r.get("carpeta"), str)]

    def _guardar_estado(self):
        o = self._leer_estado()
        if o is None:
            log.warning("config.json ilegible: no guardo la oficina activa")
            return
        o["oficina_activa"] = self.activa_carpeta
        o["oficinas_recientes"] = self.recientes
        try:
            os.makedirs(self.cfg["datos_dir"], exist_ok=True)
            hq_core.escribir_atomico(self.estado_path, json.dumps(o, ensure_ascii=False, indent=2, sort_keys=True))
        except (OSError, ErrorAPI):
            log.error("no pude guardar config.json")

    def activar(self, carpeta, nombre):
        self.activa_carpeta = carpeta
        self.recientes = [r for r in self.recientes if r.get("carpeta") != carpeta]
        self.recientes.insert(0, {"carpeta": carpeta, "nombre": nombre, "abierta": time.time()})
        self.recientes = self.recientes[:10]
        self._guardar_estado()

    def activa(self):
        """(carpeta, oficina) leída del disco, o None (ninguna abierta o ya no es válida)."""
        if not self.activa_carpeta:
            return None
        try:
            return self.activa_carpeta, hq_core.leer_oficina(self.activa_carpeta)
        except ErrorAPI:
            return None

    def requerir_activa(self):
        a = self.activa()
        if a is None:
            raise ErrorAPI(409, hq_core.SIN_OFICINA)
        return a

    def _reclamar_si_prospera(self, carpeta):
        if os.path.exists(os.path.join(carpeta, hq_core.MARCA_PROSPERA)):
            n = self.db.reclamar_legacy(carpeta)
            if n:
                log.info("chats anteriores asignados a la oficina importada: %d", n)

    def _escanear_vinculos_en_segundo_plano(self, o):
        """Al abrir una oficina se vuelven a escanear sus carpetas vinculadas (archivos nuevos o cambiados), sin bloquear."""
        ids = [v["id"] for v in (o or {}).get("vinculos") or []]
        if not ids or self.biblioteca is None:
            return

        def trabajo():
            for id_ in ids:
                try:
                    self.biblioteca("POST", "/api/vinculos/%s/escanear" % id_, {}, b"{}")
                except Exception:
                    log.exception("no pude escanear la carpeta vinculada %s", id_)
        threading.Thread(target=trabajo, daemon=True).start()

    # ---- estado, historial y chat

    def estado(self):
        a = self.activa()
        return {"app": "prospera-hq", "version": VERSION, "claude": bool(self.claude),
                "agentes": sorted(x["id"] for x in a[1]["agentes"]) if a else [],
                "oficina": {"carpeta": a[0], "nombre": a[1]["nombre"]} if a else None}

    def verificar_claude(self):
        """Chequeo de arranque (no bloquea): claude existe y `auth status`."""
        if not self.claude:
            log.error("claude no encontrado")
            return
        try:
            rc, _, _ = ejecutar([self.claude, "auth", "status"], self.cfg["proyecto"]
                                if os.path.isdir(self.cfg["proyecto"]) else None, 30)
            self.auth_ok = (rc == 0)
            log.info("claude=%s auth_status_rc=%s", self.claude, rc)
        except TiempoAgotado:
            log.warning("claude auth status: tiempo agotado")
        except Exception as e:
            log.error("claude no se pudo ejecutar (%s)", type(e).__name__)

    def _lock(self, carpeta, agente):
        with self.locks_guard:
            return self.locks.setdefault((carpeta, agente), threading.Lock())

    def chat(self, carpeta, definicion, msg, sid):
        """Procesa un mensaje a un agente de la oficina activa. -> (http_status, dict)."""
        cfg = self.cfg
        agente = definicion["id"]
        if not self.claude:
            return 500, {"error": "No encontré Claude Code en esta compu."}
        if not os.path.isdir(carpeta):
            log.error("chat agente=%s tipo=sin_proyecto", agente)
            return 500, {"error": "No encuentro la carpeta del proyecto (%s)." % carpeta}
        dueno = self.db.agente_de(sid)
        if dueno is not None and dueno != agente:
            return 400, {"error": "pedido inválido"}
        of_sesion = self.db.oficina_de(sid)
        if of_sesion is not None and of_sesion != carpeta:
            return 400, {"error": "pedido inválido"}
        t0 = time.time()
        try:
            ofi = hq_core.leer_oficina(carpeta)
        except ErrorAPI:
            ofi = None
        with self._lock(carpeta, agente):
            self.db.asegurar_sesion(sid, agente, carpeta)
            self.db.agregar(sid, agente, "u", msg)

            caja = hq_vivo.CajaCosto()
            # consultas a colegas: el token vive lo que dura este chat (se revoca al terminar)
            token = self.mcp.tokens.emitir(carpeta, agente, sid) if self.mcp else None
            try:
                with self.actividad.seguir(carpeta, agente, "chat", msg, extra=caja.observador()) as (obs, _token):
                    return self._chat_correr(carpeta, definicion, msg, sid, ofi, obs, t0, token)
            finally:
                if token:
                    self.mcp.tokens.revocar(token)
                self.costos.registrar(carpeta, "chat", caja.valor, agente, sid)

    def _chat_correr(self, carpeta, definicion, msg, sid, ofi, obs, t0, token=None):
        """Corre claude para un mensaje (con el carril ya tomado) y guarda la respuesta. -> (http_status, dict)."""
        cfg, agente = self.cfg, definicion["id"]

        def correr(flag):
            rc, so, se = ejecutar(construir_comando_oficina(cfg, carpeta, definicion, msg, sid, flag, oficina=ofi,
                                                            mcp_url=self.mcp.url() if token else None),
                                  carpeta, cfg["timeout"], al_linea=hq_vivo.lector(obs),
                                  env_extra={hq_mcp.VARIABLE_TOKEN: token} if token else None)
            return rc, so, se, hq_vivo.ultimo_json(so)

        try:
            flag = "--resume" if self.db.esta_activa(sid) else "--session-id"
            rc, so, se, out = correr(flag)
            e = error_de(rc, so, se, out)
            # si la conversación ya existe (o no existe), probamos la otra forma
            if e and "already in use" in e:
                rc, so, se, out = correr("--resume")
                e = error_de(rc, so, se, out)
            elif e and flag == "--resume" and ("No conversation" in e or "not found" in e.lower()):
                rc, so, se, out = correr("--session-id")
                e = error_de(rc, so, se, out)
        except TiempoAgotado:
            texto = "Tardó demasiado en responder."
            self.db.agregar(sid, agente, "a", "No pude responder: " + texto, True)
            log.warning("chat agente=%s sid=%s tipo=timeout seg=%.1f", agente, sid[:8], time.time() - t0)
            return 504, {"error": texto}
        except (FileNotFoundError, PermissionError, OSError) as ex:
            texto = "No pude ejecutar Claude Code en esta compu."
            self.db.agregar(sid, agente, "a", "No pude responder: " + texto, True)
            log.error("chat agente=%s sid=%s tipo=no_ejecuta (%s)", agente, sid[:8], type(ex).__name__)
            return 500, {"error": texto}
        if e:
            tipo, texto = clasificar_error(e)
            self.db.agregar(sid, agente, "a", "No pude responder: " + texto, True)
            log.warning("chat agente=%s sid=%s tipo=%s rc=%s seg=%.1f", agente, sid[:8], tipo, rc, time.time() - t0)
            return 500, {"error": texto}
        texto = (out or {}).get("result") or so.strip()
        self.db.marcar_activa(sid)
        self.db.agregar(sid, agente, "a", texto or "(sin respuesta)")
        log.info("chat agente=%s sid=%s tipo=ok seg=%.1f", agente, sid[:8], time.time() - t0)
        return 200, {"reply": texto}

    def historial(self, carpeta, agente, sid):
        if sid is None:
            ult = self.db.ultima_sesion(agente, carpeta)
            return 200, {"session": ult, "msgs": self.db.mensajes(ult) if ult else []}
        if self.db.agente_de(sid) not in (None, agente):
            return 200, {"msgs": []}
        if self.db.oficina_de(sid) not in (None, carpeta):
            return 200, {"msgs": []}
        return 200, {"msgs": self.db.mensajes(sid)}

    # ---- claude sin agente (borradores)

    def correr_sin_agente(self, prompt, cwd):
        """`claude -p` sin agente y sin herramientas. -> texto de `result`; ErrorAPI(502) si falla. Registra el costo."""
        def falla(m):
            return ErrorAPI(502, "No pude armar el borrador del agente: " + m)
        if not self.claude:
            raise falla("No encontré Claude Code en esta compu.")
        try:
            caja = hq_vivo.CajaCosto()
            rc, so, se = ejecutar([self.claude, "-p"] + hq_vivo.FORMATO_SALIDA + ["--tools", "", "--", prompt],
                                  cwd, self.cfg["timeout"], al_linea=hq_vivo.lector(caja.observador()))
            self.costos.registrar(cwd, "borrador", caja.valor)
        except TiempoAgotado:
            raise falla("Tardó demasiado en responder.")
        except (FileNotFoundError, PermissionError, OSError):
            raise falla("No pude ejecutar Claude Code en esta compu.")
        out = hq_vivo.ultimo_json(so)
        e = error_de(rc, so, se, out)
        if e:
            raise falla(clasificar_error(e)[1])
        return (out or {}).get("result") or (so.strip() if out is None else "")

    # ---- en vivo (fuera de self.mut: no se traba mientras dura un chat)

    def vivo(self, metodo, path, query):
        """/api/actividad y /api/costos. -> (status, dict) o None si no es una de esas rutas."""
        if path not in ("/api/actividad", "/api/costos"):
            return None
        if metodo != "GET":
            return 405, {"error": "método no permitido"}
        carpeta = self.activa_carpeta
        if path == "/api/actividad":
            return 200, (self.actividad.json(carpeta) if carpeta else {"agentes": {}, "version": 0})
        if not carpeta:
            return 409, {"error": "No hay una oficina abierta."}
        try:
            desde = float((query.get("desde") or ["0"])[0])
        except ValueError:
            desde = 0.0
        return 200, self.costos.totales(carpeta, desde)

    # ---- API

    def api(self, metodo, path, query, body):
        """Despacha /api/*. -> (http_status, dict). `body` son bytes o None."""
        no = (405, {"error": "método no permitido"})
        partes = path.split("/")[1:]
        if not path.startswith("/") or len(partes) < 2 or partes[0] != "api" or "" in partes:
            return 404, {"error": "no"}
        try:
            with self.mut:
                r = self._despachar(metodo, partes, query, body, no)
            if r[0] is _DIFERIDO:
                return r[1]()
            return r
        except ErrorAPI as e:
            return e.status, {"error": e.mensaje}

    def _objeto(self, body, opcional=False):
        if not body:
            if opcional:
                return {}
            raise ErrorAPI(400, "pedido inválido")
        if len(body) > MAX_BODY:
            raise ErrorAPI(413, "pedido demasiado grande")
        try:
            d = json.loads(body)
        except ValueError:
            raise ErrorAPI(400, "pedido inválido")
        if not isinstance(d, dict):
            raise ErrorAPI(400, "pedido inválido")
        return d

    @staticmethod
    def _sobre_oficina(carpeta, o):
        return {"carpeta": carpeta, "oficina": o}

    def _despachar(self, m, partes, query, body, no):
        n, p1 = len(partes), partes[1]
        if p1 == "estado" and n == 2:
            return (200, self.estado()) if m == "GET" else no
        if p1 == "historial" and n == 2:
            if m != "GET":
                return no
            carpeta, o = self.requerir_activa()
            agente = (query.get("agent") or [""])[0]
            sid = (query.get("session") or [None])[0]
            if not any(a["id"] == agente for a in o["agentes"]):
                return 400, {"error": "pedido inválido"}
            if sid is not None and not uuid_valido(sid):
                return 400, {"error": "pedido inválido"}
            return self.historial(carpeta, agente, sid.lower() if sid else None)
        if p1 == "chat" and n == 2:
            if m != "POST":
                return no
            carpeta, o = self.requerir_activa()
            try:
                d = json.loads(body or b"")
                agente, msg, sid = d["agent"], str(d["message"]).strip(), d["session"]
            except Exception:
                return 400, {"error": "pedido inválido"}
            definicion = next((a for a in o["agentes"] if a["id"] == agente), None) if isinstance(agente, str) else None
            if (definicion is None or not msg or len(msg) > MAX_MENSAJE or not uuid_valido(sid)):
                return 400, {"error": "pedido inválido"}
            # el chat corre FUERA de self.mut (ver api): si no, un chat largo traba /api/estado y todo el resto
            return _DIFERIDO, lambda: self.chat(carpeta, definicion, msg, sid.lower())
        if p1 == "consultas" and n == 2:
            if m != "GET":
                return no
            carpeta, o = self.requerir_activa()
            sid = (query.get("session") or [""])[0]
            if not uuid_valido(sid) or not self.mcp:
                return 400, {"error": "pedido inválido"}
            nombres = {a["id"]: a["nombre"] for a in o["agentes"]}
            return 200, {"consultas": self.mcp.lista(carpeta, sid.lower(), nombres)}
        if p1 == "oficinas":
            return self._oficinas(m, partes, body, no)
        if p1 == "oficina" and n == 2:
            if m == "GET":
                return 200, self._sobre_oficina(*self.requerir_activa())
            if m == "PATCH":
                d = self._objeto(body)
                carpeta, _ = self.requerir_activa()
                o = hq_core.editar_oficina(carpeta, hq_core.texto(d.get("nombre"), "nombre", 80, False),
                                           hq_core.texto(d.get("duenio"), "duenio", 80, False))
                self.activar(carpeta, o["nombre"])
                return 200, self._sobre_oficina(carpeta, o)
            return no
        if p1 == "departamentos":
            return self._departamentos(m, partes, query, body, no)
        if p1 == "agentes":
            return self._agentes(m, partes, body, no)
        return 404, {"error": "no"}

    def _oficinas(self, m, partes, body, no):
        n = len(partes)
        if n == 2:
            if m == "GET":
                out = []
                for r in sorted(self.recientes, key=lambda r: -float(r.get("abierta") or 0)):
                    try:
                        o = hq_core.leer_oficina(r["carpeta"])
                    except ErrorAPI:
                        continue
                    out.append({"carpeta": r["carpeta"], "nombre": o["nombre"], "activa": r["carpeta"] == self.activa_carpeta})
                a = self.activa()
                return 200, {"oficinas": out, "activa": a[0] if a else None}
            if m != "POST":
                return no
            d = self._objeto(body)
            deps = d.get("departamentos")
            if deps is not None:
                if not isinstance(deps, list):
                    raise ErrorAPI(400, "«departamentos» tiene que ser una lista.")
                lista = []
                for x in deps:
                    if isinstance(x, str):
                        lista.append({"nombre": x})
                    elif isinstance(x, dict):
                        lista.append({"id": hq_core.texto(x.get("id"), "id", 41, False),
                                      "nombre": hq_core.texto(x.get("nombre"), "nombre", 60),
                                      "color": hq_core.texto(x.get("color"), "color", 7, False)})
                    else:
                        raise ErrorAPI(400, "Cada departamento es un texto o un objeto {nombre, color?}.")
                deps = lista
            carpeta, o = hq_core.crear_oficina(
                self.cfg["oficinas_dir"], self.home, hq_core.texto(d.get("nombre"), "nombre", 80),
                hq_core.texto(d.get("duenio"), "duenio", 80, False) or "",
                hq_core.texto(d.get("carpeta"), "carpeta", 1024, False), deps)
            self.activar(carpeta, o["nombre"])
            log.info("oficina creada departamentos=%d", len(o["departamentos"]))
            return 200, self._sobre_oficina(carpeta, o)
        if n == 3 and partes[2] == "abrir":
            if m != "POST":
                return no
            d = self._objeto(body)
            carpeta, o = hq_core.abrir_oficina(self.home, hq_core.texto(d.get("carpeta"), "carpeta", 1024))
            self.activar(carpeta, o["nombre"])
            self._reclamar_si_prospera(carpeta)
            self._escanear_vinculos_en_segundo_plano(o)
            return 200, self._sobre_oficina(carpeta, o)
        if n == 3 and partes[2] == "importar-prospera":
            if m != "POST":
                return no
            d = self._objeto(body, opcional=True)
            repo = os.path.dirname(ROOT)
            r = hq_core.importar_prospera(self.cfg["oficinas_dir"], self.home, self.cfg["proyecto"],
                                          origen=hq_core.texto(d.get("origen"), "origen", 1024, False),
                                          repo_defecto=repo if os.path.isdir(os.path.join(repo, "agentes")) else None)
            self.activar(r["carpeta"], r["oficina"]["nombre"])
            self._reclamar_si_prospera(r["carpeta"])
            self._escanear_vinculos_en_segundo_plano(r["oficina"])
            out = self._sobre_oficina(r["carpeta"], r["oficina"])
            out.update({"yaExistia": r["yaExistia"], "agentesImportados": r["agentes"],
                        "faltantes": r["faltantes"], "copiados": r["copiados"]})
            return 200, out
        return 404, {"error": "no"}

    def _departamentos(self, m, partes, query, body, no):
        n = len(partes)
        if n == 2:
            if m != "POST":
                return no
            d = self._objeto(body)
            carpeta, _ = self.requerir_activa()
            dep, o = hq_core.crear_departamento(carpeta, {
                "id": hq_core.texto(d.get("id"), "id", 41, False), "nombre": hq_core.texto(d.get("nombre"), "nombre", 60),
                "color": hq_core.texto(d.get("color"), "color", 7, False)})
            return 200, {"departamento": dep, "oficina": o}
        if n == 3:
            id_ = partes[2]
            if not hq_core.slug_valido(id_):
                return 404, {"error": "no"}
            if m == "PATCH":
                d = self._objeto(body)
                carpeta, _ = self.requerir_activa()
                dep, o = hq_core.editar_departamento(carpeta, id_, hq_core.texto(d.get("nombre"), "nombre", 60, False),
                                                     hq_core.texto(d.get("color"), "color", 7, False))
                return 200, {"departamento": dep, "oficina": o}
            if m == "DELETE":
                d = self._objeto(body, opcional=True)
                carpeta, _ = self.requerir_activa()
                mover = d.get("moverA") if isinstance(d.get("moverA"), str) else (query.get("moverA") or [None])[0]
                return 200, {"ok": True, "oficina": hq_core.borrar_departamento(carpeta, id_, mover)}
            return no
        return 404, {"error": "no"}

    def _agentes(self, m, partes, body, no):
        n = len(partes)
        if n == 2:
            if m == "GET":
                return 200, {"agentes": self.requerir_activa()[1]["agentes"]}
            if m == "POST":
                nuevo = hq_core.nuevo_agente(self._objeto(body))
                carpeta, _ = self.requerir_activa()
                definicion, o = hq_core.contratar(carpeta, nuevo)
                log.info("agente contratado id=%s", definicion["id"])
                return 200, {"agente": definicion, "oficina": o}
            return no
        if n == 3 and partes[2] == "borrador":
            if m != "POST":
                return no
            d = self._objeto(body)
            carpeta, _ = self.requerir_activa()
            o, prompt = hq_core.preparar_borrador(carpeta, d.get("descripcion"), d.get("departamento"))
            texto = self.correr_sin_agente(prompt, carpeta)
            ocupados = {a["id"] for a in (self.activa() or (carpeta, o))[1]["agentes"]}
            b = hq_core.parsear_borrador(texto, ocupados)
            if b is None:
                log.error("borrador: respuesta sin JSON válido")
                raise ErrorAPI(502, "Claude no devolvió un borrador que pueda usar. Probá de nuevo con otra descripción.")
            b["departamento"] = d.get("departamento") or ""
            return 200, b
        if n >= 3:
            id_ = partes[2]
            if not hq_core.slug_valido(id_):
                return 404, {"error": "no"}
            if n == 3:
                if m == "GET":
                    carpeta, _ = self.requerir_activa()
                    return 200, hq_core.detalle_agente(carpeta, id_)
                if m == "PATCH":
                    c = hq_core.cambios_agente(self._objeto(body))
                    carpeta, _ = self.requerir_activa()
                    definicion, o = hq_core.editar_agente(carpeta, id_, c)
                    return 200, {"agente": definicion, "oficina": o}
                if m == "DELETE":
                    carpeta, _ = self.requerir_activa()
                    rel, o = hq_core.despedir(carpeta, id_)
                    log.info("agente despedido id=%s", id_)
                    return 200, {"ok": True, "archivado": rel, "oficina": o}
                return no
            if n == 4 and partes[3] == "conocimiento":
                if m != "GET":
                    return no
                carpeta, _ = self.requerir_activa()
                return 200, hq_core.conocimiento(carpeta, id_)
        return 404, {"error": "no"}


def crear_handler(app):
    class H(BaseHTTPRequestHandler):
        server_version = "ProsperaHQ"
        sys_version = ""

        def log_message(self, fmt, *a):
            pass  # nada de contenido en logs; los eventos de chat se registran aparte

        def _enviar(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # el cliente se fue; no hace falta matar nada

        def _json(self, code, obj):
            self._enviar(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                         "application/json; charset=utf-8")

        def _host_ok(self):
            if (self.headers.get("Host") or "").lower() in app.hosts:
                return True
            self._json(403, {"error": "host no permitido"})
            return False

        def do_GET(self):
            if not self._host_ok():
                return
            u = urlparse(self.path)
            if u.path == "/mcp":  # el sondeo SSE de claude: solo se atiende POST
                self.send_response(405)
                self.send_header("Allow", "POST")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if u.path.startswith("/api/") or u.path == "/api":
                return self._api("GET", u, None)
            f = ruta_estatica(self.path)
            if not f:
                return self._json(404, {"error": "no"})
            try:
                with open(f, "rb") as fh:
                    body = fh.read()
            except OSError:
                return self._json(404, {"error": "no"})
            ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml", "application/javascript"):
                ctype += "; charset=utf-8"
            self._enviar(200, body, ctype)

        def _escritura(self, metodo):
            """POST / PATCH / DELETE: mismas defensas que siempre (Host, Origin, JSON, tamaño)."""
            if not self._host_ok():
                return
            u = urlparse(self.path)
            if not u.path.startswith("/api/"):
                return self._json(404, {"error": "no"})
            if self.headers.get("Origin") not in app.origenes:
                return self._json(403, {"error": "origen no permitido"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._json(400, {"error": "pedido inválido"})
            limite = app.biblioteca.max_body(u.path) if app.biblioteca else MAX_BODY
            if n < 0 or n > limite:
                return self._json(413, {"error": "pedido demasiado grande"})
            if n > 0 and "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(415, {"error": "se espera JSON"})
            if n == 0 and metodo != "DELETE" and "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(415, {"error": "se espera JSON"})
            return self._api(metodo, u, self.rfile.read(n) if n else None)

        def _mcp(self):
            """POST /mcp (servidor MCP propio): lo llama el proceso `claude`, no un navegador. Host de loopback (ya
            validado) y token Bearer; sin chequeo de Origin."""
            if not self._host_ok():
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._json(400, {"error": "pedido inválido"})
            if n < 0 or n > hq_mcp.MAX_CUERPO:
                return self._json(413, {"error": "pedido demasiado grande"})
            if not app.mcp:
                return self._json(404, {"error": "no"})
            code, cuerpo, extra = app.mcp.http(self.headers.get("Authorization"), self.rfile.read(n) if n else b"")
            self.send_response(code)
            if cuerpo:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.send_header("Cache-Control", "no-store")
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(cuerpo)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            if urlparse(self.path).path == "/mcp":
                return self._mcp()
            self._escritura("POST")

        def do_PATCH(self):
            self._escritura("PATCH")

        def do_DELETE(self):
            self._escritura("DELETE")

        def _api(self, metodo, u, body):
            q = parse_qs(u.query)
            r = app.vivo(metodo, u.path, q)
            if r is not None:
                return self._json(*r)
            if u.path == "/api/reuniones" or u.path.startswith("/api/reuniones/"):
                r = app.reuniones(metodo, u.path, q, body) if app.reuniones else None
                return self._json(*(r or (404, {"error": "no"})))
            if hq_explorador.es_ruta(u.path):
                r = app.explorador(metodo, u.path, q, body) if app.explorador else None
                return self._json(*(r or (404, {"error": "no"})))
            if hq_biblioteca.es_ruta(u.path):
                r = app.biblioteca(metodo, u.path, q, body) if app.biblioteca else None
                return self._json(*(r or (404, {"error": "no"})))
            code, obj = app.api(metodo, u.path, q, body)
            return self._json(code, obj)

    return H


def configurar_logs(datos_dir):
    os.makedirs(datos_dir, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(os.path.join(datos_dir, "hq.log"), maxBytes=1_000_000,
                                             backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)
    log.propagate = False


def crear_servidor(cfg, sesiones_json=None):
    app = App(cfg, sesiones_json)
    hq_reuniones.instalar(app, sys.modules[__name__])
    hq_biblioteca.instalar(app, sys.modules[__name__])
    hq_explorador.instalar(app, sys.modules[__name__])
    hq_mcp.instalar(app, sys.modules[__name__])
    srv = ThreadingHTTPServer(("127.0.0.1", cfg["puerto"]), crear_handler(app))
    srv.daemon_threads = True
    srv.app = app
    return srv


def main():
    cfg = cargar_config()
    configurar_logs(cfg["datos_dir"])
    srv = crear_servidor(cfg)
    log.info("arranque puerto=%d oficinas_dir=%s migradas=%d", cfg["puerto"], cfg["oficinas_dir"], srv.app.migrados)
    threading.Thread(target=srv.app.verificar_claude, daemon=True).start()
    print("Próspera HQ en http://localhost:%d  (claude: %s)" % (cfg["puerto"], cfg["claude_bin"]), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
