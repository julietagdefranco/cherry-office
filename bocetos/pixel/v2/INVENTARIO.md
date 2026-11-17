# Inventario de sprites (a partir de las imágenes de referencia)

Escala común: baldosa isométrica de 60 × 30 px (S = 2,5). Personaje parado: 16 × 42 px. Escritorio: unos 20 px de alto.
Luz desde arriba a la izquierda. Personajes **sin cara**.

## Salas (planta de 24 × 14 baldosas, pasillo en el medio)

| Sala | Lugar en la app | Contenido |
|---|---|---|
| Producto | departamento | 3 escritorios dobles blancos, monitores, sillas, alfombra azul, biblioteca, planta |
| Sala de reuniones | reunión | mesa larga de madera, 6 sillas, TV en pie, pizarra, lámparas colgantes |
| Ingeniería | departamento | 3 escritorios dobles, monitores, alfombra verde, pizarra, planta |
| Dirección | dirección | escritorio grande en L, sillón, 2 sillas de visita, biblioteca, cuadro, alfombra violeta |
| Contenido | departamento | 3 escritorios dobles, alfombra rosada, corcho con notas, planta |
| Recepción | recepción | mostrador, puerta de entrada vidriada, felpudo, sillas de espera, dispensador de agua, planta |
| Juegos y café | juegos y café | mesada con cafetera y microondas, heladera, máquina expendedora, mesas altas con banquetas, sillón, mesa ratona, ping-pong, arcade, puffs |
| Despacho de Luis | despacho | escritorio de madera, silla, biblioteca, cuadro, planta, lámpara de pie |
| Biblioteca | biblioteca | estanterías altas, mesa de lectura, sillón, lámpara |

## Arquitectura

- Piso de madera en salas; piso de baldosa gris en pasillo y recepción.
- Paredes exteriores altas (fondo e izquierda) con **ventanales con ciudad** que cambian con la hora.
- Paredes interiores a media altura, cortadas (vista de maqueta), con **puertas de madera** con marco.
- Zócalo, cornisa, reloj de pared, cuadros, pizarras, corchos.

## Muebles y objetos

| Grupo | Sprites |
|---|---|
| Trabajo | escritorio doble blanco, escritorio de madera, escritorio en L, monitor (frente/espalda), notebook, teclado y mouse, taza, papeles, lámpara de escritorio, impresora |
| Asientos | silla de oficina con ruedas (4 direcciones), silla de visita, banqueta, sillón de 2 cuerpos, sillón individual, puff |
| Mesas | mesa de reunión larga, mesa redonda alta, mesa ratona, mesa de lectura, mostrador de recepción |
| Guardado | biblioteca con libros, archivero, mueble bajo con puertas |
| Cocina | mesada con bajo mesada, cafetera, microondas, heladera, máquina expendedora, dispensador de agua (bidón azul), tacho de basura |
| Juegos | mesa de ping-pong, arcade |
| Pared | ventanal con ciudad, puerta de madera, puerta vidriada, pizarra con gráfico, corcho con notas, cuadro, TV en pie, reloj |
| Deco | planta chica, planta mediana, planta alta (tipo palmera), lámpara colgante, lámpara de pie, felpudo, alfombras por sala |

## Personajes

- Cuerpo entero, proporción realista, **sin cara**, 16 × 42 px, dos direcciones dibujadas (frente y espalda en diagonal) más espejo.
- Por capas recoloreables: piel, peinado (8), arriba (8), abajo (3), calzado, accesorios (lentes, gorra, vincha, reloj, tablet).
- Animaciones:

| Animación | Direcciones | Cuadros |
|---|---|---|
| parado respirando | frente, espalda | 4 |
| caminando | frente, espalda (+ espejo = 4 direcciones) | 6 |
| sentado tecleando | frente, espalda | 4 |
| sentado pensando | frente | 4 |
| sentado preocupado (error) | frente, espalda | 4 |
| sentado dormido | frente, espalda | 4 |
| parado hablando | frente | 4 |
| parado con tablet | frente | 2 |

## Comportamiento

- Cada agente tiene su puesto. Según su estado trabaja sentado, va a reunión caminando, va a la cocina por café o se tira en el sillón cuando está inactivo.
- Caminan por el pasillo y entran por las puertas; orientan el cuerpo según hacia dónde van.
