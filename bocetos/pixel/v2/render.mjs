// Vista previa sin navegador: carga nucleo.js y los módulos indicados, llama a una función de vista previa
// y guarda un PNG agrandado para revisarlo.
// Uso: node render.mjs <salida.png> <ancho> <alto> <escala> <función> <módulo.js> [más módulos...]
//   La función recibe (g, N, t) y dibuja sobre g, un contexto falso que solo implementa fillRect/fillStyle/globalAlpha.
import fs from 'node:fs'; import zlib from 'node:zlib'; import vm from 'node:vm'; import path from 'node:path';
const [out, W, H, ESC, fn, ...mods] = process.argv.slice(2);
const w = +W, h = +H, k = +ESC || 3;
const buf = new Uint8ClampedArray(w * h * 4);
function parse(c) {
  if (c.startsWith('#')) { let s = c.slice(1); if (s.length === 3) s = s.split('').map(x => x + x).join(''); const n = parseInt(s.slice(0, 6), 16); const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1; return [n >> 16, n >> 8 & 255, n & 255, a]; }
  const m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255, 1];
}
const g = {
  fillStyle: '#000', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
  fillRect(x, y, ww, hh) {
    const [r, gg, b, a0] = parse(this.fillStyle); const a = a0 * this.globalAlpha;
    for (let j = Math.max(0, y | 0); j < Math.min(h, (y | 0) + hh); j++) for (let i = Math.max(0, x | 0); i < Math.min(w, (x | 0) + ww); i++) {
      const o = (j * w + i) * 4, ia = buf[o + 3] / 255, na = a + ia * (1 - a);
      if (na <= 0) continue;
      buf[o] = (r * a + buf[o] * ia * (1 - a)) / na; buf[o + 1] = (gg * a + buf[o + 1] * ia * (1 - a)) / na; buf[o + 2] = (b * a + buf[o + 2] * ia * (1 - a)) / na; buf[o + 3] = na * 255;
    }
  },
  clearRect() { }, drawImage() { }, save() { }, restore() { }
};
const ctx = vm.createContext({ console, Math, globalThis: null });
ctx.globalThis = ctx;
const dir = path.dirname(new URL(import.meta.url).pathname);
vm.runInContext(fs.readFileSync(path.join(dir, 'nucleo.js'), 'utf8'), ctx);
for (const m of mods) vm.runInContext(fs.readFileSync(path.resolve(m), 'utf8'), ctx);
ctx.N.g = g;
const f = vm.runInContext(fn, ctx);
// fondo neutro
g.fillStyle = '#e9e4dc'; g.fillRect(0, 0, w, h);
f(g, ctx.N, +(process.env.T || 0));
// agrandar y codificar PNG
const W2 = w * k, H2 = h * k, raw = Buffer.alloc((W2 * 4 + 1) * H2);
for (let y = 0; y < H2; y++) { raw[y * (W2 * 4 + 1)] = 0; for (let x = 0; x < W2; x++) { const s = (((y / k) | 0) * w + ((x / k) | 0)) * 4, d = y * (W2 * 4 + 1) + 1 + x * 4; raw[d] = buf[s]; raw[d + 1] = buf[s + 1]; raw[d + 2] = buf[s + 2]; raw[d + 3] = buf[s + 3]; } }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W2, 0); ih.writeUInt32BE(H2, 4); ih[8] = 8; ih[9] = 6;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('ok', out, W2 + 'x' + H2);
