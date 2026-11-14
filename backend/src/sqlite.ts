// Envoltorio mínimo de SQLite (SQLiteDB.swift) sobre `node:sqlite`: sin dependencias nativas, trae FTS5.
// Tres métodos (exec/run/query) para poder cambiar de motor sin tocar el resto.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type SQLValor = number | bigint | string | null
export type Fila = Record<string, SQLValor>

export class SQLError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'SQLError'
  }
}

export class SQLiteDB {
  private db?: DatabaseSync

  constructor(ruta: string, { soloLectura = false }: { soloLectura?: boolean } = {}) {
    try {
      this.db = new DatabaseSync(ruta, { readOnly: soloLectura, timeout: 5000 })
    } catch (e) {
      throw new SQLError(e instanceof Error ? e.message : 'no pude abrir la base')
    }
  }

  private get base(): DatabaseSync {
    if (!this.db) throw new SQLError('base cerrada')
    return this.db
  }

  get abierta() { return this.db !== undefined }

  close() {
    try {
      this.db?.close()
    } catch {}
    this.db = undefined
  }

  exec(sql: string) {
    try {
      this.base.exec(sql)
    } catch (e) {
      throw envolver(e)
    }
  }

  /** Sentencia de escritura; devuelve las filas afectadas. */
  run(sql: string, params: SQLValor[] = []): number {
    try {
      return Number(this.base.prepare(sql).run(...(params as SQLInputValue[])).changes)
    } catch (e) {
      throw envolver(e)
    }
  }

  /** Filas como objetos `{columna: valor}`. */
  query(sql: string, params: SQLValor[] = []): Fila[] {
    try {
      return this.base.prepare(sql).all(...(params as SQLInputValue[])) as Fila[]
    } catch (e) {
      throw envolver(e)
    }
  }

  /** Corre `f` dentro de una transacción (BEGIN IMMEDIATE … COMMIT, o ROLLBACK si lanza). */
  transaccion<T>(f: () => T): T {
    this.exec('BEGIN IMMEDIATE')
    try {
      const r = f()
      this.exec('COMMIT')
      return r
    } catch (e) {
      try {
        this.exec('ROLLBACK')
      } catch {}
      throw e
    }
  }
}

function envolver(e: unknown): SQLError {
  return e instanceof SQLError ? e : new SQLError(e instanceof Error ? e.message : String(e))
}

// Lectores tolerantes de columnas (como SQLRow de Swift: NULL -> "" / 0).
export const txt = (v: SQLValor | undefined): string => (v === null || v === undefined ? '' : String(v))
export const num = (v: SQLValor | undefined): number => (v === null || v === undefined ? 0 : Number(v))
