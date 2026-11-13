"""Actividad en vivo y costo (modo desarrollo). Paridad con app/Sources/Backend/{Stream,Actividad}.swift y la tabla
`costos` de Store.swift.

`claude -p --output-format stream-json --verbose` escribe un JSON por línea. De cada línea se sacan eventos
reducidos (sin contenido: solo nombre de herramienta y un objetivo corto) que alimentan el registro de actividad, y del
`result` final se toma `total_cost_usd`. Formato verificado en docs/aprendizajes.md.

Eventos: ("inicio", sesion) | ("pensando",) | ("herramienta", nombre, objetivo) | ("texto",) | ("resultado", costo, error)
"""
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from urllib.parse import urlparse

FORMATO_SALIDA = ["--output-format", "stream-json", "--verbose"]


def _corto(s, n=60):
    return s if len(s) <= n else s[:n - 1] + "…"


def objetivo(herramienta, entrada):
    """Objetivo legible y corto: nombre de archivo, patrón, dominio, búsqueda o colega. Nunca contenido."""
    entrada = entrada if isinstance(entrada, dict) else {}
    p = entrada.get("file_path") or entrada.get("path")
    if isinstance(p, str) and p:
        return _corto(os.path.basename(p.rstrip("/")) or p)
    for k in ("pattern",):
        v = entrada.get(k)
        if isinstance(v, str) and v:
            return _corto(v)
    u = entrada.get("url")
    if isinstance(u, str) and u:
        h = urlparse(u).hostname
        if h:
            return _corto(h)
    for k in ("query", "colega"):
        v = entrada.get(k)
        if isinstance(v, str) and v:
            return _corto(v)
    return None


def parsear_linea(linea):
    """Eventos de una línea de stream-json. Lo que no es JSON o no interesa (hooks, rate limits) -> []."""
    try:
        o = json.loads(linea)
    except Exception:
        return []
    if not isinstance(o, dict):
        return []
    tipo = o.get("type")
    if tipo == "system":
        if o.get("subtype") == "init" and isinstance(o.get("session_id"), str):
            return [("inicio", o["session_id"])]
        return []
    if tipo == "assistant":
        out = []
        for b in ((o.get("message") or {}).get("content") or []):
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "thinking":
                out.append(("pensando",))
            elif t == "text":
                out.append(("texto",))
            elif t == "tool_use" and isinstance(b.get("name"), str):
                out.append(("herramienta", b["name"], objetivo(b["name"], b.get("input"))))
        return out
    if tipo == "result":
        c = o.get("total_cost_usd")
        costo = float(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else None
        return [("resultado", costo, o.get("is_error") is True)]
    return []


def ultimo_json(so):
    """stdout completo como objeto JSON; si no, la última línea que lo sea (el `result` de stream-json)."""
    try:
        o = json.loads(so)
        if isinstance(o, dict):
            return o
    except Exception:
        pass
    for linea in reversed((so or "").splitlines()):
        try:
            o = json.loads(linea)
        except Exception:
            continue
        if isinstance(o, dict):
            return o
    return None


def estado_herramienta(n):
    if n in ("Read", "Glob", "Grep", "LS", "NotebookRead"):
        return "leyendo"
    if n in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "escribiendo"
    if n in ("WebSearch", "WebFetch"):
        return "buscando"
    if n.startswith("mcp__hq__consultar"):
        return "consultando"
    return "trabajando"


def recortar(s, n=48):
    t = (s or "").replace("\n", " ").strip()
    return t if len(t) <= n else t[:n - 1] + "…"


class CajaCosto:
    """Suma el costo de una o varias corridas (el lector corre en otro hilo)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._total = None

    def sumar(self, c):
        if c is None:
            return
        with self._lock:
            self._total = (self._total or 0.0) + c

    @property
    def valor(self):
        with self._lock:
            return self._total

    def observador(self, siguiente=None):
        def obs(ev):
            if ev[0] == "resultado":
                self.sumar(ev[1])
            if siguiente:
                siguiente(ev)
        return obs


def lector(obs):
    """Línea de stdout -> eventos al observador (para `server.ejecutar(..., al_linea=)`)."""
    if obs is None:
        return None

    def al_linea(linea):
        for ev in parsear_linea(linea):
            obs(ev)
    return al_linea


class Actividad:
    """Qué hace cada agente ahora (en memoria). Lock propio: no pasa por el RLock global del servidor."""

    def __init__(self, reloj=time.time):
        self._lock = threading.Lock()
        self._corridas = {}   # (oficina, agente) -> {token: estado}
        self._orden = {}      # (oficina, agente) -> [token]
        self.version = 0
        self._reloj = reloj

    def empezar(self, oficina, agente, origen, tarea=None):
        token = uuid.uuid4().hex
        k = (oficina, agente)
        with self._lock:
            self._corridas.setdefault(k, {})[token] = {
                "estado": "pensando", "herramienta": None, "objetivo": None,
                "tarea": recortar(tarea) if tarea else None, "origen": origen, "desde": self._reloj()}
            self._orden.setdefault(k, []).append(token)
            self.version += 1
        return token

    def terminar(self, oficina, agente, token):
        k = (oficina, agente)
        with self._lock:
            self._corridas.get(k, {}).pop(token, None)
            if token in self._orden.get(k, []):
                self._orden[k].remove(token)
            if not self._corridas.get(k):
                self._corridas.pop(k, None)
                self._orden.pop(k, None)
            self.version += 1

    def tarea(self, oficina, agente, token, texto):
        with self._lock:
            e = self._corridas.get((oficina, agente), {}).get(token)
            if e is not None:
                e["tarea"] = texto
                self.version += 1

    def aplicar(self, oficina, agente, token, ev):
        with self._lock:
            e = self._corridas.get((oficina, agente), {}).get(token)
            if e is None:
                return
            if ev[0] in ("pensando", "texto"):
                e.update(estado="pensando", herramienta=None, objetivo=None)
            elif ev[0] == "herramienta":
                e.update(estado=estado_herramienta(ev[1]), herramienta=ev[1], objetivo=ev[2])
            else:
                return
            self.version += 1

    def observador(self, oficina, agente, token):
        return lambda ev: self.aplicar(oficina, agente, token, ev)

    def vista(self, oficina):
        with self._lock:
            out = {}
            for (of, ag), tokens in self._orden.items():
                if of == oficina and tokens:
                    e = self._corridas.get((of, ag), {}).get(tokens[-1])
                    if e:
                        out[ag] = dict(e)
            return out

    def json(self, oficina):
        ahora = self._reloj()
        ags = {}
        for ag, e in self.vista(oficina).items():
            d = {"estado": e["estado"], "origen": e["origen"], "seg": int(ahora - e["desde"])}
            for k in ("herramienta", "objetivo", "tarea"):
                if e.get(k):
                    d[k] = e[k]
            ags[ag] = d
        with self._lock:
            v = self.version
        return {"agentes": ags, "version": v}

    @contextmanager
    def seguir(self, oficina, agente, origen, tarea=None, extra=None):
        """with app.actividad.seguir(...) as (obs, token): ... — termina pase lo que pase."""
        token = self.empezar(oficina, agente, origen, tarea)
        mio = self.observador(oficina, agente, token)

        def obs(ev):
            mio(ev)
            if extra:
                extra(ev)
        try:
            yield obs, token
        finally:
            self.terminar(oficina, agente, token)


# ----------------------------------------------------------------------------- costos

SCHEMA_COSTOS = """
CREATE TABLE IF NOT EXISTS costos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oficina TEXT NOT NULL,
    agente TEXT NOT NULL DEFAULT '',
    origen TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    costo REAL NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS costos_oficina ON costos(oficina, ts);
"""


class Costos:
    def __init__(self, path):
        self.path = path
        c = sqlite3.connect(path, timeout=30)
        try:
            with c:
                c.executescript(SCHEMA_COSTOS)
        finally:
            c.close()

    def registrar(self, oficina, origen, costo, agente="", ref=""):
        if costo is None or not (costo > 0) or costo != costo or costo == float("inf"):
            return
        c = sqlite3.connect(self.path, timeout=30)
        try:
            with c:
                c.execute("INSERT INTO costos(oficina,agente,origen,ref,costo,ts) VALUES(?,?,?,?,?,?)",
                          (oficina, agente or "", origen, ref or "", float(costo), time.time()))
        finally:
            c.close()

    def totales(self, oficina, desde=0.0):
        c = sqlite3.connect(self.path, timeout=30)
        try:
            p = (oficina, desde)
            total = c.execute("SELECT COALESCE(SUM(costo),0) FROM costos WHERE oficina=? AND ts>=?", p).fetchone()[0]

            def agrupar(col, extra=""):
                filas = c.execute("SELECT %s, SUM(costo) FROM costos WHERE oficina=? AND ts>=? %s GROUP BY %s"
                                  % (col, extra, col), p).fetchall()
                return {k: v for k, v in filas if k}
            return {"total": total, "agentes": agrupar("agente"), "origenes": agrupar("origen"),
                    "reuniones": agrupar("ref", "AND origen IN ('reunion','sintesis')")}
        finally:
            c.close()


# ----------------------------------------------------------------------------- resumen de la tarea (Haiku)

RESUMEN_MIN = 40
RESUMEN_TIMEOUT = 20


def hace_falta_resumen(msg):
    return len((msg or "").strip()) > RESUMEN_MIN


def prompt_resumen(msg):
    m = msg if len(msg) <= 2000 else msg[:2000] + "…"
    return ("Resumí en 3 a 6 palabras, en español, qué le están pidiendo a la persona en este mensaje. Empezá con un verbo "
            "en gerundio (por ejemplo «Armando el calendario de reels»). Respondé solo con el resumen, sin comillas ni punto "
            "final.\n\nMensaje:\n" + m)


def limpiar_resumen(s):
    t = ((s or "").split("\n") or [""])[0].strip(" \t\"'«»“”*")
    while t.endswith("."):
        t = t[:-1]
    return recortar(t) if t else None


def resumir_en_segundo_plano(app, srv, msg, carpeta, agente, token):
    """Hilo que pide el resumen a Haiku y lo vuelca en la actividad. -> threading.Event para avisar que terminó el chat."""
    listo = threading.Event()
    if not hace_falta_resumen(msg) or not app.claude:
        return listo

    def correr():
        caja = CajaCosto()
        try:
            rc, so, _ = srv.ejecutar([app.claude, "-p"] + FORMATO_SALIDA + ["--tools", "", "--model", "haiku", "--",
                                     prompt_resumen(msg)], carpeta, RESUMEN_TIMEOUT, al_linea=lector(caja.observador()))
            out = ultimo_json(so)
            if rc == 0 and out and not out.get("is_error") and not listo.is_set():
                r = limpiar_resumen(out.get("result"))
                if r:
                    app.actividad.tarea(carpeta, agente, token, r)
        except Exception:
            pass
        finally:
            app.costos.registrar(carpeta, "resumen", caja.valor, agente)
    threading.Thread(target=correr, daemon=True).start()
    return listo
