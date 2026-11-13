#!/usr/bin/env python3
"""Importa Próspera HQ como una oficina nueva en ~/Oficinas/Próspera HQ/ (Python 3.9, solo librería estándar).

Crea los 5 departamentos y los 8 agentes de siempre (los `agentes/*.md` de este repo o de ~/.claude/agents,
con las rutas absolutas cambiadas por rutas relativas a la oficina) y COPIA el conocimiento:
  ~/Próspera/_betty/estado-actual.md  -> conocimiento/oficina.md
  ~/.claude/betty/contexto-maestro.md -> conocimiento/contexto-maestro.md
  ~/Próspera/_equipo/...              -> conocimiento/...
Nunca mueve ni borra nada de lo original. Si la oficina ya existe, no toca nada.

Uso:  python3 tools/importar_prospera.py [--origen CARPETA] [--oficinas-dir CARPETA] [--proyecto CARPETA]
Variables: HQ_OFICINAS_DIR (donde se crean las oficinas), HQ_PROYECTO (donde están _betty y _equipo), HOME.
Es la misma lógica que POST /api/oficinas/importar-prospera de la app (app/Sources/Backend/Importar.swift).
"""
import argparse
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import hq_core  # noqa: E402

REPO = os.path.dirname(AQUI)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Importa Próspera HQ como oficina en ~/Oficinas/Próspera HQ/")
    ap.add_argument("--origen", help="carpeta con agentes/*.md (y contexto/); por defecto este repo o ~/.claude/agents")
    ap.add_argument("--oficinas-dir", default=os.environ.get("HQ_OFICINAS_DIR") or "~/Oficinas",
                    help="donde se crean las oficinas (default ~/Oficinas)")
    ap.add_argument("--proyecto", default=os.environ.get("HQ_PROYECTO") or "~/Próspera",
                    help="carpeta con _betty/ y _equipo/ (default ~/Próspera)")
    a = ap.parse_args(argv)
    home = os.path.expanduser("~")
    try:
        r = hq_core.importar_prospera(
            hq_core.resolver_carpeta_simple(a.oficinas_dir, home), home,
            hq_core.resolver_carpeta_simple(a.proyecto, home), origen=a.origen, repo_defecto=REPO)
    except hq_core.ErrorAPI as e:
        print("Error: " + e.mensaje, file=sys.stderr)
        return 1
    if r["yaExistia"]:
        print("La oficina ya existía, no toqué nada: %s" % r["carpeta"])
        return 0
    print("Oficina creada: %s" % r["carpeta"])
    print("Agentes (%d): %s" % (len(r["agentes"]), ", ".join(r["agentes"])))
    if r["faltantes"]:
        print("No encontré el .md de: %s" % ", ".join(r["faltantes"]))
    print("Conocimiento copiado: %s" % (", ".join(r["copiados"]) or "(nada: no había datos originales; quedaron las plantillas)"))
    print("Abrila desde la app (Abrir oficina existente) o con POST /api/oficinas/abrir.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
