"""Reuniones de Próspera HQ para el modo desarrollo (oficina/server.py). Python 3.9, solo librería estándar.

Es la misma API, los mismos archivos y los mismos prompts que app/Sources/Backend/Reuniones.swift: si cambia
una, cambia la otra. Varios agentes opinan por rondas sobre un tema; el usuario puede intervenir; al cerrar sale
una síntesis (resumen, decisiones, pendientes) que queda en reuniones/AAAA-MM-DD-<tema>.md y en
conocimiento/decisiones.md.

Se engancha con `instalar(app, server)` (ver crear_servidor en server.py): deja `app.reuniones`, un callable
(metodo, path, query, body) -> (código, dict) | None.
"""
import datetime
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
import uuid

import hq_core
import hq_vivo
from hq_core import ErrorAPI

MAX_BODY = 200000
MAX_PARTICIPANTES = 20
MAX_RONDAS = 3
MAX_MEMORIA = 2000
MAX_DECISIONES = 15
MAX_TRANSCRIPCION_TURNO = 12000
MAX_TRANSCRIPCION_ACTA = 40000
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

VACIAS = set("""para como sobre este esta esto estos estas entre desde hasta cuando donde porque pero tiene tener hacer
queremos podemos vamos nuestro nuestra nuestros nuestras algo cada todo toda todos todas otro otra otros otras mucho
mucha tambien ademas hacia segun tema reunion ronda""".split())

SCHEMA = """
CREATE TABLE IF NOT EXISTS reuniones (
    id TEXT PRIMARY KEY,
    oficina TEXT NOT NULL,
    tema TEXT NOT NULL,
    agentes TEXT NOT NULL,
    estado TEXT NOT NULL,
    creada REAL NOT NULL,
    cerrada REAL,
    sintesis TEXT,
    error_sintesis TEXT,
    acta TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS reuniones_oficina ON reuniones(oficina, creada);
CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reunion TEXT NOT NULL REFERENCES reuniones(id),
    oficina TEXT NOT NULL,
    ronda INTEGER NOT NULL,
    agente TEXT NOT NULL,
    texto TEXT NOT NULL,
    error INTEGER NOT NULL DEFAULT 0,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS turnos_reunion ON turnos(reunion, id);
"""
COLUMNAS = "id,oficina,tema,agentes,estado,creada,cerrada,sintesis,error_sintesis,acta,error,documentos"
MAX_FICHA = 2500
MAX_FICHAS = 8000


# ----------------------------------------------------------------------------- textos y heurísticas

def plano(s):
    base = unicodedata.normalize("NFKD", s)
    return "".join(c for c in base if not unicodedata.combining(c)).lower()


def palabras(s):
    return re.findall(r"[a-z0-9]+", plano(s))


def coincide(a, b):
    if a == b:
        return True
    return len(a) >= 5 and len(b) >= 5 and a[:5] == b[:5]


def ordenar(agentes, oficina, tema):
    """Agentes con más palabras del tema en rol/departamento (peso 2) o brief/chips (peso 1) primero; estable."""
    claves = []
    for p in palabras(tema):
        if len(p) >= 4 and p not in VACIAS and p not in claves:
            claves.append(p)
    deps = {d["id"]: d["nombre"] for d in oficina.get("departamentos", [])}

    def puntaje(a):
        fuerte = palabras("%s %s" % (a.get("rol") or "", deps.get(a.get("departamento"), "")))
        debil = palabras("%s %s" % (a.get("brief") or "", " ".join(a.get("chips") or [])))
        s = 0
        for c in claves:
            if any(coincide(x, c) for x in fuerte):
                s += 2
            elif any(coincide(x, c) for x in debil):
                s += 1
        return s

    con = [(-puntaje(a), i, a) for i, a in enumerate(agentes)]
    con.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in con]


def memoria(carpeta):
    t = (hq_core.leer_texto(os.path.join(carpeta, "conocimiento", "oficina.md")) or "").strip()
    if not t:
        return "(sin memoria común todavía)"
    return t[:MAX_MEMORIA] + "…" if len(t) > MAX_MEMORIA else t


def decisiones_recientes(carpeta):
    t = hq_core.leer_texto(os.path.join(carpeta, "conocimiento", "decisiones.md")) or ""
    lineas = [l.strip() for l in t.splitlines() if l.strip().startswith("- ")]
    if not lineas:
        return "(todavía no hay decisiones registradas)"
    return "\n".join(lineas[-MAX_DECISIONES:])


def agente_de(oficina, id_):
    return next((a for a in oficina["agentes"] if a["id"] == id_), None)


def nombre_de(id_, oficina):
    if id_ == "usuario":
        d = oficina.get("duenio") or ""
        return "%s (dueño de la oficina)" % d if d else "Usuario"
    a = agente_de(oficina, id_)
    return a["nombre"] if a else id_


def transcripcion(turnos, oficina, con_rol, maximo):
    bloques, ultima = [], -1
    for t in turnos:
        if t["error"]:
            continue
        b = ""
        if t["ronda"] != ultima and t["ronda"] > 0:
            b += "— Ronda %d —\n" % t["ronda"]
            ultima = t["ronda"]
        n = nombre_de(t["agente"], oficina)
        a = agente_de(oficina, t["agente"])
        if con_rol and a:
            n += " (%s)" % a["rol"]
        bloques.append("%s%s: %s" % (b, n, t["texto"]))
    out = "\n\n".join(bloques)
    if len(out) > maximo:
        out = "[…]\n" + out[-maximo:]
    return out


def _gente(participantes):
    return ", ".join("%s (%s)" % (a["nombre"], a["rol"]) for a in participantes)


def fichas(carpeta, documentos):
    """Fichas (conocimiento/fuentes/<slug>.md) de los documentos adjuntos al tema, recortadas."""
    out, total = [], 0
    for slug in documentos or []:
        t = (hq_core.leer_texto(os.path.join(carpeta, "conocimiento", "fuentes", slug + ".md")) or "").strip()
        if not t:
            continue
        if len(t) > MAX_FICHA:
            t = t[:MAX_FICHA] + "…"
        if total + len(t) > MAX_FICHAS:
            break
        total += len(t)
        out.append(t)
    return "\n\n---\n\n".join(out)


def prompt_turno(oficina, carpeta, tema, participantes, quien, turnos, ronda, fichas_texto=""):
    dicho = transcripcion(turnos, oficina, False, MAX_TRANSCRIPCION_TURNO)
    docs = ("\n\nDocumentos adjuntos a la reunión (fichas de la biblioteca; el texto completo está en "
            "archivos/.texto/<slug>.md):\n" + fichas_texto) if fichas_texto else ""
    return (
        "Estás en una reunión de la oficina «%s». Tema de la reunión:\n%s\n\n"
        "Participantes: %s\n\n"
        "Memoria común de la oficina:\n%s\n\n"
        "Decisiones recientes:\n%s%s\n\n"
        "Lo que se dijo hasta ahora (estamos en la ronda %d):\n%s\n\n"
        "Sos %s, %s. Opiná desde tu rol en 120-180 palabras, sin repetir lo ya dicho; decí con qué estás de acuerdo "
        "y con qué no, y proponé un próximo paso concreto. Respondé solo con tu opinión, en primera persona y sin "
        "encabezados."
    ) % (oficina["nombre"], tema, _gente(participantes), memoria(carpeta), decisiones_recientes(carpeta), docs, ronda,
         dicho or "(todavía no habló nadie)", quien["nombre"], quien["rol"])


def prompt_sintesis(oficina, tema, participantes, turnos):
    return (
        "Sos el secretario de actas de la oficina «%s». Tema de la reunión: %s\n"
        "Participantes: %s\n\n"
        "Transcripción:\n%s\n\n"
        "Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:\n"
        "{\"resumen\": \"resumen de la reunión en 3-6 oraciones\", \"decisiones\": [\"decisión concreta confirmada por la "
        "conversación\"], \"pendientes\": [{\"quien\": \"nombre de quien se encarga\", \"que\": \"tarea concreta\"}]}\n"
        "Incluí en \"decisiones\" solo lo que quedó razonablemente acordado (puede ser una lista vacía) y en "
        "\"pendientes\" los próximos pasos con responsable."
    ) % (oficina["nombre"], tema, _gente(participantes),
         transcripcion(turnos, oficina, True, MAX_TRANSCRIPCION_ACTA))


def parsear_sintesis(t):
    """Objeto JSON de la respuesta (con o sin ```json), normalizado. None si no se puede leer."""
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        o = json.loads(t[a:b + 1])
    except ValueError:
        return None
    if not isinstance(o, dict):
        return None

    def cad(v):
        return v.strip() if isinstance(v, str) else ""

    resumen = cad(o.get("resumen"))
    decisiones = [x for x in (cad(d) for d in (o.get("decisiones") if isinstance(o.get("decisiones"), list) else [])) if x]
    pend = []
    for p in (o.get("pendientes") if isinstance(o.get("pendientes"), list) else []):
        if isinstance(p, dict):
            if cad(p.get("que")):
                pend.append({"quien": cad(p.get("quien")), "que": cad(p.get("que"))})
        elif cad(p):
            pend.append({"quien": "", "que": cad(p)})
    if not resumen and not decisiones and not pend:
        return None
    return {"resumen": resumen, "decisiones": decisiones, "pendientes": pend}


def acta_md(oficina, tema, participantes, turnos, sintesis, error_sintesis, fecha):
    s = "# Reunión: %s\n\n" % tema
    s += "- **Oficina:** %s\n- **Fecha:** %s\n" % (oficina["nombre"], fecha.strftime("%Y-%m-%d"))
    s += "- **Participantes:** %s\n\n" % _gente(participantes)
    s += "## Transcripción\n\n"
    ultima = -1
    for t in turnos:
        if t["ronda"] != ultima and t["ronda"] > 0:
            s += "### Ronda %d\n\n" % t["ronda"]
            ultima = t["ronda"]
        n = nombre_de(t["agente"], oficina)
        a = agente_de(oficina, t["agente"])
        if a:
            n += " (%s)" % a["rol"]
        s += ("**%s:** _(no pudo responder: %s)_\n\n" if t["error"] else "**%s:** %s\n\n") % (n, t["texto"])
    if not turnos:
        s += "_(sin intervenciones)_\n\n"
    s += "## Síntesis\n\n"
    if sintesis:
        s += (sintesis["resumen"] or "_(sin resumen)_") + "\n\n### Decisiones\n\n"
        s += ("\n".join("- " + d for d in sintesis["decisiones"]) + "\n") if sintesis["decisiones"] else "_(ninguna)_\n"
        s += "\n### Pendientes\n\n"
        if sintesis["pendientes"]:
            s += "\n".join(("- **%s:** %s" % (p["quien"], p["que"])) if p["quien"] else "- " + p["que"]
                           for p in sintesis["pendientes"]) + "\n"
        else:
            s += "_(ninguno)_\n"
    else:
        s += "_No se pudo generar la síntesis%s._\n" % (": " + error_sintesis.strip().rstrip(".…").rstrip() if error_sintesis else "")
    return s


def iso(t):
    d = datetime.datetime.utcfromtimestamp(t)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


# ----------------------------------------------------------------------------- servicio

class Reuniones:
    def __init__(self, app, srv, env=None):
        env = os.environ if env is None else env
        self.app = app
        self.srv = srv  # módulo server (ejecutar, TiempoAgotado, error_de, clasificar_error)
        self.path = app.db.path
        self.mut = threading.RLock()
        self.corriendo = {}
        self.hablando = {}
        self.cerrando = set()

        def num(k, d):
            try:
                return float(env.get(k, d))
            except (TypeError, ValueError):
                return d

        self.timeout_turno = num("HQ_REUNION_TURNO_TIMEOUT", 180)
        self.timeout_sintesis = num("HQ_REUNION_SINTESIS_TIMEOUT", 180)
        with self._con() as c:
            c.executescript(SCHEMA)
            if "documentos" not in [r[1] for r in c.execute("PRAGMA table_info(reuniones)").fetchall()]:
                c.execute("ALTER TABLE reuniones ADD COLUMN documentos TEXT")
            # una reunión que estaba en curso al apagarse el servidor queda esperando
            c.execute("UPDATE reuniones SET estado='esperando' WHERE estado='en_curso'")

    # ---- SQLite (una conexión por operación)

    def _con(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def _sql(self, sql, params=(), uno=False, escribir=False):
        c = self._con()
        try:
            with c:
                cur = c.execute(sql, params)
                if escribir:
                    return cur.rowcount
                return cur.fetchone() if uno else cur.fetchall()
        finally:
            c.close()

    @staticmethod
    def _de_fila(r):
        try:
            ags = json.loads(r[3])
        except ValueError:
            ags = []
        try:
            docs = json.loads(r[11]) if r[11] else []
        except ValueError:
            docs = []
        return {"id": r[0], "oficina": r[1], "tema": r[2], "agentes": ags if isinstance(ags, list) else [], "estado": r[4],
                "creada": r[5], "cerrada": r[6], "sintesis": r[7], "error_sintesis": r[8], "acta": r[9], "error": r[10],
                "documentos": docs if isinstance(docs, list) else []}

    def _reunion(self, id_, carpeta):
        r = self._sql("SELECT %s FROM reuniones WHERE id=? AND oficina=?" % COLUMNAS, (id_, carpeta), uno=True)
        return self._de_fila(r) if r else None

    def _turnos(self, id_):
        return [{"ronda": r[0], "agente": r[1], "texto": r[2], "error": bool(r[3]), "ts": r[4]} for r in
                self._sql("SELECT ronda,agente,texto,error,ts FROM turnos WHERE reunion=? ORDER BY id", (id_,))]

    def _turno(self, id_, carpeta, ronda, agente, texto, error):
        self._sql("INSERT INTO turnos(reunion,oficina,ronda,agente,texto,error,ts) VALUES(?,?,?,?,?,?,?)",
                  (id_, carpeta, ronda, agente, texto, 1 if error else 0, time.time()), escribir=True)

    def _estado(self, id_, estado, error=None):
        self._sql("UPDATE reuniones SET estado=?, error=? WHERE id=?", (estado, error, id_), escribir=True)

    # ---- entrada

    def __call__(self, metodo, path, query, body):
        partes = path.split("/")[1:]
        if len(partes) < 2 or len(partes) > 4 or partes[0] != "api" or partes[1] != "reuniones" or "" in partes:
            return None
        try:
            return self._despachar(metodo, partes, body)
        except ErrorAPI as e:
            return e.status, {"error": e.mensaje}
        except Exception:
            self.srv.log.exception("reuniones: error interno")
            return 500, {"error": "error interno"}

    def _despachar(self, m, partes, body):
        no = (405, {"error": "método no permitido"})
        n = len(partes)
        if n == 2:
            if m == "GET":
                return 200, self._listar()
            return (200, self._crear(body)) if m == "POST" else no
        if not UUID_RE.match(partes[2]):
            return 404, {"error": "no"}
        id_ = partes[2].lower()
        if n == 3:
            return (200, self._detalle(id_)) if m == "GET" else no
        if m != "POST":
            return no
        if partes[3] == "intervencion":
            return 200, self._intervenir(id_, body)
        if partes[3] == "ronda":
            return 200, self._otra_ronda(id_)
        if partes[3] == "cerrar":
            return 200, self._cerrar(id_)
        return 404, {"error": "no"}

    @staticmethod
    def _objeto(body):
        if not body:
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

    def _fila(self, id_, carpeta):
        f = self._reunion(id_, carpeta)
        if f is None:
            raise ErrorAPI(404, "No encontré esa reunión.")
        return f

    def _vivo(self, id_):
        """(corre, quien habla): se toma ANTES de leer la fila (ver _correr_rondas: estado final primero, luego soltar)."""
        with self.mut:
            return id_ in self.corriendo, self.hablando.get(id_)

    def _vista(self, f, turnos, resumen=False, vivo_hablando=None):
        vivo, hablando = vivo_hablando or self._vivo(f["id"])
        estado = "en_curso" if vivo else ("esperando" if f["estado"] == "en_curso" else f["estado"])
        o = {"id": f["id"], "tema": f["tema"], "agentes": f["agentes"], "estado": estado, "creada": iso(f["creada"])}
        if resumen:
            o["turnos"] = len(turnos)
            return o
        o["hablando"] = hablando if vivo else None
        o["rondas"] = max([t["ronda"] for t in turnos] or [0])
        if f.get("documentos"):
            o["documentos"] = f["documentos"]
        o["turnos"] = []
        for t in turnos:
            x = {"ronda": t["ronda"], "agente": t["agente"], "texto": t["texto"], "ts": iso(t["ts"])}
            if t["error"]:
                x["error"] = True
            o["turnos"].append(x)
        if f["sintesis"]:
            try:
                o["sintesis"] = json.loads(f["sintesis"])
            except ValueError:
                pass
        if f["error_sintesis"]:
            o["errorSintesis"] = f["error_sintesis"]
        if f["cerrada"] is not None:
            o["cerrada"] = iso(f["cerrada"])
        if f["acta"]:
            o["acta"] = f["acta"]
            o["actaRuta"] = os.path.join(f["oficina"], f["acta"])
        if f["error"]:
            o["error"] = f["error"]
        return o

    def _respuesta(self, id_, carpeta):
        vh = self._vivo(id_)
        f = self._fila(id_, carpeta)
        return self._vista(f, self._turnos(id_), vivo_hablando=vh)

    # ---- endpoints

    def _listar(self):
        carpeta, _ = self.app.requerir_activa()
        with self.mut:
            vivas = set(self.corriendo)
        filas = self._sql("SELECT %s FROM reuniones WHERE oficina=? ORDER BY creada DESC" % COLUMNAS, (carpeta,))
        return {"reuniones": [self._vista(f, self._turnos(f["id"]), True, (f["id"] in vivas, None))
                              for f in map(self._de_fila, filas)]}

    def _detalle(self, id_):
        carpeta, _ = self.app.requerir_activa()
        return self._respuesta(id_, carpeta)

    def _crear(self, body):
        carpeta, of = self.app.requerir_activa()
        d = self._objeto(body)
        tema = hq_core.texto(d.get("tema"), "tema", 500)
        lista = d.get("agentes")
        if not isinstance(lista, list) or not lista:
            raise ErrorAPI(400, "Elegí al menos un agente para la reunión.")
        ids = []
        for x in lista:
            if not hq_core.slug_valido(x):
                raise ErrorAPI(400, "«agentes» tiene que ser una lista de ids.")
            if agente_de(of, x) is None:
                raise ErrorAPI(400, "El agente «%s» no está en la oficina." % x)
            if x not in ids:
                ids.append(x)
        if len(ids) > MAX_PARTICIPANTES:
            raise ErrorAPI(400, "Demasiados participantes (máximo %d)." % MAX_PARTICIPANTES)
        rondas = 1
        if d.get("rondas") is not None:
            r = d["rondas"]
            if isinstance(r, bool) or not isinstance(r, (int, float)) or int(r) != r or not 1 <= r <= MAX_RONDAS:
                raise ErrorAPI(400, "«rondas» tiene que ser un número entre 1 y %d." % MAX_RONDAS)
            rondas = int(r)
        documentos = []
        if d.get("documentos") is not None:
            if not isinstance(d["documentos"], list):
                raise ErrorAPI(400, "«documentos» tiene que ser una lista de slugs.")
            for x in d["documentos"]:
                if not hq_core.slug_valido(x):
                    raise ErrorAPI(400, "«documentos» tiene que ser una lista de slugs.")
                if not os.path.isfile(os.path.join(carpeta, "conocimiento", "fuentes", x + ".md")):
                    raise ErrorAPI(400, "El documento «%s» no está en la biblioteca o todavía no tiene ficha." % x)
                if x not in documentos:
                    documentos.append(x)
            if len(documentos) > 10:
                raise ErrorAPI(400, "Máximo 10 documentos por reunión.")
        id_ = str(uuid.uuid4())
        orden = [a["id"] for a in ordenar([agente_de(of, i) for i in ids], of, tema)]
        self._sql("INSERT INTO reuniones(id,oficina,tema,agentes,estado,creada,documentos) VALUES(?,?,?,?,?,?,?)",
                  (id_, carpeta, tema, json.dumps(orden), "esperando", time.time(),
                   json.dumps(documentos) if documentos else None), escribir=True)
        self._arrancar(id_, carpeta, rondas)
        return self._respuesta(id_, carpeta)

    def _intervenir(self, id_, body):
        carpeta, _ = self.app.requerir_activa()
        f = self._fila(id_, carpeta)
        texto = hq_core.texto(self._objeto(body).get("texto"), "texto", 5000)
        if f["estado"] == "cerrada":
            raise ErrorAPI(409, "La reunión ya está cerrada.")
        ronda = max([t["ronda"] for t in self._turnos(id_)] or [0])
        self._turno(id_, carpeta, ronda, "usuario", texto, False)
        return self._respuesta(id_, carpeta)

    def _otra_ronda(self, id_):
        carpeta, _ = self.app.requerir_activa()
        f = self._fila(id_, carpeta)
        with self.mut:
            if f["estado"] == "cerrada" or id_ in self.cerrando:
                raise ErrorAPI(409, "La reunión ya está cerrada.")
            if id_ in self.corriendo:
                raise ErrorAPI(409, "Todavía hay una ronda en curso.")
            self._arrancar(id_, carpeta, 1)
        return self._respuesta(id_, carpeta)

    def _cerrar(self, id_):
        carpeta, of = self.app.requerir_activa()
        f = self._fila(id_, carpeta)
        with self.mut:
            if f["estado"] == "cerrada" or id_ in self.cerrando:
                raise ErrorAPI(409, "La reunión ya está cerrada.")
            if id_ in self.corriendo:
                raise ErrorAPI(409, "Todavía hay una ronda en curso: esperá a que termine para cerrar.")
            self.cerrando.add(id_)
        try:
            turnos = self._turnos(id_)
            parts = [a for a in (agente_de(of, i) for i in f["agentes"]) if a]
            sintesis, err_sint = None, None
            if not any(not t["error"] for t in turnos):
                err_sint = "No hubo opiniones para resumir."
            else:
                caja = hq_vivo.CajaCosto()
                try:
                    t = self._sin_agente(prompt_sintesis(of, f["tema"], parts, turnos), carpeta, self.timeout_sintesis,
                                         caja.observador())
                    sintesis = parsear_sintesis(t)
                    if sintesis is None:
                        err_sint = "La síntesis no vino en el formato esperado."
                except ErrorAPI as e:
                    err_sint = e.mensaje
                self.app.costos.registrar(carpeta, "sintesis", caja.valor, ref=id_)
            hoy = datetime.date.today()
            error_acta, rel = None, None
            try:
                rel = self._escribir_acta(carpeta, f["tema"], hoy,
                                          acta_md(of, f["tema"], parts, turnos, sintesis, err_sint, hoy))
                if sintesis and sintesis["decisiones"]:
                    hq_core.anexar_decisiones(carpeta, sintesis["decisiones"], hoy)
            except (OSError, ErrorAPI):
                error_acta = "No pude guardar el acta o las decisiones en la carpeta de la oficina."
                self.srv.log.exception("reuniones: no pude escribir el acta")
            self._sql("UPDATE reuniones SET estado='cerrada', cerrada=?, sintesis=?, error_sintesis=?, acta=?, error=? WHERE id=?",
                      (time.time(), json.dumps(sintesis, ensure_ascii=False) if sintesis else None, err_sint, rel,
                       error_acta, id_), escribir=True)
        finally:
            with self.mut:
                self.cerrando.discard(id_)
        return self._respuesta(id_, carpeta)

    @staticmethod
    def _escribir_acta(carpeta, tema, fecha, texto):
        os.makedirs(os.path.join(carpeta, "reuniones"), exist_ok=True)
        base = "%s-%s" % (fecha.strftime("%Y-%m-%d"), hq_core.slug_de(tema) or "reunion")
        rel, n = "reuniones/%s.md" % base, 2
        while os.path.exists(os.path.join(carpeta, rel)):
            rel = "reuniones/%s-%d.md" % (base, n)
            n += 1
        hq_core.escribir_atomico(os.path.join(carpeta, rel), texto)
        return rel

    # ---- claude

    def _correr(self, cmd, carpeta, timeout, obs=None):
        """-> texto de `result`. ErrorAPI(502, mensaje) si falla (mensaje ya en español). `obs`: eventos en vivo."""
        srv = self.srv
        if not self.app.claude:
            raise ErrorAPI(502, "No encontré Claude Code en esta compu.")
        if not os.path.isdir(carpeta):
            raise ErrorAPI(502, "No encuentro la carpeta del proyecto (%s)." % carpeta)
        try:
            rc, so, se = srv.ejecutar(cmd, carpeta, timeout, al_linea=hq_vivo.lector(obs))
        except srv.TiempoAgotado:
            raise ErrorAPI(504, "Tardó demasiado en responder.")
        except (FileNotFoundError, PermissionError, OSError):
            raise ErrorAPI(502, "No pude ejecutar Claude Code en esta compu.")
        out = hq_vivo.ultimo_json(so)
        e = srv.error_de(rc, so, se, out)
        if e:
            raise ErrorAPI(502, srv.clasificar_error(e)[1])
        return (out or {}).get("result") or (so.strip() if out is None else "")

    def _sin_agente(self, prompt, carpeta, timeout, obs=None):
        return self._correr([self.app.claude, "-p"] + hq_vivo.FORMATO_SALIDA + ["--tools", "", "--", prompt], carpeta, timeout,
                            obs)

    def _turno_solo_lectura(self, agente, prompt, carpeta, dirs_extra=(), obs=None):
        cmd = [self.app.claude, "-p", "--agent", agente, "--session-id", str(uuid.uuid4())] + hq_vivo.FORMATO_SALIDA + [
            "--tools", "Read,Glob,Grep"]
        for d in list(self.app.cfg.get("oficina_dirs_extra", [])) + list(dirs_extra):
            cmd += ["--add-dir", d]
        return self._correr(cmd + ["--", prompt], carpeta, self.timeout_turno, obs)

    # ---- rondas

    def _arrancar(self, id_, carpeta, rondas):
        self._estado(id_, "en_curso")
        t = threading.Thread(target=self._correr_rondas, args=(id_, carpeta, rondas), daemon=True)
        with self.mut:
            self.corriendo[id_] = t
        t.start()

    def _correr_rondas(self, id_, carpeta, cuantas):
        ok, ultimo = False, None
        try:
            for _ in range(cuantas):
                o, e = self._correr_ronda(id_, carpeta)
                ok = ok or o
                ultimo = e or ultimo
        except Exception:
            self.srv.log.exception("reuniones: fallo la ronda")
            ultimo = ultimo or "Falló la ronda."
        finally:
            # estado final PRIMERO y recién después se suelta `corriendo` (nadie ve «ya no corre» con el estado viejo)
            try:
                self._estado(id_, "esperando" if ok else "error", None if ok else ultimo)
            except Exception:
                self.srv.log.exception("reuniones: no pude guardar el estado")
            with self.mut:
                self.corriendo.pop(id_, None)
                self.hablando.pop(id_, None)

    def _correr_ronda(self, id_, carpeta):
        try:
            of = hq_core.leer_oficina(carpeta)
        except ErrorAPI:
            return False, "No pude leer la oficina."
        f = self._reunion(id_, carpeta)
        if f is None:
            return False, "No encontré la reunión."
        ronda = max([t["ronda"] for t in self._turnos(id_)] or [0]) + 1
        parts = [a for a in (agente_de(of, i) for i in f["agentes"]) if a]
        ok, ultimo = False, None
        for ag in parts:
            with self.mut:
                self.hablando[id_] = ag["id"]
            prompt = prompt_turno(of, carpeta, f["tema"], parts, ag, self._turnos(id_), ronda,
                                  fichas(carpeta, f.get("documentos")))
            fallo = False
            caja = hq_vivo.CajaCosto()
            try:
                with self.app._lock(carpeta, ag["id"]):  # mismo carril que el chat 1 a 1 de ese agente
                    with self.app.actividad.seguir(carpeta, ag["id"], "reunion", "Reunión: " + f["tema"],
                                                   extra=caja.observador()) as (obs, _t):
                        texto = self._turno_solo_lectura(ag["id"], prompt, carpeta, hq_core.dirs_vinculos(of, ag),
                                                         obs).strip()
                if not texto:
                    texto, fallo = "(sin respuesta)", True
            except ErrorAPI as e:
                texto, fallo = e.mensaje, True
                self.srv.log.warning("reunion turno agente=%s status=%s", ag["id"], e.status)
            finally:
                self.app.costos.registrar(carpeta, "reunion", caja.valor, ag["id"], id_)
            if fallo:
                ultimo = texto
            else:
                ok = True
            self._turno(id_, carpeta, ronda, ag["id"], texto, fallo)
        return ok, ultimo


def instalar(app, srv):
    """Engancha las reuniones al App del servidor: `app.reuniones`."""
    app.reuniones = Reuniones(app, srv)
    return app.reuniones
