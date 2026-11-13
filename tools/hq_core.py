"""Núcleo de oficinas de Próspera HQ (Python 3.9, solo librería estándar).

Lo usan oficina/server.py (modo desarrollo en el navegador) y tools/importar_prospera.py. Es la misma lógica
que app/Sources/Backend/{Oficina,Agentes,Plantillas,Importar}.swift: si cambia una, cambia la otra.
Todas las funciones trabajan sobre la carpeta de una oficina (oficina.json es la fuente de verdad) y lanzan
ErrorAPI(status, mensaje) con mensajes en español. No hay estado global: el que llama serializa las escrituras.
"""
import datetime
import json
import os
import re
import shutil
import unicodedata
import uuid
import zoneinfo  # Python 3.9+

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
RESERVADOS = {"general-purpose", "explore", "plan", "statusline-setup", "claude-code-guide", "claude"}
MODELOS = {"sonnet", "opus", "haiku", "inherit"}
PALETA = ["#ee6da6", "#a88bd6", "#f0a35b", "#e6c22e", "#4aa0dc", "#5fbf8a", "#d9684f", "#7f8fa6"]
DEPARTAMENTOS_SUGERIDOS = ["Dirección", "Comunicación", "Operaciones"]
MAX_DEPARTAMENTOS = 12
MAX_AGENTES = 60
MARCA_MEMORIA = "## Memoria de la oficina"
MARCA_PROSPERA = ".importada-prospera"
NOMBRE_PROSPERA = "Próspera HQ"
AVATAR_CAMPOS = ["semilla", "pelo", "colorPelo", "cara", "torso", "colorTorso", "colorPiernas"]


class ErrorAPI(Exception):
    def __init__(self, status, mensaje):
        Exception.__init__(self, mensaje)
        self.status = status
        self.mensaje = mensaje


SIN_OFICINA = "No hay una oficina abierta"


# ----------------------------------------------------------------------------- slugs y validaciones

def slug_valido(s):
    return isinstance(s, str) and bool(SLUG_RE.match(s))


def slug_de(s):
    """Minúsculas, sin acentos, lo que no es alfanumérico -> '-'. Puede dar ''."""
    base = unicodedata.normalize("NFKD", s)
    base = "".join(c for c in base if not unicodedata.combining(c)).lower()
    out = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    if len(out) > 41:
        out = out[:41].rstrip("-")
    return out


def slug_unico(s, usados, respaldo):
    base = slug_de(s) or respaldo
    if base not in usados:
        return base
    n = 2
    while True:
        suf = "-%d" % n
        c = base[:41 - len(suf)] + suf
        if c not in usados:
            return c
        n += 1


def texto(v, campo, maximo, obligatorio=True):
    """Cadena recortada y no vacía de tamaño razonable (None si es opcional y falta), o ErrorAPI 400."""
    if v is None:
        if obligatorio:
            raise ErrorAPI(400, "Falta «%s»." % campo)
        return None
    if not isinstance(v, str):
        raise ErrorAPI(400, "«%s» tiene que ser texto." % campo)
    t = v.strip()
    if not t:
        if obligatorio:
            raise ErrorAPI(400, "Falta «%s»." % campo)
        return None
    if len(t) > maximo:
        raise ErrorAPI(400, "«%s» es demasiado largo (máximo %d caracteres)." % (campo, maximo))
    return t


def ruta_escritura_valida(r):
    return (isinstance(r, str) and r.startswith("conocimiento/") and ".." not in r and "\0" not in r
            and not r.endswith("/"))


def validar_oficina(o):
    if not isinstance(o, dict) or o.get("version") != 1:
        raise ErrorAPI(400, "oficina.json: versión no soportada (%s)." % (o.get("version") if isinstance(o, dict) else "?"))
    if not str(o.get("nombre") or "").strip():
        raise ErrorAPI(400, "oficina.json: falta el nombre.")
    deps = set()
    for d in o.get("departamentos", []):
        if not slug_valido(d.get("id")):
            raise ErrorAPI(400, "Departamento con id inválido: %s." % d.get("id"))
        if d["id"] in deps:
            raise ErrorAPI(400, "Departamento repetido: %s." % d["id"])
        deps.add(d["id"])
        if not str(d.get("nombre") or "").strip():
            raise ErrorAPI(400, "Departamento sin nombre: %s." % d["id"])
        if not COLOR_RE.match(str(d.get("color") or "")):
            raise ErrorAPI(400, "Color inválido en el departamento %s: %s." % (d["id"], d.get("color")))
    ids = set()
    for a in o.get("agentes", []):
        if not slug_valido(a.get("id")):
            raise ErrorAPI(400, "Agente con id inválido: %s." % a.get("id"))
        if a["id"] in ids:
            raise ErrorAPI(400, "Agente repetido: %s." % a["id"])
        ids.add(a["id"])
        if a.get("departamento") not in deps:
            raise ErrorAPI(400, "El agente %s está en un departamento que no existe (%s)." % (a["id"], a.get("departamento")))
        for r in a.get("escritura") or []:
            if not ruta_escritura_valida(r):
                raise ErrorAPI(400, "Ruta de escritura inválida en %s: %s." % (a["id"], r))
    vins = set()
    for v in o.get("vinculos") or []:
        if not isinstance(v, dict) or not slug_valido(v.get("id")) or v["id"] in vins:
            raise ErrorAPI(400, "Carpeta vinculada con id inválido o repetido: %s." % (v.get("id") if isinstance(v, dict) else v))
        vins.add(v["id"])
        if not str(v.get("ruta") or "").startswith("/"):
            raise ErrorAPI(400, "La carpeta vinculada %s tiene que tener una ruta absoluta." % v["id"])
    validar_tareas(o)


# ----------------------------------------------------------------------------- tareas programadas (ver tools/hq_tareas.py)

MAX_TAREAS = 50
MAX_CONSIGNA = 4000
MAX_NOMBRE_TAREA = 80
HORA_RE = re.compile(r"^([01][0-9]|2[0-3]):([0-5][0-9])$")


def hora_minuto(s):
    """"HH:MM" estricto -> (hora, minuto) o None."""
    m = HORA_RE.match(s) if isinstance(s, str) else None
    return (int(m.group(1)), int(m.group(2))) if m else None


def zona_valida(z):
    if not isinstance(z, str) or not z:
        return False
    try:
        zoneinfo.ZoneInfo(z)
        return True
    except Exception:
        return False


def validar_tareas(o):
    """Reglas de `tareas`: id slug único, agente existente (solo exigido a las activas: al despedir a un agente sus tareas
    quedan desactivadas y se conservan), días 1..7 sin repetir y no vacíos, hora, zona, consigna y nombre."""
    ts = o.get("tareas") or []
    if len(ts) > MAX_TAREAS:
        raise ErrorAPI(400, "Máximo %d tareas programadas." % MAX_TAREAS)
    ids = set()
    agentes = {a["id"] for a in o.get("agentes", [])}
    for t in ts:
        tid = t.get("id")
        if not slug_valido(tid) or tid in ids:
            raise ErrorAPI(400, "Tarea con id inválido o repetido: %s." % tid)
        ids.add(tid)
        if not slug_valido(t.get("agente")):
            raise ErrorAPI(400, "La tarea %s tiene un agente inválido." % tid)
        activa = t.get("activa", True)
        if not isinstance(activa, bool):
            raise ErrorAPI(400, "La tarea %s tiene un valor de «activa» inválido." % tid)
        if activa and t["agente"] not in agentes:
            raise ErrorAPI(400, "La tarea %s es de un agente que no existe (%s)." % (tid, t["agente"]))
        n = t.get("nombre")
        if not isinstance(n, str) or not n.strip() or len(n.strip()) > MAX_NOMBRE_TAREA:
            raise ErrorAPI(400, "La tarea %s necesita un nombre (hasta %d caracteres)." % (tid, MAX_NOMBRE_TAREA))
        c = t.get("consigna")
        if not isinstance(c, str) or not c.strip() or len(c.strip()) > MAX_CONSIGNA:
            raise ErrorAPI(400, "La consigna de la tarea %s tiene que tener entre 1 y %d caracteres." % (tid, MAX_CONSIGNA))
        d = t.get("dias")
        if (not isinstance(d, list) or not d or not all(type(x) is int and 1 <= x <= 7 for x in d) or len(set(d)) != len(d)):
            raise ErrorAPI(400, "Los días de la tarea %s tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir y al "
                                "menos uno." % tid)
        if hora_minuto(t.get("hora")) is None:
            raise ErrorAPI(400, "La hora de la tarea %s tiene que ser HH:MM (por ejemplo 08:00)." % tid)
        z = t.get("zona")
        if z is not None and not zona_valida(z):
            raise ErrorAPI(400, "La zona horaria de la tarea %s no existe: %s." % (tid, z))


# ----------------------------------------------------------------------------- oficina.json

def ruta_oficina(carpeta):
    return os.path.join(carpeta, "oficina.json")


def existe_oficina(carpeta):
    return os.path.isfile(ruta_oficina(carpeta))


def leer_oficina(carpeta):
    try:
        with open(ruta_oficina(carpeta), encoding="utf-8") as f:
            data = f.read()
    except OSError:
        raise ErrorAPI(404, "No hay una oficina en esa carpeta (falta oficina.json).")
    try:
        o = json.loads(data)
        if not isinstance(o, dict) or not isinstance(o.get("nombre"), str):
            raise ValueError("formato")
        o.setdefault("version", 1)
        o["duenio"] = o.get("duenio") if isinstance(o.get("duenio"), str) else ""
        o.setdefault("departamentos", [])
        o.setdefault("agentes", [])
        if not isinstance(o["departamentos"], list) or not isinstance(o["agentes"], list):
            raise ValueError("formato")
        if not all(isinstance(x, dict) for x in o["departamentos"] + o["agentes"]):
            raise ValueError("formato")
        if o.get("tareas") is not None and (not isinstance(o["tareas"], list) or not all(isinstance(x, dict) for x in o["tareas"])):
            raise ValueError("formato")
    except ValueError:
        raise ErrorAPI(400, "oficina.json no se puede leer: tiene un formato inválido.")
    validar_oficina(o)
    return o


def escribir_atomico(path, data):
    tmp = "%s.tmp-%s" % (path, uuid.uuid4().hex[:8])
    try:
        with open(tmp, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise ErrorAPI(500, "No pude guardar el archivo.")


def escribir_oficina(o, carpeta):
    """Valida y escribe de forma atómica (archivo temporal en la misma carpeta + os.replace)."""
    validar_oficina(o)
    escribir_atomico(ruta_oficina(carpeta),
                     json.dumps(o, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


# ----------------------------------------------------------------------------- plantillas

def oficina_md(nombre, duenio):
    quien = duenio or "el dueño"
    return ("# %s\n\n"
            "Memoria común de la oficina. Todos los agentes la leen al empezar; la edita %s y se completa con las "
            "decisiones de las reuniones.\n\n"
            "- **Oficina:** %s\n- **Dueño:** %s\n\n"
            "## Qué hace el negocio\n"
            "(Completá acá: a qué se dedica, a quién le vende, productos o servicios, tono de voz.)\n\n"
            "## Estado actual\n(Qué está en marcha, fechas importantes, prioridades de la semana.)\n\n"
            "## Reglas permanentes\n(Cosas que ningún agente debe olvidar ni contradecir.)\n"
            % (nombre, quien, nombre, duenio or "(sin completar)"))


def decisiones_md(nombre):
    return ("# Decisiones de %s\n\n"
            "Decisiones confirmadas. Solo se agregan al final (nunca se borran ni se reescriben), con fecha.\n\n"
            "Formato: `- AAAA-MM-DD: decisión (contexto breve si hace falta).`\n" % nombre)


def notas_agente_md(nombre, rol):
    return ("# %s: notas de trabajo\n\nRol: %s\n\n"
            "Acá %s anota lo que va aprendiendo: en qué está, qué entregó, qué espera de quién. Solo hechos, breve.\n"
            % (nombre, rol, nombre))


def seccion_memoria(id_):
    return (MARCA_MEMORIA + "\n"
            "Tu carpeta de trabajo es la raíz de la oficina; todas las rutas son relativas a ella.\n"
            "- Al empezar: leé `conocimiento/oficina.md` (contexto del negocio) y `conocimiento/decisiones.md` "
            "(decisiones confirmadas) y, si son relevantes para lo que te piden, las notas de otros agentes en "
            "`conocimiento/agentes/<id>.md`.\n"
            "- Al terminar algo concreto (una entrega, un pedido que quedó esperando a alguien, un cambio de plan): "
            "actualizá con Edit o Write SOLO tu archivo `conocimiento/agentes/%s.md`. Breve y solo hechos: en qué "
            "estás, qué entregaste, qué esperás de quién. Sin suposiciones.\n"
            "- Conocimiento y archivos: `conocimiento/archivos.md` es el catálogo de documentos de la oficina (una línea "
            "por documento); leelo al empezar. Cada documento tiene su ficha en `conocimiento/fuentes/<slug>.md` y su "
            "texto en `archivos/.texto/<slug>.md`; el material original está en `archivos/` (`compartido/` es de todos, "
            "el resto por departamento). Para citar un documento, usá la ficha.\n"
            "- Lo que produzcas para el usuario (informes, borradores, archivos) guardalo con Write en "
            "`archivos/entregables/%s/`; esa es la única carpeta de archivos donde podés escribir.\n"
            "- No podés escribir ningún otro archivo (el sistema lo impide igual). Si algo debería quedar como "
            "decisión, proponelo en una reunión o decile al usuario que lo registre.\n" % (id_, id_))


_YAML_RESERVADAS = {"null", "~", "true", "false", "yes", "no", "on", "off", "y", "n"}


def _es_numero(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def yaml_linea(s):
    """Valor YAML en una sola línea, entrecomillado y escapado si el valor plano no sería válido o cambiaría de tipo."""
    una = " ".join(l.strip() for l in re.split(r"[\r\n]+", s) if l.strip())
    peligroso = ((not una) or una[0] in "\"'[]{}&*!|>%@`#-?:," or " #" in una or ": " in una or una.endswith(":")
                 or '"' in una or "\\" in una or any(ord(c) < 0x20 or ord(c) == 0x7F for c in una)
                 or una.lower() in _YAML_RESERVADAS or _es_numero(una))
    if not peligroso:
        return una
    out = []
    for c in una:
        if c == "\\":
            out.append("\\\\")
        elif c == '"':
            out.append('\\"')
        elif c == "\t":
            out.append("\\t")
        elif ord(c) < 0x20 or ord(c) == 0x7F:
            out.append("\\u%04X" % ord(c))
        else:
            out.append(c)
    return '"%s"' % "".join(out)


def agente_md(id_, description, modelo, prompt):
    return "---\nname: %s\ndescription: %s\nmodel: %s\n---\n\n%s\n\n%s\n" % (
        id_, yaml_linea(description), modelo, prompt.strip(), seccion_memoria(id_))


def partes_md(t):
    lineas = t.split("\n")
    if lineas and lineas[0].strip() == "---":
        for i in range(1, len(lineas)):
            if lineas[i].strip() == "---":
                return lineas[1:i], "\n".join(lineas[i + 1:])
    return [], t


_ESC = {"n": "\n", "r": "\r", "t": "\t", "0": "\0"}


def valor_fm(fm, clave):
    for l in fm:
        if l.startswith(clave + ":"):
            v = l[len(clave) + 1:].strip()
            if not v or v[0] not in "\"'":
                i = v.find(" #")
                return v[:i].strip() if i >= 0 else v
            q, c, out, i = v[0], v[1:], [], 0
            while i < len(c):
                ch = c[i]
                if q == "'":
                    if ch == "'":
                        if c[i + 1:i + 2] == "'":
                            out.append("'")
                            i += 2
                            continue
                        break
                    out.append(ch)
                    i += 1
                    continue
                if ch == '"':
                    break
                if ch != "\\" or i + 1 >= len(c):
                    out.append(ch)
                    i += 1
                    continue
                e = c[i + 1]
                i += 2
                if e in _ESC:
                    out.append(_ESC[e])
                elif e in "xuU":
                    n = {"x": 2, "u": 4, "U": 8}[e]
                    h = c[i:i + n]
                    try:
                        if len(h) != n:
                            raise ValueError
                        out.append(chr(int(h, 16)))
                        i += n
                    except (ValueError, OverflowError):
                        out.append("\\" + e)
                else:
                    out.append(e)
            return "".join(out)
    return None


def fijar_fm(fm, clave, valor):
    out, puesto, saltando = [], False, False
    for l in fm:
        if l.startswith(clave + ":"):
            out.append("%s: %s" % (clave, valor))
            puesto = saltando = True
            continue
        if saltando and l[:1] in (" ", "\t"):
            continue
        saltando = False
        out.append(l)
    if not puesto:
        out.append("%s: %s" % (clave, valor))
    return out


def prompt_de(cuerpo):
    i = cuerpo.find(MARCA_MEMORIA)
    if i >= 0:
        cuerpo = cuerpo[:i]
    return cuerpo.strip()


def leer_texto(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def escribir_si_falta(carpeta, rel, contenido):
    p = os.path.join(carpeta, rel)
    if os.path.exists(p):
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(contenido)


# Carpetas de la biblioteca (ver tools/hq_biblioteca.py): material compartido, entregables de los agentes,
# texto extraído, papelera y fichas de los documentos.
CARPETAS_BIBLIOTECA = ("archivos/compartido", "archivos/entregables", "archivos/.texto", "archivos/.papelera",
                       "conocimiento/fuentes")


def archivos_md():
    """Catálogo vacío (lo regenera la biblioteca a medida que se agregan documentos)."""
    return ("# Archivos de la oficina\n\n"
            "Catálogo de documentos: una línea por documento. Para el detalle, leé su ficha en "
            "`conocimiento/fuentes/<slug>.md` y, si hace falta, el texto completo en `archivos/.texto/<slug>.md`.\n\n"
            "(Todavía no hay documentos.)\n")


def completar_estructura(carpeta):
    for d in ("conocimiento/agentes", "reuniones", "archivos", ".claude/agents") + CARPETAS_BIBLIOTECA:
        os.makedirs(os.path.join(carpeta, d), exist_ok=True)
    escribir_si_falta(carpeta, "conocimiento/archivos.md", archivos_md())


def crear_estructura(carpeta, o):
    completar_estructura(carpeta)
    for d in o.get("departamentos", []):
        os.makedirs(os.path.join(carpeta, "archivos", d["id"]), exist_ok=True)
    escribir_si_falta(carpeta, "conocimiento/oficina.md", oficina_md(o["nombre"], o["duenio"]))
    escribir_si_falta(carpeta, "conocimiento/decisiones.md", decisiones_md(o["nombre"]))


def anexar_decisiones(carpeta, decisiones, fecha=None):
    """Agrega `- AAAA-MM-DD: texto` al final de conocimiento/decisiones.md (append-only)."""
    if not decisiones:
        return
    p = os.path.join(carpeta, "conocimiento", "decisiones.md")
    dia = (fecha or datetime.date.today()).strftime("%Y-%m-%d")
    actual = leer_texto(p) or ""
    if actual and not actual.endswith("\n"):
        actual += "\n"
    for d in decisiones:
        una = " ".join(str(d).split())
        if una:
            actual += "- %s: %s\n" % (dia, una)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    escribir_atomico(p, actual)


def ahora_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


# ----------------------------------------------------------------------------- crear oficina y departamentos

def armar_departamento(p, indice, usados):
    nombre = texto(p.get("nombre") if isinstance(p, dict) else None, "nombre", 60)
    color = p.get("color") if p.get("color") else PALETA[indice % len(PALETA)]
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise ErrorAPI(400, "El color tiene que ser tipo #a88bdc.")
    pid = p.get("id")
    if pid:
        if not slug_valido(pid):
            raise ErrorAPI(400, "Id de departamento inválido (usá minúsculas, números y guiones).")
        if pid in usados:
            raise ErrorAPI(409, "Ya hay un departamento con ese id.")
        id_ = pid
    else:
        id_ = slug_unico(nombre, usados, "depto")
    return {"id": id_, "nombre": nombre, "color": color.lower()}


def carpeta_libre(base, nombre):
    limpio = "".join("-" if (c in "/:\\" or ord(c) < 32) else c for c in nombre).strip().lstrip(".")
    limpio = limpio or "Oficina"
    cand, n = os.path.join(base, limpio), 2
    while os.path.exists(cand):
        cand = os.path.join(base, "%s %d" % (limpio, n))
        n += 1
    return cand


def resolver_carpeta(c, home):
    c = c.strip()
    if not (c.startswith("/") or c == "~" or c.startswith("~/")):
        raise ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.")
    if c == "~":
        c = home
    elif c.startswith("~/"):
        c = os.path.join(home, c[2:])
    return os.path.abspath(c)


def crear_oficina(oficinas_dir, home, nombre, duenio, carpeta=None, departamentos=None):
    """Crea la carpeta, oficina.json y las plantillas. -> (carpeta, oficina)."""
    n = (nombre or "").strip()
    if not n or len(n) > 80:
        raise ErrorAPI(400, "Poné un nombre para la oficina (hasta 80 caracteres).")
    d = (duenio or "").strip()
    if len(d) > 80:
        raise ErrorAPI(400, "El nombre del dueño es demasiado largo.")
    pedidos = departamentos or [{"nombre": x} for x in DEPARTAMENTOS_SUGERIDOS]
    if len(pedidos) > MAX_DEPARTAMENTOS:
        raise ErrorAPI(400, "Máximo %d departamentos." % MAX_DEPARTAMENTOS)
    deps = []
    for i, p in enumerate(pedidos):
        deps.append(armar_departamento(p, i, {x["id"] for x in deps}))
    if carpeta and carpeta.strip():
        dirr = resolver_carpeta(carpeta, home)
        if existe_oficina(dirr):
            raise ErrorAPI(409, "Ya hay una oficina en esa carpeta. Abrila en lugar de crearla.")
    else:
        dirr = carpeta_libre(oficinas_dir, n)
    o = {"version": 1, "nombre": n, "duenio": d, "departamentos": deps, "agentes": []}
    validar_oficina(o)
    try:
        crear_estructura(dirr, o)
    except OSError:
        raise ErrorAPI(500, "No pude crear la carpeta de la oficina.")
    escribir_oficina(o, dirr)
    return dirr, o


def abrir_oficina(home, carpeta):
    dirr = resolver_carpeta(carpeta, home)
    if not os.path.isdir(dirr):
        raise ErrorAPI(404, "No encuentro esa carpeta.")
    o = leer_oficina(dirr)
    try:
        completar_estructura(dirr)
    except OSError:
        pass
    return dirr, o


def editar_oficina(carpeta, nombre=None, duenio=None):
    o = leer_oficina(carpeta)
    if nombre is not None:
        t = nombre.strip()
        if not t or len(t) > 80:
            raise ErrorAPI(400, "El nombre de la oficina es obligatorio (hasta 80 caracteres).")
        o["nombre"] = t
    if duenio is not None:
        t = duenio.strip()
        if len(t) > 80:
            raise ErrorAPI(400, "El nombre del dueño es demasiado largo.")
        o["duenio"] = t
    escribir_oficina(o, carpeta)
    return o


def crear_departamento(carpeta, p):
    o = leer_oficina(carpeta)
    if len(o["departamentos"]) >= MAX_DEPARTAMENTOS:
        raise ErrorAPI(400, "Máximo %d departamentos." % MAX_DEPARTAMENTOS)
    d = armar_departamento(p, len(o["departamentos"]), {x["id"] for x in o["departamentos"]})
    o["departamentos"].append(d)
    escribir_oficina(o, carpeta)
    return d, o


def editar_departamento(carpeta, id_, nombre=None, color=None):
    o = leer_oficina(carpeta)
    d = next((x for x in o["departamentos"] if x["id"] == id_), None)
    if d is None:
        raise ErrorAPI(404, "No existe ese departamento.")
    if nombre is not None:
        t = nombre.strip()
        if not t or len(t) > 60:
            raise ErrorAPI(400, "El nombre del departamento es obligatorio (hasta 60 caracteres).")
        d["nombre"] = t
    if color is not None:
        if not COLOR_RE.match(color):
            raise ErrorAPI(400, "El color tiene que ser tipo #a88bdc.")
        d["color"] = color.lower()
    escribir_oficina(o, carpeta)
    return d, o


def borrar_departamento(carpeta, id_, mover_a=None):
    o = leer_oficina(carpeta)
    if not any(x["id"] == id_ for x in o["departamentos"]):
        raise ErrorAPI(404, "No existe ese departamento.")
    if len(o["departamentos"]) <= 1:
        raise ErrorAPI(409, "La oficina necesita al menos un departamento.")
    adentro = [a for a in o["agentes"] if a["departamento"] == id_]
    if adentro:
        if not mover_a:
            raise ErrorAPI(409, "El departamento tiene %d agente(s). Elegí a qué departamento moverlos (moverA)." % len(adentro))
        if mover_a == id_ or not any(x["id"] == mover_a for x in o["departamentos"]):
            raise ErrorAPI(400, "El departamento de destino (moverA) no existe o es el mismo.")
        for a in adentro:
            a["departamento"] = mover_a
    o["departamentos"] = [x for x in o["departamentos"] if x["id"] != id_]
    escribir_oficina(o, carpeta)
    return o


# ----------------------------------------------------------------------------- agentes

def modelo_valido(v):
    if v is None:
        return "sonnet"
    s = v.strip().lower() if isinstance(v, str) else ""
    if s not in MODELOS:
        raise ErrorAPI(400, "Modelo inválido (sonnet, opus, haiku o inherit).")
    return s


def chips_validos(v):
    if v is None:
        return []
    if not isinstance(v, list):
        raise ErrorAPI(400, "«chips» tiene que ser una lista de textos.")
    out = []
    for x in v:
        if not isinstance(x, str):
            raise ErrorAPI(400, "«chips» tiene que ser una lista de textos.")
        t = x.strip()
        if not t:
            continue
        if len(t) > 200:
            raise ErrorAPI(400, "Un chip es demasiado largo (máximo 200 caracteres).")
        out.append(t)
    if len(out) > 6:
        raise ErrorAPI(400, "Máximo 6 chips.")
    return out


def avatar_valido(v):
    if v is None:
        return None
    if not isinstance(v, dict):
        raise ErrorAPI(400, "«avatar» tiene que ser un objeto.")
    a = {}
    for k in AVATAR_CAMPOS:
        x = v.get(k)
        if x is None:
            continue
        if not isinstance(x, str) or len(x) > 60:
            raise ErrorAPI(400, "Avatar: «%s» inválido." % k)
        if x:
            a[k] = x
    for k in ("colorPelo", "colorTorso", "colorPiernas"):
        if k in a:
            if not COLOR_RE.match(a[k]):
                raise ErrorAPI(400, "Avatar: los colores tienen que ser tipo #141414.")
            a[k] = a[k].lower()
    return a


def nuevo_agente(d):
    """Valida el JSON de POST /api/agentes. -> dict normalizado."""
    id_ = texto(d.get("id"), "id", 41, False)
    if id_ and not slug_valido(id_):
        raise ErrorAPI(400, "El id tiene que ser minúsculas, números y guiones (hasta 41 caracteres).")
    nombre = texto(d.get("nombre"), "nombre", 80)
    rol = texto(d.get("rol"), "rol", 160)
    prompt = texto(d.get("prompt"), "prompt", 20000)
    desc = texto(d.get("description"), "description", 1000, False) or rol
    dep = texto(d.get("departamento"), "departamento", 41)
    return {"id": id_, "nombre": nombre, "rol": rol, "prompt": prompt, "description": desc, "departamento": dep,
            "modelo": modelo_valido(d.get("modelo")), "brief": texto(d.get("brief"), "brief", 4000, False),
            "chips": chips_validos(d.get("chips")), "avatar": avatar_valido(d.get("avatar")), "escritura": None}


def cambios_agente(d):
    c = {}
    for k, mx in (("nombre", 80), ("rol", 160), ("departamento", 41), ("prompt", 20000), ("description", 1000), ("brief", 4000)):
        v = texto(d.get(k), k, mx, False)
        if v is not None:
            c[k] = v
    if d.get("modelo") is not None:
        c["modelo"] = modelo_valido(d["modelo"])
    if d.get("chips") is not None:
        c["chips"] = chips_validos(d["chips"])
    av = avatar_valido(d.get("avatar"))
    if av is not None:
        c["avatar"] = av
    return c


def _agente(o, id_):
    return next((a for a in o["agentes"] if a["id"] == id_), None)


def _md(carpeta, id_):
    return os.path.join(carpeta, ".claude", "agents", id_ + ".md")


def contratar(carpeta, n):
    """Escribe .claude/agents/<id>.md y conocimiento/agentes/<id>.md y actualiza oficina.json. -> (agente, oficina)."""
    o = leer_oficina(carpeta)
    if len(o["agentes"]) >= MAX_AGENTES:
        raise ErrorAPI(400, "Máximo %d agentes por oficina." % MAX_AGENTES)
    if not any(d["id"] == n["departamento"] for d in o["departamentos"]):
        raise ErrorAPI(400, "El departamento no existe.")
    usados = {a["id"] for a in o["agentes"]}
    if n.get("id"):
        if n["id"] in RESERVADOS:
            raise ErrorAPI(400, "Ese id está reservado por Claude Code. Elegí otro.")
        if n["id"] in usados:
            raise ErrorAPI(409, "Ya hay un agente con ese id.")
        id_ = n["id"]
    else:
        id_ = slug_unico(n["nombre"], usados | RESERVADOS, "agente")
    md = _md(carpeta, id_)
    if os.path.exists(md):
        raise ErrorAPI(409, "Ya existe un archivo de agente con ese id en .claude/agents.")
    avatar = dict(n.get("avatar") or {})
    avatar.setdefault("semilla", id_)
    definicion = {"id": id_, "nombre": n["nombre"], "rol": n["rol"], "departamento": n["departamento"],
                  "modelo": n["modelo"], "avatar": avatar, "creado": ahora_iso()}
    if n.get("brief"):
        definicion["brief"] = n["brief"]
    if n.get("chips"):
        definicion["chips"] = n["chips"]
    if n.get("escritura"):
        definicion["escritura"] = n["escritura"]
    notas = os.path.join(carpeta, "conocimiento", "agentes", id_ + ".md")
    notas_nuevas = not os.path.exists(notas)
    try:
        os.makedirs(os.path.dirname(md), exist_ok=True)
        escribir_atomico(md, agente_md(id_, n["description"], n["modelo"], n["prompt"]))
        escribir_si_falta(carpeta, "conocimiento/agentes/%s.md" % id_, notas_agente_md(n["nombre"], n["rol"]))
        o["agentes"].append(definicion)
        escribir_oficina(o, carpeta)
    except (ErrorAPI, OSError) as e:
        for p, hacer in ((md, True), (notas, notas_nuevas)):
            if hacer:
                try:
                    os.remove(p)
                except OSError:
                    pass
        if isinstance(e, ErrorAPI):
            raise
        raise ErrorAPI(500, "No pude guardar el agente.")
    return definicion, o


def editar_agente(carpeta, id_, c):
    o = leer_oficina(carpeta)
    a = _agente(o, id_)
    if a is None:
        raise ErrorAPI(404, "No existe ese agente.")
    if "departamento" in c:
        if not any(d["id"] == c["departamento"] for d in o["departamentos"]):
            raise ErrorAPI(400, "El departamento no existe.")
        a["departamento"] = c["departamento"]
    for k in ("nombre", "rol", "brief", "modelo"):
        if k in c:
            a[k] = c[k]
    if "chips" in c:
        if c["chips"]:
            a["chips"] = c["chips"]
        else:
            a.pop("chips", None)
    if "avatar" in c:
        av = dict(c["avatar"])
        av.setdefault("semilla", (a.get("avatar") or {}).get("semilla") or id_)
        a["avatar"] = av
    if any(k in c for k in ("prompt", "description", "modelo")):
        md = _md(carpeta, id_)
        fm, cuerpo = partes_md(leer_texto(md) or "")
        if "prompt" in c:
            modelo = c.get("modelo") or valor_fm(fm, "model") or a.get("modelo") or "sonnet"
            desc = c.get("description") or valor_fm(fm, "description") or a["rol"]
            nuevo = agente_md(id_, desc, modelo, c["prompt"])
        else:
            fm = fm or ["name: %s" % id_]
            if "description" in c:
                fm = fijar_fm(fm, "description", yaml_linea(c["description"]))
            if "modelo" in c:
                fm = fijar_fm(fm, "model", c["modelo"])
            nuevo = "---\n" + "\n".join(fm) + "\n---\n" + cuerpo
        try:
            os.makedirs(os.path.dirname(md), exist_ok=True)
            escribir_atomico(md, nuevo)
        except OSError:
            raise ErrorAPI(500, "No pude guardar el archivo del agente.")
    escribir_oficina(o, carpeta)
    return a, o


def detalle_agente(carpeta, id_):
    o = leer_oficina(carpeta)
    a = _agente(o, id_)
    if a is None:
        raise ErrorAPI(404, "No existe ese agente.")
    fm, cuerpo = partes_md(leer_texto(_md(carpeta, id_)) or "")
    r = {"agente": a, "prompt": prompt_de(cuerpo), "description": valor_fm(fm, "description") or ""}
    m = valor_fm(fm, "model")
    if m:
        r["modelo"] = m
    return r


def despedir(carpeta, id_):
    """Mueve el .md a .claude/agents/.archivados/<id>-<fecha>.md y lo saca de oficina.json. -> (ruta relativa|None, oficina)."""
    o = leer_oficina(carpeta)
    if _agente(o, id_) is None:
        raise ErrorAPI(404, "No existe ese agente.")
    md = _md(carpeta, id_)
    rel = destino = None
    if os.path.exists(md):
        dirr = os.path.join(carpeta, ".claude", "agents", ".archivados")
        base = "%s-%s" % (id_, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
        nombre, n = base, 2
        while os.path.exists(os.path.join(dirr, nombre + ".md")):
            nombre = "%s-%d" % (base, n)
            n += 1
        try:
            os.makedirs(dirr, exist_ok=True)
            destino = os.path.join(dirr, nombre + ".md")
            shutil.move(md, destino)
        except OSError:
            raise ErrorAPI(500, "No pude archivar el agente.")
        rel = ".claude/agents/.archivados/%s.md" % nombre
    o["agentes"] = [a for a in o["agentes"] if a["id"] != id_]
    for t in o.get("tareas") or []:  # sus tareas programadas quedan desactivadas (no se borran)
        if t.get("agente") == id_:
            t["activa"] = False
    try:
        escribir_oficina(o, carpeta)
    except ErrorAPI:
        if destino:
            shutil.move(destino, md)
        raise
    return rel, o


def conocimiento(carpeta, id_):
    o = leer_oficina(carpeta)
    if _agente(o, id_) is None:
        raise ErrorAPI(404, "No existe ese agente.")
    rel = "conocimiento/agentes/%s.md" % id_
    try:
        with open(os.path.join(carpeta, rel), "rb") as f:
            data = f.read(200000)
    except OSError:
        data = b""
    return {"id": id_, "ruta": rel, "texto": data.decode("utf-8", "replace")}


# ----------------------------------------------------------------------------- borrador (claude -p sin agente)

def preparar_borrador(carpeta, descripcion, departamento):
    """-> (oficina, meta_prompt). No ejecuta nada."""
    o = leer_oficina(carpeta)
    desc = (descripcion or "").strip() if isinstance(descripcion, str) else ""
    if not desc:
        raise ErrorAPI(400, "Contá en palabras qué agente querés.")
    if len(desc) > 4000:
        raise ErrorAPI(400, "La descripción es demasiado larga (máximo 4000 caracteres).")
    dep = next((d for d in o["departamentos"] if d["id"] == departamento), None) if isinstance(departamento, str) else None
    if dep is None:
        raise ErrorAPI(400, "El departamento no existe.")
    return o, meta_prompt(o, dep, desc)


def meta_prompt(o, dep, descripcion):
    if o["agentes"]:
        nombres = {d["id"]: d["nombre"] for d in o["departamentos"]}
        existentes = "\n".join("- %s (id: %s), %s, departamento %s" % (
            a["nombre"], a["id"], a["rol"], nombres.get(a["departamento"], a["departamento"])) for a in o["agentes"])
    else:
        existentes = "(todavía no hay agentes)"
    duenio = " (dueño/a: %s)" % o["duenio"] if o["duenio"] else ""
    return (
        "Sos un diseñador de equipos que redacta la definición de un agente de Claude Code para una oficina de agentes.\n\n"
        "CONTEXTO\n"
        "- Oficina: %s%s\n"
        "- Departamento donde va a trabajar el agente nuevo: %s\n"
        "- Agentes que ya existen (no dupliques sus roles; podés mencionarlos como compañeros si tiene sentido):\n%s\n\n"
        "LO QUE PIDIÓ EL USUARIO PARA EL AGENTE NUEVO\n%s\n\n"
        "TU TAREA\n"
        "Inventá a la persona que mejor cumple ese pedido y devolvé SOLO un objeto JSON válido, sin texto antes ni después, "
        "sin bloque de código, con exactamente estas claves:\n"
        "{\n"
        "  \"id\": \"slug-en-minusculas\",\n"
        "  \"nombre\": \"Nombre de pila o apodo, corto\",\n"
        "  \"rol\": \"Cargo en pocas palabras, por ejemplo Directora creativa de redes\",\n"
        "  \"description\": \"...\",\n"
        "  \"prompt\": \"...\",\n"
        "  \"chips\": [\"...\", \"...\", \"...\"],\n"
        "  \"modelo\": \"sonnet\"\n"
        "}\n\n"
        "REGLAS DE CADA CLAVE\n"
        "- id: solo minúsculas sin acentos, números y guiones, hasta 40 caracteres, derivado del nombre (por ejemplo "
        "\"marce\", \"don-armando\"). No uses ids genéricos como \"agente\" o \"asistente\".\n"
        "- nombre: un nombre propio humano y fácil de recordar, o el apodo del cargo si el usuario lo pidió.\n"
        "- rol: máximo 8 palabras.\n"
        "- description: una o dos oraciones, en tercera persona, al estilo de las descripciones de agentes de Claude Code: "
        "quién es y CUÁNDO conviene usarlo (\"Usalo cuando haga falta...\"). Sin saltos de línea.\n"
        "- prompt: las instrucciones del agente, en segunda persona (\"Sos ...\"), en el mismo idioma en que escribió el "
        "usuario (español rioplatense por defecto). Estructura: quién es y para quién trabaja; \"Tu trabajo\" (qué hace y "
        "qué entrega); \"Cómo respondés\" (formato, extensión, tono); \"Reglas\" (propone y el usuario aprueba; no inventa "
        "datos, cifras ni promesas; si falta información pregunta lo mínimo). Entre 150 y 400 palabras. No incluyas rutas "
        "de archivos ni una sección de memoria: el sistema la agrega solo.\n"
        "- chips: exactamente 3 frases cortas (máximo 60 caracteres) que el usuario podría escribirle al agente para "
        "empezar a trabajar.\n"
        "- modelo: \"sonnet\" salvo que el trabajo exija razonamiento muy profundo (\"opus\") o sea muy simple y repetitivo "
        "(\"haiku\").\n\n"
        "Devolvé únicamente el JSON." % (o["nombre"], duenio, dep["nombre"], existentes, descripcion))


def _candidatos(t):
    t = t.strip()
    out = [t]
    for m in re.finditer(r"```(?:[a-zA-Z]*)\n?(.*?)```", t, re.S):
        out.append(m.group(1).strip())
    i, j = t.find("{"), t.rfind("}")
    if 0 <= i < j:
        out.append(t[i:j + 1])
    return out


def parsear_borrador(t, ocupados):
    """Extrae y valida el borrador del `result` de claude (JSON puro, en ```json o rodeado de texto). dict o None."""
    for cand in _candidatos(t or ""):
        try:
            o = json.loads(cand)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue

        def s(k):
            v = o.get(k)
            return v.strip() if isinstance(v, str) else ""
        nombre, rol, prompt = s("nombre"), s("rol"), s("prompt")
        if not (nombre and rol and prompt):
            continue
        pedido = slug_de(s("id")) or nombre
        id_ = slug_unico(pedido, set(ocupados) | RESERVADOS, "agente")
        desc = " ".join(s("description").split()) or "%s, %s." % (nombre, rol)
        chips = [c.strip() for c in (o.get("chips") if isinstance(o.get("chips"), list) else [])
                 if isinstance(c, str) and c.strip() and len(c.strip()) <= 200]
        m = s("modelo").lower()
        return {"id": id_, "nombre": nombre[:80], "rol": rol[:160], "description": desc[:1000],
                "prompt": prompt[:20000], "chips": chips[:3], "modelo": m if m in MODELOS else "sonnet"}
    return None


# ----------------------------------------------------------------------------- importar Próspera

REEMPLAZOS = [
    (re.compile(r"/Users/[^/\s`]+/Pr(?:ó|ó)spera/_betty/estado-actual\.md"), "conocimiento/oficina.md"),
    (re.compile(r"/Users/[^/\s`]+/\.claude/betty/contexto-maestro\.md"), "conocimiento/contexto-maestro.md"),
    (re.compile(r"/Users/[^/\s`]+/Pr(?:ó|ó)spera/_equipo/"), "conocimiento/"),
]


# Rutas absolutas que quedan (Reels, Meta ads, Guiones, intro...) apuntan a la carpeta de Próspera del autor.
RUTA_PROYECTO_RE = re.compile(r"/Users/[^/\s`]+/Pr(?:\u00f3|o\u0301)spera(?![\w.-])")
# Agentes que referencian esos archivos: son los que reciben la carpeta vinculada (--add-dir).
AGENTES_PROYECTO = ["mario", "don-armando", "nicolas", "sofia"]


def adaptar_rutas(t, proyecto=None):
    """Rutas del autor -> relativas a la oficina. Con `proyecto` (carpeta real de Próspera), lo que queda de
    /Users/<x>/Próspera/... apunta a esa carpeta (coincide con la carpeta vinculada que se pasa con --add-dir)."""
    for patron, nuevo in REEMPLAZOS:
        t = patron.sub(lambda m, n=nuevo: n, t)
    if proyecto:
        t = RUTA_PROYECTO_RE.sub(lambda m: proyecto, t)
    return t


def cargar_datos_prospera(ruta_json=None):
    ruta_json = ruta_json or os.path.join(os.path.dirname(os.path.abspath(__file__)), "prospera_oficina.json")
    with open(ruta_json, encoding="utf-8") as f:
        return json.load(f)


def _origenes(origen, home, repo_defecto):
    """-> (carpetas con los <id>.md, raíz del repo con contexto/ o None)."""
    if origen and origen.strip():
        dirr = resolver_carpeta_simple(origen, home)
        if not os.path.isdir(dirr):
            raise ErrorAPI(404, "No encuentro la carpeta de origen.")
        repo = dirr if os.path.isdir(os.path.join(dirr, "contexto")) else None
        return [os.path.join(dirr, "agentes"), dirr], repo
    cands = []
    repo = None
    if repo_defecto:
        cands.append(os.path.join(repo_defecto, "agentes"))
        if os.path.isdir(os.path.join(repo_defecto, "contexto")):
            repo = repo_defecto
    cands.append(os.path.join(home, ".claude", "agents"))
    return cands, repo


def resolver_carpeta_simple(p, home):
    p = p.strip()
    if p == "~":
        p = home
    elif p.startswith("~/"):
        p = os.path.join(home, p[2:])
    return os.path.abspath(p)


def importar_prospera(oficinas_dir, home, proyecto, origen=None, repo_defecto=None, datos=None):
    """Crea <oficinas_dir>/Próspera HQ con 5 departamentos y 8 agentes. Copia (nunca mueve) el conocimiento.

    Idempotente: si la oficina ya existe no se toca nada. -> dict con carpeta, oficina, yaExistia, agentes, faltantes, copiados.
    `proyecto` = carpeta con _betty/ y _equipo/ (default ~/Próspera). `repo_defecto` = raíz del repo (agentes/, contexto/).
    """
    datos = datos or cargar_datos_prospera()
    dirr = os.path.join(oficinas_dir, datos["nombre"])
    if existe_oficina(dirr):
        o = leer_oficina(dirr)
        return {"carpeta": dirr, "oficina": o, "yaExistia": True, "agentes": [a["id"] for a in o["agentes"]],
                "faltantes": [], "copiados": []}
    dirs_agentes, repo = _origenes(origen, home, repo_defecto)
    textos, faltantes = {}, []
    for a in datos["agentes"]:
        hallado = None
        for d in dirs_agentes:
            t = leer_texto(os.path.join(d, a["id"] + ".md"))
            if t is not None:
                hallado = t
                break
        if hallado is None:
            faltantes.append(a["id"])
        else:
            textos[a["id"]] = hallado
    if not textos:
        raise ErrorAPI(404, "No encontré los agentes de Próspera (agentes/*.md). Indicá la carpeta con «origen».")

    completar_estructura(dirr)
    copiados = []

    def copiar(src, rel):
        dst = os.path.join(dirr, rel)
        if not os.path.isfile(src) or os.path.exists(dst):
            return
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        copiados.append(rel)

    copiar(os.path.join(proyecto, "_betty", "estado-actual.md"), "conocimiento/oficina.md")
    copiar(os.path.join(home, ".claude", "betty", "contexto-maestro.md"), "conocimiento/contexto-maestro.md")
    if repo:
        copiar(os.path.join(repo, "contexto", "contexto-maestro.md"), "conocimiento/contexto-maestro.md")
    equipo = os.path.join(proyecto, "_equipo")
    for raiz, subdirs, archivos in os.walk(equipo):
        subdirs[:] = [d for d in subdirs if not d.startswith(".")]
        for nombre in sorted(archivos):
            if nombre.startswith(".") or nombre.endswith("PLANTILLA.md"):
                continue
            src = os.path.join(raiz, nombre)
            copiar(src, "conocimiento/" + os.path.relpath(src, equipo).replace(os.sep, "/"))
    if repo:
        copiar(os.path.join(repo, "contexto", "equipo", "decisiones.md"), "conocimiento/decisiones.md")

    ahora = ahora_iso()
    defs = []
    # La carpeta de Próspera se vincula solo si existe y no es la carpeta personal entera ni algo de la oficina.
    proyecto = os.path.abspath(proyecto) if proyecto else None
    vinculado = []
    if proyecto and os.path.isdir(proyecto) and os.path.realpath(proyecto) not in (os.path.realpath(home), "/") \
            and not os.path.realpath(proyecto).startswith(os.path.realpath(dirr) + os.sep):
        vinculado = [i for i in AGENTES_PROYECTO if i in textos]
    for a in datos["agentes"]:
        t = textos.get(a["id"])
        if t is None:
            continue
        adaptado = adaptar_rutas(t, proyecto if a["id"] in vinculado else None)
        md = _md(dirr, a["id"])
        os.makedirs(os.path.dirname(md), exist_ok=True)
        escribir_atomico(md, adaptado)
        modelo = valor_fm(partes_md(adaptado)[0], "model")
        d = {"id": a["id"], "nombre": a["nombre"], "rol": a["rol"], "departamento": a["departamento"],
             "modelo": modelo if modelo in MODELOS else "sonnet", "chips": list(a["chips"]),
             "avatar": dict(a["avatar"]), "creado": ahora}
        if a.get("escritura"):
            d["escritura"] = list(a["escritura"])
        defs.append(d)
    o = {"version": 1, "nombre": datos["nombre"], "duenio": datos["duenio"],
         "departamentos": [dict(d) for d in datos["departamentos"]], "agentes": defs}
    if vinculado:
        o["vinculos"] = [{"id": "prospera", "ruta": proyecto, "alcance": {"agentes": vinculado}}]
    validar_oficina(o)
    crear_estructura(dirr, o)
    for d in defs:
        escribir_si_falta(dirr, "conocimiento/agentes/%s.md" % d["id"], notas_agente_md(d["nombre"], d["rol"]))
    escribir_atomico(os.path.join(dirr, MARCA_PROSPERA), "{}\n")
    escribir_oficina(o, dirr)
    return {"carpeta": dirr, "oficina": o, "yaExistia": False, "agentes": [d["id"] for d in defs],
            "faltantes": faltantes, "copiados": copiados}


# ----------------------------------------------------------------------------- permisos de la biblioteca

def alcance_incluye(alcance, agente):
    """El agente (dict de oficina.json) tiene acceso a una carpeta vinculada con ese alcance."""
    if alcance == "oficina":
        return True
    if isinstance(alcance, dict):
        if isinstance(alcance.get("departamentos"), list):
            return agente.get("departamento") in alcance["departamentos"]
        if isinstance(alcance.get("agentes"), list):
            return agente.get("id") in alcance["agentes"]
    return False


def dirs_vinculos(o, agente):
    """Carpetas vinculadas a las que `agente` tiene acceso (para --add-dir). Solo las que existen."""
    out = []
    for v in (o or {}).get("vinculos") or []:
        if alcance_incluye(v.get("alcance"), agente) and os.path.isdir(v["ruta"]) and v["ruta"] not in out:
            out.append(v["ruta"])
    return out


def entregables(carpeta, id_):
    """Patrón de escritura `archivos/entregables/<id>/**` (crea la carpeta del agente). Solo en oficinas con la estructura
    de biblioteca (`archivos/entregables/`); si no, None."""
    base = os.path.join(carpeta, "archivos", "entregables")
    if not os.path.isdir(base):
        return None
    os.makedirs(os.path.join(base, id_), exist_ok=True)
    return os.path.join(base, id_) + "/**"
