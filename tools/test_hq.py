"""Smoke tests del modo desarrollo (Python, solo librería estándar). Correr con:

    python3 tools/test_hq.py

Usan un `claude` falso (bash) y llaman a `App.api` / `App.vivo` directo, sin levantar HTTP.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
sys.path.insert(0, os.path.join(os.path.dirname(AQUI), "oficina"))

import hq_core  # noqa: E402
import hq_tareas  # noqa: E402
import hq_vivo  # noqa: E402

CLAUDE_FALSO = r"""#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
if [[ "$1" == "auth" ]]; then exit 0; fi
agent=""; prev=""
for a in "$@"; do
  if [[ "$prev" == "--agent" ]]; then agent="$a"; fi
  prev="$a"
done
msg="${@: -1}"
{ printf '%s\x1f' "$@"; printf '\x1e'; } >> "$D/args.log"
if [[ "$msg" == *ISERR* ]]; then echo '{"type":"result","result":"fallo raro","is_error":true}'; exit 0; fi
if [[ "$msg" == *STREAM* ]]; then
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-$agent\"}"
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x/conocimiento/oficina.md"}}]}}'
  if [[ "$msg" == *PAUSA* ]]; then n=0; while [[ ! -f "$D/go" && $n -lt 200 ]]; do sleep 0.05; n=$((n+1)); done; fi
  echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"secreto"}]}}'
  echo "{\"type\":\"result\",\"result\":\"stream $agent\",\"is_error\":false,\"total_cost_usd\":0.25}"
  exit 0
fi
echo "{\"type\":\"result\",\"result\":\"hola $agent\",\"is_error\":false,\"total_cost_usd\":0.01}"
"""


class VivoUnit(unittest.TestCase):
    def test_parsear(self):
        self.assertEqual(hq_vivo.parsear_linea('{"type":"system","subtype":"hook_started"}'), [])
        self.assertEqual(hq_vivo.parsear_linea("no json"), [])
        self.assertEqual(hq_vivo.parsear_linea('{"type":"system","subtype":"init","session_id":"a"}'), [("inicio", "a")])
        l = ('{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"tool_use","name":"Read",'
             '"input":{"file_path":"/a/b/informe.md"}},{"type":"text","text":"x"}]}}')
        self.assertEqual(hq_vivo.parsear_linea(l), [("pensando",), ("herramienta", "Read", "informe.md"), ("texto",)])
        self.assertEqual(hq_vivo.parsear_linea('{"type":"result","is_error":false,"total_cost_usd":0.5}'),
                         [("resultado", 0.5, False)])
        self.assertEqual(len(hq_vivo.objetivo("Grep", {"pattern": "a" * 200})), 60)

    def test_ultimo_json(self):
        so = '{"type":"system"}\n{"type":"result","result":"ok"}\n'
        self.assertEqual(hq_vivo.ultimo_json(so)["result"], "ok")
        self.assertIsNone(hq_vivo.ultimo_json("nada"))

    def test_actividad(self):
        a = hq_vivo.Actividad(reloj=lambda: 1000.0)
        self.assertEqual(hq_vivo.estado_herramienta("Edit"), "escribiendo")
        self.assertEqual(hq_vivo.estado_herramienta("mcp__hq__consultar"), "consultando")
        t1 = a.empezar("/o", "marce", "chat", "x" * 100)
        self.assertEqual(len(a.vista("/o")["marce"]["tarea"]), 48)
        a.aplicar("/o", "marce", t1, ("herramienta", "Write", "plan.md"))
        self.assertEqual(a.vista("/o")["marce"]["estado"], "escribiendo")
        t2 = a.empezar("/o", "marce", "consulta")
        self.assertEqual(a.vista("/o")["marce"]["origen"], "consulta")
        a.terminar("/o", "marce", t2)
        a.terminar("/o", "marce", t1)
        self.assertEqual(a.vista("/o"), {})

    def test_costos(self):
        d = tempfile.mkdtemp()
        try:
            c = hq_vivo.Costos(os.path.join(d, "hq.db"))
            c.registrar("/o", "chat", 0.25, "marce", "s1")
            c.registrar("/o", "reunion", 0.1, "betty", "r1")
            c.registrar("/o", "sintesis", 0.05, ref="r1")
            c.registrar("/o", "chat", None, "marce")
            c.registrar("/otra", "chat", 9, "x")
            t = c.totales("/o")
            self.assertAlmostEqual(t["total"], 0.4)
            self.assertAlmostEqual(t["agentes"]["marce"], 0.25)
            self.assertAlmostEqual(t["reuniones"]["r1"], 0.15)
        finally:
            shutil.rmtree(d)


class BaseAPI(unittest.TestCase):
    """App con un claude falso, una oficina «Taller» y a Marce contratada (sin HTTP: se llama a `App.api` directo)."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.bin = os.path.join(self.d, "bin")
        os.makedirs(self.bin)
        claude = os.path.join(self.bin, "claude")
        with open(claude, "w") as f:
            f.write(CLAUDE_FALSO)
        os.chmod(claude, 0o755)
        env = {"CLAUDE_BIN": claude, "HQ_PROYECTO": self.d, "HQ_DIR_EXTRA": "", "HQ_OFICINAS_DIR": os.path.join(self.d, "of"),
               "HQ_CONFIG": os.path.join(self.d, "no-existe.json"), "PORT": "0", "HOME": self.d}
        import server
        self.server = server
        cfg = server.cargar_config(env=env)
        cfg["datos_dir"] = os.path.join(self.d, "datos")
        self.app = server.App(cfg, sesiones_json=os.path.join(self.d, "no.json"))
        hq = self.app

        def llamar(m, p, body=None):
            return hq.api(m, p, {}, json.dumps(body).encode() if body is not None else None)
        self.llamar = llamar
        st, r = llamar("POST", "/api/oficinas", {"nombre": "Taller", "duenio": "Ana"})
        self.assertEqual(st, 200, r)
        st, r = llamar("POST", "/api/agentes", {"id": "marce", "nombre": "Marce", "rol": "Directora", "prompt": "Sos Marce.",
                                                 "departamento": "direccion"})
        self.assertEqual(st, 200, r)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)


class VivoAPI(BaseAPI):
    def test_chat_en_vivo_y_costo(self):
        res = {}
        sid = "11111111-1111-4111-8111-111111111111"
        t = threading.Thread(target=lambda: res.update(r=self.llamar(
            "POST", "/api/chat", {"agent": "marce", "message": "STREAM PAUSA armame el plan", "session": sid})))
        t.start()
        visto = None
        for _ in range(100):
            st, a = self.app.vivo("GET", "/api/actividad", {})
            m = a["agentes"].get("marce")
            if m and m.get("estado") == "leyendo":
                visto = m
                break
            time.sleep(0.05)
        self.assertIsNotNone(visto, "la actividad no mostró la lectura")
        self.assertEqual(visto["objetivo"], "oficina.md")
        self.assertTrue(visto["tarea"].startswith("STREAM PAUSA"))
        self.assertNotIn("secreto", json.dumps(a))
        open(os.path.join(self.bin, "go"), "w").close()
        t.join(10)
        st, r = res["r"]
        self.assertEqual((st, r.get("reply")), (200, "stream marce"))
        self.assertEqual(self.app.vivo("GET", "/api/actividad", {})[1]["agentes"], {})
        st, c = self.app.vivo("GET", "/api/costos", {})
        self.assertAlmostEqual(c["total"], 0.25)
        self.assertAlmostEqual(c["agentes"]["marce"], 0.25)
        with open(os.path.join(self.bin, "args.log")) as f:
            args = f.read().split("\x1e")[-2].split("\x1f")
        self.assertIn("stream-json", args)
        self.assertIn("--verbose", args)


BA = "America/Argentina/Buenos_Aires"
NY = "America/New_York"


def f(s):
    return hq_tareas.fecha(s)


def tarea(dias=(1, 2, 3, 4, 5), hora="08:00", zona=BA, activa=True, creada=None, desde=None):
    t = {"id": "informe", "agente": "marce", "nombre": "Informe", "consigna": "Armá el informe", "dias": list(dias),
         "hora": hora, "activa": activa}
    if zona:
        t["zona"] = zona
    if creada:
        t["creada"] = creada
    if desde:
        t["desde"] = desde
    return t


class TareasUnit(unittest.TestCase):
    """Lógica pura de horarios (paridad con ProgramacionTests de Swift). 2026-11-13 es viernes."""

    def test_es_ruta(self):
        for p in ("/api/tareas", "/api/tareas/x", "/api/tareas/x/correr"):
            self.assertTrue(hq_tareas.es_ruta(p))
        for p in ("/api/tarea", "/api/tareasx", "/api/agentes"):
            self.assertFalse(hq_tareas.es_ruta(p))

    def test_proxima(self):
        t = tarea()
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-13T07:00:00-03:00"), "UTC"), f("2026-11-13T08:00:00-03:00"))
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-13T08:00:00-03:00"), "UTC"), f("2026-11-16T08:00:00-03:00"))
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-14T09:00:00-03:00"), "UTC"), f("2026-11-16T08:00:00-03:00"))
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-13T00:00:00Z"), "UTC"), f("2026-11-13T11:00:00Z"))

    def test_dias_iso(self):
        d = f("2026-11-13T07:00:00-03:00")
        self.assertEqual(hq_tareas.proxima(tarea(dias=[7]), d), f("2026-11-15T08:00:00-03:00"))
        self.assertEqual(hq_tareas.proxima(tarea(dias=[1]), d), f("2026-11-16T08:00:00-03:00"))
        self.assertEqual(hq_tareas.proxima(tarea(dias=[6, 7]), d), f("2026-11-14T08:00:00-03:00"))
        self.assertIsNone(hq_tareas.proxima(tarea(dias=[]), d))

    def test_zona_del_sistema(self):
        t = tarea(zona=None)
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-13T00:00:00Z"), NY), f("2026-11-13T08:00:00-05:00"))
        self.assertEqual(hq_tareas.proxima(t, f("2026-11-13T00:00:00Z"), "UTC"), f("2026-11-13T08:00:00Z"))

    def test_dst(self):
        t = tarea(dias=range(1, 8), hora="09:00", zona=NY)
        sab = f("2026-03-07T09:00:00-05:00")
        dom = hq_tareas.proxima(t, sab, "UTC")
        self.assertEqual(dom, f("2026-03-08T09:00:00-04:00"))
        self.assertEqual(dom - sab, 23 * 3600)
        sab2 = f("2026-10-31T09:00:00-04:00")
        dom2 = hq_tareas.proxima(t, sab2, "UTC")
        self.assertEqual(dom2, f("2026-11-01T09:00:00-05:00"))
        self.assertEqual(dom2 - sab2, 25 * 3600)

    def test_dst_hora_inexistente(self):
        t = tarea(dias=range(1, 8), hora="02:30", zona=NY)
        p = hq_tareas.proxima(t, f("2026-03-08T00:00:00-05:00"), "UTC")
        self.assertEqual(p, f("2026-03-08T03:30:00-04:00"))
        self.assertEqual(hq_tareas.proxima(t, p, "UTC"), f("2026-03-09T02:30:00-04:00"))

    def test_debe_correr(self):
        t, vie8 = tarea(), f("2026-11-13T08:00:00-03:00")

        def dc(ahora, ult=None, tt=None):
            return hq_tareas.debe_correr(tt or t, f(ahora), ult, "UTC")
        self.assertIsNone(dc("2026-11-13T07:59:00-03:00"))
        self.assertEqual(dc("2026-11-13T08:00:10-03:00"), vie8)
        self.assertIsNone(dc("2026-11-13T08:00:40-03:00", vie8))      # nunca dos veces
        self.assertIsNone(dc("2026-11-13T15:00:00-03:00", vie8))
        self.assertIsNone(dc("2026-11-14T09:00:00-03:00", vie8))      # fin de semana
        self.assertIsNone(dc("2026-11-15T09:00:00-03:00"))
        self.assertIsNone(dc("2026-11-13T08:00:10-03:00", tt=tarea(activa=False)))

    def test_puesta_al_dia(self):
        t, vie8, jue8 = tarea(), f("2026-11-13T08:00:00-03:00"), f("2026-11-12T08:00:00-03:00")

        def dc(ahora, ult, tt=None):
            return hq_tareas.debe_correr(tt or t, f(ahora), ult, "UTC")
        self.assertEqual(dc("2026-11-13T19:59:00-03:00", jue8), vie8)
        self.assertIsNone(dc("2026-11-13T20:00:00-03:00", jue8))
        self.assertIsNone(dc("2026-11-13T20:01:00-03:00", jue8))
        self.assertEqual(dc("2026-11-13T09:00:00-03:00", f("2026-11-11T08:00:00-03:00")), vie8)
        noche = tarea(dias=range(1, 8), hora="23:00")
        self.assertEqual(dc("2026-11-14T05:00:00-03:00", None, noche), f("2026-11-13T23:00:00-03:00"))

    def test_nueva_no_se_pone_al_dia(self):
        ahora = f("2026-11-13T10:00:00-03:00")

        def dc(tt):
            return hq_tareas.debe_correr(tt, ahora, None, "UTC")
        self.assertEqual(dc(tarea()), f("2026-11-13T08:00:00-03:00"))
        self.assertIsNone(dc(tarea(creada="2026-11-13T12:50:00Z")))
        self.assertIsNone(dc(tarea(creada="2026-11-01T00:00:00Z", desde="2026-11-13T12:50:00Z")))
        self.assertIsNotNone(dc(tarea(creada="2026-11-12T00:00:00Z")))

    def test_simulacion(self):
        for zona, dia in [(BA, "2026-11-13"), (NY, "2026-03-08"), (NY, "2026-11-01")]:
            t = tarea(dias=range(1, 8), hora="09:00", zona=zona)
            cuando = f(dia + "T00:00:00Z") - 3600 * 12
            fin = cuando + 3 * 86400
            ultima, corridas = None, []
            while cuando < fin:
                p = hq_tareas.debe_correr(t, cuando, ultima, "UTC")
                if p is not None:
                    corridas.append(p)
                    ultima = p
                cuando += 30
            self.assertIn(len(corridas), (3, 4), (zona, dia))
            self.assertEqual(len(set(corridas)), len(corridas))

    def test_validacion(self):
        def of(ts):
            return {"version": 1, "nombre": "O", "departamentos": [{"id": "d", "nombre": "D", "color": "#aaaaaa"}],
                    "agentes": [{"id": "marce", "nombre": "M", "rol": "r", "departamento": "d"}], "tareas": ts}

        def malo(t, m=""):
            with self.assertRaises(hq_core.ErrorAPI, msg=m):
                hq_core.validar_oficina(of([t]))
        hq_core.validar_oficina(of([tarea()]))
        hq_core.validar_oficina(of([]))
        for hora in ("8:00", "24:00", "08:60", "", None, 800):
            malo(dict(tarea(), hora=hora), "hora %r" % (hora,))
        for dias in ([], [0], [8], [1, 1], "1", [True], None):
            malo(dict(tarea(), dias=dias), "dias %r" % (dias,))
        malo(tarea(zona="Marte/Base"))
        malo(dict(tarea(), consigna="  "))
        malo(dict(tarea(), consigna="x" * 4001))
        malo(dict(tarea(), id="Mal Id"))
        malo(dict(tarea(), agente="nadie"))
        hq_core.validar_oficina(of([dict(tarea(), agente="nadie", activa=False)]))
        with self.assertRaises(hq_core.ErrorAPI):
            hq_core.validar_oficina(of([tarea(), tarea()]))
        muchas = [dict(tarea(), id="t%d" % i) for i in range(51)]
        with self.assertRaises(hq_core.ErrorAPI):
            hq_core.validar_oficina(of(muchas))
        hq_core.validar_oficina(of(muchas[:50]))


class TareasAPI(BaseAPI):
    def setUp(self):
        super().setUp()
        self.llamar("POST", "/api/agentes", {"id": "nico", "nombre": "Nico", "rol": "Ads", "prompt": "Sos Nico.",
                                             "departamento": "direccion"})
        self.reloj = [time.time()]
        self.app.tareas = hq_tareas.Tareas(self.app, self.server, env={"HQ_PROGRAMADOR": "0"}, reloj=lambda: self.reloj[0],
                                           sistema="UTC")
        self.tar = self.app.tareas

    def t(self, metodo, path, body=None):
        return self.tar(metodo, path, {}, json.dumps(body).encode() if body is not None else None)

    def nueva(self, **extra):
        d = {"agente": "marce", "nombre": "Informe diario", "consigna": "Armá el informe de ayer",
             "dias": [1, 2, 3, 4, 5], "hora": "08:00", "zona": BA}
        d.update(extra)
        return self.t("POST", "/api/tareas", d)

    def ejecuciones(self, id_="informe-diario"):
        return self.t("GET", "/api/tareas/%s/ejecuciones" % id_)[1].get("ejecuciones", [])

    def terminada(self, id_="informe-diario", cuantas=1):
        fin = time.time() + 15
        while time.time() < fin:
            e = self.ejecuciones(id_)
            if len(e) >= cuantas and e[0]["estado"] != "corriendo":
                return e[0]
            time.sleep(0.03)
        self.fail("la ejecución no terminó: %r" % self.ejecuciones(id_))

    def llamadas_claude(self):
        try:
            with open(os.path.join(self.bin, "args.log")) as fh:
                return [x for x in fh.read().split("\x1e") if x]
        except OSError:
            return []

    def test_crear(self):
        st, r = self.nueva()
        self.assertEqual(st, 200, r)
        t = r["tarea"]
        self.assertEqual((t["id"], t["dias"], t["zona"], t["activa"]), ("informe-diario", [1, 2, 3, 4, 5], BA, True))
        self.assertIsNotNone(hq_tareas.fecha(t["proxima"]))
        self.assertIsNone(t["ultima"])
        self.assertNotIn("desde", t)
        en_disco = hq_core.leer_oficina(self.app.activa_carpeta)["tareas"]
        self.assertEqual(len(en_disco), 1)
        st, r = self.t("POST", "/api/tareas", {"agente": "nico", "nombre": "Otra", "consigna": "x", "dias": [7], "hora": "21:30"})
        self.assertEqual((st, r["tarea"]["zona"]), (200, "UTC"))
        self.assertEqual([x["id"] for x in self.t("GET", "/api/tareas")[1]["tareas"]], ["informe-diario", "otra"])
        self.assertEqual(self.nueva()[1]["tarea"]["id"], "informe-diario-2")

    def test_crear_validaciones(self):
        for extra, estado in [({"dias": []}, 400), ({"dias": [0]}, 400), ({"dias": [8]}, 400), ({"dias": [1, 1]}, 400),
                              ({"dias": "lunes"}, 400), ({"dias": [True]}, 400), ({"hora": "8:00"}, 400),
                              ({"hora": "24:00"}, 400), ({"hora": "07:75"}, 400), ({"hora": 800}, 400),
                              ({"zona": "Marte/Base"}, 400), ({"consigna": ""}, 400), ({"consigna": "x" * 4001}, 400),
                              ({"nombre": " "}, 400), ({"activa": "si"}, 400), ({"id": "Con Espacios"}, 400),
                              ({"agente": "nadie"}, 404)]:
            st, r = self.nueva(**extra)
            self.assertEqual(st, estado, (extra, st, r))
            self.assertTrue(r.get("error"))
        self.assertEqual(self.t("POST", "/api/tareas", {"agente": "marce"})[0], 400)
        self.assertEqual(self.tar("POST", "/api/tareas", {}, b"no json")[0], 400)
        self.assertEqual(self.nueva(id="fija")[0], 200)
        self.assertEqual(self.nueva(id="fija")[0], 409)
        for i in range(1, 50):
            self.assertEqual(self.nueva(nombre="T%d" % i)[0], 200)
        self.assertEqual(len(hq_core.leer_oficina(self.app.activa_carpeta)["tareas"]), 50)
        self.assertEqual(self.nueva()[0], 400)

    def test_editar(self):
        self.nueva()
        st, r = self.t("PATCH", "/api/tareas/informe-diario",
                       {"nombre": "Informe de la mañana", "hora": "09:15", "dias": [1, 3, 5], "activa": False})
        self.assertEqual(st, 200, r)
        t = r["tarea"]
        self.assertEqual((t["nombre"], t["hora"], t["dias"], t["activa"], t["proxima"]),
                         ("Informe de la mañana", "09:15", [1, 3, 5], False, None))
        self.assertEqual(hq_core.leer_oficina(self.app.activa_carpeta)["tareas"][0]["consigna"], "Armá el informe de ayer")
        st, r = self.t("PATCH", "/api/tareas/informe-diario", {"activa": True, "zona": NY})
        self.assertEqual((st, r["tarea"]["zona"]), (200, NY))
        self.assertIsNotNone(hq_tareas.fecha(r["tarea"]["proxima"]))
        self.assertIn("desde", hq_core.leer_oficina(self.app.activa_carpeta)["tareas"][0])
        for body in ({"hora": "99:00"}, {"zona": "x/y"}, {"dias": []}, {"consigna": "x" * 4001}):
            self.assertEqual(self.t("PATCH", "/api/tareas/informe-diario", body)[0], 400, body)
        self.assertEqual(self.t("PATCH", "/api/tareas/no-existe", {"nombre": "x"})[0], 404)
        self.assertEqual(self.t("PATCH", "/api/tareas/Mal Id", {"nombre": "x"})[0], 404)
        self.assertEqual(self.tar("PATCH", "/api/tareas/informe-diario", {}, None)[0], 400)
        self.assertEqual(self.t("PUT", "/api/tareas/informe-diario", {})[0], 405)

    def test_borrar(self):
        self.nueva()
        self.assertEqual(self.t("POST", "/api/tareas/informe-diario/correr", {})[0], 202)
        self.terminada()
        self.assertEqual(self.t("DELETE", "/api/tareas/informe-diario")[1], {"ok": True})
        self.assertEqual(self.t("GET", "/api/tareas")[1]["tareas"], [])
        self.assertNotIn("tareas", hq_core.leer_oficina(self.app.activa_carpeta))
        self.assertEqual(self.t("GET", "/api/tareas/informe-diario/ejecuciones")[0], 404)
        self.assertEqual(self.t("DELETE", "/api/tareas/informe-diario")[0], 404)
        self.nueva()
        self.assertEqual(self.ejecuciones(), [])

    def test_despedir_desactiva(self):
        self.nueva()
        self.nueva(agente="nico", nombre="De Nico")
        self.assertEqual(self.llamar("DELETE", "/api/agentes/marce")[0], 200)
        ts = {x["id"]: x for x in self.t("GET", "/api/tareas")[1]["tareas"]}
        self.assertEqual(len(ts), 2)
        self.assertEqual((ts["informe-diario"]["activa"], ts["informe-diario"]["proxima"]), (False, None))
        self.assertTrue(ts["de-nico"]["activa"])
        self.assertEqual(self.t("PATCH", "/api/tareas/informe-diario", {"activa": True})[0], 409)
        self.assertEqual(self.t("POST", "/api/tareas/informe-diario/correr", {})[0], 409)
        self.assertEqual(self.llamar("GET", "/api/oficina")[0], 200)

    def test_sin_oficina(self):
        self.app.activa_carpeta = None
        self.assertEqual(self.t("GET", "/api/tareas")[0], 409)
        self.assertEqual(self.t("POST", "/api/tareas/x/correr", {})[0], 409)

    def test_probar_ahora(self):
        self.nueva(consigna="Armá el informe")
        avisos = []
        self.tar.al_terminar = avisos.append
        st, r = self.t("POST", "/api/tareas/informe-diario/correr", {})
        self.assertEqual(st, 202, r)
        ej = r["ejecucion"]
        self.assertEqual((ej["estado"], ej["manual"], ej["agente"], ej["tarea"]), ("corriendo", True, "marce", "informe-diario"))
        fin = self.terminada()
        self.assertEqual((fin["estado"], fin["resultado"]), ("ok", "hola marce"))
        self.assertAlmostEqual(fin["costo"], 0.01)
        self.assertIsNotNone(fin["fin"])
        self.assertIsNone(fin["error"])
        self.assertEqual(fin["sid"], ej["sid"])
        st, h = self.app.api("GET", "/api/historial", {"agent": ["marce"], "session": [ej["sid"]]}, None)
        self.assertEqual([(m["r"], m["t"]) for m in h["msgs"]], [("u", "Armá el informe"), ("a", "hola marce")])
        self.assertEqual(self.app.api("GET", "/api/historial", {"agent": ["marce"]}, None)[1]["session"], ej["sid"])
        args = self.llamadas_claude()[-1].split("\x1f")
        self.assertIn(ej["sid"], args)
        self.assertEqual(args[args.index("--agent") + 1], "marce")
        self.assertTrue(any("conocimiento/agentes/marce.md" in a for a in args))
        c = self.app.vivo("GET", "/api/costos", {})[1]
        self.assertAlmostEqual(c["origenes"]["tarea"], 0.01)
        self.assertAlmostEqual(c["agentes"]["marce"], 0.01)
        for _ in range(100):
            if avisos:
                break
            time.sleep(0.03)
        self.assertEqual([(a["estado"], a["tarea"]) for a in avisos], [("ok", "informe-diario")])
        t = self.t("GET", "/api/tareas")[1]["tareas"][0]
        self.assertEqual((t["ultima"]["estado"], t["corriendo"]), ("ok", False))

    def test_en_vivo_y_conflictos(self):
        self.nueva(consigna="STREAM PAUSA informe")
        self.assertEqual(self.t("POST", "/api/tareas/informe-diario/correr", {})[0], 202)
        visto = None
        for _ in range(100):
            m = self.app.vivo("GET", "/api/actividad", {})[1]["agentes"].get("marce")
            if m and m.get("origen") == "tarea":
                visto = m
                break
            time.sleep(0.05)
        self.assertIsNotNone(visto)
        self.assertEqual(visto["tarea"], "Informe diario")
        self.assertEqual(self.t("POST", "/api/tareas/informe-diario/correr", {})[0], 409)
        self.assertEqual(self.t("DELETE", "/api/tareas/informe-diario")[0], 409)
        self.assertTrue(self.t("GET", "/api/tareas")[1]["tareas"][0]["corriendo"])
        open(os.path.join(self.bin, "go"), "w").close()
        fin = self.terminada()
        self.assertEqual((fin["estado"], fin["resultado"]), ("ok", "stream marce"))
        self.assertAlmostEqual(fin["costo"], 0.25)
        self.assertEqual(self.app.vivo("GET", "/api/actividad", {})[1]["agentes"], {})

    def test_falla(self):
        self.nueva(consigna="ISERR por favor")
        avisos = []
        self.tar.al_terminar = avisos.append
        self.assertEqual(self.t("POST", "/api/tareas/informe-diario/correr", {})[0], 202)
        fin = self.terminada()
        self.assertEqual(fin["estado"], "error", fin)
        self.assertTrue(fin["error"])
        for _ in range(100):
            if avisos:
                break
            time.sleep(0.03)
        self.assertEqual(avisos[0]["estado"], "error")

    def test_programador(self):
        todos = [1, 2, 3, 4, 5, 6, 7]
        self.nueva(dias=todos)
        modelo = tarea(dias=todos)
        p1 = hq_tareas.proxima(modelo, time.time() + 2 * 86400)
        self.reloj[0] = p1 - 30
        self.tar.revisar()
        self.assertEqual(self.ejecuciones(), [])
        self.reloj[0] = p1 + 5
        self.tar.revisar()
        e = self.ejecuciones()
        self.assertEqual(len(e), 1)
        self.assertFalse(e[0]["manual"])
        self.assertEqual(hq_tareas.fecha(e[0]["programada"]), p1)
        self.terminada()
        self.tar.revisar()
        self.reloj[0] = p1 + 35
        self.tar.revisar()
        self.assertEqual(len(self.ejecuciones()), 1, "nunca dos veces la misma programada")
        self.assertEqual(len(self.llamadas_claude()), 1)
        p2 = hq_tareas.proxima(modelo, p1)
        self.reloj[0] = p2 + 10
        self.tar.revisar()
        self.terminada(cuantas=2)
        # la app estuvo cerrada dos días: a las 11 h del tercero corre una sola vez
        p4 = hq_tareas.proxima(modelo, p2 + 2 * 86400)
        self.reloj[0] = p4 + 11 * 3600
        self.tar.revisar()
        self.terminada(cuantas=3)
        e = self.ejecuciones()
        self.assertEqual((len(e), hq_tareas.fecha(e[0]["programada"])), (3, p4))
        self.tar.revisar()
        self.assertEqual(len(self.ejecuciones()), 3)
        p5 = hq_tareas.proxima(modelo, p4)
        self.reloj[0] = p5 + 13 * 3600
        self.tar.revisar()
        self.assertEqual(len(self.ejecuciones()), 3, "más de 12 h tarde: se perdió")

    def test_programador_omite(self):
        todos = [1, 2, 3, 4, 5, 6, 7]
        self.nueva(dias=todos, activa=False)
        self.nueva(nombre="De Nico", agente="nico", dias=todos)
        self.llamar("DELETE", "/api/agentes/nico")
        nueva = self.nueva(nombre="Nueva", dias=todos)[1]["tarea"]
        p = hq_tareas.anterior(tarea(dias=todos), time.time())
        self.reloj[0] = p + 3600  # atrás de «desde» a propósito: ningún horario >= desde
        self.tar.revisar()
        self.assertEqual(self.llamadas_claude(), [])
        for id_ in ("informe-diario", "de-nico", nueva["id"]):
            self.assertEqual(self.ejecuciones(id_), [], id_)

    def test_reinicio(self):
        self.nueva()
        self.t("GET", "/api/tareas")
        carpeta = self.app.activa_carpeta
        self.tar._sql("INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) "
                      "VALUES(?,?,?,?,?,'corriendo',?,0)", (carpeta, "informe-diario", "marce", 1, 2, "s"), escribir=True)
        # otro arranque sobre la misma base
        self.app.tareas = hq_tareas.Tareas(self.app, self.server, env={"HQ_PROGRAMADOR": "0"})
        e = self.app.tareas("GET", "/api/tareas/informe-diario/ejecuciones", {}, None)[1]["ejecuciones"][0]
        self.assertEqual(e["estado"], "error")
        self.assertIn("Interrumpida", e["error"])
        self.assertIsNotNone(e["fin"])

    def test_bucle_automatico(self):
        todos = [1, 2, 3, 4, 5, 6, 7]
        self.nueva(dias=todos)
        p = hq_tareas.proxima(tarea(dias=todos), time.time() + 86400)
        self.reloj[0] = p + 1
        auto = hq_tareas.Tareas(self.app, self.server, env={"HQ_PROGRAMADOR_INTERVALO": "0.1"}, reloj=lambda: self.reloj[0])
        self.app.tareas = auto
        auto.iniciar()
        try:
            fin = time.time() + 15
            while time.time() < fin and len(self.ejecuciones()) < 1:
                time.sleep(0.05)
            self.assertEqual(len(self.ejecuciones()), 1)
            self.terminada()
        finally:
            auto.detener()


if __name__ == "__main__":
    unittest.main(verbosity=2)
