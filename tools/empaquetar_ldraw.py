#!/usr/bin/env python3
"""Empaqueta las piezas LDraw del catalogo de minifigs en un solo archivo MPD.

Uso:
  python3 tools/empaquetar_ldraw.py <ruta-a-ldraw> [--catalogo oficina/ldraw/catalogo.json] [--salida oficina/ldraw/minifigs.mpd]
  python3 tools/empaquetar_ldraw.py <ruta-a-ldraw> --partes oficina/ldraw/piezas-oficina.txt --salida oficina/ldraw/oficina.mpd

Con --partes se empaqueta una lista de piezas (una por linea, "#" comenta) en vez del catalogo de minifigs:
asi se arma oficina.mpd, con los muebles, plantas, arboles y autos de la maqueta.

Lee oficina/ldraw/catalogo.json (la unica fuente del catalogo; figuras.js lo lee
tambien), resuelve recursivamente los subarchivos (parts/, p/, parts/s/, p/48/,
con backslashes y sin distinguir mayusculas) y escribe un MPD con un
"0 FILE <nombre>" por archivo. Los nombres son las claves que usa LDrawLoader
(r128) en su cache de subarchivos: minusculas, tal cual se referencian ("3818.dat",
"stud.dat"), salvo "s/x.dat" -> "parts/s/x.dat" y "48/x.dat" -> "p/48/x.dat" ("8/x.dat" queda igual). El primer FILE ("ldconfig") lleva solo los colores usados.

Se descartan lineas condicionales (tipo 5), comentarios y metadatos que el
loader no usa; se conservan las lineas tipo 2 (el loader las usa para suavizar
normales), los "0 BFC" y "0 !LDRAW_ORG" (el loader exige este ultimo).

Piezas LDraw: CC BY 4.0 (LDraw.org). Ver oficina/ldraw/LICENSE-LDraw.txt.
"""
import argparse, json, os, re, sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def indexar(ldraw):
    """Mapa 'ruta relativa en minusculas' -> ruta real, para parts/ y p/."""
    idx = {}
    for sub in ("parts", "p"):
        base = os.path.join(ldraw, sub)
        for dp, _dn, fn in os.walk(base):
            for f in fn:
                real = os.path.join(dp, f)
                rel = os.path.relpath(real, ldraw).replace(os.sep, "/").lower()
                idx[rel] = real
    return idx


def clave(nombre):
    n = nombre.strip().replace("\\", "/").lower()
    if n.startswith("s/"):
        n = "parts/" + n
    elif n.startswith("48/"):
        n = "p/" + n            # LDrawLoader r128 solo antepone p/ a 48/; 8/ queda tal cual
    elif n.startswith("parts/") or n.startswith("p/"):
        n = n.split("/", 1)[1] if not n.startswith(("parts/s/", "p/48/", "p/8/")) else n
    return n


def resolver(idx, k):
    if k in idx:
        return idx[k]
    for pre in ("parts/", "p/"):
        if pre + k in idx:
            return idx[pre + k]
    return None


def limpiar(texto, colores):
    out = []
    for ln in texto.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        t = ln.split(None, 1)[0]
        if t == "0":
            if re.match(r"0\s+(BFC\b|!LDRAW_ORG\b)", ln):
                out.append(ln)
            continue
        if t in ("1", "2", "3", "4"):
            toks = ln.split()
            if toks[1].isdigit():
                colores.add(int(toks[1]))
            if t == "2":
                # color de linea: solo importa para suavizado, no se dibuja
                pass
            out.append(ln)
        # tipo 5 (condicional) se descarta
    return "\n".join(out) + "\n"


def colores_ldconfig(ldraw, usados):
    usados = set(usados) | {0, 15}
    res = []
    with open(os.path.join(ldraw, "LDConfig.ldr"), encoding="utf-8", errors="replace") as f:
        for ln in f:
            m = re.match(r"0\s+!COLOUR\s+\S+\s+CODE\s+(\d+)", ln)
            if m and int(m.group(1)) in usados:
                res.append(ln.strip())
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ldraw")
    ap.add_argument("--catalogo", default=os.path.join(RAIZ, "oficina/ldraw/catalogo.json"))
    ap.add_argument("--salida", default=os.path.join(RAIZ, "oficina/ldraw/minifigs.mpd"))
    ap.add_argument("--partes", help="archivo con una pieza por linea (en vez del catalogo de minifigs)")
    a = ap.parse_args()

    if a.partes:
        with open(a.partes, encoding="utf-8") as f:
            raiz_partes = [ln.split("#", 1)[0].strip() for ln in f]
        raiz_partes = [p for p in raiz_partes if p]
    else:
        with open(a.catalogo, encoding="utf-8") as f:
            cat = json.load(f)
        raiz_partes = list(cat["base"].values())
        for grupo in ("pelo", "cara", "torso"):
            raiz_partes += [v["parte"] for v in cat[grupo].values()]

    idx = indexar(a.ldraw)
    archivos = {}   # clave -> texto limpio
    colores = set()
    cola = [clave(p + ".dat") for p in raiz_partes]
    faltan = set()
    while cola:
        k = cola.pop()
        if k in archivos:
            continue
        real = resolver(idx, k)
        if not real:
            faltan.add(k)
            continue
        with open(real, encoding="utf-8", errors="replace") as f:
            txt = limpiar(f.read(), colores)
        archivos[k] = txt
        for ln in txt.splitlines():
            if ln.startswith("1 "):
                toks = ln.split(None, 14)
                if len(toks) >= 15:
                    cola.append(clave(toks[14]))
    if faltan:
        print("AVISO: no se encontraron:", ", ".join(sorted(faltan)), file=sys.stderr)

    os.makedirs(os.path.dirname(a.salida), exist_ok=True)
    with open(a.salida, "w", encoding="utf-8", newline="\n") as f:
        f.write("0 FILE ldconfig\n0 !LDRAW_ORG Configuration\n")
        for ln in colores_ldconfig(a.ldraw, colores):
            f.write(ln + "\n")
        for k in sorted(archivos):
            f.write("0 FILE " + k + "\n" + archivos[k])
    tam = os.path.getsize(a.salida)
    print("%d archivos, %.2f MB -> %s" % (len(archivos), tam / 1048576.0, a.salida))


if __name__ == "__main__":
    main()
