# Caso Próspera: mapeo esperado del Creador

Qué debería proponer el Creador si se le pega `texto-original.md` estando abierta la oficina actual de Próspera HQ (5 departamentos y 8 agentes; el test `backend/test/unit/caso-prospera.test.ts` la arma por la API). Este archivo hecho a mano es la vara para probarlo: cada tarjeta trae su tipo, su estado (`borrador` o `lista`), el fragmento de origen, la conciliación con la oficina actual (`nuevo`, `cambia` o `existente`) y lo que le falta.

Reglas del mapeo:
- **No inventar.** Lo que el texto no dice queda como **falta** o como pregunta, no como valor.
- **Una tarjeta por cosa.** Si el texto repite algo (por ejemplo «no inventar» aparece en la regla 1 y en varios límites), la cosa va en un solo lugar (en este caso la regla) y las demás tarjetas la referencian.
- **Nada se crea solo.** Todas las tarjetas quedan como propuesta hasta que Juli las aprueba, de a partes.

Convenciones: «Juli» es la persona dueña de la oficina. «La persona» en un paso de flujo es Juli. Las citas son textuales y van entre comillas angulares.

---

## 0. Resumen de diferencias con la oficina actual

| Tipo | Nuevo | Cambia | Existente no mencionado |
|---|---|---|---|
| Departamentos | `productos` | `dir`, `redes` → `contenido`, `ads` → `crecimiento`, `clases` → `educacion` | `video` (Edición de video) |
| Agentes | Diseñadora de presentaciones, Guionista, Analista de Instagram, Directora creativa de anuncios (se separa de Nicolás), Product Manager de formación, Especialista en experiencia de alumnas | Betty → Chief of Staff (coordinadora), Sofía → Directora académica, Don Armando → Editora audiovisual, Marce → Estratega editorial, Nicolás → Analista de performance | Catalina, Patricia, Mario |
| Reglas | 6 reglas de la oficina | — | Reglas que hoy repiten los `.md` de cada agente (no inventar, proponés y Juli aprueba) pasan a la oficina |
| Flujos | 3 (clase, contenido orgánico, anuncios) | — | — |
| Tareas recurrentes | 9 a 11 (ver sección 5) | Agenda diaria de Betty (hoy está en su prompt) | — |
| Conectores | Google Calendar (disponible), Notion, Instagram, Meta Ads (no disponibles) | — | Gmail y Drive (disponibles, el texto no los pide) |

El texto habla de «once chats»: son las 11 tarjetas de agente de la sección 2. La oficina actual tiene 8. Si se aplica todo y se conservan los 3 no mencionados, la oficina queda con 14 agentes, y hay solapamientos (ver huecos H1 a H3).

---

## 1. Departamentos

### D1 · `dir` · Dirección y operaciones — cambia · lista
- **Origen:** «## 1. Dirección y operaciones»
- **Misión:** falta. El texto no le da misión explícita (es el único departamento sin «Su misión es…»). Se puede derivar del objetivo de su único agente, pero el Creador debe preguntarla o dejarla vacía, no redactarla.
- **Conciliación:** hoy se llama «Dirección». Cambia el nombre.

### D2 · `educacion` · Departamento de educación — cambia · lista
- **Origen:** «Su misión es convertir tu conocimiento en experiencias educativas de calidad, especialmente para PRÓSPERAS.»
- **Misión:** convertir el conocimiento de Juli en experiencias educativas de calidad, especialmente para PRÓSPERAS.
- **Conciliación:** reemplaza a `clases` («Clases de PRÓSPERAS»). Conviene renombrar `clases` (mantener el id evita mover agentes y carpetas `archivos/clases/`) en lugar de crear uno nuevo. Pregunta P3.

### D3 · `contenido` · Departamento de contenido orgánico — cambia · lista
- **Origen:** «Su misión es construir posicionamiento, comunidad y reconocimiento de marca a través de contenido estratégico.»
- **Misión:** construir posicionamiento, comunidad y reconocimiento de marca con contenido estratégico.
- **Conciliación:** equivale a `redes` («Redes y estrategia digital»). Hoy tiene a Marce, Catalina y Patricia.

### D4 · `crecimiento` · Departamento de crecimiento y publicidad — cambia · lista
- **Origen:** «Su misión es mejorar el rendimiento comercial de los productos y campañas de Cherry Glow.»
- **Misión:** mejorar el rendimiento comercial de productos y campañas de Cherry Glow.
- **Conciliación:** equivale a `ads` («Ads»). Hoy tiene a Nicolás.

### D5 · `productos` · Departamento de productos y experiencia de alumnas — nuevo · lista
- **Origen:** «Su misión es desarrollar, mantener y mejorar el catálogo educativo de Academia Cherry Glow.»
- **Misión:** desarrollar, mantener y mejorar el catálogo educativo de Academia Cherry Glow.

### D6 · `video` · Edición de video — existente no mencionado
- No aparece en el texto. Su agente Don Armando pasa a Educación (A4) y Mario queda sin departamento mencionado (H1). Si los dos se mueven, `video` queda vacío. **El Creador no lo borra:** pregunta (P3).

---

## 2. Agentes

Formato de los límites: **hace solo** = puede hacerlo y lo entrega; **propone y espera** = deja una entrega con la propuesta y no sigue hasta el «Listo» de Juli. Lo que el texto no dice queda en «falta». Todos heredan además las reglas de la oficina (sección 3).

### A1 · Chief of Staff · `dir` · coordinador — cambia (Betty) · borrador
- **Origen:** «### Chief of Staff» y «**Objetivo:** garantizar que Cherry Glow avance de manera organizada, con prioridades claras y sin depender de que vos recuerdes absolutamente todo.»
- **Objetivo:** que Cherry Glow avance ordenada y con prioridades claras sin que Juli tenga que acordarse de todo.
- **Responsabilidades:** conocer las cuatro marcas (Cherry Glow, Academia Cherry Glow, PRÓSPERAS, ARTEMPRESARIAS); mantener el estado de proyectos, lanzamientos, cursos y tareas; armar agenda diaria y semanal desde Calendar y Notion; priorizar por urgencia, impacto, esfuerzo y objetivos; coordinar entregables de los demás; detectar bloqueos, retrasos y duplicados; proponer qué delegar, posponer, simplificar o eliminar; preparar revisiones semanales y mensuales; proteger bloques de grabación y compromisos personales.
- **Entregables:** agenda diaria, planificación semanal, tablero de prioridades, seguimiento de proyectos, reporte de bloqueos.
- **Coordinador: sí.** Origen: «Coordinar los entregables de los demás departamentos.» y «Detectar bloqueos, retrasos, tareas duplicadas…». Es exactamente el rol coordinador de la visión (ve notas, entregas y flujos de todos, arma parte y reporte de bloqueos).
- **Límites:**
  - Hace solo: leer Calendar (y Notion si estuviera), armar agenda, planificación, tablero, seguimiento y reporte de bloqueos; leer notas y entregas de todos.
  - Propone y espera: crear o mover eventos (incluido «proteger bloques de grabación»), modificar fechas o prioridades estratégicas, delegar, posponer o eliminar proyectos, repartir encargos a otros agentes (pregunta P7). Origen: «no inventa tareas ni modifica fechas o prioridades estratégicas sin tu aprobación».
- **Conectores:** Google Calendar (leer: hace solo; crear o mover eventos: propone). Notion (leer): no disponible (C2).
- **Falta:** si reparte encargos solo o los propone (P7); con qué umbral cuenta un paso como «trabado» (P8).
- **Conciliación con Betty:** coincide en casi todo (agenda 08:00, priorización, dirigir al equipo, no crear eventos sin instrucción). Lo que Betty tiene y el texto no: Banco del Sol, domingos de descanso, horarios mañana/tarde, «no mandes la agenda por Gmail ni Slack», escribir `decisiones.md`. Se conserva salvo que Juli diga lo contrario (P2). Cambia: rol, se le da el permiso de coordinador y la agenda pasa a ser tarea recurrente (T1).

### A2 · Directora académica y diseñadora instruccional · `educacion` — cambia (Sofía) · lista
- **Origen:** «### Directora académica y diseñadora instruccional» y «**Objetivo:** diseñar clases que realmente enseñen algo y ayuden a las alumnas a implementar lo aprendido.»
- **Responsabilidades:** planificación educativa mensual y trimestral de PRÓSPERAS; investigar en fuentes confiables; revisar lo ya enseñado para no repetir; objetivos de aprendizaje por clase; progresión lógica; guiones naturales de 15 a 20 minutos; ejemplos y aplicaciones al negocio artesanal; desafíos, ejercicios, plantillas y descargables; revisar nivel pedagógico; recomendar mejoras según dudas y resultados de las alumnas.
- **Entregables:** plan curricular, ficha de clase, guion completo, ejercicios y materiales de apoyo.
- **Límites:**
  - Hace solo: investigar, redactar plan, ficha, guion y materiales.
  - Propone y espera: el plan curricular y cada guion (la diseñadora trabaja sobre «guiones educativos aprobados»).
  - No le corresponde: «no define nuevos cursos comerciales; eso corresponde al área de productos». Es un límite de ámbito: deriva a A10.
- **Conectores:** ninguno pedido. Necesita leer lo publicado en Skool para no repetir (hoy en el prompt de Sofía): no hay conector (H8).
- **Conciliación:** Sofía ya hace esto (tema del mes, mapas, guiones, desafíos, no repetir). El texto pide guion completo; Sofía hoy dice «mapa de clase, no guiones kilométricos». Diferencia a confirmar (P2).

### A3 · Diseñadora de presentaciones educativas · `educacion` — nuevo · borrador
- **Origen:** «### Diseñadora de presentaciones educativas» y «**Objetivo:** transformar los guiones en presentaciones visuales, atractivas y fáciles de utilizar al grabar.»
- **Responsabilidades:** interpretar guiones aprobados; estructura visual; qué va en pantalla y qué en la voz; diapositivas con jerarquía, ejemplos, comparaciones y diagramas; capturas, referencias, memes y recursos; respetar el sistema visual y tipografías de PRÓSPERAS; consistencia entre clases; plantillas reutilizables; revisar legibilidad y carga; formato editable.
- **Entregables:** PowerPoint editable, recursos gráficos, notas de presentación.
- **Límites:**
  - Hace solo: armar la presentación y las notas.
  - Propone y espera: cualquier cambio de concepto técnico o de contenido pedagógico. Origen: «no modifica los conceptos técnicos ni el contenido pedagógico sin validación». Falta: ¿la validación es de Juli o de la Directora académica (A2)? (P9)
- **Conectores:** ninguno. Necesita herramientas locales para producir `.pptx`.
- **Falta:** nombre; verificar que puede producir un PowerPoint editable (H6); dónde está el sistema visual de PRÓSPERAS (hay `Marca/` y `Manual de marca.pdf` en la carpeta de Juli: vincular a su biblioteca).

### A4 · Editora y productora audiovisual de clases · `educacion` — cambia (Don Armando) · borrador
- **Origen:** «### Editora y productora audiovisual de clases» y «**Objetivo:** convertir las grabaciones en clases terminadas, claras y profesionales.»
- **Responsabilidades:** revisar grabaciones y guion original; detectar errores, silencios y repeticiones; proponer cortes y transiciones; sincronizar voz, diapositivas y recursos; subtítulos, rótulos, acercamientos; consistencia; calidad de audio y ritmo; detectar tomas a repetir; versiones finales completas; archivos de producción ordenados.
- **Entregables:** plan de edición, lista de correcciones y video final «cuando disponga de herramientas para editar archivos».
- **Límites:**
  - Hace solo: plan de edición y lista de correcciones.
  - Propone y espera: el plan de edición antes de renderizar (hoy en el prompt de Don Armando: «mostráselo a Juli antes de renderizar»); pedir nuevas tomas.
  - No le corresponde: «no reescribe el contenido académico ni altera el sentido de tus explicaciones».
- **Conectores:** ninguno. Herramientas locales: ffmpeg, whisper y Python (ya existen en `_herramientas/` de Juli).
- **Conciliación:** Don Armando ya tiene el pipeline de las clases 1 y 2. El texto lo trata como si no tuviera herramientas (H5). Cambia de departamento (`video` → `educacion`). El rol del texto es femenino y Don Armando es masculino: el Creador no debe renombrar ni cambiar el avatar sin preguntar (P2).

### A5 · Estratega y planificadora editorial · `contenido` — cambia (Marce) · lista
- **Origen:** «### Estratega y planificadora editorial» y «**Objetivo:** definir qué comunicar, cuándo hacerlo y para qué.»
- **Responsabilidades:** estrategia mensual y trimestral; pilares, objetivos y temas; equilibrio entre posicionamiento, conexión, educación y venta; integrar lanzamientos y promociones; calendario editorial semanal y mensual; jornadas de grabación por lotes; priorizar formatos; evitar repetición y saturación comercial; usar aprendizajes de métricas; mantener el estado de cada pieza (idea, guion, grabación, edición, programación, publicación).
- **Entregables:** estrategia editorial, calendario de contenidos, briefs para guiones.
- **Límites:**
  - Hace solo: estrategia, calendario y briefs como borrador.
  - Propone y espera: estrategia y calendario (regla 6 y el límite de la guionista: «no decide por su cuenta el calendario»). Falta: ¿quién aprueba el calendario, Juli o la Chief of Staff?
  - No le corresponde: «no desarrolla todos los guiones; define qué piezas se necesitan».
- **Conectores:** Notion «Calendario creativo» (no disponible). Calendar (leer) para jornadas de grabación: el texto no lo pide explícitamente; preguntar.
- **Conciliación:** Marce define estrategia y piezas; el calendario hoy lo hace Catalina (H2). «Mantener el estado de cada pieza» es lo que muestran las corridas del flujo F2: con flujos, este estado lo lleva la app.

### A6 · Guionista y directora creativa · `contenido` — nuevo · borrador
- **Origen:** «### Guionista y directora creativa» y «**Objetivo:** transformar las ideas y experiencias de Juli en contenido que conecte y comunique con intención.»
- **Responsabilidades:** investigar formatos narrativos; desarrollar ideas desde el calendario; ganchos, guiones y estructuras para reels y carruseles; adaptar formatos virales sin copiar; usar experiencias reales de Juli; escribir con su voz («cercana, directa, natural y con humor»); guiones que pueda decir sin sonar memorizada; indicaciones de grabación; referencias visuales; captions y CTA; variantes.
- **Entregables:** guion listo para grabar, storyboard o guía visual, indicaciones de edición, caption.
- **Límites:**
  - Hace solo: guiones, storyboard, indicaciones, captions y variantes.
  - Propone y espera: el guion final (lo graba Juli con su voz).
  - No le corresponde: «no decide por su cuenta el calendario ni las prioridades comerciales».
- **Conectores:** ninguno.
- **Falta:** nombre. Las experiencias de Juli no se inventan (regla 1, y hoy lo dicen los prompts de Catalina y Sofía).
- **Conciliación:** solapa con Catalina en captions (H2).

### A7 · Analista de Instagram e investigación · `contenido` — nuevo · borrador
- **Origen:** «### Analista de Instagram e investigación» y «**Objetivo:** identificar qué contenidos funcionan, por qué y qué podemos aprender para mejorar.»
- **Responsabilidades:** métricas de reels, carruseles, historias y publicaciones; alcance, guardados, compartidos, interacciones, crecimiento y retención; comparar formatos y temas; patrones; referentes y tendencias; comentarios y preguntas; separar datos de hipótesis; proponer experimentos; compartir aprendizajes con la estratega y la guionista.
- **Entregables:** informe semanal, análisis mensual, patrones detectados, recomendaciones de experimentación.
- **Límites:**
  - Hace solo: informes y análisis (son lectura, no acción hacia afuera).
  - Propone: experimentos de contenido (los decide la estratega o Juli).
  - Estilo: «no garantiza viralidad ni atribuye resultados a causas que los datos no permiten demostrar».
- **Conectores:** Instagram / Meta (leer métricas): no disponible (C3). Sin él, las métricas tienen que venir de capturas o exportaciones que suba Juli (paso de la persona).
- **Falta:** nombre; de dónde salen los datos (P5).
- **Conciliación:** «Analizar comentarios y preguntas de la audiencia» solapa con Patricia (H3). «Compartir aprendizajes con…» es entregar a otros agentes: lo resuelve la memoria compartida o que sus entregas lleguen a A5 y A6 (concepto K10).

### A8 · Analista de performance y crecimiento · `crecimiento` — cambia (Nicolás, se divide) · borrador
- **Origen:** «### Analista de performance y crecimiento» y «**Objetivo:** evaluar qué está funcionando comercialmente y dónde conviene invertir recursos.»
- **Responsabilidades:** resultados de campañas; inversión, costo por resultado, conversiones y retorno; productos y páginas de venta; problemas de tráfico, creatividad, oferta o conversión; comparar históricos; oportunidades; pruebas A/B; rentabilidad; distribución de presupuesto; reportes con conclusiones.
- **Entregables:** dashboard, diagnóstico de campañas, recomendaciones, plan de pruebas.
- **Límites:**
  - Hace solo: diagnóstico, dashboard, reportes.
  - Propone y espera: plan de pruebas, distribución de presupuesto y cualquier cambio en campañas. Origen: «no cambia presupuestos ni campañas activas sin autorización».
- **Conectores:** Meta Ads (leer; actuar solo con aprobación): no disponible (C4). Google Sheets podría servir para el dashboard (disponible, el texto no lo pide).
- **Falta:** qué es el «dashboard» (archivo que se actualiza, hoja de cálculo): concepto K9.
- **Conciliación:** Nicolás hoy hace análisis y copies. El texto lo divide en A8 y A9. Propuesta: Nicolás queda como A8 y A9 es nuevo (P2).

### A9 · Directora creativa de anuncios y copywriter ADS · `crecimiento` — nuevo · borrador
- **Origen:** «### Directora creativa de anuncios y copywriter ADS» y «**Objetivo:** desarrollar anuncios persuasivos, claros y adaptados a cada producto.»
- **Responsabilidades:** deseos, dudas y objeciones de compradoras; propuesta de valor; ángulos; hooks y guiones de video; anuncios demostrativos, educativos, testimoniales y de objeciones; briefs de grabación; textos, títulos y CTA; variantes para testeo; usar aprendizajes del analista; evitar promesas engañosas.
- **Entregables:** banco de ángulos, guiones ADS, briefs de grabación, variantes para testeo.
- **Límites:**
  - Hace solo: ángulos, guiones, briefs y variantes.
  - Propone y espera: guiones que se graban (los graba Juli); toda promesa comercial (regla 6).
  - No le corresponde: «no decide cuánto invertir ni declara que un anuncio funcionará antes de probarlo».
- **Conectores:** ninguno.
- **Falta:** nombre.
- **Conciliación:** hoy esto lo hace Nicolás (copies y briefs). Usa sus skills `ads` / `ad-creative` (concepto K12).

### A10 · Product Manager de formación · `productos` — nuevo · borrador
- **Origen:** «### Product Manager de formación» y «**Objetivo:** identificar oportunidades para crear, actualizar y mejorar productos educativos.»
- **Responsabilidades:** inventario de cursos, talleres, ebooks y pendientes; necesidades del mercado; demanda; actualizaciones; evaluar por valor, esfuerzo, costo y potencial; propuestas de valor y alcance; roadmap; coordinar con Educación los cursos aprobados; feedback; ampliaciones y nuevas versiones.
- **Entregables:** roadmap de productos, fichas de oportunidades, propuestas de nuevos cursos, backlog priorizado.
- **Límites:**
  - Hace solo: inventario, fichas, roadmap y backlog como borrador.
  - Propone y espera: todo producto nuevo. Origen: «no inicia el desarrollo de nuevos productos sin aprobación». Una vez aprobado, encarga a Educación (posible flujo, H9).
- **Conectores:** ninguno.
- **Falta:** nombre; dónde vive el inventario (Notion, archivo de la oficina): K9.

### A11 · Especialista en experiencia de alumnas · `productos` — nuevo · borrador
- **Origen:** «### Especialista en experiencia de alumnas» y «**Objetivo:** mejorar la experiencia de quienes compran y utilizan los productos educativos de Cherry Glow.»
- **Responsabilidades:** preguntas frecuentes; analizar consultas y dificultades; detectar problemas repetidos en cursos, recetas o materiales; preparar respuestas con la voz de marca; explicaciones que faltan; mejoras en manuales y procesos; base de conocimiento; registro de incidencias y verificación; compartir hallazgos con el PM y con Educación; accesos y navegación.
- **Entregables:** base de preguntas frecuentes, respuestas propuestas, registro de incidencias, informe de mejoras.
- **Límites:**
  - Hace solo: base de preguntas, registro de incidencias, informe de mejoras.
  - Propone y espera: respuestas a alumnas. El texto solo exige revisión para «casos delicados, reclamaciones económicas o cuestiones técnicas de seguridad»; no hay herramienta para responder (no hay conector de Skool ni de mensajería), así que en la práctica todas las respuestas son propuestas.
- **Conectores:** el canal por donde llegan las consultas no está dicho (Skool, Instagram, mail). Gmail está disponible pero el texto no lo menciona (P6).
- **Falta:** nombre; canal de consultas.
- **Conciliación:** solapa con Patricia (respuestas con la voz de Juli, objeciones frecuentes), aunque Patricia atiende comunidad y leads y esta, alumnas que ya compraron (H3).

### Existentes no mencionados
| Agente | Hoy | Qué propone el Creador |
|---|---|---|
| Catalina (`redes`) | Social Media Manager: calendario, captions, hashtags, checklist de piezas | Su trabajo se reparte entre A5 (calendario) y A6 (captions). Preguntar si se mantiene, se fusiona o se archiva (P1). Nunca archivar solo. |
| Patricia (`redes`) | Community Manager: comentarios y DMs, objeciones, seguimiento de leads | Nadie en el texto responde comentarios ni DMs de la comunidad. Probablemente se mantiene. Preguntar (P1). |
| Mario (`video`) | Editor de reels | El flujo F2 pasa de «grabación» a «medición» sin edición: Mario es el candidato natural para ese paso y para editar anuncios en F3. Preguntar (P1, H4). |

---

## 3. Reglas de la oficina

Valen para todos los agentes y se inyectan en cada uno. Origen común: «## Las reglas que pondría para todos».

| Id | Regla | Origen | Estado | Nota |
|---|---|---|---|---|
| R1 | Trabajar desde información real: consultar las fuentes disponibles y no inventar métricas, tareas, testimonios ni resultados. | «**Trabajar desde información real.**» | lista | Hoy repetida en los 8 prompts: al crearse la regla, el Creador puede proponer sacarla de cada `.md`. |
| R2 | Entregar trabajo terminado, no solo sugerencias, cuando hay herramientas para producirlo. | «**Entregar trabajo terminado.**» | lista | Convive con los límites: «terminado» quiere decir la pieza completa como propuesta, no ejecutada hacia afuera. |
| R3 | Respetar la identidad de Cherry Glow: voz, público, productos, posicionamiento y criterios comerciales. | «**Respetar la identidad de Cherry Glow.**» | borrador | Falta dónde está esa identidad: hoy en las skills `cherry-glow-voz`, `cherry-glow-productos`, etc. y en `contexto-maestro.md` (K11, K12). |
| R4 | Evitar duplicaciones: cada rol tiene su responsabilidad y le entrega su trabajo al siguiente. | «**Evitar duplicaciones.**» | lista | La segunda mitad la cumplen los flujos (sección 4). |
| R5 | No crear trabajo innecesario: toda propuesta justifica objetivo y prioridad. | «**No crear trabajo innecesario.**» | lista | |
| R6 | Juli toma las decisiones finales, en especial lanzamientos, inversión, promesas comerciales y publicación de contenidos. | «**Mantener a Juli como responsable de las decisiones finales.**» | lista | No es solo texto: fija que publicar, invertir, lanzar y prometer sean siempre «propone y espera» para todos (K3). |

---

## 4. Flujos

Columnas: quién (agente o **la persona**), recibe, entrega, si requiere aprobación para seguir. Los pasos de la persona quedan como aviso «te necesita» hasta que sube un archivo o toca «Hecho».

### F1 · Producción de una clase — nuevo · borrador
- **Origen:** «**Producción de una clase:** diseño académico → PPT → grabación de Juli → edición → publicación.»
- **Corrida típica:** «Clase 7».

| # | Paso | Quién | Recibe | Entrega | Aprobación |
|---|---|---|---|---|---|
| 1 | Diseño académico | A2 Directora académica | Tema de la clase (lo escribe Juli al iniciar la corrida) y el plan curricular | Ficha de clase, guion completo, ejercicios y materiales | Sí: la diseñadora trabaja con «guiones educativos aprobados» |
| 2 | PPT | A3 Diseñadora de presentaciones | Guion aprobado (paso 1) | PowerPoint editable y notas de presentación | Falta (P9). Propuesta: sí, porque Juli graba con eso |
| 3 | Grabación | **La persona** | PPT y guion | Archivo de la grabación (sube el archivo) | No (el paso termina al subir) |
| 4 | Edición | A4 Editora audiovisual | Grabación (paso 3), guion original (paso 1) y diapositivas (paso 2) | Plan de edición y lista de correcciones; después, video final y `.srt` | Sí, dos veces: el plan antes de renderizar y el video final |
| 5 | Publicación | **La persona** | Video final | «Hecho» | No |

- **Falta:** quién publica (P4); el paso 4 tiene un punto de aprobación intermedio (plan) y otro final (video), que se modela como dos pasos del mismo agente (4a plan, 4b render) o como concepto nuevo (K6); el paso 4 recibe entregas de pasos anteriores al inmediato (K5); el paso 4 necesita las diapositivas como imágenes o PDF, porque en la compu de Juli no se puede renderizar un `.pptx` (H6); una lista de correcciones que pide nueva toma vuelve a la persona (paso 3), no al mismo agente (K7).

### F2 · Producción de contenido orgánico — nuevo · borrador
- **Origen:** «**Producción de contenido orgánico:** análisis → planificación → guion → grabación → medición.»

| # | Paso | Quién | Recibe | Entrega | Aprobación |
|---|---|---|---|---|---|
| 1 | Análisis | A7 Analista de Instagram | Métricas recientes (las sube Juli si no hay conector) | Informe con patrones y recomendaciones | No (es información) |
| 2 | Planificación | A5 Estratega editorial | Informe (paso 1) | Calendario de contenidos y briefs para guiones | Sí («no decide por su cuenta el calendario», regla 6) |
| 3 | Guion | A6 Guionista | Brief (paso 2) | Guion listo para grabar, guía visual, indicaciones de edición y caption | Sí (lo dice Juli con su voz) |
| 4 | Grabación | **La persona** | Guion e indicaciones | Archivo grabado | No |
| — | Edición (hueco) | ¿Mario? | Grabación e indicaciones | Reel editado | Sí |
| — | Publicación (hueco) | **La persona** | Pieza final y caption | «Hecho» | No |
| 5 | Medición | A7 Analista de Instagram | Métricas de la pieza publicada | Resultados y aprendizajes | No |

- **Falta:** edición y publicación no están en el texto pero el estado de pieza de A5 sí las nombra («edición, programación y publicación»): el Creador debe preguntar si se agregan (H4, P4). La medición necesita esperar días después de publicar (K8). Un calendario genera varios briefs: o una corrida por pieza (los pasos 1 y 2 quedan como tareas recurrentes y la corrida arranca en el guion) o un paso que abre varias corridas (K4). Preguntar cuál prefiere Juli.

### F3 · Optimización de anuncios — nuevo · borrador
- **Origen:** «**Optimización de anuncios:** diagnóstico → hipótesis → guiones ADS → prueba → resultados.»

| # | Paso | Quién | Recibe | Entrega | Aprobación |
|---|---|---|---|---|---|
| 0 | Datos (hueco) | **La persona** | — | Exportación o capturas de Meta Ads | No |
| 1 | Diagnóstico | A8 Analista de performance | Datos de campañas | Diagnóstico de campañas | No |
| 2 | Hipótesis | A8 Analista de performance | Diagnóstico (paso 1) | Plan de pruebas con hipótesis medibles | Sí (inversión, regla 6) |
| 3 | Guiones ADS | A9 Directora creativa de anuncios | Plan de pruebas (paso 2) | Guiones, briefs de grabación y variantes | Sí (promesas comerciales, regla 6) |
| 4 | Prueba | **La persona** | Guiones y briefs | Grabación y campaña lanzada («Hecho») | No |
| 5 | Resultados | A8 Analista de performance | Datos de la prueba (los sube Juli) | Resultados y próximas acciones | No |

- **Falta:** el paso 0 existe solo porque no hay conector de Meta Ads (C4); «prueba» mezcla grabar, editar (¿Mario?) y lanzar la campaña: lanzar es acción hacia afuera y sin conector la hace Juli; resultados necesita esperar días (K8); diagnóstico e hipótesis son el mismo agente: se pueden fusionar en un paso con aprobación al final (preguntar).

---

## 5. Tareas recurrentes

Se desprenden de responsabilidades y entregables con frecuencia. El texto da la frecuencia, casi nunca día ni hora: eso queda en «falta».

| Id | Agente | Tarea | Frecuencia | Origen | Estado |
|---|---|---|---|---|---|
| T1 | A1 Chief of Staff | Agenda diaria | Diaria; hoy L a S 08:00, domingo solo saludo (prompt de Betty) | «agenda diaria» | lista (cambia: pasa del prompt a tarea) |
| T2 | A1 | Planificación semanal | Semanal; falta día | «planificación semanal» | borrador |
| T3 | A1 | Revisión semanal de objetivos | Semanal; falta día | «Preparar revisiones semanales y mensuales de objetivos.» | borrador |
| T4 | A1 | Revisión mensual de objetivos | Mensual; falta día del mes | ídem | borrador (K13: las tareas hoy son solo semanales) |
| T5 | A1 | Reporte de bloqueos | Falta: ¿semanal o junto con el parte de llegada? | «reporte de bloqueos» | borrador (P8) |
| T6 | A2 | Planificación educativa mensual y trimestral | Mensual y trimestral | «planificación educativa mensual y trimestral» | borrador (K13) |
| T7 | A5 | Estrategia mensual y trimestral de contenido | Mensual y trimestral | «estrategia mensual y trimestral de contenido» | borrador (K13) |
| T8 | A5 | Calendario editorial semanal | Semanal | «calendario editorial semanal y mensual» | borrador |
| T9 | A7 | Informe semanal de Instagram | Semanal | «informe semanal» | borrador (sin datos hasta C3 o P5) |
| T10 | A7 | Análisis mensual de Instagram | Mensual | «análisis mensual» | borrador (K13) |
| T11 | A8 | Reporte de performance | Falta: el texto no da frecuencia | «Elaborar reportes con conclusiones y próximas acciones.» | borrador |

T1 y T2 se solapan con el parte de llegada de la app; T8 con el paso 2 de F2. El Creador debe señalar ese solapamiento al proponerlas.

---

## 6. Conectores

Según los conectores de esta cuenta de Claude. La disponibilidad real la da el listado que haga la app; los que digan «Needs authentication» no se ofrecen.

| Id | Conector | Para quién | Leer | Actuar | Disponible | Origen |
|---|---|---|---|---|---|---|
| C1 | Google Calendar | A1 (y quizás A5) | Ver agenda: hace solo | Crear o mover eventos, proteger bloques: propone y espera | Sí | «Revisar Google Calendar y Notion…» |
| C2 | Notion | A1, A5 | Calendario creativo, Tareas Cherry Glow | Editar tareas: propone | **No** | ídem; Betty hoy lo usa como fuente de verdad |
| C3 | Instagram / Meta (métricas) | A7 | Métricas de publicaciones | — | **No** | «Analizar métricas de reels, carruseles, historias y publicaciones.» |
| C4 | Meta Ads | A8 | Resultados de campañas | Cambiar presupuestos y campañas: propone | **No** | «Analizar resultados de campañas publicitarias.» |
| — | Gmail | — | — | — | Sí, no pedido | Betty: «No mandes la agenda por Gmail ni Slack». No se asigna. |
| — | Google Drive / Sheets | ¿A8 para el dashboard? | — | — | Sí, no pedido | Preguntar solo si Juli quiere el dashboard en una hoja. |
| — | Skool | A2 (lo ya publicado), A11 (consultas) | — | — | **No** | Sale de los prompts actuales, no del texto. |

Sin C2, C3 y C4 el Creador debe decirlo y proponer el reemplazo: pasos o tareas donde Juli sube capturas o exportaciones.

---

## 7. Huecos

- **H1 · Mario, Patricia y Catalina no aparecen.** El texto dice «once» y define 11 roles distintos de los 8 actuales. Nada indica que quiera despedir a nadie.
- **H2 · Calendario y captions repartidos.** Hoy Catalina hace calendario y captions; el texto se los da a A5 y A6.
- **H3 · Respuestas a la comunidad.** Patricia (comentarios y DMs), A7 (analiza comentarios) y A11 (responde alumnas) se pisan en parte.
- **H4 · Edición de reels y anuncios.** F2 y F3 no tienen paso de edición; nadie del texto edita reels.
- **H5 · Video final «cuando disponga de herramientas».** Don Armando ya tiene ffmpeg y whisper; la frase sugiere que Juli no lo sabe o lo condiciona. Es una capacidad que depende de herramientas locales, no de conectores.
- **H6 · PowerPoint editable a verificar.** En la compu de Juli no hay PowerPoint, Keynote ni LibreOffice (lo dice el prompt de Don Armando). Generar `.pptx` con código es posible, pero el paso siguiente (edición) necesita las diapositivas como imágenes, y para eso hay que renderizar. Probar antes de prometerlo.
- **H7 · Quién publica.** Regla 6 deja la publicación en Juli; ningún agente tiene herramienta para publicar en Skool ni en Instagram.
- **H8 · Fuentes sin conector.** Notion, Instagram, Meta Ads y Skool.
- **H9 · Flujo implícito de nuevo curso.** A10 «coordinar con el departamento educativo el desarrollo de cursos aprobados»: propuesta de curso → aprobación → plan curricular. El texto no lo lista como flujo; el Creador puede ofrecerlo, no crearlo.
- **H10 · Documentos vivos.** Tablero de prioridades, dashboard, inventario, backlog, base de preguntas frecuentes, registro de incidencias: no son entregas únicas sino archivos que el agente mantiene.
- **H11 · Contexto del negocio.** Las cuatro marcas, el público, la voz: no entran en ninguna tarjeta de los seis tipos; van a la memoria común (`conocimiento/oficina.md`).
- **H12 · Cierre del texto.** «definir estos flujos no significa que ya puedan ejecutarlos automáticamente»: Juli espera que la app le diga qué falta (permisos, conectores) antes de correrlos. Es lo que muestran los «falta» de cada tarjeta.

## 8. Preguntas que el Creador debería hacer

Ordenadas por cuánto bloquean.

1. **P1.** Catalina, Patricia y Mario no aparecen en tu texto. ¿Los mantenés? Propuesta: Patricia sigue con comunidad, Mario edita reels y anuncios, y Catalina se fusiona con la estratega o la guionista.
2. **P2.** ¿Los roles nuevos reemplazan a los agentes que ya tenés (Betty → Chief of Staff, Sofía → Directora académica, Don Armando → Editora, Marce → Estratega, Nicolás → Analista de performance) conservando nombre, avatar y lo que ya saben, o querés agentes nuevos? ¿Se conserva lo que el texto no dice (Banco del Sol, domingos, «mapa y no guion kilométrico»)?
3. **P3.** ¿Renombro los departamentos (`clases` → Educación, `redes` → Contenido orgánico, `ads` → Crecimiento y publicidad) o creo nuevos? ¿Qué hago con «Edición de video» si queda vacío?
4. **P4.** ¿Quién publica las clases y las piezas: vos a mano (paso tuyo con «Hecho») o alguien prepara la publicación?
5. **P5.** Sin conector de Instagram ni de Meta Ads, ¿le pasás capturas o exportaciones al analista? ¿Cada cuánto?
6. **P6.** ¿Por dónde llegan las consultas de alumnas (Skool, Instagram, mail)?
7. **P7.** ¿La Chief of Staff reparte encargos sola o te los propone?
8. **P8.** ¿Después de cuántos días un paso parado cuenta como bloqueo?
9. **P9.** En la clase, ¿la PPT necesita tu aprobación antes de grabar? ¿Quién valida un cambio de contenido de la diseñadora: vos o la directora académica?
10. **P10.** Nombres para los agentes nuevos (A3, A6, A7, A9, A10, A11).
11. **P11.** Días y horas de las tareas recurrentes (sección 5).
12. **P12.** En el flujo de contenido, ¿una corrida por pieza o una por calendario?

---

## 9. Conceptos que el modelo necesita

Para que todo el texto entre. «Ya está» quiere decir que existe hoy en la app; «visión» que está en lo decidido para construir; «falta» que no entra en ningún concepto de la visión.

| Id | Concepto | Para qué en este texto | Estado |
|---|---|---|---|
| K1 | Departamento con **misión** | D2 a D5 | Visión parcial: `Departamento` hoy tiene solo id, nombre y color. Hay que sumar `mision`. |
| K2 | Agente con **objetivo, responsabilidades y entregables** declarados | Las 11 tarjetas; los flujos referencian entregables | Visión parcial: hoy todo va en `brief` y en el prompt. Para que el Creador cite y diferencie, conviene guardarlos como campos (o al menos en el brief estructurado). |
| K3 | **Límites por agente**: hace solo / propone y espera, más rutas de escritura | Todos los «Límite:» | Visión (punto 2). Además R6 actúa como límite global para publicar, invertir, lanzar y prometer: las reglas tienen que poder fijar límites, no solo texto. |
| K4 | **Flujo con pasos y corridas**, pasos de la persona, aprobación, «Pedir cambios» | F1, F2, F3 | Visión (punto 1). Falta: un paso que abre varias corridas (calendario → N piezas). Se puede esquivar con una corrida por pieza. |
| K5 | Un paso **recibe entregas de cualquier paso anterior** de la corrida, no solo del inmediato | F1 paso 4 (grabación + guion + PPT) | Falta precisar en la visión («qué recibe» debe poder nombrar pasos). |
| K6 | **Aprobación intermedia dentro de un paso** (plan antes de render) | F1 paso 4 | Se resuelve con dos pasos del mismo agente; no hace falta concepto nuevo si se acepta eso. |
| K7 | **Pedir cambios que vuelve a otro paso** (nueva toma → la persona) | F1 | Falta: la visión dice que «Pedir cambios» vuelve al mismo agente. |
| K8 | **Espera de tiempo** en un paso («medir a los 7 días») | F2 paso 5, F3 paso 5 | Falta. Alternativa: que la medición sea un paso de la persona («ya pasaron los días, seguí») o una tarea recurrente. |
| K9 | **Documento vivo a cargo de un agente** (tablero, dashboard, inventario, backlog, preguntas frecuentes, registro de incidencias) | A1, A8, A10, A11 | Falta como concepto. Hoy entra a medias: ruta de escritura en `archivos/<depto>/` + biblioteca. Las entregas son de una vez y no sirven para esto. |
| K10 | **Entregas que van a otros agentes** fuera de un flujo («compartir aprendizajes con…») | A7, A11, A8 → A9 | Ya está a medias: memoria compartida y consultas MCP. Falta poder decir «las entregas de A7 las leen A5 y A6». |
| K11 | **Reglas de la oficina** inyectadas | R1 a R6 | Visión (punto 3). |
| K12 | **Skills por agente** (`cherry-glow-voz`, `prospera-clases`, `ads`…) | R3 y los agentes actuales | Falta en la visión: los agentes actuales dependen de skills de la cuenta de Juli; habría que listarlas y asignarlas como los conectores. |
| K13 | **Tareas mensuales y trimestrales** | T4, T6, T7, T10 | Falta: `tareas` hoy solo tiene `dias:[1-7]` y `hora`. Hace falta frecuencia mensual (día del mes) y trimestral. |
| K14 | **Rol coordinador** | A1 | Visión (punto 4). |
| K15 | **Conectores por agente**, leer vs actuar, no disponibles marcados | C1 a C4 | Visión (punto 5). Falta un estado «pedido pero no disponible» para que la tarjeta quede con falta en lugar de desaparecer. |
| K16 | **Herramientas locales** (ffmpeg, whisper, Python, generar `.pptx`) | A3, A4, H5, H6 | Falta como concepto propio: no son conectores de claude.ai sino herramientas del sistema (`Bash`). Hoy entra solo por el prompt y los permisos. |
| K17 | **Memoria común / contexto del negocio** como tarjeta | Marcas, público, voz (H11) | Ya está `conocimiento/oficina.md`, pero no es uno de los seis tipos de tarjeta del Creador. Hace falta una tarjeta «contexto» o que el Creador lo proponga como cambio a la memoria común. |
| K18 | **Conciliación con lo existente**: renombrar, mover de departamento, fusionar, archivar | Sección 0, agentes existentes | Visión (diferencias). Falta precisar «fusionar dos agentes» y «dividir uno en dos» (Nicolás → A8 + A9). |
| K19 | **Límite de ámbito** («eso corresponde al área de productos») | A2, A3, A4 | Entra como texto del prompt; no necesita concepto propio. |
| K20 | **Límite condicional por tipo de caso** («casos delicados») | A11 | Entra como texto del prompt; en la práctica todo es propuesta porque no hay herramienta de respuesta. |

**Lo que no entra en ningún concepto de la visión:** documentos vivos (K9), espera de tiempo en flujos (K8), pedir cambios hacia otro paso (K7), recibir de pasos anteriores (K5), tareas mensuales y trimestrales (K13), skills por agente (K12), herramientas locales (K16), contexto del negocio como tarjeta (K17), un paso que abre varias corridas (K4) y dividir o fusionar agentes (K18).
