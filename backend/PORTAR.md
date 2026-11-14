# Cómo portar un módulo del backend Swift a TypeScript

Plan general: `docs/plan-backend-ts.md`. Fuente: `app/Sources/Backend/*.swift`. Destino: `backend/src/`.

## Antes de escribir
- Leé el/los `.swift` del módulo enteros y sus tests (`app/Tests/BackendTests/<X>Tests.swift`) y el port de esos tests
  (`backend/test/api/<x>.test.ts`): son el contrato.
- Mirá cómo quedaron los módulos ya portados: `rutas-oficinas.ts`, `rutas-chat.ts`, `entregas.ts`, `avisos.ts`,
  `permisos.ts`, `claude-runner.ts`, `oficinas.ts`, `oficina.ts`, `explorador.ts`.

## Reglas
- **Misma API exacta:** rutas, métodos, códigos, claves y textos de error (en español, idénticos). Mismo orden de
  validaciones (el primer error que da Swift es el que tiene que dar TS).
- **Mismos datos en disco:** mismas tablas y columnas de SQLite (copiá los `CREATE TABLE`/`ALTER` tal cual), mismos
  archivos y textos (plantillas `.md`), `oficina.json` siempre con `OficinaStore.escribir` (formato de Swift).
- **Largos en grafemas:** `largo(s)` / `prefijo(s, n)` de `validar.ts`, nunca `.length`/`.slice` para límites de texto.
  `Validar.texto(v, campo, max, obligatorio)` para campos de texto del cuerpo.
- **Fechas en respuestas:** `iso(t)` de `entregas.ts` (epoch en segundos → ISO con milisegundos y Z). En la base, epoch
  en segundos (`Date.now() / 1000`).
- **Rutas de archivos:** `path.join`/`path.resolve`/`path.isAbsolute`, nunca `"/"` a mano (tiene que andar en Windows).
  Para comparar contención de rutas usá `dentro()`/`realAunqueFalte()` de `explorador.ts`.
- **Concurrencia:** todo el acceso a la base es sincrónico (`node:sqlite`) y Node tiene un solo hilo: un
  leer-modificar-escribir sin `await` en el medio es atómico (como un actor de Swift). Si hay un `await` en el medio
  (por ejemplo, correr claude), volvé a leer después. Para serializar trabajo por clave usá `runner.conCarrilDe` o una
  cadena de promesas propia.
- **Nada global:** el estado vive en objetos que crea `instalar`. Sin `process.exit`.
- **Sin dependencias npm nuevas** salvo que el plan las nombre (zip, pdf, docx, Temporal) y las necesites de verdad.

## Cómo se enchufa
- Tu módulo exporta un `instalar(s: Servicios)` y se registra al importarse:
  `registrarModulo('<nombre>', <orden>, instalar)` (ver `servicios.ts` para el orden de cada uno).
- En `src/modulos.ts` reemplazá SOLO tu línea `// [<nombre>]` por `import './<archivo>.js' // [<nombre>]`.
  No toques las líneas de otros módulos.
- En `instalar`: creá tus tablas, armá tus objetos, registrá rutas (`s.router.registrarExtra(sub)` para routers
  «extra», `s.router.reuniones = …` / `.biblioteca` / `.tareas` / `.entregas` / `.paquete` para las secciones, o
  `s.router.nucleo.push(ruta)` para rutas del núcleo), y llená los huecos que otros usan:
  `s.huecos.<nombre> = objeto` + un accesor tipado exportado (`export const programadorDe = (s: Servicios) =>
  s.huecos.programador as Programador | undefined`). Ganchos: `s.alAbrir`, `s.validaciones`, `s.mcp`, `s.catalogo`,
  `s.corridas`, `s.creadorVersion`, `s.listo`, `s.alCerrar`, `s.despuesDeProcesos`, `s.alArrancar`, `s.avisos.fuentes`.
- Si necesitás algo de otro módulo que todavía no existe, dejá el uso detrás del accesor (`programadorDe(s)?.…`) para
  que funcione cuando llegue; no lo reimplementes.
- Si tu módulo necesita cambiar un archivo del núcleo (`oficinas.ts`, `rutas-chat.ts`, `rutas-oficinas.ts`,
  `oficina.ts`, `store.ts`…), hacelo con el cambio mínimo y avisalo en tu reporte.

## Cómo se verifica
- `cd backend && npx tsc --noEmit` limpio.
- `HQ_BACKEND=ts npx vitest run test/api/<x>.test.ts` (y los demás archivos de test que toquen tu módulo): la meta es
  que pasen igual que contra Swift (`npx vitest run test/api/<x>.test.ts`, que no tiene que romperse).
- Los tests en `test.skip` con `// interno (unit test del port)` describen lógica interna: reescribilos como unit
  tests en `test/unit/<x>.test.ts` importando tus funciones de `src/` (sin servidor).
- No debilites tests. Si un test falla por una diferencia real e inevitable (de plataforma, por ejemplo), dejalo con
  `test.skipIf(inject('servidor').nombre === 'ts')` y un comentario que diga por qué, y reportalo.
