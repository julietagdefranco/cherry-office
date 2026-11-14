/** Error de la API con su código HTTP y un mensaje en español para el usuario (ErrorAPI de Swift). */
export class ErrorAPI extends Error {
  constructor(readonly status: number, readonly mensaje: string) {
    super(mensaje)
    this.name = 'ErrorAPI'
  }
  static get sinOficina() { return new ErrorAPI(409, 'No hay una oficina abierta') }
}
