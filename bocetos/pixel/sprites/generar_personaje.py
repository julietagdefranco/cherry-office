#!/usr/bin/env python3
"""Genera el personaje modular de la oficina pixel.

Salidas (junto a este script):
  personaje.aseprite  archivo nativo de Aseprite: capas, grupo de peinados, etiquetas por animación
  personaje.png       hoja de sprites: una fila por capa, una columna por cuadro
  personaje.json      dónde está cada cuadro, sus etiquetas, duraciones y colores llave
  vista_previa.png    todas las animaciones ampliadas, para revisar a ojo

Los colores de piel, pelo y ropa del archivo son "colores llave": la app los
reemplaza por los de cada agente, así un solo dibujo da todas las variantes.
"""
import json
import os
import struct
import zlib

from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
W, H = 16, 21          # lienzo de cada cuadro
OX, OY = 2, 1          # dónde se apoya la plantilla de 12x20 dentro del lienzo
ANCHOR = (8, 20)       # punto de los pies: lo que la app alinea con el piso

PAL = {
    'o': (0x2a, 0x1f, 0x2e), 'e': (0x2a, 0x1f, 0x2e), 'g': (0x2a, 0x1f, 0x2e),
    's': (0xf7, 0xd2, 0xa8), 'S': (0xdc, 0xa6, 0x7e),
    'w': (0xff, 0xff, 0xff), 'b': (0xf1, 0x9c, 0x8f), 'm': (0x9a, 0x46, 0x46), 'd': (0x8f, 0xd3, 0xff),
    'c': (0xe2, 0x57, 0x4c), 'C': (0xb1, 0x3d, 0x3d), 'h': (0xf7, 0x8a, 0x72),
    'p': (0x3d, 0x42, 0x62), 'P': (0x2b, 0x2f, 0x48), 'k': (0x3a, 0x2b, 0x2e),
    'r': (0x5b, 0x3a, 0x29), 'R': (0x3c, 0x25, 0x19),
}
KEYS = {'piel': ['s', 'S'], 'pelo': ['r', 'R'], 'ropa': ['c', 'C', 'h']}

FRONT = ["............", "............", "...oooooo...", "..osssssso..", ".osssssssso.", ".osssssssso.",
         ".oswessweso.", ".oseesseeso.", ".obssmmssbo.", ".oSssssssSo.", "..oSSSSSSo..", "...oossoo...",
         "..occcccco..", ".ohccccccCo.", ".ohccccccCo.", ".occccccCCo.", "..occccCCo..", "..oppppppo..",
         "..opPoopPo..", "..okkookko.."]
BACK = FRONT[:]
BACK[6] = BACK[7] = BACK[8] = ".osssssssso."

HAIR = {
    'corto': {
        'f': (2, ["...oooooo...", "..orrrrrro..", ".orrrrrrrro.", ".orR....Rro.", ".oR......Ro."]),
        'b': (2, ["...oooooo...", "..orrrrrro..", ".orrrrrrrro.", ".orrrrrrrro.", ".orrrrrrrRo.", ".orrrrrrRRo.",
                  ".oRRRRRRRRo.", "..oRRRRRRo.."])},
    'largo': {
        'f': (2, ["...oooooo...", "..orrrrrro..", ".orrrrrrrro.", "orrR....Rrro", "orR......Rro", "orR......Rro",
                  "orR......Rro", "oRR......RRo", "oRRo....oRRo", ".oo......oo."]),
        'b': (2, ["...oooooo...", "..orrrrrro..", ".orrrrrrrro.", "orrrrrrrrrro", "orrrrrrrrrro", "orrrrrrrrrro",
                  "orrrrrrrrrRo", "orrrrrrrrRRo", "oRrrrrrrrRRo", "oRRRRRRRRRRo", ".oRRRRRRRRo.", "..oooooooo.."])},
    'rodete': {
        'f': (0, ["....oooo....", "...orrRRo...", "..ooorrooo..", "..orrrrrro..", ".orrrrrrrro.", ".orR....Rro."]),
        'b': (0, ["....oooo....", "...orrRRo...", "..ooorrooo..", "..orrrrrro..", ".orrrrrrrro.", ".orrrrrrrro.",
                  ".orrrrrrrro.", ".orrrrrrRRo.", ".oRRRRRRRRo."])},
    'gorra': {
        'f': (2, ["...oooooo...", "..occhccco..", ".occcccccco.", "oCCCCCCCCCCo", ".or......ro."]),
        'b': (2, ["...oooooo...", "..occcccco..", ".occcccccco.", ".oCCCCCCCCo.", ".orrrrrrrro.", ".oRRRRRRRRo."])},
    'pelado': {
        'f': (3, ["...ww.......", "............", "............", "............", ".R........R.", ".R........R."]),
        'b': (3, ["...ww.......", "............", "............", "............", "............", ".oRRRRRRRRo.",
                  ".oRRRRRRRRo."])},
}
GLASSES = {'f': (5, ["..gggggggg..", ".og..gg..go.", ".og..gg..go."]), 'b': (6, [".g........g."])}
POSE = {'rest': [(1, 15), (10, 15)], 'ta': [(1, 14), (10, 15)], 'tb': [(1, 15), (10, 14)],
        'chin': [(1, 15), (8, 11)], 'head': [(0, 6), (11, 6), (0, 7), (11, 7)],
        'wave': [(1, 15), (10, 12), (11, 11)]}

# (etiqueta, vista, ms por cuadro, opciones de cada cuadro)
ANIMS = [
    ('respirar', 'f', 150, [dict(breath=b, blink=i == 5) for i, b in enumerate([0, 0, 0, 1, 1, 1, 1, 0])]),
    ('tipear', 'f', 120, [dict(pose=p, breath=b) for p, b in zip(['ta', 'tb', 'ta', 'tb'], [0, 0, 1, 1])]),
    ('pensar', 'f', 170, [dict(pose='chin', look_up=i in (2, 3, 4, 5), breath=i >= 4, blink=i == 7) for i in range(8)]),
    ('error', 'f', 100, [dict(pose='head', mouth='o', shake=s, sweat=i >= 2, sweat_y=max(0, i - 2) // 2)
                         for i, s in enumerate([1, -1, 1, -1, 0, 0])]),
    ('dormir', 'f', 230, [dict(sleep=True, droop=1, breath=i >= 4, mouth='small' if i >= 4 else None) for i in range(8)]),
    ('hablar', 'f', 140, [dict(mouth='o' if i % 2 == 0 else None, pose='wave' if i in (2, 3) else 'rest', breath=i >= 3)
                          for i in range(6)]),
    ('espalda_quieto', 'b', 150, [dict(breath=b) for b in [0, 0, 0, 1, 1, 1, 1, 0]]),
    ('espalda_tipear', 'b', 120, [dict(nod=n) for n in [0, 1, 0, 0]]),
    ('espalda_error', 'b', 100, [dict(pose='head', shake=s) for s in [1, -1, 1, -1, 0, 0]]),
    ('espalda_dormir', 'b', 230, [dict(droop=1, breath=i >= 4) for i in range(8)]),
]
TAG_COLORS = [(0x5c, 0xcf, 0x7e), (0x5a, 0xa9, 0xf2), (0xf2, 0xc1, 0x4e), (0xf0, 0x56, 0x4c), (0x8f, 0x95, 0xa3),
              (0xb4, 0x8e, 0xf2)]

# Orden de abajo hacia arriba, como los guarda Aseprite. (nombre, tipo 0=normal 1=grupo, nivel, visible)
LAYERS = [('cuerpo', 0, 0, True), ('peinados', 1, 0, True), ('corto', 0, 1, True), ('largo', 0, 1, False),
          ('rodete', 0, 1, False), ('gorra', 0, 1, False), ('pelado', 0, 1, False), ('lentes', 0, 0, False)]
IMAGE_LAYERS = [n for n, t, _, _ in LAYERS if t == 0]


def build_frame(view, o):
    rows = list(FRONT if view == 'f' else BACK)
    if view == 'f':
        if o.get('blink') or o.get('sleep'):
            rows[6] = ".osssssssso."
        if o.get('look_up'):
            rows[6], rows[7] = ".oseesseeso.", ".osssssssso."
        if o.get('mouth') == 'o':
            rows[8] = ".obssoossbo."
        elif o.get('mouth') == 'small':
            rows[8] = ".obsssossbo."
    shake, breath = o.get('shake', 0), o.get('breath', 0)
    head = o.get('droop', 0) + o.get('nod', 0)

    def dy(r):
        return (-1 if breath and r < 17 else 0) + (head if r < 12 else 0)

    out = {}

    def put(layer, r, row):
        px = out.setdefault(layer, {})
        for k, ch in enumerate(row):
            if ch != '.':
                px[(OX + k + shake, OY + r + dy(r))] = ch

    for r, row in enumerate(rows):
        put('cuerpo', r, row)
    if breath:
        for k, ch in enumerate(rows[16]):
            if ch != '.':
                out['cuerpo'][(OX + k + shake, OY + 16)] = ch
    pose = o.get('pose', 'rest')
    if view == 'f' or pose == 'head':
        for k, r in POSE[pose]:
            out['cuerpo'][(OX + k + shake, OY + r + dy(r))] = 's'
    if o.get('sweat'):
        out['cuerpo'][(OX + 11 + shake, OY + 4 + dy(4) + o.get('sweat_y', 0))] = 'd'
    for name, views in HAIR.items():
        start, hr = views[view]
        for i, row in enumerate(hr):
            put(name, start + i, row)
    start, gr = GLASSES[view]
    for i, row in enumerate(gr):
        put('lentes', start + i, row)
    return out


def layer_image(pixels):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for (x, y), ch in (pixels or {}).items():
        if 0 <= x < W and 0 <= y < H:
            img.putpixel((x, y), PAL[ch] + (255,))
    return img


frames, tags = [], []
for ti, (name, view, ms, opts) in enumerate(ANIMS):
    start = len(frames)
    for o in opts:
        data = build_frame(view, o)
        frames.append({'ms': ms, 'imgs': {ln: layer_image(data.get(ln)) for ln in IMAGE_LAYERS}})
    tags.append({'name': name, 'from': start, 'to': len(frames) - 1, 'color': TAG_COLORS[ti % len(TAG_COLORS)]})


# ---------- .aseprite (formato documentado en github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md)
def ase_string(s):
    b = s.encode('utf-8')
    return struct.pack('<H', len(b)) + b


def chunk(kind, data):
    return struct.pack('<IH', len(data) + 6, kind) + data


def cel_chunk(layer_index, img):
    bbox = img.getbbox()
    if not bbox:
        return None
    crop = img.crop(bbox)
    head = struct.pack('<HhhBHh5x', layer_index, bbox[0], bbox[1], 255, 2, 0)
    return chunk(0x2005, head + struct.pack('<HH', crop.width, crop.height) + zlib.compress(crop.tobytes(), 9))


palette = []
for c in PAL.values():
    if c not in palette:
        palette.append(c)

frame_blobs = []
for fi, fr in enumerate(frames):
    chunks = []
    if fi == 0:
        chunks.append(chunk(0x2007, struct.pack('<HHI8x', 1, 0, 0)))
        pal = struct.pack('<III8x', len(palette), 0, len(palette) - 1)
        pal += b''.join(struct.pack('<HBBBB', 0, *c, 255) for c in palette)
        chunks.append(chunk(0x2019, pal))
        for name, kind, level, visible in LAYERS:
            flags = (1 if visible else 0) | 2
            chunks.append(chunk(0x2004, struct.pack('<HHHHHHB3x', flags, kind, level, 0, 0, 0, 255) + ase_string(name)))
        tag_data = struct.pack('<H8x', len(tags))
        for t in tags:
            tag_data += struct.pack('<HHBH6x', t['from'], t['to'], 0, 0) + bytes(t['color']) + b'\x00' + ase_string(t['name'])
        chunks.append(chunk(0x2018, tag_data))
    for li, (name, kind, _, _) in enumerate(LAYERS):
        if kind == 0:
            c = cel_chunk(li, fr['imgs'][name])
            if c:
                chunks.append(c)
    body = b''.join(chunks)
    n = len(chunks)
    frame_blobs.append(struct.pack('<IHHH2xI', 16 + len(body), 0xF1FA, min(n, 0xFFFF), fr['ms'], n) + body)

payload = b''.join(frame_blobs)
header = struct.pack('<IHHHHHIHIIB3xHBBhhHH', 128 + len(payload), 0xA5E0, len(frames), W, H, 32, 1, 100, 0, 0,
                     0, 0, 1, 1, 0, 0, 16, 16) + b'\x00' * 84
assert len(header) == 128
with open(os.path.join(OUT, 'personaje.aseprite'), 'wb') as f:
    f.write(header + payload)

# ---------- hoja PNG + JSON para la app
sheet = Image.new('RGBA', (W * len(frames), H * len(IMAGE_LAYERS)), (0, 0, 0, 0))
meta_frames = {}
for li, ln in enumerate(IMAGE_LAYERS):
    for fi, fr in enumerate(frames):
        sheet.paste(fr['imgs'][ln], (fi * W, li * H))
        meta_frames[f'{ln}#{fi}'] = {'frame': {'x': fi * W, 'y': li * H, 'w': W, 'h': H}, 'duration': fr['ms']}
sheet.save(os.path.join(OUT, 'personaje.png'))
hexc = lambda c: '#%02x%02x%02x' % c
with open(os.path.join(OUT, 'personaje.json'), 'w', encoding='utf-8') as f:
    json.dump({'frames': meta_frames, 'meta': {
        'app': 'generar_personaje.py', 'image': 'personaje.png', 'size': {'w': sheet.width, 'h': sheet.height},
        'frameSize': {'w': W, 'h': H}, 'anchor': {'x': ANCHOR[0], 'y': ANCHOR[1]},
        'layers': [{'name': n, 'group': 'peinados' if lvl else None} for n, t, lvl, _ in LAYERS if t == 0],
        'frameTags': [{'name': t['name'], 'from': t['from'], 'to': t['to'], 'direction': 'forward'} for t in tags],
        'keyColors': {k: [hexc(PAL[ch]) for ch in v] for k, v in KEYS.items()}}}, f, ensure_ascii=False, indent=1)

# ---------- vista previa ampliada
S = 6
cols = max(t['to'] - t['from'] + 1 for t in tags)
prev = Image.new('RGBA', (110 + cols * (W * S + 6), len(tags) * (H * S + 10) + 10), (32, 27, 40, 255))
dr = ImageDraw.Draw(prev)
for ti, t in enumerate(tags):
    y = 10 + ti * (H * S + 10)
    dr.text((8, y + H * S // 2 - 6), t['name'], fill=(239, 233, 244, 255))
    hair = ['corto', 'largo', 'rodete', 'gorra', 'pelado'][ti % 5]
    for k, fi in enumerate(range(t['from'], t['to'] + 1)):
        comp = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for ln in ['cuerpo', hair] + (['lentes'] if hair == 'pelado' else []):
            comp.alpha_composite(frames[fi]['imgs'][ln])
        prev.alpha_composite(comp.resize((W * S, H * S), Image.NEAREST), (110 + k * (W * S + 6), y))
prev.save(os.path.join(OUT, 'vista_previa.png'))
print(f'{len(frames)} cuadros, {len(tags)} etiquetas, {len(IMAGE_LAYERS)} capas de imagen')
