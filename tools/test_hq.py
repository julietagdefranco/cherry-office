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


class VivoAPI(unittest.TestCase):
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


class ReunionesPatrones(unittest.TestCase):
    """Patrones de reunión (fase 3): validaciones, orden de turnos, consignas y archivo de salida."""

    def setUp(self):
        VivoAPI.setUp(self)
        import hq_reuniones
        self.hr = hq_reuniones
        self.hr.instalar(self.app, self.server)
        for i, nom in (("nico", "Nico"), ("betty", "Betty")):
            st, r = self.llamar("POST", "/api/agentes", {"id": i, "nombre": nom, "rol": "Rol de " + i, "prompt": "Sos " + nom + ".",
                                                         "departamento": "direccion"})
            self.assertEqual(st, 200, r)

    def tearDown(self):
        VivoAPI.tearDown(self)

    def reu(self, m, p, body=None):
        return self.app.reuniones(m, p, {}, json.dumps(body).encode() if body is not None else None)

    def esperar(self, id_, estados=("esperando", "error", "cerrada")):
        r = None
        for _ in range(200):
            st, r = self.reu("GET", "/api/reuniones/" + id_)
            if r["estado"] in estados:
                return r
            time.sleep(0.05)
        self.fail("la reunión no llegó a %s: %s" % (estados, r))

    def prompts(self, marca="Estás en una reunión"):
        with open(os.path.join(self.bin, "args.log")) as f:
            regs = [x.split("\x1f") for x in f.read().split("\x1e") if x]
        return [r[-2] for r in regs if len(r) > 1 and marca in r[-2]]

    def crear(self, **extra):
        d = {"tema": "plan de lanzamiento", "agentes": ["marce", "nico", "betty"]}
        d.update(extra)
        return self.reu("POST", "/api/reuniones", d)

    def test_crear_con_patron_y_validaciones(self):
        st, r = self.crear()
        self.assertEqual(st, 200, r)
        self.assertEqual(r["patron"], "debate")
        hoy = __import__("datetime").date.today().strftime("%Y-%m-%d")
        self.assertEqual(r["salida"], "archivos/entregables/reuniones/%s-plan-de-lanzamiento.md" % hoy)
        self.esperar(r["id"])
        for extra in ({"patron": "asamblea"}, {"patron": 3}, {"patron": "lider"}, {"patron": "lider", "lider": "fantasma"},
                      {"patron": "redblue"}, {"patron": "redblue", "bandos": {"a": ["marce", "nico", "betty"], "b": []}},
                      {"patron": "redblue", "bandos": {"a": ["marce"], "b": ["nico"]}},
                      {"patron": "redblue", "bandos": {"a": ["marce", "nico"], "b": ["nico", "betty"]}},
                      {"patron": "revision"}, {"salida": "archivos/../x.md"}, {"salida": "/tmp/x.md"},
                      {"salida": "archivos/x.txt"}, {"salida": "otra/x.md"}, {"salida": 5}):
            st, e = self.crear(**extra)
            self.assertEqual(st, 400, (extra, e))
        st, r = self.crear(patron="lider", lider="betty", salida="archivos/a/b.md")
        self.assertEqual((st, r["lider"], r["patron"], r["salida"]), (200, "betty", "lider", "archivos/a/b.md"))
        self.esperar(r["id"])
        st, d = self.reu("GET", "/api/reuniones/" + r["id"])
        self.assertEqual((d["patron"], d["lider"]), ("lider", "betty"))
        st, l = self.reu("GET", "/api/reuniones")
        self.assertEqual({x["patron"] for x in l["reuniones"]}, {"debate", "lider"})

    def test_plan_y_visibles(self):
        hr = self.hr
        self.assertEqual(hr.plan("lider", ["x", "y", "z"], "y", None), [("y", "abre"), ("x", "opina"), ("z", "opina"), ("y", "cierra")])
        self.assertEqual(hr.plan("redblue", ["x", "y", "z", "w"], None, {"a": ["x", "z"], "b": ["y", "w"]}),
                         [("x", "defiende"), ("y", "critica"), ("z", "defiende"), ("w", "critica")])
        self.assertEqual([p[0] for p in hr.plan("mapreduce", ["x", "y"], None, None)], ["x", "y"])
        t = [{"ronda": 1, "agente": "x", "texto": "a", "error": False}, {"ronda": 2, "agente": "y", "texto": "b", "error": False},
             {"ronda": 2, "agente": "usuario", "texto": "c", "error": False}]
        self.assertEqual([x["texto"] for x in hr.visibles("mapreduce", t, 2)], ["a", "c"])
        self.assertEqual(len(hr.visibles("debate", t, 2)), 3)
        self.assertIsNone(hr.error_de_salida("archivos/a/b.md"))
        for mal in ("", "archivos/../x.md", "/x.md", "archivos/.texto/x.md", "archivos/x.txt", "x.md", "archivos//x.md"):
            self.assertIsNotNone(hr.error_de_salida(mal), mal)
        self.assertEqual(hr.ruta_libre("archivos/a.md", lambda r: r in ("archivos/a.md", "archivos/a-2.md")), "archivos/a-3.md")

    def test_orden_lider_y_consignas(self):
        st, r = self.crear(patron="lider", lider="betty")
        self.assertEqual(st, 200, r)
        resto = [a for a in r["agentes"] if a != "betty"]
        fin = self.esperar(r["id"])
        self.assertEqual([t["agente"] for t in fin["turnos"]], ["betty"] + resto + ["betty"])
        p = self.prompts()
        self.assertEqual(len(p), 4)
        self.assertIn("Abrí la ronda", p[0])
        self.assertIn("lidera la reunión y ya abrió la ronda", p[1])
        self.assertIn("Cerrala con tu posición", p[3])

    def test_redblue_y_mapreduce_en_el_prompt(self):
        st, r = self.crear(patron="redblue", bandos={"a": ["marce", "betty"], "b": ["nico"]})
        self.assertEqual(st, 200, r)
        a = [x for x in r["agentes"] if x in ("marce", "betty")]
        fin = self.esperar(r["id"])
        self.assertEqual([t["agente"] for t in fin["turnos"]], [a[0], "nico", a[1]])
        p = self.prompts()
        self.assertIn("del bando A: DEFENDÉS", p[0])
        self.assertIn("del bando B: CRITICÁS", p[1])
        # mapreduce: corren en paralelo y ninguno ve los turnos de su ronda
        st, m = self.crear(patron="mapreduce", rondas=2)
        fin = self.esperar(m["id"])
        self.assertEqual(len(fin["turnos"]), 6)
        pm = [x for x in self.prompts() if "cada participante responde por separado" in x]
        self.assertEqual(len(pm), 6)
        r1 = [x for x in pm if "estamos en la ronda 1" in x]
        r2 = [x for x in pm if "estamos en la ronda 2" in x]
        self.assertEqual((len(r1), len(r2)), (3, 3))
        for x in r1:
            self.assertNotIn("hola ", x.split("Lo que se dijo")[1])
        for x in r2:
            self.assertIn("— Ronda 1 —", x)
            self.assertNotIn("— Ronda 2 —", x)

    def test_archivo_de_salida(self):
        st, r = self.crear(patron="lider", lider="marce")
        self.esperar(r["id"])
        carpeta = self.app.requerir_activa()[0]
        self.assertFalse(os.path.exists(os.path.join(carpeta, r["salida"])))
        st, c = self.reu("POST", "/api/reuniones/%s/cerrar" % r["id"])
        self.assertEqual(st, 200, c)
        self.assertEqual(c["salida"], r["salida"])
        self.assertEqual(c["salidaRuta"], os.path.join(carpeta, r["salida"]))
        with open(c["salidaRuta"], encoding="utf-8") as f:
            md = f.read()
        self.assertTrue(md.startswith("# plan de lanzamiento"))
        self.assertIn("**Patrón:** Líder y equipo", md)
        self.assertIn("**Líder:** Marce", md)
        self.assertIn("## Resumen", md)
        self.assertIn("`%s`" % c["acta"], md)
        self.assertTrue(os.path.exists(os.path.join(carpeta, c["acta"])))
        # misma ruta otra vez -> -2; y un estorbo no rompe el cierre
        st, r2 = self.crear(salida=r["salida"])
        self.esperar(r2["id"])
        st, c2 = self.reu("POST", "/api/reuniones/%s/cerrar" % r2["id"])
        self.assertTrue(c2["salida"].endswith("-2.md"), c2["salida"])
        with open(os.path.join(carpeta, "archivos", "estorbo"), "w") as f:
            f.write("x")
        st, r3 = self.crear(salida="archivos/estorbo/x.md")
        self.esperar(r3["id"])
        st, c3 = self.reu("POST", "/api/reuniones/%s/cerrar" % r3["id"])
        self.assertEqual((st, c3["estado"]), (200, "cerrada"))
        self.assertIn("archivo de salida", c3["error"])
        self.assertNotIn("salidaRuta", c3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
