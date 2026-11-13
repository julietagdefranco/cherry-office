"""Tareas programadas por agente (modo desarrollo). Paridad con app/Sources/Backend/{Tareas,Programador,TareasRouter}.swift:
mismo modelo en `oficina.json` (`tareas`), misma lógica de horarios, misma tabla `ejecuciones` y mismas rutas.

Cada tarea corre como un chat del agente (`App._chat_correr`), en una sesión nueva, con su carril, sus permisos y su costo
(origen «tarea», ref = id de la tarea). Un hilo revisa la oficina activa cada 30 s.

Las funciones de horarios (`proxima`, `anterior`, `debe_correr`) son puras: reciben `ahora`/`desde` (epoch) y la zona del
sistema. Reglas: corre en el horario de su zona en los días marcados (1 = lunes … 7 = domingo); si la app estuvo cerrada o
dormida se pone al día UNA vez si pasaron menos de 12 h; nunca dos veces la misma programada; DST correcto (hora de pared).
"""
import datetime
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
import zoneinfo

import hq_core
import hq_vivo
import hq_entregas

# Las corridas únicas que salen de un pendiente de reunión («Hacelo ahora») usan `encargo:<reunión>:<n>` como tarea.
PREFIJO_ENCARGO = "encargo:"
from hq_core import ErrorAPI

log = logging.getLogger("hq")

VENTANA_PUESTA_AL_DIA = 12 * 3600
MAX_RESULTADO = 2000
MAX_BODY = 200_000

# ----------------------------------------------------------------------------- lógica pura


def zona_sistema():
    """Nombre IANA de la zona del sistema (TZ, /etc/localtime), o UTC si no se puede saber."""
    tz = os.environ.get("TZ")
    if tz and hq_core.zona_valida(tz):
        return tz
    try:
        destino = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in destino:
            nombre = destino.split("zoneinfo/", 1)[1]
            if hq_core.zona_valida(nombre):
                return nombre
    except OSError:
        pass
    return "UTC"


def zona_de(t, sistema=None):
    z = t.get("zona")
    if not (isinstance(z, str) and hq_core.zona_valida(z)):
        z = sistema or zona_sistema()
    return zoneinfo.ZoneInfo(z)


def iso(ts):
    """ISO 8601 UTC con segundos (`2026-11-13T11:00:00Z`)."""
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_ms(ts):
    """ISO 8601 UTC con milésimas (como las demás fechas de la API: `2026-11-13T11:00:00.000Z`)."""
    d = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def fecha(s):
    """ISO 8601 -> epoch, o None."""
    if not isinstance(s, str):
        return None
    try:
        d = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.timestamp()


def fecha_inicio(t):
    """Instante a partir del cual cuenta la tarea (el más reciente entre `creada` y `desde`)."""
    fs = [f for f in (fecha(t.get("creada")), fecha(t.get("desde"))) if f is not None]
    return max(fs) if fs else None


def _horario(t, dia, zona):
    """El horario de la tarea en el día local `dia`. Si la hora no existe ese día (salto de DST) se corre hacia adelante;
    si existe dos veces, toma la primera."""
    h, m = hq_core.hora_minuto(t["hora"])
    return datetime.datetime(dia.year, dia.month, dia.day, h, m, tzinfo=zona).timestamp()


def proxima(t, desde, sistema=None):
    """Próxima corrida estrictamente posterior a `desde` (epoch), o None."""
    if hq_core.hora_minuto(t.get("hora")) is None:
        return None
    zona = zona_de(t, sistema)
    d0 = datetime.datetime.fromtimestamp(desde, zona).date()
    for i in range(9):
        d = d0 + datetime.timedelta(days=i)
        if d.isoweekday() in t.get("dias", []):
            c = _horario(t, d, zona)
            if c > desde:
                return c
    return None


def anterior(t, hasta, sistema=None):
    """Último horario marcado que ya pasó (<= `hasta`), buscando hasta una semana atrás."""
    if hq_core.hora_minuto(t.get("hora")) is None:
        return None
    zona = zona_de(t, sistema)
    d0 = datetime.datetime.fromtimestamp(hasta, zona).date()
    for i in range(9):
        d = d0 - datetime.timedelta(days=i)
        if d.isoweekday() in t.get("dias", []):
            c = _horario(t, d, zona)
            if c <= hasta:
                return c
    return None


def debe_correr(t, ahora, ultima_programada, sistema=None):
    """El horario programado que hay que correr ahora (epoch), o None.
    Corre el último horario marcado que ya pasó, salvo que: ya se corrió ese (o uno posterior) -> nunca dos veces; pasaron 12 h
    o más (se pierde); es anterior a la creación de la tarea o a su último cambio de horario."""
    if not t.get("activa", True):
        return None
    p = anterior(t, ahora, sistema)
    if p is None:
        return None
    if ultima_programada is not None and ultima_programada >= p:
        return None
    if ahora - p >= VENTANA_PUESTA_AL_DIA:
        return None
    inicio = fecha_inicio(t)
    if inicio is not None and inicio > p:
        return None
    return p


# ----------------------------------------------------------------------------- modelo

def vista_tarea(t, sistema=None):
    """JSON de la API de una tarea (la zona siempre viene resuelta; sin el campo interno `desde`)."""
    o = {"id": t["id"], "agente": t["agente"], "nombre": t["nombre"], "consigna": t["consigna"], "dias": t["dias"],
         "hora": t["hora"], "zona": t.get("zona") or sistema or zona_sistema(), "activa": t.get("activa", True)}
    if t.get("creada"):
        o["creada"] = t["creada"]
    return o


def _dias(v):
    if not isinstance(v, list) or not v:
        raise ErrorAPI(400, "Elegí al menos un día (números del 1, lunes, al 7, domingo).")
    out = []
    for x in v:
        if type(x) is not int or not 1 <= x <= 7 or x in out:
            raise ErrorAPI(400, "Los días tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir.")
        out.append(x)
    return sorted(out)


def _hora(v):
    h = hq_core.texto(v, "hora", 5)
    if hq_core.hora_minuto(h) is None:
        raise ErrorAPI(400, "La hora tiene que ser HH:MM (por ejemplo 08:00).")
    return h


def _zona(v):
    z = hq_core.texto(v, "zona", 64, False)
    if z is None:
        return None
    if not hq_core.zona_valida(z):
        raise ErrorAPI(400, "No conozco esa zona horaria (usá, por ejemplo, America/Argentina/Buenos_Aires).")
    return z


def _activa(v):
    if v is None:
        return None
    if not isinstance(v, bool):
        raise ErrorAPI(400, "«activa» tiene que ser verdadero o falso.")
    return v


# ----------------------------------------------------------------------------- SQLite

SCHEMA = """
CREATE TABLE IF NOT EXISTS ejecuciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oficina TEXT NOT NULL,
    tarea TEXT NOT NULL,
    agente TEXT NOT NULL,
    programada REAL NOT NULL,
    inicio REAL NOT NULL,
    fin REAL,
    estado TEXT NOT NULL,
    sid TEXT NOT NULL DEFAULT '',
    resultado TEXT NOT NULL DEFAULT '',
    error TEXT,
    costo REAL,
    manual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ejecuciones_tarea ON ejecuciones(oficina, tarea, id);
"""
COLUMNAS = "id,oficina,tarea,agente,programada,inicio,fin,estado,sid,resultado,error,costo,manual"


def ejecucion_json(r):
    return {"id": r[0], "tarea": r[2], "agente": r[3], "programada": iso_ms(r[4]), "inicio": iso_ms(r[5]),
            "fin": iso_ms(r[6]) if r[6] is not None else None, "estado": r[7], "sid": r[8], "resultado": r[9],
            "error": r[10], "costo": r[11], "manual": bool(r[12])}


def es_ruta(path):
    return path == "/api/tareas" or path.startswith("/api/tareas/")


class Tareas:
    """Programador y rutas `/api/tareas*`. `app.tareas(metodo, path, query, body) -> (status, dict) | None`."""

    def __init__(self, app, srv, env=None, reloj=time.time, sistema=None):
        env = os.environ if env is None else env
        self.app = app
        self.srv = srv  # módulo server
        self.path = app.db.path
        self.reloj = reloj
        self.sistema = sistema or zona_sistema()
        self.mut = threading.RLock()
        self.corriendo = {}  # (oficina, tarea) -> hilo
        self._parar = threading.Event()
        self._hilo = None
        self.automatico = env.get("HQ_PROGRAMADOR") != "0"
        try:
            self.intervalo = float(env.get("HQ_PROGRAMADOR_INTERVALO", 30))
            if not self.intervalo > 0:
                raise ValueError
        except (TypeError, ValueError):
            self.intervalo = 30.0
        # Hook para avisos y notificaciones: se llama con el dict de la ejecución cuando termina (ok o error), ya guardada.
        # Por defecto no hace nada. Se llama también en «Probar ahora». Corre en el hilo de la ejecución, después de soltar
        # el carril del agente.
        self.al_terminar = lambda ejecucion: None
        with self._con() as c:
            c.executescript(SCHEMA)
            c.execute("UPDATE ejecuciones SET estado='error', error=?, fin=? WHERE estado='corriendo'",
                      ("Interrumpida: la app se cerró mientras corría.", time.time()))

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
                    return cur.lastrowid if sql.lstrip().upper().startswith("INSERT") else cur.rowcount
                return cur.fetchone() if uno else cur.fetchall()
        finally:
            c.close()

    def _ejecuciones(self, oficina, tarea, limite=20):
        return self._sql("SELECT %s FROM ejecuciones WHERE oficina=? AND tarea=? ORDER BY id DESC LIMIT ?" % COLUMNAS,
                         (oficina, tarea, limite))

    def _ultima_programada(self, oficina, tarea):
        r = self._sql("SELECT MAX(programada) FROM ejecuciones WHERE oficina=? AND tarea=? AND manual=0", (oficina, tarea), uno=True)
        return r[0] if r else None

    # ---- ciclo de vida

    def iniciar(self):
        """Arranca el hilo de revisión (cada 30 s). Idempotente."""
        if not self.automatico or self._hilo is not None or self._parar.is_set():
            return
        self._hilo = threading.Thread(target=self._bucle, daemon=True, name="hq-tareas")
        self._hilo.start()

    def detener(self):
        self._parar.set()

    def _bucle(self):
        while not self._parar.is_set():
            try:
                self.revisar()
            except Exception:
                log.exception("tareas: falló la revisión")
            self._parar.wait(self.intervalo)

    def esta_corriendo(self, carpeta, tarea):
        with self.mut:
            return (carpeta, tarea) in self.corriendo

    def esperar(self, limite=5.0):
        """Espera a que terminen las corridas en curso (tests, cierre)."""
        fin = time.time() + limite
        for h in list(self.corriendo.values()):
            if h is not None:
                h.join(max(0.0, fin - time.time()))

    # ---- revisión

    def revisar(self):
        """Una vuelta: corre las tareas activas de la oficina activa que tocan según `debe_correr`."""
        a = self.app.activa()
        if a is None:
            return
        carpeta, o = a
        ahora = self.reloj()
        for t in o.get("tareas") or []:
            if not t.get("activa", True) or self.esta_corriendo(carpeta, t["id"]):
                continue
            definicion = next((x for x in o["agentes"] if x["id"] == t["agente"]), None)
            if definicion is None:
                continue
            p = debe_correr(t, ahora, self._ultima_programada(carpeta, t["id"]), self.sistema)
            if p is None:
                continue
            try:
                self._lanzar(carpeta, o, t, definicion, p, False)
                log.info("tarea %s agente=%s programada=%s", t["id"], definicion["id"], iso(p))
            except ErrorAPI:
                pass

    def _lanzar(self, carpeta, o, t, definicion, programada, manual):
        clave = (carpeta, t["id"])
        with self.mut:
            if clave in self.corriendo:
                raise ErrorAPI(409, "Esa tarea ya se está corriendo.")
            self.corriendo[clave] = None
        sid = str(uuid.uuid4())
        inicio = time.time()
        try:
            id_ = self._sql("INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) "
                            "VALUES(?,?,?,?,?,'corriendo',?,?)",
                            (carpeta, t["id"], definicion["id"], programada, inicio, sid, 1 if manual else 0), escribir=True)
        except sqlite3.Error:
            with self.mut:
                self.corriendo.pop(clave, None)
            raise ErrorAPI(500, "No pude guardar la ejecución.")
        hilo = threading.Thread(target=self._correr, args=(id_, carpeta, o, dict(t), definicion, sid), daemon=True)
        with self.mut:
            self.corriendo[clave] = hilo
        hilo.start()
        return ejecucion_json(self._sql("SELECT %s FROM ejecuciones WHERE id=?" % COLUMNAS, (id_,), uno=True))

    def _correr(self, id_, carpeta, o, t, definicion, sid):
        """Lo mismo que `App.chat`: carril del agente, permisos de la oficina, actividad (origen «tarea») y costo (origen
        «tarea», ref = id de la tarea), en una sesión nueva donde quedan el pedido y la respuesta como un chat más."""
        app, agente = self.app, definicion["id"]
        caja = hq_vivo.CajaCosto()
        escritos = hq_entregas.CajaArchivos()
        estado, texto, error = "ok", "", None
        try:
            with app._lock(carpeta, agente):
                app.db.asegurar_sesion(sid, agente, carpeta)
                app.db.agregar(sid, agente, "u", t["consigna"])
                with app.actividad.seguir(carpeta, agente, "tarea", t["nombre"],
                                          extra=caja.observador(escritos.observador())) as (obs, _tok):
                    code, obj = app._chat_correr(carpeta, definicion, t["consigna"], sid, o, obs, time.time())
            if code == 200:
                texto = obj.get("reply") or "(sin respuesta)"
            else:
                estado, error = "error", obj.get("error") or "No pude correr la tarea."
        except Exception:
            log.exception("tarea %s: falló la corrida", t["id"])
            estado, error = "error", "No pude correr la tarea."
        finally:
            try:
                app.costos.registrar(carpeta, "tarea", caja.valor, agente, t["id"])
                self._sql("UPDATE ejecuciones SET estado=?, fin=?, resultado=?, error=?, costo=? WHERE id=?",
                          (estado, time.time(), texto[:MAX_RESULTADO], error, caja.valor, id_), escribir=True)
            except Exception:
                log.exception("tarea %s: no pude guardar el resultado", t["id"])
            log.info("tarea %s agente=%s estado=%s", t["id"], agente, estado)
            if estado == "ok" and getattr(app, "entregas", None):
                try:
                    app.entregas.crear(carpeta, agente, "encargo" if t["id"].startswith(PREFIJO_ENCARGO) else "tarea", t["id"],
                                       t["nombre"], texto, sid, hq_entregas.relativos(escritos.valor, carpeta), costo=caja.valor)
                except Exception:
                    log.exception("tarea %s: no pude guardar la entrega", t["id"])
            with self.mut:
                self.corriendo.pop((carpeta, t["id"]), None)
        try:
            fila = self._sql("SELECT %s FROM ejecuciones WHERE id=?" % COLUMNAS, (id_,), uno=True)
            if fila:
                self.al_terminar(ejecucion_json(fila))
        except Exception:
            log.exception("tarea %s: falló al_terminar", t["id"])

    def correr_ahora(self, carpeta, o, t):
        definicion = next((x for x in o["agentes"] if x["id"] == t["agente"]), None)
        if definicion is None:
            raise ErrorAPI(409, "El agente de esta tarea ya no está en la oficina.")
        if not self.app.claude:
            raise ErrorAPI(500, "No encontré Claude Code en esta compu.")
        if not os.path.isdir(carpeta):
            raise ErrorAPI(500, "No encuentro la carpeta del proyecto (%s)." % carpeta)
        return self._lanzar(carpeta, o, t, definicion, time.time(), True)

    # ---- rutas

    def __call__(self, metodo, path, query, body):
        if not es_ruta(path):
            return None
        no = (405, {"error": "método no permitido"})
        partes = path.split("/")[1:]
        if len(partes) < 2 or len(partes) > 4 or "" in partes:
            return 404, {"error": "no"}
        try:
            if len(partes) == 2:
                if metodo == "GET":
                    return self._listar()
                return self._crear(self._objeto(body)) if metodo == "POST" else no
            id_ = partes[2]
            if not hq_core.slug_valido(id_):
                return 404, {"error": "no"}
            if len(partes) == 3:
                if metodo == "GET":
                    return self._ver(id_)
                if metodo == "PATCH":
                    return self._editar(id_, self._objeto(body))
                return self._borrar(id_) if metodo == "DELETE" else no
            if partes[3] == "correr":
                return self._correr_ruta(id_) if metodo == "POST" else no
            if partes[3] == "ejecuciones":
                return self._ver_ejecuciones(id_) if metodo == "GET" else no
            return 404, {"error": "no"}
        except ErrorAPI as e:
            return e.status, {"error": e.mensaje}

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

    def _vista(self, carpeta, o, t, ahora):
        v = vista_tarea(t, self.sistema)
        existe = any(a["id"] == t["agente"] for a in o["agentes"])
        p = proxima(t, ahora, self.sistema) if (t.get("activa", True) and existe) else None
        v["proxima"] = iso(p) if p is not None else None
        ult = self._ejecuciones(carpeta, t["id"], 1)
        v["ultima"] = ejecucion_json(ult[0]) if ult else None
        v["corriendo"] = self.esta_corriendo(carpeta, t["id"])
        return v

    @staticmethod
    def _buscar(o, id_):
        t = next((x for x in o.get("tareas") or [] if x["id"] == id_), None)
        if t is None:
            raise ErrorAPI(404, "No existe esa tarea.")
        return t

    def _listar(self):
        carpeta, o = self.app.requerir_activa()
        ahora = self.reloj()
        return 200, {"tareas": [self._vista(carpeta, o, t, ahora) for t in o.get("tareas") or []]}

    def _ver(self, id_):
        carpeta, o = self.app.requerir_activa()
        return 200, {"tarea": self._vista(carpeta, o, self._buscar(o, id_), self.reloj())}

    def _guardar(self, carpeta, o):
        if not o.get("tareas"):
            o.pop("tareas", None)
        hq_core.escribir_oficina(o, carpeta)

    def _crear(self, d):
        agente = hq_core.texto(d.get("agente"), "agente", 41)
        nombre = hq_core.texto(d.get("nombre"), "nombre", hq_core.MAX_NOMBRE_TAREA)
        consigna = hq_core.texto(d.get("consigna"), "consigna", hq_core.MAX_CONSIGNA)
        dias, hora = _dias(d.get("dias")), _hora(d.get("hora"))
        zona = _zona(d.get("zona")) or self.sistema
        activa = _activa(d.get("activa"))
        activa = True if activa is None else activa
        pedido = hq_core.texto(d.get("id"), "id", 41, False)
        if pedido is not None and not hq_core.slug_valido(pedido):
            raise ErrorAPI(400, "Id de tarea inválido (usá minúsculas, números y guiones).")
        ahora = iso(self.reloj())
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            if not any(a["id"] == agente for a in o["agentes"]):
                raise ErrorAPI(404, "No existe ese agente.")
            ts = o.get("tareas") or []
            if len(ts) >= hq_core.MAX_TAREAS:
                raise ErrorAPI(400, "Máximo %d tareas programadas." % hq_core.MAX_TAREAS)
            usados = {t["id"] for t in ts}
            if pedido is not None and pedido in usados:
                raise ErrorAPI(409, "Ya hay una tarea con ese id.")
            id_ = pedido or hq_core.slug_unico(nombre, usados, "tarea")
            t = {"id": id_, "agente": agente, "nombre": nombre, "consigna": consigna, "dias": dias, "hora": hora, "zona": zona,
                 "activa": activa, "creada": ahora, "desde": ahora}
            o["tareas"] = ts + [t]
            self._guardar(carpeta, o)
        return 200, {"tarea": self._vista(carpeta, o, t, self.reloj())}

    def _editar(self, id_, d):
        nombre = hq_core.texto(d.get("nombre"), "nombre", hq_core.MAX_NOMBRE_TAREA, False)
        consigna = hq_core.texto(d.get("consigna"), "consigna", hq_core.MAX_CONSIGNA, False)
        dias = _dias(d.get("dias")) if d.get("dias") is not None else None
        hora = _hora(d.get("hora")) if d.get("hora") is not None else None
        zona = _zona(d.get("zona"))
        activa = _activa(d.get("activa"))
        ahora = iso(self.reloj())
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            t = self._buscar(o, id_)
            cambio = False
            if nombre is not None:
                t["nombre"] = nombre
            if consigna is not None:
                t["consigna"] = consigna
            if dias is not None and dias != t["dias"]:
                t["dias"], cambio = dias, True
            if hora is not None and hora != t["hora"]:
                t["hora"], cambio = hora, True
            if zona is not None and zona != t.get("zona"):
                t["zona"], cambio = zona, True
            if activa is not None:
                if activa and not t.get("activa", True):
                    if not any(a["id"] == t["agente"] for a in o["agentes"]):
                        raise ErrorAPI(409, "El agente de esta tarea ya no está en la oficina.")
                    cambio = True
                t["activa"] = activa
            if cambio:  # una tarea movida o reactivada no se pone al día con el horario que ya pasó hoy
                t["desde"] = ahora
            self._guardar(carpeta, o)
        return 200, {"tarea": self._vista(carpeta, o, t, self.reloj())}

    def _borrar(self, id_):
        with self.app.mut:
            carpeta, o = self.app.requerir_activa()
            self._buscar(o, id_)
            if self.esta_corriendo(carpeta, id_):
                raise ErrorAPI(409, "La tarea está corriendo ahora. Esperá a que termine para borrarla.")
            o["tareas"] = [t for t in o["tareas"] if t["id"] != id_]
            self._guardar(carpeta, o)
        self._sql("DELETE FROM ejecuciones WHERE oficina=? AND tarea=?", (carpeta, id_), escribir=True)
        return 200, {"ok": True}

    def _correr_ruta(self, id_):
        carpeta, o = self.app.requerir_activa()
        t = self._buscar(o, id_)
        return 202, {"ejecucion": self.correr_ahora(carpeta, o, t)}

    def _ver_ejecuciones(self, id_):
        carpeta, o = self.app.requerir_activa()
        self._buscar(o, id_)
        return 200, {"ejecuciones": [ejecucion_json(r) for r in self._ejecuciones(carpeta, id_, 20)]}


def instalar(app, srv):
    """Engancha las tareas al App del servidor: `app.tareas`. El hilo programador se arranca aparte (`app.tareas.iniciar()`)."""
    app.tareas = Tareas(app, srv)
    return app.tareas
