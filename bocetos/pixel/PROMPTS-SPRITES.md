# Cómo pedir los sprites a otra IA

Las IAs que generan imágenes no entregan sprites listos para un juego: no respetan medidas exactas, no dejan el fondo transparente y les cuesta mantener el mismo personaje igual entre poses. Así que no les pedimos el archivo final. Les pedimos **el dibujo bien hecho y parejo**, y después yo lo corto, lo bajo a pixeles reales, le saco el fondo y lo conecto a la oficina.

## Pasos

1. **Prueba con un personaje** (prompt 1). Revisá que se vea igual en todas las poses y que el estilo te guste. Si no, repetí antes de seguir.
2. **El resto de los personajes** (prompt 2), adjuntando la imagen aprobada del paso 1 como referencia.
3. **Más animaciones** (prompt 3), de nuevo con la referencia.
4. **Muebles y objetos** (prompt 4), adjuntando también tu imagen de la oficina grande como referencia de estilo.
5. Pasame los PNG tal como salen. Yo los limpio y los conecto.

Como referencia de estilo, adjuntá tus propias imágenes de la oficina. No adjuntes la imagen de Freepik: alcanza con describir el estilo, así no copia personajes de otro autor.

---

## Prompt 1: personaje de prueba

```
Hoja de sprites en pixel art para un juego isométrico de oficina.

Estilo: pixel art real de baja resolución, pixeles grandes y nítidos, todos del mismo tamaño, sin antialias, sin degradés suaves, sin desenfoque. Personajes de cuerpo entero con proporciones realistas (unas 4 cabezas y media de alto), SIN CARA: la cara es solo piel, sin ojos ni boca. Sombreado simple con 2 o 3 tonos por color, luz desde arriba a la izquierda, sin contorno negro (el borde es un tono más oscuro del mismo color).

Personaje: mujer de unos 30 años, pelo castaño a la altura de los hombros, saco gris y pollera gris, zapatos negros.

Vista: isométrica 3/4 en diagonal. Dos direcciones:
- de frente, mirando hacia abajo a la derecha
- de espaldas, mirando hacia arriba a la derecha

Organizá la hoja como una grilla de celdas iguales, un personaje por celda, todos del mismo tamaño y apoyados a la misma altura:
- fila 1: parada de frente, respirando, 4 cuadros
- fila 2: caminando de frente, 6 cuadros
- fila 3: parada de espaldas, respirando, 4 cuadros
- fila 4: caminando de espaldas, 6 cuadros

Fondo: un solo color plano magenta (#FF00FF) en toda la imagen. Sin sombras en el piso, sin escenario, sin líneas de grilla, sin texto, sin marca de agua.
```

## Prompt 2: el resto de los personajes

Adjuntá la hoja aprobada del paso 1 y pedí de a uno o dos personajes por vez (en una sola imagen grande se pierde detalle):

```
Usando exactamente el mismo estilo, tamaño de personaje, tamaño de pixel, perspectiva, iluminación, fondo magenta (#FF00FF) y organización de filas que la imagen adjunta, dibujá este personaje nuevo con las mismas 4 filas de animación:

[DESCRIPCIÓN]
```

Personajes para pedir (o los tuyos):

- hombre con traje gris oscuro, camisa blanca y corbata roja, pelo castaño corto peinado al costado
- hombre joven con campera roja abierta sobre remera celeste, pantalón gris, zapatillas rojas con suela blanca, pelo castaño parado
- hombre con chomba gris, jean azul oscuro, zapatos marrones, reloj negro, pelo pelirrojo corto
- hombre con remera verde agua, short naranja, medias blancas, zapatillas verde agua, vincha naranja, piel morena
- mujer rubia de pelo suelto con vestido celeste corto y zapatillas celestes
- mujer rubia con colitas, jardinero de jean azul sobre remera blanca, botas marrones
- mujer de piel oscura con musculosa naranja, calza corta verde agua, gorra amarilla y cola de caballo
- vos (Luis): campera verde sobre remera blanca, jean azul, zapatillas blancas, pelo oscuro peinado

## Prompt 3: animaciones sentado

Con la referencia adjunta, por cada personaje:

```
Mismo personaje, mismo estilo, tamaño de pixel y fondo magenta que la imagen adjunta. Ahora sentado en una silla de oficina (sin dibujar la silla, solo la persona en posición sentada), en las mismas dos direcciones:
- fila 1: sentado de frente, tecleando, 4 cuadros
- fila 2: sentado de espaldas, tecleando, 4 cuadros
- fila 3: sentado de frente, pensando con una mano en el mentón, 4 cuadros
- fila 4: sentado de frente, agarrándose la cabeza preocupado, 4 cuadros
- fila 5: sentado de frente, dormido cabeceando, 4 cuadros
- fila 6: parado de frente, hablando y gesticulando con las manos, 4 cuadros
```

## Prompt 4: muebles y objetos

Adjuntá tu imagen de la oficina grande como referencia de estilo:

```
Hoja de objetos en pixel art isométrico 2:1 (las líneas del piso suben 1 pixel cada 2 de ancho) para una oficina, con el mismo estilo de la imagen adjunta: pixel art real, pixeles grandes y parejos, sin antialias, contorno oscuro de 1 pixel, luz desde arriba a la izquierda (la cara izquierda más clara, la derecha más oscura).

Un objeto por celda, todos a la misma escala, para personajes de unos 48 pixeles de alto:
escritorio blanco con patas de madera; escritorio doble de madera; silla de oficina con ruedas (vista de frente y de espaldas); monitor (de frente y de espaldas); notebook abierta; mesa de reunión larga de madera; sillón de dos cuerpos; mesa ratona; biblioteca con libros; pizarra blanca con dibujos; dispensador de agua; cafetera sobre mesada; máquina expendedora; heladera; mesa de ping-pong; arcade; plantas en maceta (chica, mediana y alta); lámpara colgante; puerta de madera; alfombra rectangular.

Fondo: un solo color plano magenta (#FF00FF). Sin sombras en el piso, sin texto, sin marca de agua.
```

## Qué revisar antes de pasármelos

- El personaje se ve **igual en todas las celdas**: misma altura, misma ropa, mismo peinado.
- Los pixeles son **cuadrados parejos**, no manchas suaves. Si hacés zoom, se ven bloques nítidos.
- El fondo es **magenta liso**, sin degradé ni sombra.
- Las dos direcciones son **diagonales**: no de frente plano ni de perfil.
- No hay texto ni logos.

Si algo falla, pedí que lo corrija nombrando el problema ("el personaje cambia de altura entre la fila 1 y la 2", "los pixeles están borrosos").
