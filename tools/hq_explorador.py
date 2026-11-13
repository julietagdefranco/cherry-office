"""Explorador de carpetas y de la carpeta de la oficina, para el modo desarrollo (oficina/server.py). Python 3.9, solo librería estándar.

Misma API, mismos topes y mismas reglas de seguridad que app/Sources/Backend/Explorador.swift: si cambia una, cambia la otra.

  GET  /api/fs/carpetas?ruta=&ocultas=0|1   subcarpetas de una carpeta DENTRO de $HOME (nunca contenido de archivos)
  POST /api/fs/carpetas {padre, nombre}     crea una subcarpeta dentro de $HOME
  GET  /api/oficina/archivos?ruta=<rel>     lista de la carpeta de la oficina activa (solo lectura)
  GET  /api/oficina/archivo?ruta=<rel>      vista previa: {texto} (tope 512 KB) o {base64, mime} (imágenes, tope 2 MB)

Se engancha con `instalar(app, server)`: deja `app.explorador`, un callable (metodo, path, query, body) -> (código, dict) | None.
"""
import base64
import json
import os
import re

import hq_core
from hq_core import ErrorAPI

MAX_ENTRADAS = 500
MAX_TEXTO = 512 * 1024
MAX_IMAGEN = 2 * 1024 * 1024
MAX_NOMBRE = 120
EXT_TEXTO = {"md", "markdown", "txt", "json", "csv", "tsv", "log"}
EXT_IMAGEN = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
RUTAS = ("/api/fs/carpetas", "/api/oficina/archivos", "/api/oficina/archivo")


def es_ruta(path):
    return path in RUTAS


# ----------------------------------------------------------------------------- utilidades puras

def dentro(base, ruta):
    """true si `ruta` es `base` o cae dentro (ambas ya resueltas con realpath)."""
    return ruta == base or ruta.startswith(base.rstrip("/") + "/")


def nombre_saneado(s):
    """Nombre de carpeta nuevo: sin separadores, `:` ni caracteres de control, sin puntos al principio. '' si no sirve."""
    t = "".join("-" if (c in "/\\:" or ord(c) < 32 or ord(c) == 127) else c for c in str(s or ""))
    t = t.strip().lstrip(".").strip()
    return t[:MAX_NOMBRE].strip()


def parte_oculta_permitida(i, parte):
    """Dentro de la oficina solo se ven los ocultos `.claude` (nivel 0); el resto de los `.algo` queda fuera."""
    return not parte.startswith(".") or (i == 0 and parte == ".claude")


def _cadena(v):
    return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else "")


class Explorador:
    def __init__(self, app, srv):
        self.app = app
        self.srv = srv

    # ---- despacho

    def __call__(self, metodo, path, query, body):
        if path not in RUTAS:
            return None
        q = {k: _cadena(v) for k, v in (query or {}).items()}
        try:
            if path == "/api/fs/carpetas":
                if metodo == "GET":
                    return 200, self._carpetas(q)
                if metodo == "POST":
                    return 200, self._crear_carpeta(body)
                return 405, {"error": "método no permitido"}
            if metodo != "GET":
                return 405, {"error": "método no permitido"}
            if path == "/api/oficina/archivos":
                return 200, self._archivos(q)
            return 200, self._archivo(q)
        except ErrorAPI as e:
            return e.status, {"error": e.mensaje}
        except Exception:
            self.srv.log.exception("explorador: error interno")
            return 500, {"error": "error interno"}

    # ---- carpetas dentro de $HOME

    def _home(self):
        return os.path.realpath(self.app.home)

    def _resolver_en_home(self, ruta):
        """realpath de `ruta` (absoluta) si cae dentro de $HOME; 400 / 403 / 404 si no."""
        home = self._home()
        if not ruta:
            return home
        if "\0" in ruta or not ruta.startswith("/"):
            raise ErrorAPI(400, "La ruta tiene que ser absoluta.")
        real = os.path.realpath(ruta)
        if not dentro(home, real):
            raise ErrorAPI(403, "Solo se pueden explorar carpetas dentro de tu carpeta personal.")
        if not os.path.exists(real):
            raise ErrorAPI(404, "No encontré esa carpeta.")
        if not os.path.isdir(real):
            raise ErrorAPI(400, "Eso no es una carpeta.")
        return real

    def _accesos(self, home):
        out = [{"nombre": "Inicio", "ruta": home}]
        for nombre, rel in (("Escritorio", "Desktop"), ("Documentos", "Documents"), ("Descargas", "Downloads")):
            r = os.path.realpath(os.path.join(home, rel))
            if dentro(home, r) and os.path.isdir(r):
                out.append({"nombre": nombre, "ruta": r})
        ofi = os.path.realpath(self.app.cfg["oficinas_dir"])
        if dentro(home, ofi) and os.path.isdir(ofi):
            out.append({"nombre": "Oficinas", "ruta": ofi})
        return out

    def _carpetas(self, q):
        home = self._home()
        real = self._resolver_en_home(q.get("ruta", "").strip())
        ocultas = q.get("ocultas", "") in ("1", "true")
        carpetas, truncado = [], False
        try:
            nombres = os.listdir(real)
        except OSError:
            raise ErrorAPI(403, "No tengo permiso para leer esa carpeta.")
        nombres.sort(key=lambda n: (n.lower(), n))
        for n in nombres:
            if not ocultas and n.startswith("."):
                continue
            p = os.path.join(real, n)
            try:
                if os.path.islink(p):
                    r = os.path.realpath(p)
                    if not dentro(home, r):
                        continue  # un enlace que sale de $HOME no se muestra
                if not os.path.isdir(p):
                    continue
                es_ofi = os.path.isfile(os.path.join(p, "oficina.json"))
            except OSError:
                continue
            if len(carpetas) >= MAX_ENTRADAS:
                truncado = True
                break
            carpetas.append({"nombre": n, "ruta": p, "esOficina": es_ofi})
        return {"ruta": real, "padre": None if real == home else os.path.dirname(real),
                "esOficina": os.path.isfile(os.path.join(real, "oficina.json")),
                "accesos": self._accesos(home), "carpetas": carpetas, "truncado": truncado}

    def _crear_carpeta(self, body):
        if not body or len(body) > 10000:
            raise ErrorAPI(400, "pedido inválido")
        try:
            d = json.loads(body)
        except ValueError:
            raise ErrorAPI(400, "pedido inválido")
        if not isinstance(d, dict) or not isinstance(d.get("padre"), str) or not isinstance(d.get("nombre"), str):
            raise ErrorAPI(400, "pedido inválido")
        padre = d["padre"].strip()
        if not padre:
            raise ErrorAPI(400, "Falta la carpeta donde crearla.")
        real = self._resolver_en_home(padre)
        nombre = nombre_saneado(d["nombre"])
        if not nombre or nombre in (".", ".."):
            raise ErrorAPI(400, "Ponele un nombre a la carpeta.")
        destino = os.path.join(real, nombre)
        if os.path.lexists(destino):
            raise ErrorAPI(409, "Ya existe algo con ese nombre.")
        try:
            os.mkdir(destino)
        except OSError:
            raise ErrorAPI(403, "No pude crear la carpeta ahí.")
        return {"ok": True, "nombre": nombre, "ruta": destino}

    # ---- carpeta de la oficina activa (solo lectura)

    def _resolver_en_oficina(self, rel):
        """(base, real, partes): `rel` es relativa a la oficina; sin `..`, sin ocultos (salvo .claude), sin salir por symlinks."""
        carpeta, _ = self.app.requerir_activa()
        base = os.path.realpath(carpeta)
        crudo = (rel or "").strip()
        rel = crudo.strip("/")
        if "\0" in rel or "\\" in rel or crudo.startswith("/"):
            raise ErrorAPI(403, "Esa ruta no está permitida.")
        partes = [p for p in rel.split("/") if p not in ("", ".")] if rel else []
        for i, p in enumerate(partes):
            if p == ".." or not parte_oculta_permitida(i, p):
                raise ErrorAPI(403, "Esa ruta no está permitida.")
        real = os.path.realpath(os.path.join(base, *partes)) if partes else base
        if not dentro(base, real):
            raise ErrorAPI(403, "Esa ruta no está permitida.")
        if not os.path.exists(real):
            raise ErrorAPI(404, "No encontré eso en la oficina.")
        return base, real, partes

    def _archivos(self, q):
        base, real, partes = self._resolver_en_oficina(q.get("ruta", ""))
        if not os.path.isdir(real):
            raise ErrorAPI(400, "Eso no es una carpeta.")
        try:
            nombres = os.listdir(real)
        except OSError:
            raise ErrorAPI(403, "No tengo permiso para leer esa carpeta.")
        filas, truncado = [], False
        for n in nombres:
            if not parte_oculta_permitida(len(partes), n):
                continue
            if partes == [".claude"] and n != "agents":
                continue
            p = os.path.join(real, n)
            try:
                r = os.path.realpath(p)
                if not dentro(base, r):
                    continue  # enlace que sale de la oficina
                st = os.stat(r)
            except OSError:
                continue
            es_dir = os.path.isdir(r)
            filas.append({"rel": "/".join(partes + [n]), "nombre": n, "esCarpeta": es_dir,
                          "tam": 0 if es_dir else st.st_size, "mod": int(st.st_mtime)})
        filas.sort(key=lambda f: (not f["esCarpeta"], f["nombre"].lower(), f["nombre"]))
        if len(filas) > MAX_ENTRADAS:
            filas, truncado = filas[:MAX_ENTRADAS], True
        return {"carpeta": base, "ruta": "/".join(partes), "archivos": filas, "truncado": truncado}

    def _archivo(self, q):
        base, real, partes = self._resolver_en_oficina(q.get("ruta", ""))
        if not partes:
            raise ErrorAPI(400, "Falta la ruta del archivo.")
        if not os.path.isfile(real):
            raise ErrorAPI(400, "Eso no es un archivo.")
        nombre = partes[-1]
        ext = nombre.rsplit(".", 1)[-1].lower() if "." in nombre else ""
        st = os.stat(real)
        out = {"rel": "/".join(partes), "nombre": nombre, "tam": st.st_size, "mod": int(st.st_mtime),
               "ruta": os.path.join(base, *partes)}
        try:
            if ext in EXT_TEXTO:
                with open(real, "rb") as f:
                    datos = f.read(MAX_TEXTO + 1)
                out["truncado"] = len(datos) > MAX_TEXTO
                out["texto"] = datos[:MAX_TEXTO].decode("utf-8", errors="replace")
            elif ext in EXT_IMAGEN:
                if st.st_size > MAX_IMAGEN:
                    raise ErrorAPI(413, "La imagen es demasiado grande para la vista previa (máximo 2 MB).")
                with open(real, "rb") as f:
                    out["base64"] = base64.b64encode(f.read()).decode("ascii")
                out["mime"] = EXT_IMAGEN[ext]
            else:
                out["sinVista"] = True
        except OSError:
            raise ErrorAPI(403, "No tengo permiso para leer ese archivo.")
        return out


def instalar(app, srv):
    """Engancha el explorador al App del servidor: `app.explorador`."""
    app.explorador = Explorador(app, srv)
    return app.explorador
