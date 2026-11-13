#!/usr/bin/env python3
"""Servidor local de Próspera HQ.
- Sirve la oficina (index.html) en http://localhost:8765
- POST /api/chat  -> habla con un agente real de ~/.claude/agents usando Claude Code en modo no interactivo.
Solo escucha en 127.0.0.1. Los chats son de SOLO LECTURA: los agentes pueden leer archivos pero no editar,
ejecutar comandos ni publicar nada desde acá."""
import glob, json, os, shutil, subprocess, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PROYECTO = "/Users/julietadefranco/Próspera"
BETTY_DIR = "/Users/julietadefranco/.claude/betty"
AGENTES = {"betty", "don-armando", "marce", "catalina", "patricia", "sofia", "mario", "nicolas"}
PUERTO = int(os.environ.get("PORT", "8765"))
ORIGENES = {f"http://localhost:{PUERTO}", f"http://127.0.0.1:{PUERTO}"}
SESIONES = os.path.join(ROOT, ".sesiones.json")
lock_global = threading.Lock()
locks = {a: threading.Lock() for a in AGENTES}


def buscar_claude():
    if os.environ.get("CLAUDE_BIN"):
        return os.environ["CLAUDE_BIN"]
    w = shutil.which("claude")
    if w:
        return w
    pat = "/Users/julietadefranco/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"
    c = sorted(glob.glob(pat), key=os.path.getmtime)
    return c[-1] if c else None


CLAUDE = buscar_claude()


def cargar():
    try:
        return json.load(open(SESIONES))
    except Exception:
        return {}


def guardar(d):
    json.dump(d, open(SESIONES, "w"))


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/estado"):
            return self._json(200, {"claude": bool(CLAUDE), "agentes": sorted(AGENTES)})
        if self.path.startswith("/.") or self.path.endswith(".py"):
            return self._json(404, {"error": "no"})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/chat":
            return self._json(404, {"error": "no"})
        origen = self.headers.get("Origin")
        if origen and origen not in ORIGENES:
            return self._json(403, {"error": "origen no permitido"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(415, {"error": "se espera JSON"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            d = json.loads(self.rfile.read(min(n, 200_000)))
            agente, msg, sid = d["agent"], str(d["message"]).strip(), d["session"]
        except Exception:
            return self._json(400, {"error": "pedido inválido"})
        if agente not in AGENTES or not msg or len(sid) != 36:
            return self._json(400, {"error": "pedido inválido"})
        if not CLAUDE:
            return self._json(500, {"error": "No encontré Claude Code en esta compu."})
        with locks[agente]:
            with lock_global:
                ses = cargar()
            def correr(flag):
                herramientas = "Read,Glob,Grep,Skill"
                extra = []
                if agente == "betty":
                    # Betty solo puede escribir en su archivo de estado, en ningún otro lado.
                    herramientas += ",Edit,Write"
                    extra = ["--allowedTools", "Edit(//Users/julietadefranco/Próspera/_betty/estado-actual.md)",
                             "Write(//Users/julietadefranco/Próspera/_betty/estado-actual.md)"]
                cmd = [CLAUDE, "-p", msg, "--agent", agente, flag, sid,
                       "--output-format", "json",
                       "--tools", herramientas,
                       "--add-dir", BETTY_DIR] + extra
                r = subprocess.run(cmd, cwd=PROYECTO, capture_output=True, text=True, timeout=600,
                                   stdin=subprocess.DEVNULL)
                try:
                    out = json.loads(r.stdout)
                except Exception:
                    out = None
                return r, out

            def error_de(r, out):
                if out is not None and out.get("is_error"):
                    return str(out.get("result") or "Error desconocido")
                if r.returncode != 0:
                    return (r.stdout or r.stderr or "Error desconocido")[-600:]
                return None

            try:
                flag = "--resume" if sid in ses else "--session-id"
                r, out = correr(flag)
                e = error_de(r, out)
                # si la conversación ya existe (o no existe), probamos la otra forma
                if e and "already in use" in e:
                    r, out = correr("--resume"); e = error_de(r, out)
                elif e and flag == "--resume" and ("No conversation" in e or "not found" in e.lower()):
                    r, out = correr("--session-id"); e = error_de(r, out)
            except subprocess.TimeoutExpired:
                return self._json(504, {"error": "Tardó demasiado en responder."})
            if e:
                if "login" in e.lower():
                    e = ("Claude Code todavía no tiene la sesión iniciada para usarse desde la oficina. "
                         "Cerrá la ventana negra y volvé a abrir 'Abrir Próspera HQ.command' para iniciar sesión.")
                return self._json(500, {"error": e})
            with lock_global:
                ses = cargar(); ses[sid] = agente; guardar(ses)
            texto = (out or {}).get("result") or r.stdout.strip()
            return self._json(200, {"reply": texto})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PUERTO), H)
    print(f"Próspera HQ en http://localhost:{PUERTO}  (claude: {CLAUDE})", flush=True)
    srv.serve_forever()
