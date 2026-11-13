"""Entregas para revisar (modo desarrollo). Paridad con app/Sources/Backend/{Entregas,EntregasRouter}.swift.

Una entrega es algo que un agente terminó y la persona tiene que revisar. Nace «sin_revisar» y pasa a «revisada» solo
cuando la persona toca «Listo». La generan: una ejecución de tarea que terminó bien (programada, de prueba o encargo),
el acta de una reunión y un chat que escribió archivos en `archivos/entregables/`.

Rutas: GET /api/entregas?estado=&agente=&origen=&limite= · GET /api/entregas/:id · POST /api/entregas/:id/revisada |
/sin-revisar
"""
import json
import os
import sqlite3
import threading
import time

ESTADOS = ("sin_revisar", "revisada", "cambios")
MAX_TEXTO = 100_000
CARPETA_ENTREGABLES = "archivos/entregables/"
IGNORADOS = (".claude/", "conocimiento/agentes/")

SCHEMA = """
CREATE TABLE IF NOT EXISTS entregas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oficina TEXT NOT NULL,
    agente TEXT NOT NULL DEFAULT '',
    origen TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    titulo TEXT NOT NULL,
    texto TEXT NOT NULL DEFAULT '',
    sid TEXT NOT NULL DEFAULT '',
    archivos TEXT NOT NULL DEFAULT '[]',
    creada REAL NOT NULL,
    estado TEXT NOT NULL DEFAULT 'sin_revisar',
    revisada REAL,
    padre INTEGER,
    costo REAL
);
CREATE INDEX IF NOT EXISTS entregas_oficina ON entregas(oficina, estado, id);
"""
COLUMNAS = "id,oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,estado,revisada,padre,costo"


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t is not None else None


def _plano(t):
    return " ".join((t or "").split("\n")).strip()


def resumen(t):
    s = _plano(t)
    return s[:279] + "…" if len(s) > 280 else s


def titulo(t):
    s = _plano(t)
    return s[:69] + "…" if len(s) > 70 else s


def relativos(rutas, carpeta):
    """Rutas relativas a `carpeta`, sin repetir, de las que caen dentro de la oficina (sin notas internas ni `..`)."""
    bases = {os.path.normpath(carpeta), os.path.realpath(carpeta)}
    bases = [b if b.endswith("/") else b + "/" for b in bases]
    out = []
    for r in rutas:
        abs_ = r if r.startswith("/") else os.path.join(carpeta, r)
        rel = None
        for c in (os.path.normpath(abs_), os.path.realpath(abs_)):
            for b in bases:
                if c.startswith(b):
                    rel = c[len(b):]
                    break
            if rel is not None:
                break
        if not rel or ".." in rel.split("/") or any(rel.startswith(i) for i in IGNORADOS) or rel in out:
            continue
        out.append(rel)
    return out


def en_entregables(rels):
    return [r for r in rels if r.startswith(CARPETA_ENTREGABLES)]


class CajaArchivos:
    """Junta las rutas de los archivos escritos (eventos ("archivo", ruta)) sin repetir; el lector corre en otro hilo."""

    def __init__(self):
        self._lock = threading.Lock()
        self._rutas = []

    def agregar(self, r):
        with self._lock:
            if r not in self._rutas:
                self._rutas.append(r)

    @property
    def valor(self):
        with self._lock:
            return list(self._rutas)

    def observador(self, siguiente=None):
        def obs(ev):
            if ev[0] == "archivo":
                self.agregar(ev[1])
            if siguiente:
                siguiente(ev)
        return obs


def entrega_json(r, completo=False):
    o = {"id": r[0], "agente": r[2], "origen": r[3], "ref": r[4], "titulo": r[5], "resumen": resumen(r[6]), "sid": r[7],
         "archivos": json.loads(r[8] or "[]"), "creada": _iso(r[9]), "estado": r[10], "revisada": _iso(r[11]),
         "padre": r[12], "costo": r[13]}
    if completo:
        o["texto"] = r[6]
    return o


class Entregas:
    def __init__(self, path):
        self.path = path
        self._tx(lambda c: c.executescript(SCHEMA))
        self.al_revisar = lambda entrega, carpeta: None  # E1: tilda el pendiente de reunión que la originó

    def _tx(self, fn):
        c = sqlite3.connect(self.path, timeout=30)
        try:
            with c:
                return fn(c)
        finally:
            c.close()

    def crear(self, oficina, agente, origen, ref, titulo_, texto, sid="", archivos=None, padre=None, costo=None):
        tit = (titulo_ or "").strip() or "Entrega"

        def fn(c):
            cur = c.execute("INSERT INTO entregas(oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,padre,costo) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (oficina, agente or "", origen, ref or "", tit, (texto or "")[:MAX_TEXTO], sid or "",
                             json.dumps(archivos or [], ensure_ascii=False), time.time(), padre, costo))
            return c.execute("SELECT %s FROM entregas WHERE id=?" % COLUMNAS, (cur.lastrowid,)).fetchone()
        return self._tx(fn)

    def fila(self, oficina, id_):
        return self._tx(lambda c: c.execute("SELECT %s FROM entregas WHERE oficina=? AND id=?" % COLUMNAS,
                                            (oficina, id_)).fetchone())

    def lista(self, oficina, estado=None, agente=None, origen=None, limite=100):
        sql, p = "SELECT %s FROM entregas WHERE oficina=?" % COLUMNAS, [oficina]
        for col, v in (("estado", estado), ("agente", agente), ("origen", origen)):
            if v is not None:
                sql += " AND %s=?" % col
                p.append(v)
        sql += " ORDER BY id DESC LIMIT ?"
        p.append(max(1, min(limite, 500)))
        return self._tx(lambda c: c.execute(sql, p).fetchall())

    def sin_revisar(self, oficina):
        return self._tx(lambda c: c.execute("SELECT COUNT(*) FROM entregas WHERE oficina=? AND estado='sin_revisar'",
                                            (oficina,)).fetchone()[0])

    def marcar(self, oficina, id_, estado):
        if estado not in ESTADOS:
            return None
        cuando = time.time() if estado == "revisada" else None
        self._tx(lambda c: c.execute("UPDATE entregas SET estado=?, revisada=? WHERE oficina=? AND id=?",
                                     (estado, cuando, oficina, id_)))
        return self.fila(oficina, id_)

    # ---- rutas

    def __call__(self, metodo, path, query, carpeta):
        """`/api/entregas*` -> (status, dict). `query` como lo da parse_qs."""
        no = (405, {"error": "método no permitido"})
        partes = path.split("/")[1:]
        if len(partes) < 2 or len(partes) > 4 or "" in partes:
            return 404, {"error": "no"}
        if not carpeta:
            return 409, {"error": "No hay una oficina abierta."}
        if len(partes) == 2:
            if metodo != "GET":
                return no

            def filtro(k):
                v = (query.get(k) or [""])[0]
                return None if v in ("", "todas") else v
            estado = filtro("estado")
            if estado is not None and estado not in ESTADOS:
                return 400, {"error": "«estado» tiene que ser sin_revisar, revisada o cambios."}
            try:
                limite = int((query.get("limite") or ["100"])[0])
            except ValueError:
                limite = 100
            filas = self.lista(carpeta, estado, filtro("agente"), filtro("origen"), limite)
            return 200, {"entregas": [entrega_json(f) for f in filas], "sinRevisar": self.sin_revisar(carpeta)}
        if not partes[2].isdigit() or int(partes[2]) <= 0:
            return 404, {"error": "no"}
        id_ = int(partes[2])
        f = self.fila(carpeta, id_)
        if f is None:
            return 404, {"error": "No existe esa entrega."}
        if len(partes) == 3:
            return (200, {"entrega": entrega_json(f, True)}) if metodo == "GET" else no
        if metodo != "POST":
            return no
        if partes[3] == "revisada":
            n = self.marcar(carpeta, id_, "revisada")
            try:
                self.al_revisar(entrega_json(n, True), carpeta)
            except Exception:
                pass
            return 200, {"entrega": entrega_json(n), "sinRevisar": self.sin_revisar(carpeta)}
        if partes[3] == "sin-revisar":
            if f[10] == "cambios":
                return 409, {"error": "Esa entrega ya tiene una versión nueva."}
            n = self.marcar(carpeta, id_, "sin_revisar")
            return 200, {"entrega": entrega_json(n), "sinRevisar": self.sin_revisar(carpeta)}
        return 404, {"error": "no"}


def es_ruta(path):
    return path == "/api/entregas" or path.startswith("/api/entregas/")
