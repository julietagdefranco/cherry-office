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
import hq_entregas
import hq_tareas
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
COLUMNAS = "id,oficina,tema,agentes,estado,creada,cerrada,sintesis,error_sintesis,acta,error,documentos,patron,lider,bandos,salida"
PATRONES = ("debate", "lider", "mapreduce", "redblue", "revision")
ETIQUETAS = {"debate": "Debate", "lider": "Líder y equipo", "mapreduce": "Map-reduce (opiniones independientes)",
             "redblue": "Red/blue (dos bandos)", "revision": "Panel de revisión"}
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


# ----------------------------------------------------------------------------- patrones (puros)
# Mismos textos y mismo orden que app/Sources/Backend/ReunionPatrones.swift.

def plan(patron, ids, lider, bandos):
    """Orden de una ronda: lista de (agente, fase). Map-reduce da el orden de siempre pero se corre en paralelo."""
    libre = [(i, "libre") for i in ids]
    if patron == "revision":
        return [(i, "revisa") for i in ids]
    if patron == "lider":
        if lider not in ids:
            return libre
        return [(lider, "abre")] + [(i, "opina") for i in ids if i != lider] + [(lider, "cierra")]
    if patron == "redblue":
        if not bandos:
            return libre
        a = [i for i in ids if i in bandos["a"]]
        b = [i for i in ids if i in bandos["b"]]
        out = []
        for k in range(max(len(a), len(b))):
            if k < len(a):
                out.append((a[k], "defiende"))
            if k < len(b):
                out.append((b[k], "critica"))
        return out
    return libre


def visibles(patron, turnos, ronda):
    """Map-reduce: nadie ve los turnos de la ronda en curso (sí las intervenciones del usuario y las rondas anteriores)."""
    if patron != "mapreduce":
        return turnos
    return [t for t in turnos if t["ronda"] < ronda or t["agente"] == "usuario"]


def salida_por_defecto(tema, fecha):
    return "archivos/entregables/reuniones/%s-%s.md" % (fecha.strftime("%Y-%m-%d"), hq_core.slug_de(tema) or "reunion")


def error_de_salida(s):
    """Mensaje de error si `s` no sirve como ruta de salida; None si está bien."""
    malo = "«salida» tiene que ser una ruta relativa dentro de archivos/ que termine en .md (sin «..»)."
    if not isinstance(s, str) or not s or len(s) > 200 or s[0] in "/~" or "\\" in s or "\0" in s:
        return malo
    comps = s.split("/")
    if len(comps) < 2 or comps[0] != "archivos":
        return malo
    if any(c == "" or c.startswith(".") for c in comps):
        return malo
    if not comps[-1].lower().endswith(".md") or len(comps[-1]) <= 3:
        return malo
    return None


def ruta_libre(rel, existe):
    if not existe(rel):
        return rel
    base, n = rel[:-3], 2
    while existe("%s-%d.md" % (base, n)):
        n += 1
    return "%s-%d.md" % (base, n)


def _nombres(lista):
    return ", ".join("%s (%s)" % (a["nombre"], a["rol"]) for a in lista)


def consigna(patron, fase, quien, lider, bando_a, bando_b):
    """Último párrafo del prompt de un turno. En debate es el texto de siempre."""
    n, r = quien["nombre"], quien["rol"]
    cierre = "Respondé solo con tu intervención, en primera persona y sin encabezados."
    if patron == "lider" and fase == "abre":
        return ("Sos %s, %s, y liderás esta reunión. Abrí la ronda en 100-150 palabras: encuadrá el tema, decí qué hay que "
                "resolver y dejale al equipo dos o tres preguntas concretas. %s") % (n, r, cierre)
    if patron == "lider" and fase == "opina":
        l = "%s (%s)" % (lider["nombre"], lider["rol"]) if lider else "el líder"
        return ("Sos %s, %s. %s lidera la reunión y ya abrió la ronda. Opiná desde tu rol en 120-180 palabras, respondiendo a "
                "lo que planteó y sin repetir lo ya dicho; decí con qué estás de acuerdo y con qué no, y proponé un próximo "
                "paso concreto. %s") % (n, r, l, cierre)
    if patron == "lider" and fase == "cierra":
        return ("Sos %s, %s, y liderás esta reunión. El equipo ya opinó en esta ronda. Cerrala con tu posición en 100-150 "
                "palabras: qué tomás de lo dicho, qué descartás y por qué, y qué queda por decidir. %s") % (n, r, cierre)
    if patron == "mapreduce":
        return ("Sos %s, %s. En esta ronda cada participante responde por separado y sin ver lo que dicen los demás; no "
                "asumas qué van a decir. Opiná desde tu rol en 120-180 palabras, con tu propia postura (podés apoyarte en "
                "lo dicho en rondas anteriores) y proponé un próximo paso concreto. %s") % (n, r, cierre)
    if patron == "redblue" and fase == "defiende":
        return ("Esta reunión es un debate entre dos bandos. Bando A (defiende la propuesta o postura del tema): %s. Bando B "
                "(la critica): %s. Sos %s, %s, del bando A: DEFENDÉS. Argumentá a favor desde tu rol en 120-180 palabras, "
                "respondiendo a las críticas del bando B si ya hablaron y sin repetir lo ya dicho, y proponé un próximo paso "
                "concreto. %s") % (_nombres(bando_a), _nombres(bando_b), n, r, cierre)
    if patron == "redblue" and fase == "critica":
        return ("Esta reunión es un debate entre dos bandos. Bando A (defiende la propuesta o postura del tema): %s. Bando B "
                "(la critica): %s. Sos %s, %s, del bando B: CRITICÁS. Señalá desde tu rol en 120-180 palabras los riesgos, "
                "huecos y objeciones de lo que defendió el bando A, sin repetir lo ya dicho, y proponé qué habría que "
                "cambiar o probar. %s") % (_nombres(bando_a), _nombres(bando_b), n, r, cierre)
    if patron == "revision":
        return ("Sos %s, %s. Esta reunión es un panel de revisión de los documentos adjuntos. Revisalos desde tu rol en "
                "120-180 palabras: hallazgos (qué está bien y qué falla), riesgos y qué cambiarías, sin repetir lo que ya "
                "señalaron tus colegas. Si necesitás el texto completo, leelo en archivos/.texto/<slug>.md. %s"
                ) % (n, r, cierre.replace("tu intervención", "tu revisión"))
    return ("Sos %s, %s. Opiná desde tu rol en 120-180 palabras, sin repetir lo ya dicho; decí con qué estás de acuerdo "
            "y con qué no, y proponé un próximo paso concreto. Respondé solo con tu opinión, en primera persona y sin "
            "encabezados.") % (n, r)


def variante_sintesis(patron, lider, bando_a, bando_b):
    """Frase que se suma al prompt de la síntesis según el patrón ('' en debate)."""
    if patron == "lider":
        return ("\nLa reunión la lideró %s, que abrió y cerró cada ronda: su posición final pesa en las decisiones."
                % ("%s (%s)" % (lider["nombre"], lider["rol"]) if lider else "un líder"))
    if patron == "mapreduce":
        return ("\nCada participante opinó por separado en cada ronda, sin ver a los demás: en el resumen marcá las "
                "coincidencias y las diferencias entre posturas independientes.")
    if patron == "redblue":
        return ("\nFue un debate entre dos bandos. Bando A (defiende): %s. Bando B (critica): %s. El resumen tiene que "
                "ponderar los argumentos de ambos bandos con equilibrio, y las decisiones reflejar qué se adopta y qué "
                "objeciones del bando B se incorporan." % (_nombres(bando_a), _nombres(bando_b)))
    if patron == "revision":
        return ("\nFue un panel de revisión de los documentos adjuntos: en «decisiones» poné los cambios recomendados "
                "(concretos y accionables) y en «resumen» los hallazgos y riesgos principales.")
    return ""


def markdown_salida(oficina, f, participantes, sintesis, error_sintesis, acta, fecha):
    patron = f.get("patron") or "debate"
    s = "# %s\n\n" % f["tema"]
    s += "- **Patrón:** %s\n- **Oficina:** %s\n- **Fecha:** %s\n" % (ETIQUETAS.get(patron, "Debate"), oficina["nombre"],
                                                                      fecha.strftime("%Y-%m-%d"))
    s += "- **Participantes:** %s\n" % _gente(participantes)
    if patron == "lider" and f.get("lider"):
        s += "- **Líder:** %s\n" % nombre_de(f["lider"], oficina)
    if patron == "redblue" and f.get("bandos"):
        s += "- **Bando A (defiende):** %s\n" % ", ".join(nombre_de(i, oficina) for i in f["bandos"].get("a", []))
        s += "- **Bando B (critica):** %s\n" % ", ".join(nombre_de(i, oficina) for i in f["bandos"].get("b", []))
    s += "\n## Resumen\n\n"
    if sintesis:
        s += (sintesis["resumen"] or "_(sin resumen)_") + "\n\n## " + ("Cambios recomendados" if patron == "revision" else "Decisiones") + "\n\n"
        s += ("\n".join("- " + d for d in sintesis["decisiones"]) + "\n") if sintesis["decisiones"] else "_(ninguna)_\n"
        s += "\n## Pendientes\n\n"
        if sintesis["pendientes"]:
            s += "\n".join(linea_md(p) for p in sintesis["pendientes"]) + "\n"
        else:
            s += "_(ninguno)_\n"
    else:
        s += "_No se pudo generar la síntesis%s._\n" % (": " + error_sintesis.strip().rstrip(".…").rstrip() if error_sintesis else "")
    s += "\n---\n" + ("Acta completa con la transcripción: `%s`.\n" % acta if acta else "_(el acta no se pudo guardar)_\n")
    return s


# ---- pendientes que llegan a quien se encarga (Pendientes.swift)

TITULO_PENDIENTES = "## Pendientes de reuniones"


def _normal(s):
    return unicodedata.normalize("NFD", (s or "").lower()).encode("ascii", "ignore").decode().strip()


def agente_de_pendiente(quien, oficina):
    """Agente responsable: id exacto, nombre completo o primera palabra del nombre (si es única). None = nadie / la persona."""
    q = _normal(quien)
    if not q:
        return None
    for a in oficina.get("agentes") or []:
        if _normal(a["id"]) == q or _normal(a["nombre"]) == q:
            return a
    primera = q.split(" ")[0]
    cand = [a for a in oficina.get("agentes") or [] if (_normal(a["nombre"]).split(" ") or [""])[0] == primera]
    return cand[0] if len(cand) == 1 else None


def linea_pendiente(p, tema, dia):
    que = " ".join(p["que"].split("\n"))
    return "- [ ] %s · reunión «%s»: %s%s" % (dia, tema, que,
                                              " (necesita a la persona: avisale qué hace falta)" if p.get("necesita_usuario") else "")


def consigna_encargo(tema, acta, p):
    """Consigna del encargo («Hacelo ahora»): el pendiente con su contexto y dónde dejar lo que produzca."""
    s = "Pendiente de la reunión «%s»" % tema
    if acta:
        s += " (acta: `%s`)" % acta
    return s + (":\n\n%s\n\nHacelo ahora. Si producís un documento, guardalo en `archivos/entregables/` y decí al final qué "
                "archivo dejaste." % p["que"])


def tildar(carpeta, agente, linea):
    """Marca `- [x]` la primera línea exacta del pendiente en las notas del agente. -> si la encontró."""
    ruta = os.path.join(carpeta, "conocimiento", "agentes", agente + ".md")
    if not linea.startswith("- [ ] "):
        return False
    try:
        with open(ruta, encoding="utf-8") as fh:
            lineas = fh.read().split("\n")
    except OSError:
        return False
    if linea not in lineas:
        return False
    lineas[lineas.index(linea)] = "- [x] " + linea[6:]
    hq_core.escribir_atomico(ruta, "\n".join(lineas))
    return True


def linea_md(p):
    base = ("- **%s:** %s" % (p["quien"], p["que"])) if p["quien"] else "- " + p["que"]
    return base + (" _(necesita a la persona)_" if p.get("necesita_usuario") else "")


def consigna_secretario(duenio):
    return ("\n\nPara cada pendiente agregá \"necesita_usuario\": true si el responsable NO lo puede hacer solo. Los agentes de la "
            "oficina solo pueden leer archivos de la oficina y escribir sus notas y sus entregables: no pueden correr programas ni "
            "scripts, mandar mensajes o mails, publicar, ni mirar el calendario, el correo u otras apps. Si un pendiente necesita "
            "eso, asignalo a %s (o al agente, con \"necesita_usuario\": true si el agente prepara algo y la persona lo ejecuta). "
            "Usá en \"quien\" el nombre exacto de un participante o el de la persona."
            % (duenio or "la persona dueña de la oficina"))


def repartir_pendientes(carpeta, oficina, tema, pendientes, fecha):
    """Anexa cada pendiente asignado a un agente en sus notas (sección «Pendientes de reuniones»). -> {id: cantidad}."""
    dia = fecha.strftime("%Y-%m-%d")
    por = {}
    for p in pendientes:
        a = agente_de_pendiente(p["quien"], oficina)
        if a:
            por.setdefault(a["id"], []).append(linea_pendiente(p, tema, dia))
    for id_, lineas in por.items():
        ruta = os.path.join(carpeta, "conocimiento", "agentes", id_ + ".md")
        try:
            with open(ruta, encoding="utf-8") as fh:
                t = fh.read()
        except OSError:
            t = ""
        if t and not t.endswith("\n"):
            t += "\n"
        if TITULO_PENDIENTES not in t:
            t += ("\n" if t else "") + TITULO_PENDIENTES + "\n"
        i = t.index(TITULO_PENDIENTES) + len(TITULO_PENDIENTES)
        j = t.find("\n## ", i)
        j = len(t) if j < 0 else j
        bloque = t[i:j]
        if not bloque.endswith("\n"):
            bloque += "\n"
        bloque += "\n".join(lineas) + "\n"
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        hq_core.escribir_atomico(ruta, t[:i] + bloque + t[j:])
    return {k: len(v) for k, v in por.items()}


def prompt_turno(oficina, carpeta, tema, participantes, quien, turnos, ronda, fichas_texto="",
                 patron="debate", fase="libre", lider=None, bando_a=(), bando_b=()):
    dicho = transcripcion(visibles(patron, turnos, ronda), oficina, False, MAX_TRANSCRIPCION_TURNO)
    docs = ("\n\nDocumentos adjuntos a la reunión (fichas de la biblioteca; el texto completo está en "
            "archivos/.texto/<slug>.md):\n" + fichas_texto) if fichas_texto else ""
    return (
        "Estás en una reunión de la oficina «%s». Tema de la reunión:\n%s\n\n"
        "Participantes: %s\n\n"
        "Memoria común de la oficina:\n%s\n\n"
        "Decisiones recientes:\n%s%s\n\n"
        "Lo que se dijo hasta ahora (estamos en la ronda %d):\n%s\n\n"
        "%s"
    ) % (oficina["nombre"], tema, _gente(participantes), memoria(carpeta), decisiones_recientes(carpeta), docs, ronda,
         dicho or "(todavía no habló nadie)", consigna(patron, fase, quien, lider, bando_a, bando_b))


def prompt_sintesis(oficina, tema, participantes, turnos, patron="debate", lider=None, bando_a=(), bando_b=()):
    return (
        "Sos el secretario de actas de la oficina «%s». Tema de la reunión: %s\n"
        "Participantes: %s\n\n"
        "Transcripción:\n%s\n\n"
        "Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:\n"
        "{\"resumen\": \"resumen de la reunión en 3-6 oraciones\", \"decisiones\": [\"decisión concreta confirmada por la "
        "conversación\"], \"pendientes\": [{\"quien\": \"nombre de quien se encarga\", \"que\": \"tarea concreta\", "
        "\"necesita_usuario\": false}]}\n"
        "Incluí en \"decisiones\" solo lo que quedó razonablemente acordado (puede ser una lista vacía) y en "
        "\"pendientes\" los próximos pasos con responsable.%s%s"
    ) % (oficina["nombre"], tema, _gente(participantes),
         transcripcion(turnos, oficina, True, MAX_TRANSCRIPCION_ACTA), consigna_secretario(oficina.get("duenio") or ""),
         variante_sintesis(patron, lider, bando_a, bando_b))


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
                pend.append({"quien": cad(p.get("quien")), "que": cad(p.get("que")),
                             "necesita_usuario": p.get("necesita_usuario") is True})
        elif cad(p):
            pend.append({"quien": "", "que": cad(p), "necesita_usuario": False})
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
            s += "\n".join(linea_md(p) for p in sintesis["pendientes"]) + "\n"
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
            cols = [r[1] for r in c.execute("PRAGMA table_info(reuniones)").fetchall()]
            for nombre in ("patron", "lider", "bandos", "salida"):
                if nombre not in cols:
                    c.execute("ALTER TABLE reuniones ADD COLUMN %s TEXT" % nombre)
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
        try:
            bandos = json.loads(r[14]) if r[14] else None
        except ValueError:
            bandos = None
        return {"patron": r[12] or "debate", "lider": r[13], "bandos": bandos if isinstance(bandos, dict) else None,
                "salida": r[15], "id": r[0], "oficina": r[1], "tema": r[2], "agentes": ags if isinstance(ags, list) else [], "estado": r[4],
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
        if len(partes) < 2 or len(partes) > 6 or partes[0] != "api" or partes[1] != "reuniones" or "" in partes:
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
        if n == 5:
            return 404, {"error": "no"}
        if n == 6:
            # POST /api/reuniones/:id/pendientes/:n/encargar
            if partes[3] != "pendientes" or not partes[4].isdigit() or partes[5] != "encargar":
                return 404, {"error": "no"}
            return (202, self._encargar(id_, int(partes[4]))) if m == "POST" else no
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
        o["patron"] = f.get("patron") or "debate"
        if f.get("lider"):
            o["lider"] = f["lider"]
        if f.get("bandos"):
            o["bandos"] = f["bandos"]
        if f.get("salida"):
            o["salida"] = f["salida"]
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
        if f["estado"] == "cerrada" and f.get("salida") and os.path.isfile(os.path.join(f["oficina"], f["salida"])):
            o["salidaRuta"] = os.path.join(f["oficina"], f["salida"])
        return o

    def _respuesta(self, id_, carpeta):
        vh = self._vivo(id_)
        f = self._fila(id_, carpeta)
        o = self._vista(f, self._turnos(id_), vivo_hablando=vh)
        e = self._estado_pendientes(f, carpeta)
        if e is not None:
            o["pendientesEstado"] = e
        return o

    # ---- pendientes que se ejecutan (E1; paridad con PendientesAcciones.swift)

    @staticmethod
    def _pendientes(f):
        if f["estado"] != "cerrada" or not f["sintesis"]:
            return None
        s = parsear_sintesis(f["sintesis"])
        return (s or {}).get("pendientes") or None

    def _estado_pendientes(self, f, carpeta):
        ps = self._pendientes(f)
        if ps is None:
            return None
        try:
            of = hq_core.leer_oficina(carpeta)
        except ErrorAPI:
            return None
        tareas_app = getattr(self.app, "tareas", None)
        entregas = getattr(self.app, "entregas", None)
        out = []
        for i, p in enumerate(ps):
            ag = agente_de_pendiente(p["quien"], of)
            o = {"pendiente": i, "agente": ag["id"] if ag else None,
                 "encargable": bool(ag) and not p.get("necesita_usuario") and tareas_app is not None}
            id_enc = hq_tareas.id_encargo(f["id"], i)
            ult = tareas_app._ejecuciones(carpeta, id_enc, 1) if tareas_app is not None else []
            if ult:
                ej = hq_tareas.ejecucion_json(ult[0])
                enc = {"estado": ej["estado"], "ejecucion": ej["id"]}
                if ej["estado"] == "error":
                    enc["error"] = ej.get("error") or "Falló."
                if entregas is not None:
                    e = next((x for x in entregas.lista(carpeta, origen="encargo", limite=500) if x[4] == id_enc), None)
                    if e is not None:
                        enc["entrega"], enc["entregaEstado"] = e[0], e[10]
                o["encargo"] = enc
            o["tareas"] = [{"id": t["id"], "nombre": t["nombre"]} for t in of.get("tareas") or []
                           if t.get("origen") == {"reunion": f["id"], "pendiente": i}]
            out.append(o)
        return out

    def _encargar(self, id_, n):
        tareas_app = getattr(self.app, "tareas", None)
        if tareas_app is None:
            raise ErrorAPI(404, "no")
        carpeta, of = self.app.requerir_activa()
        f = self._fila(id_, carpeta)
        ps = self._pendientes(f)
        if ps is None:
            raise ErrorAPI(409, "La reunión todavía no tiene pendientes (se cierran con el acta).")
        if n >= len(ps):
            raise ErrorAPI(404, "No existe ese pendiente.")
        p = ps[n]
        if p.get("necesita_usuario"):
            raise ErrorAPI(409, "Ese pendiente necesita tu parte: el agente no lo puede hacer solo.")
        definicion = agente_de_pendiente(p["quien"], of)
        if definicion is None:
            raise ErrorAPI(409, "Ese pendiente no es de un agente de la oficina.")
        tareas_app.encargar(carpeta, of, definicion, id_, n, hq_entregas.titulo(p["que"]),
                            consigna_encargo(f["tema"], f["acta"], p))
        return {"id": id_, "pendientesEstado": self._estado_pendientes(self._fila(id_, carpeta), carpeta) or []}

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
        patron = "debate"
        if d.get("patron") is not None:
            if not isinstance(d["patron"], str) or d["patron"] not in PATRONES:
                raise ErrorAPI(400, "«patron» tiene que ser uno de: %s." % ", ".join(PATRONES))
            patron = d["patron"]
        lider = None
        if patron == "lider":
            lider = d.get("lider")
            if not isinstance(lider, str) or lider not in ids:
                raise ErrorAPI(400, "«lider» tiene que ser uno de los participantes.")
        bandos = None
        if patron == "redblue":
            malo = ErrorAPI(400, "«bandos» tiene que repartir a todos los participantes entre «a» y «b», con al menos uno en cada bando.")
            b = d.get("bandos")
            if not isinstance(b, dict) or not isinstance(b.get("a"), list) or not isinstance(b.get("b"), list):
                raise malo
            ba, bb = b["a"], b["b"]
            if (not ba or not bb or not all(isinstance(x, str) for x in ba + bb) or len(set(ba)) != len(ba)
                    or len(set(bb)) != len(bb) or set(ba) & set(bb) or set(ba) | set(bb) != set(ids)):
                raise malo
            bandos = {"a": ba, "b": bb}
        if patron == "revision" and not documentos:
            raise ErrorAPI(400, "El panel de revisión necesita al menos un documento adjunto.")
        salida = salida_por_defecto(tema, datetime.date.today())
        if d.get("salida") is not None:
            t = d["salida"].strip() if isinstance(d["salida"], str) else None
            err = error_de_salida(t)
            if err:
                raise ErrorAPI(400, err)
            salida = t
        id_ = str(uuid.uuid4())
        orden = [a["id"] for a in ordenar([agente_de(of, i) for i in ids], of, tema)]
        self._sql("INSERT INTO reuniones(id,oficina,tema,agentes,estado,creada,documentos,patron,lider,bandos,salida) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                  (id_, carpeta, tema, json.dumps(orden), "esperando", time.time(),
                   json.dumps(documentos) if documentos else None, patron, lider,
                   json.dumps(bandos, sort_keys=True) if bandos else None, salida), escribir=True)
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
            lider_def, banda, bandb = self._roles(f, of)
            sintesis, err_sint = None, None
            if not any(not t["error"] for t in turnos):
                err_sint = "No hubo opiniones para resumir."
            else:
                caja = hq_vivo.CajaCosto()
                try:
                    t = self._sin_agente(prompt_sintesis(of, f["tema"], parts, turnos, f["patron"], lider_def, banda, bandb),
                                         carpeta, self.timeout_sintesis,
                                         caja.observador())
                    sintesis = parsear_sintesis(t)
                    if sintesis is None:
                        err_sint = "La síntesis no vino en el formato esperado."
                except ErrorAPI as e:
                    err_sint = e.mensaje
                self.app.costos.registrar(carpeta, "sintesis", caja.valor, ref=id_)
            hoy = datetime.date.today()
            error_acta, rel, salida_final = None, None, None
            texto_acta = acta_md(of, f["tema"], parts, turnos, sintesis, err_sint, hoy)
            try:
                rel = self._escribir_acta(carpeta, f["tema"], hoy, texto_acta)
                if sintesis and sintesis["decisiones"]:
                    hq_core.anexar_decisiones(carpeta, sintesis["decisiones"], hoy)
                if sintesis and sintesis["pendientes"]:
                    repartir_pendientes(carpeta, of, f["tema"], sintesis["pendientes"], hoy)
                    para_vos = sum(1 for p in sintesis["pendientes"] if p.get("necesita_usuario") or agente_de_pendiente(p["quien"], of) is None)
                    if para_vos and getattr(self.app, "avisos", None):
                        self.app.avisos.crear(carpeta, "pendiente",
                                              "Quedó 1 pendiente de «%s» que necesita tu parte" % f["tema"] if para_vos == 1 else
                                              "Quedaron %d pendientes de «%s» que necesitan tu parte" % (para_vos, f["tema"]), ref=id_)
            except (OSError, ErrorAPI):
                error_acta = "No pude guardar el acta o las decisiones en la carpeta de la oficina."
                self.srv.log.exception("reuniones: no pude escribir el acta")
            # archivo de salida: lo escribe el backend (los turnos son de solo lectura); un fallo se informa como el del acta
            if f.get("salida"):
                try:
                    final = self._escribir_salida(carpeta, f["salida"], markdown_salida(of, f, parts, sintesis, err_sint, rel, hoy))
                    self._sql("UPDATE reuniones SET salida=? WHERE id=?", (final, id_), escribir=True)
                    salida_final = final
                except (OSError, ErrorAPI):
                    if not error_acta:
                        error_acta = "No pude guardar el archivo de salida (%s)." % f["salida"]
                    self.srv.log.exception("reuniones: no pude escribir la salida")
            self._sql("UPDATE reuniones SET estado='cerrada', cerrada=?, sintesis=?, error_sintesis=?, acta=?, error=? WHERE id=?",
                      (time.time(), json.dumps(sintesis, ensure_ascii=False) if sintesis else None, err_sint, rel,
                       error_acta, id_), escribir=True)
            # el acta queda como entrega para revisar (sin agente: es de la reunión)
            if rel and getattr(self.app, "entregas", None):
                self.app.entregas.crear(carpeta, "", "reunion", id_, "Acta: %s" % f["tema"], texto_acta,
                                        archivos=[rel] + ([salida_final] if salida_final else []))
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

    @staticmethod
    def _escribir_salida(carpeta, rel, texto):
        """Escribe `rel` (ya validada, dentro de archivos/) creando carpetas; si existe agrega -2, -3. Devuelve la ruta final.
        Se niega si un enlace simbólico sacaría el archivo de la carpeta de la oficina."""
        if error_de_salida(rel):
            raise ErrorAPI(400, "salida inválida")
        final = ruta_libre(rel, lambda r: os.path.exists(os.path.join(carpeta, r)))
        ruta = os.path.join(carpeta, final)
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        base = os.path.realpath(carpeta) + os.sep
        if not (os.path.realpath(os.path.dirname(ruta)) + os.sep).startswith(base):
            raise ErrorAPI(400, "salida fuera de la oficina")
        hq_core.escribir_atomico(ruta, texto)
        return final

    @staticmethod
    def _roles(f, of):
        """Líder y bandos de la reunión como agentes (los que ya no existan en la oficina se omiten)."""
        bandos = f.get("bandos") or {}
        return (agente_de(of, f["lider"]) if f.get("lider") else None,
                [a for a in (agente_de(of, i) for i in bandos.get("a", [])) if a],
                [a for a in (agente_de(of, i) for i in bandos.get("b", [])) if a])

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
        """Una ronda en el orden y con la consigna que marca el patrón. -> (hubo algún turno bueno, último error)."""
        try:
            of = hq_core.leer_oficina(carpeta)
        except ErrorAPI:
            return False, "No pude leer la oficina."
        f = self._reunion(id_, carpeta)
        if f is None:
            return False, "No encontré la reunión."
        ronda = max([t["ronda"] for t in self._turnos(id_)] or [0]) + 1
        parts = [a for a in (agente_de(of, i) for i in f["agentes"]) if a]
        pasos = plan(f["patron"], [a["id"] for a in parts], f.get("lider"), f.get("bandos"))
        ok, ultimo = False, None
        if f["patron"] == "mapreduce":
            # todos a la vez (un hilo por agente); cada uno respeta su carril y no ve los turnos de esta ronda
            pendientes = [p[0] for p in pasos]
            with self.mut:
                self.hablando[id_] = pendientes[0] if pendientes else None
            resultados = []

            def hilo(paso):
                try:
                    r = self._hacer_turno(id_, carpeta, of, f, ronda, parts, paso)
                except Exception:
                    self.srv.log.exception("reuniones: fallo un turno")
                    r = ("No pude responder.", True)
                with self.mut:
                    resultados.append(r)
                    pendientes.remove(paso[0])
                    self.hablando[id_] = pendientes[0] if pendientes else None

            hilos = [threading.Thread(target=hilo, args=(p,), daemon=True) for p in pasos]
            for h in hilos:
                h.start()
            for h in hilos:
                h.join()
            for texto, fallo in resultados:
                if fallo:
                    ultimo = texto
                else:
                    ok = True
            return ok, ultimo
        for paso in pasos:
            with self.mut:
                self.hablando[id_] = paso[0]
            texto, fallo = self._hacer_turno(id_, carpeta, of, f, ronda, parts, paso)
            if fallo:
                ultimo = texto
            else:
                ok = True
        return ok, ultimo

    def _hacer_turno(self, id_, carpeta, of, f, ronda, parts, paso):
        """Un turno: arma el prompt, corre el turno de solo lectura en el carril del agente (con actividad y costo) y lo guarda."""
        ag = agente_de(of, paso[0])
        if ag is None:
            return "No encontré al agente.", True
        lider_def, banda, bandb = self._roles(f, of)
        prompt = prompt_turno(of, carpeta, f["tema"], parts, ag, self._turnos(id_), ronda, fichas(carpeta, f.get("documentos")),
                              f["patron"], paso[1], lider_def, banda, bandb)
        fallo = False
        caja = hq_vivo.CajaCosto()
        try:
            with self.app._lock(carpeta, ag["id"]):  # mismo carril que el chat 1 a 1 de ese agente
                with self.app.actividad.seguir(carpeta, ag["id"], "reunion", "Reunión: " + f["tema"],
                                               extra=caja.observador()) as (obs, _t):
                    texto = self._turno_solo_lectura(ag["id"], prompt, carpeta, hq_core.dirs_vinculos(of, ag), obs).strip()
            if not texto:
                texto, fallo = "(sin respuesta)", True
        except ErrorAPI as e:
            texto, fallo = e.mensaje, True
            self.srv.log.warning("reunion turno agente=%s status=%s", ag["id"], e.status)
        finally:
            self.app.costos.registrar(carpeta, "reunion", caja.valor, ag["id"], id_)
        self._turno(id_, carpeta, ronda, ag["id"], texto, fallo)
        return texto, fallo


def instalar(app, srv):
    """Engancha las reuniones al App del servidor: `app.reuniones`."""
    app.reuniones = Reuniones(app, srv)
    if getattr(app, "entregas", None) is not None:
        app.entregas.al_revisar = lambda e, carpeta: _tildar_encargo(app.reuniones, e, carpeta)
    return app.reuniones


def _tildar_encargo(reus, e, carpeta):
    """Al revisar la entrega de un encargo: tilda el pendiente que lo originó (si sigue en las notas)."""
    de = hq_tareas.de_encargo(e.get("ref")) if e.get("origen") == "encargo" else None
    if not de:
        return
    f = reus._reunion(de[0], carpeta)
    ps = Reuniones._pendientes(f) if f else None
    if not ps or de[1] >= len(ps):
        return
    try:
        of = hq_core.leer_oficina(carpeta)
    except ErrorAPI:
        return
    a = agente_de_pendiente(ps[de[1]]["quien"], of)
    if a:
        dia = datetime.date.fromtimestamp(f["cerrada"] or f["creada"]).strftime("%Y-%m-%d")
        tildar(carpeta, a["id"], linea_pendiente(ps[de[1]], f["tema"], dia))
