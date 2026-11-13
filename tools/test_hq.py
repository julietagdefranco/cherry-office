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


if __name__ == "__main__":
    unittest.main(verbosity=2)
