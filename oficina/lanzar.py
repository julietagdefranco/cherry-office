#!/usr/bin/env python3
"""Lanzador de Próspera HQ (macOS / Linux / Windows). Solo librería estándar, Python 3.9+."""
import glob
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

AQUI = os.path.dirname(os.path.abspath(__file__))
PUERTO_BASE = int(os.environ.get("PORT", "8765"))
RANGO_ALTERNATIVO = range(8766, 8786)
SIN_NAVEGADOR = bool(os.environ.get("HQ_NO_BROWSER"))


def esperar_enter(msg="Apretá Enter para cerrar. "):
    try:
        input(msg)
    except (EOFError, KeyboardInterrupt):
        pass


def buscar_claude():
    env = os.environ.get("CLAUDE_BIN")
    if env:
        return env
    patron = os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude")
    candidatos = glob.glob(patron)
    if candidatos:
        return max(candidatos, key=os.path.getmtime)
    return shutil.which("claude")


def estado(puerto):
    """Devuelve el JSON de /api/estado si responde, o None."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/estado" % puerto, timeout=1.5) as r:
            datos = json.loads(r.read().decode("utf-8"))
        return datos if isinstance(datos, dict) else None
    except Exception:
        return None


def es_hq(puerto):
    d = estado(puerto)
    return bool(d) and d.get("app") == "prospera-hq"


def puerto_libre(puerto):
    # Se prueba bind en todas las interfaces, como hace el server, para detectar cualquier ocupante.
    for host in ("127.0.0.1", ""):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, puerto))
        except OSError:
            return False
        finally:
            s.close()
    return True


def abrir(url):
    if SIN_NAVEGADOR:
        print("(HQ_NO_BROWSER: no abro el navegador) " + url)
        return
    try:
        webbrowser.open(url)
    except Exception:
        print("No pude abrir el navegador solo. Abrí esta dirección a mano: " + url)


def asegurar_sesion(claude):
    try:
        ok = subprocess.run([claude, "auth", "status"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    if ok:
        return True
    print("Primera vez: se va a abrir el navegador para que autorices tu cuenta de Claude.")
    try:
        subprocess.run([claude, "auth", "login"])
    except OSError as e:
        print("No pude iniciar sesión: %s" % e)
        return False
    return True


def main():
    claude = buscar_claude()
    if not claude:
        print("No encontré Claude Code en esta compu.")
        print("Instalalo (o pedile ayuda a quien te armó la oficina) y volvé a abrir esto.")
        esperar_enter()
        return 1

    # Si ya hay una oficina abierta, solo la mostramos.
    if es_hq(PUERTO_BASE):
        url = "http://localhost:%d" % PUERTO_BASE
        print("Próspera HQ ya estaba abierta. La abro de nuevo en el navegador: " + url)
        abrir(url)
        return 0
    puerto = PUERTO_BASE
    if not puerto_libre(puerto):
        for p in RANGO_ALTERNATIVO:
            if es_hq(p):
                url = "http://localhost:%d" % p
                print("Próspera HQ ya estaba abierta. La abro de nuevo en el navegador: " + url)
                abrir(url)
                return 0
        print("El puerto %d lo está usando otro programa, busco uno libre..." % puerto)
        puerto = next((p for p in RANGO_ALTERNATIVO if puerto_libre(p)), None)
        if puerto is None:
            print("No encontré ningún puerto libre (probé %d a %d)." % (RANGO_ALTERNATIVO[0], RANGO_ALTERNATIVO[-1]))
            esperar_enter()
            return 1

    if not asegurar_sesion(claude):
        esperar_enter()
        return 1

    env = dict(os.environ, PORT=str(puerto), CLAUDE_BIN=claude)
    print("Iniciando Próspera HQ...")
    proc = subprocess.Popen([sys.executable, os.path.join(AQUI, "server.py")], cwd=AQUI, env=env)

    def apagar(*_):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        sys.exit(0)

    for nombre in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, nombre):
            signal.signal(getattr(signal, nombre), apagar)

    try:
        limite = time.time() + 10
        listo = False
        while time.time() < limite and proc.poll() is None:
            if es_hq(puerto) or (estado(puerto) is not None):
                listo = True
                break
            time.sleep(0.3)
        if proc.poll() is not None:
            print("")
            print("Próspera HQ se cerró sola (código %s). Mirá el mensaje de arriba para ver qué pasó." % proc.returncode)
            esperar_enter()
            return 1
        url = "http://localhost:%d" % puerto
        if not listo:
            print("Tarda más de lo normal en arrancar; igual intento abrirla.")
        abrir(url)
        print("Próspera HQ abierta en %s  (cerrá esta ventana para apagarla)" % url)
        proc.wait()
        print("")
        print("Próspera HQ se apagó (código %s)." % proc.returncode)
        if proc.returncode not in (0, None):
            esperar_enter()
        return proc.returncode or 0
    except KeyboardInterrupt:
        apagar()
    finally:
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
