// Módulos del backend: cada import registra el suyo (ver servicios.ts). El orden de instalación lo da `orden`, no el de
// estas líneas. Cada módulo tiene su propia línea: al portar uno, se agrega solo su import.
import './consultas.js' // [consultas]
import './agentes.js' // [agentes]
import './rutas-entregas.js' // [entregas]
import './programador.js' // [tareas]
import './reuniones.js' // [reuniones]
import './biblioteca.js' // [biblioteca]
import './flujos.js' // [flujos]
import './rutas-creador.js' // [creador]
import './gobierno.js' // [gobierno]
import './parte.js' // [parte]
import './dependencias.js' // [dependencias]
import './paquete.js' // [paquete]
import './importar.js' // [importar]
import './migracion.js' // [migracion]
export {}
