"""Biblioteca de la oficina (modo desarrollo): /api/archivos*, /api/vinculos*, /api/biblioteca*.

Misma API, mismos archivos y mismos prompts que app/Sources/Backend/Biblioteca.swift (+ Extraccion.swift): si cambia una
implementación, cambia la otra. Archivos del usuario (subidos o vinculados) → ficha del "bibliotecario" (un `claude -p` sin
agente) → catálogo `conocimiento/archivos.md`, ficha `conocimiento/fuentes/<slug>.md`, índice FTS5 (o LIKE), lectura por rol y
propuestas de contradicción. Python 3.9, solo librería estándar. En PDF usa `pdftotext` si existe o `mdimport` (macOS); en
.docx/.doc/.rtf/.odt/.pages usa `textutil` (macOS); si no hay con qué leerlo, la ficha lleva un aviso.

Carpetas: archivos/compartido/, archivos/<departamento>/, archivos/entregables/<agente>/, archivos/.texto/<slug>.md,
archivos/.papelera/, conocimiento/archivos.md, conocimiento/fuentes/<slug>.md.
"""
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import unicodedata
import uuid

import hq_core
import hq_vivo
import hq_reuniones
from hq_core import ErrorAPI

MAX_BODY_CHICO = 200000
MAX_VINCULOS = 20
MAX_BASE64_DIRECTO = 8 * 1024 * 1024
MAX_TEXTO = 2000000
MAX_TEXTO_PROMPT = 12000
MAX_MEMORIA_PROMPT = 3000
MAX_DECISIONES_PROMPT = 2000
MAX_CONTRADICCIONES = 5
MAX_LECTORES = 10
COMPARTIDO = "compartido"
VINCULO = "vinculo"

PDF = "pdf"
DOCUMENTOS = {"docx", "doc", "rtf", "pages", "odt"}
PLANOS = {"txt", "md", "csv", "tsv", "json"}
IMAGENES = {"png", "jpg", "jpeg", "gif", "webp", "heic"}
SOPORTADOS = DOCUMENTOS | PLANOS | IMAGENES | {PDF}
MIMES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword", "rtf": "application/rtf", "odt": "application/vnd.oasis.opendocument.text",
    "pages": "application/vnd.apple.pages", "txt": "text/plain; charset=utf-8", "md": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8", "tsv": "text/tab-separated-values; charset=utf-8", "json": "application/json",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "heic": "image/heic",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS archivos (
    slug TEXT NOT NULL,
    oficina TEXT NOT NULL,
    nombre TEXT NOT NULL,
    departamento TEXT NOT NULL,
    ruta TEXT NOT NULL,
    origen TEXT NOT NULL,
    vinculo TEXT,
    tipo TEXT NOT NULL,
    tam INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL,
    error TEXT,
    aviso TEXT,
    ficha TEXT,
    leer TEXT,
    lectura TEXT,
    creado REAL NOT NULL,
    actualizado REAL NOT NULL,
    papelera INTEGER NOT NULL DEFAULT 0,
    leer_pedido INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (oficina, slug)
);
CREATE INDEX IF NOT EXISTS archivos_estado ON archivos(estado, papelera);
CREATE TABLE IF NOT EXISTS propuestas (
    id TEXT PRIMARY KEY,
    oficina TEXT NOT NULL,
    archivo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    actual TEXT NOT NULL,
    nuevo TEXT NOT NULL,
    sugerencia TEXT NOT NULL,
    estado TEXT NOT NULL,
    creada REAL NOT NULL,
    resuelta REAL
);
CREATE INDEX IF NOT EXISTS propuestas_oficina ON propuestas(oficina, estado);
"""
COLS = ("slug,oficina,nombre,departamento,ruta,origen,vinculo,tipo,tam,hash,estado,error,aviso,ficha,leer,lectura,"
        "creado,actualizado,papelera,leer_pedido")


# ----------------------------------------------------------------------------- utilidades puras

def es_ruta(path):
    return (path in ("/api/archivos", "/api/vinculos", "/api/biblioteca")
            or path.startswith(("/api/archivos/", "/api/vinculos/", "/api/biblioteca/")))


def cadena(v):
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, (int, float)):
        return str(v)
    return ""


def lista(v):
    if isinstance(v, str):
        t = cadena(v)
        return [t] if t else []
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        if isinstance(x, dict):
            x = ", ".join(sorted("%s: %s" % (k, cadena(val)) for k, val in x.items()))
        else:
            x = cadena(x)
        if x:
            out.append(x)
    return out


def recortar(s, mx):
    return s[:mx] + "…" if len(s) > mx else s


def extension(nombre):
    return os.path.splitext(nombre)[1][1:].lower()


def nombre_seguro(crudo):
    """Nombre de archivo seguro: sin rutas, sin `..`, sin caracteres de control ni `:`, sin punto inicial, ≤ 120."""
    s = crudo.replace("\\", "/")
    if "/" in s:
        s = s[s.rindex("/") + 1:]
    s = "".join("-" if (ord(c) < 32 or ord(c) == 127 or c in ':*?"<>|') else c for c in s)
    s = s.replace("..", ".").strip()
    while s.startswith("."):
        s = s[1:]
    s = s.strip()
    if len(s) > 120:
        base, ext = os.path.splitext(s)
        ext = ext[1:]
        s = base[:max(1, 119 - len(ext))] + ("." + ext if ext else "")
    return s or "archivo"


def ruta_libre(dir_, nombre):
    cand = os.path.join(dir_, nombre)
    base, ext = os.path.splitext(nombre)
    n = 2
    while os.path.exists(cand):
        cand = os.path.join(dir_, "%s-%d%s" % (base, n, ext))
        n += 1
    return cand


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_archivo(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for bloque in iter(lambda: f.read(1 << 20), b""):
                h.update(bloque)
        return h.hexdigest()
    except OSError:
        return None


def tam_texto(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%d KB" % (n // 1024)
    return "%.1f MB" % (n / 1048576.0)


def dia(t):
    return datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d")


def nombre_departamento(id_, oficina):
    if id_ == COMPARTIDO:
        return "Compartido"
    if id_ == VINCULO:
        return "Carpeta vinculada"
    d = next((x for x in oficina["departamentos"] if x["id"] == id_), None)
    return d["nombre"] if d else id_


def _departamento(oficina, id_):
    return next((x for x in oficina["departamentos"] if x["id"] == id_), None)


def departamentos_de(valores, oficina):
    """Ids de departamento a partir de ids o nombres (descarta los desconocidos, sin repetir)."""
    out = []
    for x in valores:
        s = hq_core.slug_de(x)
        hit = next((d for d in oficina["departamentos"]
                    if d["id"] == x or d["id"] == s or hq_core.slug_de(d["nombre"]) == s), None)
        if hit and hit["id"] not in out:
            out.append(hit["id"])
    return out


# ----------------------------------------------------------------------------- extracción

def _proceso(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def _texto_pdf(ruta):
    """(texto, aviso). pdftotext si existe; si no, mdimport (macOS); si no, aviso."""
    if shutil.which("pdftotext"):
        rc, out = _proceso(["pdftotext", "-layout", ruta, "-"])
        t = out.strip()
        if rc == 0 and t:
            return t, None
        return None, "El PDF no tiene texto (¿es un escaneo?)." if rc == 0 else "No pude abrir el PDF."
    if shutil.which("mdimport"):
        rc, out = _proceso(["mdimport", "-t", "-d3", ruta])
        m = re.search(r'kMDItemTextContent = "((?:[^"\\]|\\.)*)";', out, re.S)
        if m:
            t = m.group(1).replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\").strip()
            if t:
                return t, None
        return None, "El PDF no tiene texto (¿es un escaneo?)."
    return None, "No hay con qué leer PDFs en esta compu (instalá pdftotext: brew install poppler)."


def extraer_texto(ruta, ext):
    """-> (texto|None, aviso|None, necesita_vision)."""
    texto, aviso = None, None
    if ext in IMAGENES:
        return None, None, True
    if ext == PDF:
        texto, aviso = _texto_pdf(ruta)
    elif ext in DOCUMENTOS:
        if not shutil.which("textutil"):
            aviso = "No encuentro textutil para leer este tipo de documento."
        else:
            rc, out = _proceso(["textutil", "-convert", "txt", "-stdout", ruta])
            t = out.strip()
            if rc == 0 and t:
                texto = t
            else:
                aviso = "El documento no tiene texto." if rc == 0 else "No pude leer el texto de este documento (.%s)." % ext
    else:
        try:
            with open(ruta, "rb") as f:
                d = f.read()
        except OSError:
            return None, "No pude leer el archivo.", False
        try:
            t = d.decode("utf-8")
        except UnicodeDecodeError:
            t = d.decode("latin-1")
        t = t.strip()
        if t:
            texto = t
        else:
            aviso = "El archivo está vacío."
    if texto and len(texto) > MAX_TEXTO:
        texto = texto[:MAX_TEXTO]
    return texto, aviso, False


def escanear(raiz, max_archivos, max_bytes, max_archivo_bytes):
    """Recorre `raiz` (sin ocultos ni enlaces simbólicos), solo extensiones soportadas, con tope de archivos y de bytes.
    -> {hallados:[{ruta,tam,hash}], omitidos, tope}."""
    out = {"hallados": [], "omitidos": 0, "tope": False}
    candidatos = []
    for dp, dns, fns in os.walk(raiz, followlinks=False):
        dns[:] = [d for d in dns if not d.startswith(".") and not os.path.islink(os.path.join(dp, d))]
        for fn in fns:
            p = os.path.join(dp, fn)
            if fn.startswith(".") or os.path.islink(p) or not os.path.isfile(p):
                continue
            if extension(fn) not in SOPORTADOS:
                continue
            try:
                candidatos.append((p, os.path.getsize(p)))
            except OSError:
                continue
    candidatos.sort(key=lambda c: c[0])
    total = 0
    for p, tam in candidatos:
        if tam > max_archivo_bytes:
            out["omitidos"] += 1
            continue
        if len(out["hallados"]) >= max_archivos or total + tam > max_bytes:
            out["omitidos"] += 1
            out["tope"] = True
            continue
        h = sha256_archivo(p)
        if h is None:
            out["omitidos"] += 1
            continue
        total += tam
        out["hallados"].append({"ruta": p, "tam": tam, "hash": h})
    return out


# ----------------------------------------------------------------------------- prompts, parseo y textos

def prompt_ficha(oficina, carpeta, nombre, tipo, departamento, texto):
    deps = "\n".join("- %s: %s" % (d["id"], d["nombre"]) for d in oficina["departamentos"])
    memoria = recortar((hq_core.leer_texto(os.path.join(carpeta, "conocimiento", "oficina.md")) or "").strip(),
                       MAX_MEMORIA_PROMPT)
    decisiones = hq_reuniones.decisiones_recientes(carpeta)
    return (
        "Sos el bibliotecario de la oficina «%s». Llegó un documento nuevo y tenés que fichar.\n\n"
        "Documento: %s (tipo: %s; carpeta: %s)\n\n"
        "Departamentos de la oficina (id: nombre):\n%s\n\n"
        "Memoria común de la oficina (recortada):\n%s\n\n"
        "Decisiones recientes:\n%s\n\n"
        "Texto del documento (recortado a %d caracteres):\n<<<\n%s\n>>>\n\n"
        "Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:\n"
        "{\"titulo\": \"título claro del documento\", \"resumen\": \"resumen en 3-5 oraciones\", "
        "\"datos_clave\": [\"dato concreto: cifras, nombres, fechas, condiciones\"], \"temas\": [\"tema\"], "
        "\"util_para\": [\"id-de-departamento\"], \"fechas\": [\"fechas relevantes\"], "
        "\"contradicciones\": [{\"actual\": \"lo que dice hoy la memoria o las decisiones\", "
        "\"nuevo\": \"lo que dice el documento\", \"sugerencia\": \"frase breve para anexar a la memoria común\"}]}\n"
        "Reglas: en \"util_para\" poné solo ids de la lista de departamentos a los que este documento les sirve. En "
        "\"contradicciones\" poné solo diferencias reales y verificables entre el documento y la memoria o las "
        "decisiones (lista vacía si no hay). No inventes nada que no esté en el texto."
    ) % (oficina["nombre"], nombre, tipo, nombre_departamento(departamento, oficina), deps or "(ninguno)",
         memoria or "(vacía)", recortar(decisiones, MAX_DECISIONES_PROMPT), MAX_TEXTO_PROMPT, texto[:MAX_TEXTO_PROMPT])


def parsear_ficha(t, nombre, oficina):
    """-> (ficha, contradicciones) o None si no hay forma de leerlo."""
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        o = json.loads(t[a:b + 1])
    except ValueError:
        return None
    if not isinstance(o, dict):
        return None
    f = {"titulo": cadena(o.get("titulo")), "resumen": cadena(o.get("resumen")), "datos_clave": lista(o.get("datos_clave")),
         "temas": lista(o.get("temas")), "util_para": lista(o.get("util_para")), "fechas": lista(o.get("fechas"))}
    if not f["titulo"] and not f["resumen"]:
        return None
    if not f["titulo"]:
        f["titulo"] = nombre
    f["util_para"] = departamentos_de(f["util_para"], oficina)
    cs = []
    for x in o.get("contradicciones") or []:
        if not isinstance(x, dict):
            continue
        c = {"actual": cadena(x.get("actual")), "nuevo": cadena(x.get("nuevo")), "sugerencia": cadena(x.get("sugerencia"))}
        if c["sugerencia"]:
            cs.append(c)
        if len(cs) >= MAX_CONTRADICCIONES:
            break
    return f, cs


def ficha_md(f, ficha, oficina):
    origen = "carpeta vinculada «%s»" % (f.get("vinculo") or "") if f["origen"] == "vinculo" else "subido el %s" % dia(f["creado"])
    s = "# %s\n\n" % (ficha["titulo"] or f["nombre"])
    s += "- **Archivo:** %s\n" % f["nombre"]
    s += "- **Tipo:** %s · %s\n" % (f["tipo"], tam_texto(f["tam"]))
    s += "- **Carpeta:** %s\n" % nombre_departamento(f["departamento"], oficina)
    s += "- **Origen:** %s\n" % origen
    s += "- **Ubicación del original:** %s\n" % f["ruta"]
    s += "- **Texto completo:** archivos/.texto/%s.md\n" % f["slug"]
    s += "- **Identificador:** %s (sha256 %s)\n" % (f["slug"], f["hash"][:12])
    if ficha["util_para"]:
        s += "- **Útil para:** " + ", ".join(nombre_departamento(d, oficina) for d in ficha["util_para"]) + "\n"
    if ficha["fechas"]:
        s += "- **Fechas:** " + "; ".join(ficha["fechas"]) + "\n"
    s += "\n## Resumen\n\n%s\n" % (ficha["resumen"] or "(sin resumen)")
    if ficha["datos_clave"]:
        s += "\n## Datos clave\n\n" + "\n".join("- " + d for d in ficha["datos_clave"]) + "\n"
    if ficha["temas"]:
        s += "\n## Temas\n\n" + ", ".join(ficha["temas"]) + "\n"
    return s


def catalogo_md(filas, oficina):
    s = ("# Archivos de la oficina\n\n"
         "Catálogo de documentos: una línea por documento. Para el detalle, leé su ficha en "
         "`conocimiento/fuentes/<slug>.md` y, si hace falta, el texto completo en `archivos/.texto/<slug>.md`.\n\n")
    vivas = sorted([f for f in filas if not f["papelera"]], key=lambda f: (f["departamento"], f["nombre"]))
    if not vivas:
        return s + "(Todavía no hay documentos.)\n"
    for f in vivas:
        dep = nombre_departamento(f["departamento"], oficina)
        fi = f["ficha"]
        if fi:
            resumen = " ".join(fi["resumen"].split("\n"))
            if len(resumen) > 180:
                resumen = resumen[:180] + "…"
            s += "- **%s** (`%s`, %s, %s): %s → `conocimiento/fuentes/%s.md`\n" % (
                fi["titulo"] or f["nombre"], f["slug"], dep, f["tipo"], resumen, f["slug"])
        else:
            s += "- **%s** (`%s`, %s, %s): todavía sin ficha (%s) → texto en `archivos/.texto/%s.md`\n" % (
                f["nombre"], f["slug"], dep, f["tipo"], "no se pudo fichar" if f["estado"] == "error" else "en proceso", f["slug"])
    return s


def prompt_lectura(titulo, nombre, slug, agente, es_imagen, ruta):
    s = ("Se sumó un documento a la biblioteca de la oficina: «%s» (archivo %s).\n"
         "Leé su ficha en `conocimiento/fuentes/%s.md` y, si hace falta, el texto completo en `archivos/.texto/%s.md`."
         % (titulo, nombre, slug, slug))
    if es_imagen:
        s += "\nEs una imagen: el original está en `%s`; podés verlo con Read." % ruta
    s += ("\n\nDespués anotá en tus notas (`conocimiento/agentes/%s.md`, el único archivo que podés escribir) qué te "
          "sirve de este documento desde tu rol de %s: breve, solo hechos, sin suposiciones. Leé tus notas antes y "
          "agregá al final sin pisar lo que ya tenés. Si nada de esto sirve para tu rol, anotá una línea que lo diga.\n"
          "Cuando termines, respondé solo «listo»." % (agente["id"], agente["rol"]))
    return s


def anexar_actualizacion(carpeta, sugerencia, titulo, slug, fecha=None):
    p = os.path.join(carpeta, "conocimiento", "oficina.md")
    actual = hq_core.leer_texto(p) or ""
    if actual and not actual.endswith("\n"):
        actual += "\n"
    d = (fecha or datetime.date.today()).strftime("%Y-%m-%d")
    actual += "\n## Actualizado %s\n%s\n(Fuente: %s, `conocimiento/fuentes/%s.md`)\n" % (d, sugerencia, titulo, slug)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    hq_core.escribir_atomico(p, actual)


# ----------------------------------------------------------------------------- servicio

class Biblioteca:
    def __init__(self, app, srv, env=None):
        env = os.environ if env is None else env
        self.app = app
        self.srv = srv  # módulo server (ejecutar, TiempoAgotado, error_de, clasificar_error, regla_permiso)
        self.path = app.db.path
        self.sin_fts = env.get("HQ_BIBLIOTECA_SIN_FTS") == "1"

        def num(k, d):
            try:
                v = float(env.get(k, d))
                return v if v > 0 else d
            except (TypeError, ValueError):
                return d

        self.timeout_ficha = num("HQ_BIBLIOTECA_TIMEOUT", 180)
        self.timeout_imagen = num("HQ_BIBLIOTECA_IMAGEN_TIMEOUT", 120)
        self.env_max_mb = int(num("HQ_BIBLIOTECA_MAX_MB", 25))
        self.env_max_archivos = int(num("HQ_BIBLIOTECA_MAX_ARCHIVOS", 200))
        self.env_max_total_mb = int(num("HQ_BIBLIOTECA_MAX_TOTAL_MB", 500))
        self.mut = threading.RLock()
        self.leyendo_ahora = set()
        self.ev = threading.Event()
        self._lock_escaneo = threading.Lock()
        with self._con() as c:
            c.executescript(SCHEMA)
            hay = c.execute("SELECT 1 FROM sqlite_master WHERE name='archivos_fts'").fetchone()
            if not hay:
                try:
                    if self.sin_fts:
                        raise sqlite3.OperationalError("sin fts")
                    c.execute("CREATE VIRTUAL TABLE archivos_fts USING fts5(slug UNINDEXED, oficina UNINDEXED, titulo, "
                              "resumen, temas, texto, tokenize='unicode61 remove_diacritics 2')")
                except sqlite3.OperationalError:
                    c.execute("CREATE TABLE archivos_fts (slug TEXT, oficina TEXT, titulo TEXT, resumen TEXT, temas TEXT, texto TEXT, norm TEXT)")
            if "VIRTUAL" not in (c.execute("SELECT sql FROM sqlite_master WHERE name='archivos_fts'").fetchone()[0] or "").upper():
                # índice sin FTS: `norm` guarda el texto sin acentos ni mayúsculas, que es donde busca el LIKE
                cols = [r[1] for r in c.execute("PRAGMA table_info(archivos_fts)")]
                if "norm" not in cols:
                    c.execute("ALTER TABLE archivos_fts ADD COLUMN norm TEXT")
                    for rid, *p in c.execute("SELECT rowid, titulo, resumen, temas, texto FROM archivos_fts").fetchall():
                        c.execute("UPDATE archivos_fts SET norm=? WHERE rowid=?", (hq_reuniones.plano("\n".join(p)), rid))
            c.execute("UPDATE archivos SET estado='pendiente' WHERE estado IN ('extrayendo','fichando')")
        t = threading.Thread(target=self._bucle, daemon=True)
        t.start()

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

    def _es_fts(self):
        r = self._sql("SELECT sql FROM sqlite_master WHERE name='archivos_fts'", uno=True)
        return bool(r and "VIRTUAL" in (r[0] or "").upper())

    @staticmethod
    def _de_fila(r):
        def js(x, defecto):
            try:
                v = json.loads(x) if x else defecto
                return v if isinstance(v, type(defecto)) else defecto
            except ValueError:
                return defecto
        ficha = None
        if r[13]:
            try:
                o = json.loads(r[13])
                if isinstance(o, dict):
                    ficha = {"titulo": cadena(o.get("titulo")), "resumen": cadena(o.get("resumen")),
                             "datos_clave": lista(o.get("datos_clave")), "temas": lista(o.get("temas")),
                             "util_para": lista(o.get("util_para")), "fechas": lista(o.get("fechas"))}
            except ValueError:
                ficha = None
        return {"slug": r[0], "oficina": r[1], "nombre": r[2], "departamento": r[3], "ruta": r[4], "origen": r[5],
                "vinculo": r[6], "tipo": r[7], "tam": r[8], "hash": r[9], "estado": r[10], "error": r[11], "aviso": r[12],
                "ficha": ficha, "leer": js(r[14], []), "lectura": js(r[15], {}), "creado": r[16], "actualizado": r[17],
                "papelera": bool(r[18]), "leer_pedido": bool(r[19])}

    def _guardar(self, f):
        self._sql("INSERT OR REPLACE INTO archivos(%s) VALUES(%s)" % (COLS, ",".join("?" * 20)), (
            f["slug"], f["oficina"], f["nombre"], f["departamento"], f["ruta"], f["origen"], f.get("vinculo"), f["tipo"],
            f["tam"], f["hash"], f["estado"], f.get("error"), f.get("aviso"),
            json.dumps(f["ficha"], ensure_ascii=False) if f.get("ficha") else None,
            json.dumps(f["leer"]) if f.get("leer") else None, json.dumps(f["lectura"]) if f.get("lectura") else None,
            f["creado"], f["actualizado"], 1 if f.get("papelera") else 0, 1 if f.get("leer_pedido") else 0), escribir=True)

    def _archivo(self, slug, carpeta):
        r = self._sql("SELECT %s FROM archivos WHERE oficina=? AND slug=?" % COLS, (carpeta, slug), uno=True)
        return self._de_fila(r) if r else None

    def _archivos(self, carpeta, papelera=False):
        return [self._de_fila(r) for r in self._sql(
            "SELECT %s FROM archivos WHERE oficina=? AND papelera=? ORDER BY creado DESC, slug" % COLS,
            (carpeta, 1 if papelera else 0))]

    def _estado_sql(self, slug, carpeta, estado, error=None):
        self._sql("UPDATE archivos SET estado=?, error=?, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                  (estado, error, time.time(), carpeta, slug), escribir=True)

    def _aviso(self, slug, carpeta, aviso):
        self._sql("UPDATE archivos SET aviso=? WHERE oficina=? AND slug=? AND papelera=0", (aviso, carpeta, slug), escribir=True)

    def _reprocesar_sql(self, slug, carpeta, hash_, tam, leer_pedido=None):
        self._sql("UPDATE archivos SET hash=?, tam=?, estado='pendiente', error=NULL, aviso=NULL, leer=NULL, lectura=NULL, "
                  "actualizado=? WHERE oficina=? AND slug=? AND papelera=0", (hash_, tam, time.time(), carpeta, slug), escribir=True)
        if leer_pedido is not None:
            self._sql("UPDATE archivos SET leer_pedido=? WHERE oficina=? AND slug=?",
                      (1 if leer_pedido else 0, carpeta, slug), escribir=True)

    def _papelera_sql(self, slug, carpeta, ruta):
        self._sql("UPDATE archivos SET papelera=1, ruta=?, actualizado=? WHERE oficina=? AND slug=?",
                  (ruta, time.time(), carpeta, slug), escribir=True)

    def _pedir_lectura(self, slug, carpeta, agentes):
        self._sql("UPDATE archivos SET estado='leyendo', leer=?, lectura=NULL, error=NULL, actualizado=? "
                  "WHERE oficina=? AND slug=? AND papelera=0", (json.dumps(agentes), time.time(), carpeta, slug), escribir=True)

    def _indice_guardar(self, slug, carpeta, titulo, resumen, temas, texto):
        fts = self._es_fts()
        c = self._con()
        try:
            with c:
                c.execute("DELETE FROM archivos_fts WHERE slug=? AND oficina=?", (slug, carpeta))
                if fts:
                    c.execute("INSERT INTO archivos_fts(slug,oficina,titulo,resumen,temas,texto) VALUES(?,?,?,?,?,?)",
                              (slug, carpeta, titulo, resumen, temas, texto[:300000]))
                else:
                    c.execute("INSERT INTO archivos_fts(slug,oficina,titulo,resumen,temas,texto,norm) VALUES(?,?,?,?,?,?,?)",
                              (slug, carpeta, titulo, resumen, temas, texto[:300000],
                               hq_reuniones.plano("\n".join((titulo, resumen, temas, texto[:300000])))))
        finally:
            c.close()

    def _indice_quitar(self, slug, carpeta):
        self._sql("DELETE FROM archivos_fts WHERE slug=? AND oficina=?", (slug, carpeta), escribir=True)

    def _buscar(self, carpeta, q):
        toks = hq_reuniones.palabras(q)
        if not toks:
            return []
        if self._es_fts():
            m = " ".join('"%s"*' % t for t in toks)
            return [(r[0], r[1]) for r in self._sql(
                "SELECT slug, snippet(archivos_fts, 5, '[', ']', '…', 14) FROM archivos_fts "
                "WHERE archivos_fts MATCH ? AND oficina=? ORDER BY rank LIMIT 100", (m, carpeta))]
        cond = " AND ".join("norm LIKE ?" for _ in toks)
        params = [carpeta]
        for t in toks:
            params.append("%" + t + "%")
        out = []
        for slug, texto in self._sql("SELECT slug, texto FROM archivos_fts WHERE oficina=? AND %s LIMIT 100" % cond, params):
            i = hq_reuniones.plano(texto).find(toks[0])
            sn = ""
            if i >= 0:
                sn = "…" + texto[max(0, i - 60):i + len(toks[0]) + 80].replace("\n", " ") + "…"
            out.append((slug, sn))
        return out

    # ---- entrada

    def max_body(self, path):
        """Tope del cuerpo de un pedido a `path` (la subida admite el archivo en base64)."""
        if path == "/api/archivos":
            a = self.app.activa()
            mb = self._limites(a[1])["max_archivo"] if a else self.env_max_mb * 1048576
            return mb * 4 // 3 + 100000
        return hq_reuniones.MAX_BODY

    def __call__(self, metodo, path, query, body):
        partes = path.split("/")[1:]
        if len(partes) < 2 or len(partes) > 5 or partes[0] != "api" or partes[1] not in ("archivos", "vinculos", "biblioteca") \
                or "" in partes:
            return None
        try:
            return self._despachar(metodo, partes, query, body)
        except ErrorAPI as e:
            return e.status, {"error": e.mensaje}
        except Exception:
            self.srv.log.exception("biblioteca: error interno")
            return 500, {"error": "error interno"}

    def _despachar(self, m, partes, query, body):
        no = (405, {"error": "método no permitido"})
        n = len(partes)
        q = {k: (v[0] if isinstance(v, list) and v else v) for k, v in (query or {}).items()}
        if partes[1] == "archivos":
            if n == 2:
                if m == "GET":
                    return 200, self._listar(q)
                return (200, self._subir(body)) if m == "POST" else no
            slug = partes[2]
            if not hq_core.slug_valido(slug):
                return 404, {"error": "no"}
            if n == 3:
                if m == "GET":
                    return 200, self._detalle(slug)
                return (200, self._quitar(slug)) if m == "DELETE" else no
            if n != 4:
                return 404, {"error": "no"}
            if partes[3] == "original":
                return (200, self._original(slug)) if m == "GET" else no
            if partes[3] == "leer":
                return (200, self._leer(slug, body)) if m == "POST" else no
            if partes[3] == "reprocesar":
                return (200, self._reprocesar(slug)) if m == "POST" else no
            return 404, {"error": "no"}
        if partes[1] == "vinculos":
            if n == 2:
                if m == "GET":
                    return 200, self._listar_vinculos()
                return (200, self._crear_vinculo(body)) if m == "POST" else no
            id_ = partes[2]
            if not hq_core.slug_valido(id_):
                return 404, {"error": "no"}
            if n == 3:
                return (200, self._quitar_vinculo(id_)) if m == "DELETE" else no
            if n == 4 and partes[3] == "escanear":
                return (200, self._escanear_vinculo(id_)) if m == "POST" else no
            return 404, {"error": "no"}
        sub = partes[2]
        if sub == "estado" and n == 3:
            return (200, self._estado()) if m == "GET" else no
        if sub == "config" and n == 3:
            if m == "GET":
                return 200, self._config()
            return (200, self._cambiar_config(body)) if m == "PATCH" else no
        if sub == "propuestas" and n == 3:
            return (200, self._propuestas(q)) if m == "GET" else no
        if sub == "propuestas" and n == 4:
            return (200, self._resolver_propuesta(partes[3], body)) if m == "POST" else no
        if sub == "entregables" and n == 3:
            return (200, self._entregables(q)) if m == "GET" else no
        if sub == "entregable" and n == 3:
            return (200, self._entregable(q)) if m == "GET" else no
        return 404, {"error": "no"}

    # ---- utilidades

    @staticmethod
    def _objeto(body, maximo=MAX_BODY_CHICO, opcional=False):
        if not body:
            if opcional:
                return {}
            raise ErrorAPI(400, "pedido inválido")
        if len(body) > maximo:
            raise ErrorAPI(413, "pedido demasiado grande")
        try:
            d = json.loads(body)
        except ValueError:
            raise ErrorAPI(400, "pedido inválido")
        if not isinstance(d, dict):
            raise ErrorAPI(400, "pedido inválido")
        return d

    def _limites(self, o):
        c = o.get("biblioteca") if isinstance(o.get("biblioteca"), dict) else {}

        def pos(v, d):
            return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else d
        return {"max_archivo": pos(c.get("maxMB"), self.env_max_mb) * 1048576,
                "max_archivos": pos(c.get("maxArchivos"), self.env_max_archivos),
                "max_total": pos(c.get("maxTotalMB"), self.env_max_total_mb) * 1048576}

    @staticmethod
    def _ruta_abs(f, carpeta):
        return f["ruta"] if f["ruta"].startswith("/") else os.path.join(carpeta, f["ruta"])

    @staticmethod
    def _vista(f, snippet=None):
        o = {"slug": f["slug"], "nombre": f["nombre"], "titulo": (f["ficha"] or {}).get("titulo") or f["nombre"],
             "departamento": f["departamento"], "tipo": f["tipo"], "tam": f["tam"], "hash": f["hash"], "estado": f["estado"],
             "origen": f["origen"], "ruta": f["ruta"], "creado": hq_reuniones.iso(f["creado"]),
             "actualizado": hq_reuniones.iso(f["actualizado"]), "fichaRuta": "conocimiento/fuentes/%s.md" % f["slug"],
             "textoRuta": "archivos/.texto/%s.md" % f["slug"]}
        if f.get("vinculo"):
            o["vinculo"] = f["vinculo"]
        if f.get("error"):
            o["error"] = f["error"]
        if f.get("aviso"):
            o["aviso"] = f["aviso"]
        if f.get("ficha"):
            o["ficha"] = f["ficha"]
        if f.get("leer"):
            o["leer"] = f["leer"]
        if f.get("lectura"):
            o["lectura"] = f["lectura"]
        if snippet:
            o["snippet"] = snippet
        return o

    def _fila(self, slug, carpeta):
        f = self._archivo(slug, carpeta)
        if f is None or f["papelera"]:
            raise ErrorAPI(404, "No encontré ese archivo.")
        return f

    @staticmethod
    def _escribir(texto, ruta):
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        hq_core.escribir_atomico(ruta, texto)

    # ---- archivos

    def _listar(self, q):
        carpeta, _ = self.app.requerir_activa()
        filas = self._archivos(carpeta)
        snippets = {}
        busqueda = (q.get("q") or "").strip()
        if busqueda:
            hits = self._buscar(carpeta, busqueda)
            orden = {}
            for i, (slug, sn) in enumerate(hits):
                orden.setdefault(slug, i)
                snippets[slug] = sn
            filas = sorted([f for f in filas if f["slug"] in orden], key=lambda f: orden[f["slug"]])
        if q.get("departamento"):
            filas = [f for f in filas if f["departamento"] == q["departamento"]]
        o = {"archivos": [self._vista(f, snippets.get(f["slug"])) for f in filas]}
        if busqueda:
            o["q"] = busqueda
        return o

    def _detalle(self, slug):
        carpeta, _ = self.app.requerir_activa()
        f = self._fila(slug, carpeta)
        v = self._vista(f)
        v["rutaAbsoluta"] = self._ruta_abs(f, carpeta)
        texto = hq_core.leer_texto(os.path.join(carpeta, "archivos", ".texto", slug + ".md")) or ""
        return {"archivo": v, "texto": recortar(texto, 4000)}

    def _subir(self, body):
        carpeta, of = self.app.requerir_activa()
        lim = self._limites(of)
        d = self._objeto(body, lim["max_archivo"] * 4 // 3 + 100000)
        nombre = nombre_seguro(hq_core.texto(d.get("nombre"), "nombre", 255))
        ext = extension(nombre)
        if ext not in SOPORTADOS:
            raise ErrorAPI(400, "Ese tipo de archivo no se puede leer (%s). Tipos soportados: %s." % (
                "." + ext if ext else "sin extensión", " ".join("." + e for e in sorted(SOPORTADOS))))
        dep = hq_core.texto(d.get("departamento"), "departamento", 41, False) or COMPARTIDO
        if dep != COMPARTIDO and _departamento(of, dep) is None:
            raise ErrorAPI(400, "El departamento «%s» no existe." % dep)
        b64 = d.get("base64")
        if not isinstance(b64, str) or not b64:
            raise ErrorAPI(400, "Falta el contenido del archivo (base64).")
        if b64.startswith("data:") and "," in b64:
            b64 = b64.split(",", 1)[1]
        mb = lim["max_archivo"] // 1048576
        if len(b64) > lim["max_archivo"] * 4 // 3 + 8:
            raise ErrorAPI(413, "El archivo es demasiado grande (el máximo es %d MB)." % mb)
        try:
            data = base64.b64decode(re.sub(r"\s+", "", b64), validate=False)
        except Exception:
            data = b""
        if not data:
            raise ErrorAPI(400, "El contenido del archivo no es base64 válido.")
        if len(data) > lim["max_archivo"]:
            raise ErrorAPI(413, "El archivo pesa %s y el máximo es %d MB." % (tam_texto(len(data)), mb))
        leer_pedido = d.get("leer") is True
        h = sha256_bytes(data)
        existentes = self._archivos(carpeta)
        ya = next((f for f in existentes if f["origen"] == "subido" and f["departamento"] == dep and f["hash"] == h), None)
        if ya:
            v = self._vista(ya)
            v["duplicado"] = True
            return {"archivo": v, "duplicado": True}
        rel_base = "archivos/" + dep
        viejo = next((f for f in existentes if f["origen"] == "subido" and f["departamento"] == dep and f["nombre"] == nombre), None)
        if viejo:
            try:
                os.makedirs(os.path.join(carpeta, rel_base), exist_ok=True)
                with open(os.path.join(carpeta, viejo["ruta"]), "wb") as fh:
                    fh.write(data)
                self._reprocesar_sql(viejo["slug"], carpeta, h, len(data), leer_pedido)
            except OSError:
                raise ErrorAPI(500, "No pude guardar el archivo.")
            self.ev.set()
            v = self._vista(self._archivo(viejo["slug"], carpeta) or viejo)
            v["reemplazado"] = True
            return {"archivo": v, "reemplazado": True}
        destino = ruta_libre(os.path.join(carpeta, rel_base), nombre)
        try:
            os.makedirs(os.path.join(carpeta, rel_base), exist_ok=True)
            with open(destino, "wb") as fh:
                fh.write(data)
        except OSError:
            raise ErrorAPI(500, "No pude guardar el archivo.")
        usados = {r[0] for r in self._sql("SELECT slug FROM archivos WHERE oficina=?", (carpeta,))}
        slug = hq_core.slug_unico(os.path.splitext(nombre)[0], usados, "archivo")
        ahora = time.time()
        f = {"slug": slug, "oficina": carpeta, "nombre": os.path.basename(destino), "departamento": dep,
             "ruta": rel_base + "/" + os.path.basename(destino), "origen": "subido", "vinculo": None, "tipo": ext,
             "tam": len(data), "hash": h, "estado": "pendiente", "error": None, "aviso": None, "ficha": None,
             "leer": [], "lectura": {}, "creado": ahora, "actualizado": ahora, "papelera": False, "leer_pedido": leer_pedido}
        try:
            self._guardar(f)
        except sqlite3.Error:
            raise ErrorAPI(500, "No pude registrar el archivo.")
        self.ev.set()
        self.srv.log.info("biblioteca: archivo subido tipo=%s tam=%d", ext, len(data))
        return {"archivo": self._vista(f)}

    def _quitar(self, slug):
        carpeta, of = self.app.requerir_activa()
        f = self._fila(slug, carpeta)
        ts = "%s-%d" % (dia(time.time()), int(time.time()) % 100000)
        rel = "archivos/.papelera/%s-%s" % (slug, ts)
        os.makedirs(os.path.join(carpeta, rel), exist_ok=True)
        destino = f["ruta"]
        if f["origen"] == "subido":
            d = ruta_libre(os.path.join(carpeta, rel), f["nombre"])
            try:
                shutil.move(os.path.join(carpeta, f["ruta"]), d)
                destino = rel + "/" + os.path.basename(d)
            except OSError:
                pass
        for de, a2 in (("conocimiento/fuentes/%s.md" % slug, "ficha.md"), ("archivos/.texto/%s.md" % slug, "texto.md")):
            if os.path.exists(os.path.join(carpeta, de)):
                try:
                    shutil.move(os.path.join(carpeta, de), os.path.join(carpeta, rel, a2))
                except OSError:
                    pass
        try:
            self._papelera_sql(slug, carpeta, destino)
        except sqlite3.Error:
            raise ErrorAPI(500, "No pude quitar el archivo.")
        self._indice_quitar(slug, carpeta)
        self._catalogo(carpeta, of)
        return {"ok": True, "papelera": destino}

    @staticmethod
    def _contenido(ruta, nombre, tipo):
        """{nombre, tipo, mime, tam, ruta, base64?} (los de hasta 8 MB viajan en base64, igual que en la app)."""
        try:
            tam = os.path.getsize(ruta)
        except OSError:
            raise ErrorAPI(404, "El archivo original ya no está en esa ubicación.")
        o = {"nombre": nombre, "tipo": tipo, "mime": MIMES.get(tipo, "application/octet-stream"), "tam": tam, "ruta": ruta}
        if tam <= MAX_BASE64_DIRECTO:
            try:
                with open(ruta, "rb") as fh:
                    o["base64"] = base64.b64encode(fh.read()).decode("ascii")
            except OSError:
                pass
        return o

    def _original(self, slug):
        carpeta, _ = self.app.requerir_activa()
        f = self._fila(slug, carpeta)
        return self._contenido(self._ruta_abs(f, carpeta), f["nombre"], f["tipo"])

    def _reprocesar(self, slug):
        carpeta, _ = self.app.requerir_activa()
        f = self._fila(slug, carpeta)
        ruta = self._ruta_abs(f, carpeta)
        h = sha256_archivo(ruta)
        if h is None:
            raise ErrorAPI(404, "El archivo original ya no está en esa ubicación.")
        self._reprocesar_sql(slug, carpeta, h, os.path.getsize(ruta))
        self.ev.set()
        return {"archivo": self._vista(self._archivo(slug, carpeta) or f)}

    # ---- lectura por rol

    @staticmethod
    def _lectores_por_defecto(f, o):
        deps = list((f["ficha"] or {}).get("util_para") or [])
        if not deps and _departamento(o, f["departamento"]):
            deps = [f["departamento"]]
        ags = [a for a in o["agentes"] if a["departamento"] in deps]
        if f.get("vinculo"):
            v = next((x for x in o.get("vinculos") or [] if x["id"] == f["vinculo"]), None)
            if v:
                ags = [a for a in ags if hq_core.alcance_incluye(v.get("alcance"), a)]
        return [a["id"] for a in ags[:MAX_LECTORES]]

    def _leer(self, slug, body):
        carpeta, of = self.app.requerir_activa()
        f = self._fila(slug, carpeta)
        d = self._objeto(body, opcional=True)
        if f["estado"] not in ("listo", "error") or not f["ficha"]:
            raise ErrorAPI(409, "Todavía no hay ficha de este archivo: esperá a que termine de procesarse."
                           if not f["ficha"] else "El archivo todavía se está procesando.")
        if d.get("agentes") is not None:
            if not isinstance(d["agentes"], list):
                raise ErrorAPI(400, "«agentes» tiene que ser una lista de ids.")
            ids = []
            for x in d["agentes"]:
                if not isinstance(x, str) or hq_reuniones.agente_de(of, x) is None:
                    raise ErrorAPI(400, "Hay un agente que no está en la oficina.")
                if x not in ids:
                    ids.append(x)
            if len(ids) > MAX_LECTORES:
                raise ErrorAPI(400, "Máximo %d agentes por lectura." % MAX_LECTORES)
        else:
            ids = self._lectores_por_defecto(f, of)
        if not ids:
            raise ErrorAPI(409, "No hay agentes a quienes les sirva este documento (revisá «útil para» o elegí agentes).")
        self._pedir_lectura(slug, carpeta, ids)
        self.ev.set()
        return {"archivo": self._vista(self._archivo(slug, carpeta) or f), "agentes": ids}

    # ---- cola (un solo trabajador)

    def _siguiente(self):
        r = self._sql("SELECT %s FROM archivos WHERE papelera=0 AND estado IN ('pendiente','leyendo') "
                      "ORDER BY actualizado, slug LIMIT 1" % COLS, uno=True)
        return self._de_fila(r) if r else None

    def _bucle(self):
        while True:
            try:
                f = self._siguiente()
                if f is None:
                    self.ev.wait(1.0)
                    self.ev.clear()
                    continue
                self._procesar(f)
            except Exception:
                self.srv.log.exception("biblioteca: fallo el procesamiento")
                time.sleep(1)

    def _sigue(self, f):
        x = self._archivo(f["slug"], f["oficina"])
        return bool(x and not x["papelera"])

    def _procesar(self, f):
        try:
            of = hq_core.leer_oficina(f["oficina"])
        except ErrorAPI:
            self._estado_sql(f["slug"], f["oficina"], "error", "No pude leer la oficina.")
            return
        if f["estado"] == "pendiente":
            self._extraer_y_fichar(f, of)
            if not self._sigue(f):
                return
            f = self._archivo(f["slug"], f["oficina"])
            if f is None:
                return
        if f["estado"] == "leyendo":
            self._leer_por_rol(f, of)

    def _extraer_y_fichar(self, f, of):
        slug, carpeta = f["slug"], f["oficina"]
        ruta = self._ruta_abs(f, carpeta)
        self._estado_sql(slug, carpeta, "extrayendo")
        self._aviso(slug, carpeta, None)
        texto, aviso, vision = extraer_texto(ruta, f["tipo"])
        if vision:
            p = ("Describí la imagen que está en «%s» (usá la herramienta Read para verla). Incluí todo el texto visible tal "
                 "cual, números, objetos, personas (sin identificarlas), colores y contexto. Respondé en español, en texto "
                 "plano, sin inventar lo que no se ve." % ruta)
            caja = hq_vivo.CajaCosto()
            try:
                t = self._correr([self.app.claude, "-p"] + hq_vivo.FORMATO_SALIDA + ["--tools", "Read", "--add-dir",
                                  os.path.dirname(ruta), "--", p], carpeta, self.timeout_imagen, caja.observador()).strip()
                if t:
                    texto = t
                else:
                    aviso = "Claude no devolvió una descripción de la imagen."
            except ErrorAPI as e:
                aviso = "No pude describir la imagen: %s" % e.mensaje
            self.app.costos.registrar(carpeta, "biblioteca", caja.valor, ref=slug)
        if not self._sigue(f):
            return
        texto = texto or ""
        if texto:
            self._escribir(texto, os.path.join(carpeta, "archivos", ".texto", slug + ".md"))
        self._estado_sql(slug, carpeta, "fichando")
        if aviso:
            self._aviso(slug, carpeta, aviso)
        if not texto:
            aviso = aviso or "No pude sacar texto de este archivo."
            self._indice_guardar(slug, carpeta, f["nombre"], "", "", "")
            self._estado_sql(slug, carpeta, "error", aviso)
            self._aviso(slug, carpeta, aviso)
            self._catalogo(carpeta, of)
            return
        ficha, contradicciones, error_ficha = None, [], None
        caja = hq_vivo.CajaCosto()
        try:
            p = prompt_ficha(of, carpeta, f["nombre"], f["tipo"], f["departamento"], texto)
            t = self._correr([self.app.claude, "-p"] + hq_vivo.FORMATO_SALIDA + ["--tools", "", "--", p], carpeta,
                             self.timeout_ficha, caja.observador())
            r = parsear_ficha(t, f["nombre"], of)
            if r:
                ficha, contradicciones = r
            else:
                error_ficha = "El bibliotecario no devolvió la ficha en el formato esperado."
        except ErrorAPI as e:
            error_ficha = e.mensaje
        self.app.costos.registrar(carpeta, "biblioteca", caja.valor, ref=slug)
        if not self._sigue(f):
            return
        if ficha:
            f["ficha"] = ficha
            self._sql("UPDATE archivos SET ficha=? WHERE oficina=? AND slug=? AND papelera=0",
                      (json.dumps(ficha, ensure_ascii=False), carpeta, slug), escribir=True)
            self._escribir(ficha_md(f, ficha, of), os.path.join(carpeta, "conocimiento", "fuentes", slug + ".md"))
            for c in contradicciones:
                ya = self._sql("SELECT 1 FROM propuestas WHERE oficina=? AND archivo=? AND sugerencia=? AND estado='pendiente'",
                               (carpeta, slug, c["sugerencia"]), uno=True)
                if not ya:
                    self._sql("INSERT INTO propuestas(id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada) "
                              "VALUES(?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), carpeta, slug, ficha["titulo"], c["actual"],
                                                           c["nuevo"], c["sugerencia"], "pendiente", time.time()), escribir=True)
        self._indice_guardar(slug, carpeta, ((ficha or {}).get("titulo") or "") + " " + f["nombre"],
                             (ficha or {}).get("resumen") or "", " ".join((ficha or {}).get("temas") or []), texto)
        if not ficha:
            self._estado_sql(slug, carpeta, "error", error_ficha)  # antes del catálogo: si no queda «en proceso»
        self._catalogo(carpeta, of)
        if not ficha:
            return
        auto = bool((of.get("biblioteca") or {}).get("lecturaAutomatica")) if isinstance(of.get("biblioteca"), dict) else False
        if f.get("leer_pedido") or auto:
            ids = self._lectores_por_defecto(f, of)
            if ids:
                self._pedir_lectura(slug, carpeta, ids)
                return
        self._estado_sql(slug, carpeta, "listo")

    def _leer_por_rol(self, f, of):
        """Cada agente lee la ficha y anota en SU archivo de notas (único permiso de escritura), en su carril."""
        srv, cfg = self.srv, self.app.cfg
        carpeta, slug = f["oficina"], f["slug"]
        titulo = (f["ficha"] or {}).get("titulo") or f["nombre"]
        ids = list(f["leer"])
        resultados = {}
        with self.mut:
            self.leyendo_ahora.update(ids)
        try:
            for i, id_ in enumerate(ids):
                if not self._sigue(f):
                    return
                ag = hq_reuniones.agente_de(of, id_)
                if ag is None:
                    resultados[id_] = "error: el agente ya no está en la oficina"
                    continue
                prompt = prompt_lectura(titulo, f["nombre"], slug, ag, f["tipo"] in IMAGENES, self._ruta_abs(f, carpeta))
                herr = (cfg["herramientas_agente"].get(id_) or cfg["herramientas"]) + ",Edit,Write"
                notas = os.path.join(carpeta, "conocimiento", "agentes", id_ + ".md")
                cmd = [self.app.claude, "-p", "--agent", id_, "--session-id", str(uuid.uuid4())] + hq_vivo.FORMATO_SALIDA + [
                    "--tools", herr]
                for d in hq_core.dirs_vinculos(of, ag):
                    cmd += ["--add-dir", d]
                cmd += ["--allowedTools"] + [srv.regla_permiso(h, notas) for h in ("Edit", "Write")] + ["--", prompt]
                caja = hq_vivo.CajaCosto()
                try:
                    with self.app._lock(carpeta, id_):
                        with self.app.actividad.seguir(carpeta, id_, "biblioteca", "Leyendo " + f["nombre"],
                                                       extra=caja.observador()) as (obs, _t):
                            self._correr(cmd, carpeta, cfg["timeout"], obs)
                    resultados[id_] = "ok"
                except ErrorAPI as e:
                    resultados[id_] = "error: " + e.mensaje
                finally:
                    self.app.costos.registrar(carpeta, "biblioteca", caja.valor, id_, slug)
                self._sql("UPDATE archivos SET leer=?, lectura=?, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                          (json.dumps(ids[i + 1:]) if ids[i + 1:] else None, json.dumps(resultados), time.time(), carpeta, slug),
                          escribir=True)
            self._sql("UPDATE archivos SET leer=NULL, lectura=?, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                      (json.dumps(resultados), time.time(), carpeta, slug), escribir=True)
            self._estado_sql(slug, carpeta, "listo")
        finally:
            with self.mut:
                self.leyendo_ahora.difference_update(ids)

    def _correr(self, cmd, carpeta, timeout, obs=None):
        """-> texto de `result`. ErrorAPI(502, mensaje en español) si falla. `obs`: eventos en vivo."""
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

    # ---- catálogo

    def _catalogo(self, carpeta, of):
        try:
            self._escribir(catalogo_md(self._archivos(carpeta), of), os.path.join(carpeta, "conocimiento", "archivos.md"))
        except (OSError, ErrorAPI):
            self.srv.log.exception("biblioteca: no pude escribir el catálogo")

    # ---- estado, config y propuestas

    def _estado(self):
        carpeta, of = self.app.requerir_activa()
        filas = self._archivos(carpeta)
        cola = []
        for f in filas:
            if f["estado"] == "listo":
                continue
            o = {"slug": f["slug"], "nombre": f["nombre"], "estado": f["estado"]}
            if f["error"]:
                o["error"] = f["error"]
            if f["aviso"]:
                o["aviso"] = f["aviso"]
            if f["leer"]:
                o["leer"] = f["leer"]
            cola.append(o)
        en_curso = [f for f in filas if f["estado"] in ("pendiente", "extrayendo", "fichando", "leyendo")]
        with self.mut:
            lee = sorted(self.leyendo_ahora & {a["id"] for a in of["agentes"]})
        props = self._sql("SELECT COUNT(*) FROM propuestas WHERE oficina=? AND estado='pendiente'", (carpeta,), uno=True)[0]
        return {"cola": cola, "pendientes": len(en_curso), "total": len(filas), "leyendo": lee, "propuestas": props,
                "fts": self._es_fts()}

    def _config(self):
        carpeta, of = self.app.requerir_activa()
        l = self._limites(of)
        b = of.get("biblioteca") if isinstance(of.get("biblioteca"), dict) else {}
        return {"lecturaAutomatica": bool(b.get("lecturaAutomatica")), "maxMB": l["max_archivo"] // 1048576,
                "maxArchivos": l["max_archivos"], "maxTotalMB": l["max_total"] // 1048576, "extensiones": sorted(SOPORTADOS)}

    def _cambiar_config(self, body):
        d = self._objeto(body)

        def entero(k, mx):
            v = d.get(k)
            if v is None:
                return None
            if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v or not 1 <= v <= mx:
                raise ErrorAPI(400, "«%s» tiene que ser un número entre 1 y %d." % (k, mx))
            return int(v)
        auto = d.get("lecturaAutomatica")
        if auto is not None and not isinstance(auto, bool):
            raise ErrorAPI(400, "«lecturaAutomatica» tiene que ser verdadero o falso.")
        mb, na, mt = entero("maxMB", 500), entero("maxArchivos", 5000), entero("maxTotalMB", 20000)
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            c = o.get("biblioteca") if isinstance(o.get("biblioteca"), dict) else {}
            if auto is not None:
                c["lecturaAutomatica"] = auto
            if mb is not None:
                c["maxMB"] = mb
            if na is not None:
                c["maxArchivos"] = na
            if mt is not None:
                c["maxTotalMB"] = mt
            o["biblioteca"] = c
            hq_core.escribir_oficina(o, carpeta)
        return self._config()

    @staticmethod
    def _vista_propuesta(p):
        o = {"id": p[0], "archivo": p[2], "titulo": p[3], "actual": p[4], "nuevo": p[5], "sugerencia": p[6], "estado": p[7],
             "creada": hq_reuniones.iso(p[8])}
        if p[9] is not None:
            o["resuelta"] = hq_reuniones.iso(p[9])
        return o

    def _propuestas(self, q):
        carpeta, _ = self.app.requerir_activa()
        filtro = "" if q.get("todas") == "1" else "AND estado='pendiente'"
        filas = self._sql("SELECT id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada,resuelta FROM propuestas "
                          "WHERE oficina=? %s ORDER BY creada DESC" % filtro, (carpeta,))
        return {"propuestas": [self._vista_propuesta(p) for p in filas]}

    def _resolver_propuesta(self, id_, body):
        if not hq_reuniones.UUID_RE.match(id_):
            raise ErrorAPI(404, "No encontré esa propuesta.")
        carpeta, _ = self.app.requerir_activa()
        aceptar = self._objeto(body).get("aceptar")
        if not isinstance(aceptar, bool):
            raise ErrorAPI(400, "Falta «aceptar» (verdadero o falso).")
        id_ = id_.lower()
        cols = "id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada,resuelta"
        p = self._sql("SELECT %s FROM propuestas WHERE id=? AND oficina=?" % cols, (id_, carpeta), uno=True)
        if not p:
            raise ErrorAPI(404, "No encontré esa propuesta.")
        if p[7] != "pendiente":
            raise ErrorAPI(409, "Esa propuesta ya fue resuelta.")
        if aceptar:
            try:
                anexar_actualizacion(carpeta, p[6], p[3], p[2])
            except (OSError, ErrorAPI):
                raise ErrorAPI(500, "No pude actualizar la memoria de la oficina.")
        self._sql("UPDATE propuestas SET estado=?, resuelta=? WHERE id=?",
                  ("aceptada" if aceptar else "rechazada", time.time(), id_), escribir=True)
        v = self._vista_propuesta(self._sql("SELECT %s FROM propuestas WHERE id=?" % cols, (id_,), uno=True))
        v["aplicada"] = aceptar
        return {"propuesta": v}

    # ---- entregables

    @staticmethod
    def _carpeta_entregables(q, carpeta):
        id_ = q.get("agente")
        if not isinstance(id_, str) or not hq_core.slug_valido(id_):
            raise ErrorAPI(400, "Falta el agente.")
        return id_, os.path.join(carpeta, "archivos", "entregables", id_)

    def _entregables(self, q):
        carpeta, _ = self.app.requerir_activa()
        id_, dir_ = self._carpeta_entregables(q, carpeta)
        out = []
        for dp, dns, fns in os.walk(dir_):
            dns[:] = [d for d in dns if not d.startswith(".")]
            for fn in fns:
                if fn.startswith("."):
                    continue
                p = os.path.join(dp, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                out.append((st.st_mtime, {"nombre": fn, "ruta": os.path.relpath(p, dir_), "tam": st.st_size,
                                          "tipo": extension(fn), "modificado": hq_reuniones.iso(st.st_mtime)}))
                if len(out) >= 300:
                    break
        out.sort(key=lambda x: -x[0])
        return {"agente": id_, "carpeta": "archivos/entregables/%s" % id_, "entregables": [x[1] for x in out]}

    def _entregable(self, q):
        carpeta, _ = self.app.requerir_activa()
        _, dir_ = self._carpeta_entregables(q, carpeta)
        rel = q.get("ruta")
        if not isinstance(rel, str) or not rel or "\0" in rel:
            raise ErrorAPI(400, "Falta la ruta del entregable.")
        base = os.path.realpath(dir_)
        p = os.path.realpath(os.path.join(dir_, rel))
        if not p.startswith(base + os.sep) or not os.path.isfile(p):
            raise ErrorAPI(404, "No encontré ese entregable.")
        return self._contenido(p, os.path.basename(p), extension(p))

    # ---- vínculos

    def _vista_vinculo(self, v, filas):
        mios = [f for f in filas if f.get("vinculo") == v["id"]]
        return {"id": v["id"], "ruta": v["ruta"], "alcance": v.get("alcance", "oficina"), "archivos": len(mios),
                "existe": os.path.exists(v["ruta"]), "pendientes": len([f for f in mios if f["estado"] not in ("listo", "error")])}

    def _listar_vinculos(self):
        carpeta, o = self.app.requerir_activa()
        filas = self._archivos(carpeta)
        return {"vinculos": [self._vista_vinculo(v, filas) for v in o.get("vinculos") or []]}

    @staticmethod
    def _alcance_de(v, o):
        msg = "«alcance» tiene que ser \"oficina\", {departamentos:[...]} o {agentes:[...]}."
        if v is None or v == "oficina":
            return "oficina"
        if not isinstance(v, dict):
            raise ErrorAPI(400, msg)

        def ids(k):
            x = v.get(k)
            if x is None:
                return None
            if not isinstance(x, list) or not x:
                raise ErrorAPI(400, "«alcance.%s» tiene que ser una lista con al menos un id." % k)
            out = []
            for e in x:
                if not hq_core.slug_valido(e):
                    raise ErrorAPI(400, "«alcance.%s» tiene que ser una lista de ids." % k)
                if e not in out:
                    out.append(e)
            return out
        deps = ids("departamentos")
        if deps is not None:
            mal = next((x for x in deps if _departamento(o, x) is None), None)
            if mal:
                raise ErrorAPI(400, "El departamento «%s» no existe." % mal)
            return {"departamentos": deps}
        ags = ids("agentes")
        if ags is not None:
            mal = next((x for x in ags if hq_reuniones.agente_de(o, x) is None), None)
            if mal:
                raise ErrorAPI(400, "El agente «%s» no está en la oficina." % mal)
            return {"agentes": ags}
        raise ErrorAPI(400, msg)

    def _crear_vinculo(self, body):
        d = self._objeto(body)
        cruda = hq_core.texto(d.get("ruta"), "ruta", 1024)
        if not (cruda.startswith("/") or cruda == "~" or cruda.startswith("~/")):
            raise ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.")
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            home = self.app.home
            ruta = hq_core.resolver_carpeta(cruda, home)
            real, real_home = os.path.realpath(ruta), os.path.realpath(home)
            if ruta == "/" or real == "/" or ruta == home or real == real_home:
                raise ErrorAPI(400, "Esa carpeta es demasiado amplia: elegí una carpeta concreta (no «/» ni tu carpeta personal entera).")
            if not os.path.exists(ruta):
                raise ErrorAPI(404, "No encuentro esa carpeta.")
            if not os.path.isdir(ruta):
                raise ErrorAPI(400, "Eso no es una carpeta.")
            of_real = os.path.realpath(carpeta)
            if real == of_real or real.startswith(of_real + os.sep):
                raise ErrorAPI(400, "Esa carpeta ya es parte de la oficina: no hace falta vincularla.")
            alcance = self._alcance_de(d.get("alcance"), o)
            existentes = o.get("vinculos") or []
            if any(v["ruta"] == ruta for v in existentes):
                raise ErrorAPI(409, "Esa carpeta ya está vinculada.")
            if len(existentes) >= MAX_VINCULOS:
                raise ErrorAPI(400, "Máximo %d carpetas vinculadas." % MAX_VINCULOS)
            usados = {v["id"] for v in existentes}
            pid = hq_core.texto(d.get("id"), "id", 41, False)
            if pid:
                if not hq_core.slug_valido(pid):
                    raise ErrorAPI(400, "Id inválido (usá minúsculas, números y guiones).")
                if pid in usados:
                    raise ErrorAPI(409, "Ya hay una carpeta vinculada con ese id.")
                id_ = pid
            else:
                id_ = hq_core.slug_unico(os.path.basename(ruta), usados, "carpeta")
            v = {"id": id_, "ruta": ruta, "alcance": alcance}
            o["vinculos"] = existentes + [v]
            hq_core.escribir_oficina(o, carpeta)
        self.srv.log.info("biblioteca: carpeta vinculada id=%s", id_)
        return {"vinculo": self._vista_vinculo(v, self._archivos(carpeta))}

    def _quitar_vinculo(self, id_):
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            if not any(v["id"] == id_ for v in o.get("vinculos") or []):
                raise ErrorAPI(404, "No existe esa carpeta vinculada.")
            quitados = 0
            for f in self._archivos(carpeta):
                if f.get("vinculo") != id_:
                    continue
                rel = "archivos/.papelera/%s-vinculo" % f["slug"]
                for de, a2 in (("conocimiento/fuentes/%s.md" % f["slug"], "ficha.md"), ("archivos/.texto/%s.md" % f["slug"], "texto.md")):
                    if os.path.exists(os.path.join(carpeta, de)):
                        try:
                            os.makedirs(os.path.join(carpeta, rel), exist_ok=True)
                            shutil.move(os.path.join(carpeta, de), os.path.join(carpeta, rel, a2))
                        except OSError:
                            pass
                self._papelera_sql(f["slug"], carpeta, f["ruta"])
                self._indice_quitar(f["slug"], carpeta)
                quitados += 1
            o["vinculos"] = [v for v in o["vinculos"] if v["id"] != id_]
            if not o["vinculos"]:
                del o["vinculos"]
            hq_core.escribir_oficina(o, carpeta)
        self._catalogo(carpeta, o)
        return {"ok": True, "quitados": quitados}

    def _escanear_vinculo(self, id_):
        with self._lock_escaneo:  # el escaneo al abrir la oficina y el manual no se pisan
            return self._escanear_vinculo_sin_lock(id_)

    def _escanear_vinculo_sin_lock(self, id_):
        carpeta, o = self.app.requerir_activa()
        v = next((x for x in o.get("vinculos") or [] if x["id"] == id_), None)
        if v is None:
            raise ErrorAPI(404, "No existe esa carpeta vinculada.")
        if not os.path.isdir(v["ruta"]):
            raise ErrorAPI(404, "La carpeta vinculada ya no existe en esa ubicación.")
        lim = self._limites(o)
        esc = escanear(v["ruta"], lim["max_archivos"], lim["max_total"], lim["max_archivo"])
        usados = {r[0] for r in self._sql("SELECT slug FROM archivos WHERE oficina=?", (carpeta,))}
        previos = [f for f in self._archivos(carpeta) if f.get("vinculo") == id_]
        vistos = set()
        nuevos = actualizados = iguales = 0
        ahora = time.time()
        for h in esc["hallados"]:
            vistos.add(h["ruta"])
            p = next((x for x in previos if x["ruta"] == h["ruta"]), None)
            if p:
                if p["hash"] == h["hash"]:
                    iguales += 1
                else:
                    self._reprocesar_sql(p["slug"], carpeta, h["hash"], h["tam"])
                    actualizados += 1
                continue
            nombre = os.path.basename(h["ruta"])
            slug = hq_core.slug_unico(os.path.splitext(nombre)[0], usados, "archivo")
            usados.add(slug)
            self._guardar({"slug": slug, "oficina": carpeta, "nombre": nombre, "departamento": VINCULO, "ruta": h["ruta"],
                           "origen": "vinculo", "vinculo": id_, "tipo": extension(nombre), "tam": h["tam"], "hash": h["hash"],
                           "estado": "pendiente", "error": None, "aviso": None, "ficha": None, "leer": [], "lectura": {},
                           "creado": ahora, "actualizado": ahora, "papelera": False, "leer_pedido": False})
            nuevos += 1
        quitados = 0
        for p in previos:
            if p["ruta"] not in vistos and not os.path.exists(p["ruta"]):
                self._papelera_sql(p["slug"], carpeta, p["ruta"])
                self._indice_quitar(p["slug"], carpeta)
                quitados += 1
        if quitados or nuevos or actualizados:
            self._catalogo(carpeta, o)
        self.ev.set()
        r = {"ok": True, "nuevos": nuevos, "actualizados": actualizados, "sinCambios": iguales, "quitados": quitados,
             "omitidos": esc["omitidos"], "tope": esc["tope"]}
        if esc["tope"]:
            r["aviso"] = ("La carpeta tiene más archivos o más peso que el tope (%d archivos, %d MB): se leyeron solo los "
                          "primeros." % (lim["max_archivos"], lim["max_total"] // 1048576))
        return r


def instalar(app, srv):
    """Engancha la biblioteca al App del servidor: `app.biblioteca`."""
    app.biblioteca = Biblioteca(app, srv)
    return app.biblioteca
