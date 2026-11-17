# Especificación de pixel art para la oficina

Pixel art real: cada pixel en la grilla, sin antialias, sin difuminados ni semitransparencias (salvo la sombra del piso). Entregar a escala 1× (sin agrandar).

## Vista y luz

- Isométrica 2:1: las líneas "horizontales" del piso suben 1 pixel cada 2 de ancho.
- Baldosa del piso: 48 × 24 px.
- Luz desde arriba a la izquierda: la cara izquierda de cada volumen es la clara, la derecha la oscura.
- Muebles con contorno de 1 px en #2a1f2e. Personajes sin contorno negro: el borde es un tono más oscuro del mismo color.

## Personajes

- Cuerpo entero, **sin cara** (solo piel), proporción realista.
- Tamaño: **12 px de ancho × 32 px de alto**.
  - cabeza 7 px
  - torso 10 px
  - piernas 10 px
  - calzado 2 px
- Cuadro por frame: **16 × 36 px**, transparente, personaje centrado en x = 8.
  - **Parado:** los pies apoyan en la fila 34.
  - **Sentado:** el asiento queda en la fila 25; las piernas bajan hasta la 30 y en la oficina las tapa el escritorio.
- Vista 3/4 en diagonal, **dos direcciones** (las otras dos salen espejando):
  - **SE**, de frente mirando abajo a la derecha:
    - se ve la piel de la cara del lado derecho y el pelo cubre el lado izquierdo de la cabeza
    - el costado izquierdo del cuerpo va en un tono más oscuro
  - **NE**, de espalda mirando arriba a la derecha:
    - el pelo tapa la nuca y asoma la mejilla a la derecha
    - el costado derecho va más oscuro

### Capas (cada una en su propio PNG o capa, mismo cuadro, fondo transparente)

1. `cuerpo`: piel (cabeza, cuello, manos, piernas desnudas).
2. `peinado`, por separado cada uno: corto, peinado al costado, alto, bob, largo, coletas, cola de caballo.
3. `arriba`: remera, polo, camisa con corbata, campera abierta, traje, vestido, jardinero, musculosa.
4. `abajo`: pantalón, short, pollera.
5. `calzado`.
6. `accesorios` (opcional): lentes, gorra, vincha, reloj.

### Colores clave (la app los reemplaza por los de cada agente; usar exactamente estos)

| Parte | Claro | Oscuro | Extra |
|---|---|---|---|
| Piel | #f7d2a8 | #dca67e | |
| Pelo | #5b3a29 | #3c2519 | |
| Ropa de arriba | #e2574c | #b13d3d | #f78a72 (brillo) |
| Ropa de abajo | #3d4262 | #2b2f48 | |
| Calzado | #24242a | #18181c | |

Todo lo demás (botones, cierres, cinturón, cordones) puede ir en colores fijos.

### Animaciones (frames de 16×36; la duración es orientativa)

| Nombre | Dirección | Frames | ms por frame |
|---|---|---|---|
| respirar (parado) | SE y NE | 4 | 160 |
| caminar | SE y NE | 6 | 100 |
| sentado_tipear | SE y NE | 4 | 120 |
| sentado_pensar (mano al mentón) | SE | 4 | 170 |
| sentado_error (se agarra la cabeza) | SE y NE | 4 | 100 |
| sentado_dormir (cabeceo) | SE y NE | 4 | 230 |
| hablar (parado, gesticula) | SE | 4 | 140 |

## Muebles y objetos

En la misma isométrica y con la misma luz. Medidas de referencia (alto en px de pantalla):

- escritorio: 53 × 26 px de planta, 16 px de alto
- silla de oficina: asiento a 10 px, respaldo hasta 26 px, base en cruz con rueditas
- monitor: 19 px de ancho, pantalla de 14 px de alto, apoyado sobre el escritorio
- mesa de reunión, sillón, mesa ratona, ping-pong, arcade, heladera, cafetera, plantas en maceta, biblioteca, pizarra

## Entrega

- **Personajes:** una hoja PNG por capa, con **filas = animación + dirección** y **columnas = frames**, más un JSON con la posición y duración de cada frame (formato de exportación de Aseprite: `--sheet` y `--data` con `--list-tags`). Un archivo `.aseprite` con capas y etiquetas también sirve.
- **Muebles:** un PNG por objeto, recortado justo, indicando dónde está el punto que apoya en el piso.
- Nombres en minúscula y sin espacios: `peinado-bob.png`, `arriba-traje.png`, `silla.png`.
