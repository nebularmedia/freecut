/**
 * El workspace servido por el motor, con la forma que espera el montador.
 *
 * FreeCut habla con el disco a través de `FileSystemDirectoryHandle`, la API de
 * ficheros del navegador, y **todo** pasa por `requireWorkspaceRoot()`. Así que
 * en lugar de reescribir los treinta módulos de almacenamiento, aquí hay un
 * objeto que se comporta igual y por debajo pide las cosas por HTTP.
 *
 * Lo que se gana: el navegador deja de necesitar permiso sobre una carpeta, no
 * hay selector al arrancar, y los medios se sirven por tramos en vez de entrar
 * enteros en memoria.
 *
 * Dos detalles que no son opcionales:
 *
 * - **`NotFoundError` tiene que ser un `DOMException` con ese nombre.** La capa
 *   de almacenamiento distingue «no está» de «falló» mirando exactamente eso, y
 *   convierte lo primero en un `null` limpio. Si se lanza un `Error` normal, un
 *   fichero que falta pasa por avería.
 * - **Escribir no manda nada hasta `close()`.** El montador escribe a trozos y
 *   luego cierra; enviar cada trozo por separado dejaría el fichero a medias en
 *   disco si algo se corta.
 *
 * Y una tercera cosa que no se ve hasta que se mira la traza del motor: **con la
 * API del navegador preguntar era gratis, y aquí cada pregunta es un viaje**.
 * Abrir GAMEBRO son 916 medios, y el montador hace dos peticiones por cada uno:
 * «¿existe esta carpeta?» y «¿qué hay dentro?». La primera sobra: el listado del
 * padre ya dijo qué hijos hay. Por eso el listado siembra el caché de presencia,
 * y son ~1830 peticiones en vez de ~2750.
 *
 * El caché dura dos segundos y se tira entero al escribir. Corto a propósito: el
 * motor escribe en el mismo disco desde fuera —una tanda de proxies con la
 * pestaña abierta— y una lista de hace un minuto mentiría.
 */

import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('CutDirectorio')

const RAIZ = '/cut'

function noExiste(ruta: string): DOMException {
  return new DOMException(`No existe ${ruta}`, 'NotFoundError')
}

function unir(base: string, nombre: string): string {
  return base ? `${base}/${nombre}` : nombre
}

/** Cada segmento por separado: un nombre con `/` no puede colarse como ruta. */
function codificar(ruta: string): string {
  return ruta
    .split('/')
    .filter((parte) => parte.length > 0)
    .map(encodeURIComponent)
    .join('/')
}

interface Presencia {
  fichero: boolean
  carpeta: boolean
}

/** Cuánto vale una respuesta antes de volver a preguntar. */
const CADUCA_MS = 2000

const recordado = new Map<string, { cuando: number; valor: Promise<unknown> }>()

function conCache<T>(clave: string, pedir: () => Promise<T>): Promise<T> {
  const guardado = recordado.get(clave)
  if (guardado && Date.now() - guardado.cuando < CADUCA_MS) {
    return guardado.valor as Promise<T>
  }
  const valor = pedir()
  recordado.set(clave, { cuando: Date.now(), valor })
  return valor
}

/** Guarda una respuesta ya sabida, sin haberla pedido. */
function recordar<T>(clave: string, valor: T): void {
  recordado.set(clave, { cuando: Date.now(), valor: Promise.resolve(valor) })
}

/**
 * Se tira el caché entero después de escribir.
 *
 * Tirarlo entero y no solo la ruta tocada es a propósito: un `move` cambia dos
 * carpetas, y equivocarse aquí deja al montador viendo un fichero que ya no
 * está. Dos segundos de trabajo repetido no valen ese riesgo.
 */
function olvidar(): void {
  recordado.clear()
}

async function presencia(ruta: string): Promise<Presencia> {
  return conCache(`existe:${ruta}`, async () => {
    const respuesta = await fetch(`${RAIZ}/existe/${codificar(ruta)}`, { cache: 'no-store' })
    if (!respuesta.ok) return { fichero: false, carpeta: false }
    return (await respuesta.json()) as Presencia
  })
}

interface EntradaListada {
  nombre: string
  carpeta: boolean
  bytes: number
}

/**
 * Un fichero del workspace.
 *
 * No se comprueba que exista al crearlo: igual que en la API del navegador, el
 * handle es una referencia y el fallo llega al usarlo.
 */
export class FicheroCut {
  readonly kind = 'file' as const

  constructor(
    readonly name: string,
    private readonly ruta: string,
  ) {}

  /** Para que la carpeta pueda situarlo con `resolve`. */
  get rutaInterna(): string {
    return this.ruta
  }

  async getFile(): Promise<File> {
    const respuesta = await fetch(`${RAIZ}/workspace/${codificar(this.ruta)}`, {
      cache: 'no-store',
    })
    if (!respuesta.ok) throw noExiste(this.ruta)
    const datos = await respuesta.blob()
    return new File([datos], this.name, {
      type: datos.type,
      lastModified: Date.now(),
    })
  }

  /**
   * Un escritor que junta lo que le den y lo manda de una vez al cerrar.
   *
   * El `PUT` del motor escribe al lado y renombra encima, así que el fichero
   * nunca queda a medias en disco.
   */
  async createWritable(): Promise<FileSystemWritableFileStream> {
    const trozos: BlobPart[] = []
    const ruta = this.ruta
    const escritor = {
      async write(dato: unknown): Promise<void> {
        // El montador escribe de las dos formas que admite la API: el dato
        // suelto, o un objeto `{ type: 'write', data }`.
        if (dato && typeof dato === 'object' && 'type' in dato) {
          const orden = dato as { type: string; data?: BlobPart }
          if (orden.type === 'truncate') {
            trozos.length = 0
            return
          }
          if (orden.data !== undefined) trozos.push(orden.data)
          return
        }
        trozos.push(dato as BlobPart)
      },
      async truncate(): Promise<void> {
        trozos.length = 0
      },
      async seek(): Promise<void> {
        throw new DOMException('seek no está en el workspace del motor', 'NotSupportedError')
      },
      async abort(): Promise<void> {
        trozos.length = 0
      },
      async close(): Promise<void> {
        const respuesta = await fetch(`${RAIZ}/workspace/${codificar(ruta)}`, {
          method: 'PUT',
          body: new Blob(trozos),
        })
        olvidar()
        if (!respuesta.ok) {
          throw new Error(`No se pudo guardar ${ruta}: ${respuesta.status}`)
        }
      },
    }
    return escritor as unknown as FileSystemWritableFileStream
  }

  /**
   * Renombrar. Es lo que usa el guardado atómico del montador: escribe un
   * `.tmp` y lo mueve encima del bueno.
   */
  async move(destino: DirectorioCut | string, nombre?: string): Promise<void> {
    const hasta =
      typeof destino === 'string'
        ? unir(this.ruta.split('/').slice(0, -1).join('/'), destino)
        : unir(destino.rutaInterna, nombre ?? this.name)
    const respuesta = await fetch(
      `${RAIZ}/mover/${codificar(this.ruta)}?a=${encodeURIComponent(hasta)}`,
      { method: 'POST' },
    )
    olvidar()
    if (!respuesta.ok) throw new Error(`No se pudo mover ${this.ruta}: ${respuesta.status}`)
  }

  async isSameEntry(otro: unknown): Promise<boolean> {
    return otro instanceof FicheroCut && otro.ruta === this.ruta
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted'
  }
}

/** Una carpeta del workspace. */
export class DirectorioCut {
  readonly kind = 'directory' as const

  constructor(
    readonly name: string,
    private readonly ruta: string,
  ) {}

  /** Para que `move` pueda componer el destino. */
  get rutaInterna(): string {
    return this.ruta
  }

  /**
   * Las carpetas no se crean aquí: nacen solas cuando se escribe algo dentro,
   * porque el motor crea el camino al guardar. Con `create` se devuelve el
   * handle sin más; sin él, hay que comprobar que existe.
   */
  async getDirectoryHandle(
    nombre: string,
    opciones?: { create?: boolean },
  ): Promise<DirectorioCut> {
    const hija = unir(this.ruta, nombre)
    if (!opciones?.create) {
      const hay = await presencia(hija)
      if (!hay.carpeta) throw noExiste(hija)
    }
    return new DirectorioCut(nombre, hija)
  }

  async getFileHandle(nombre: string, opciones?: { create?: boolean }): Promise<FicheroCut> {
    const hijo = unir(this.ruta, nombre)
    if (!opciones?.create) {
      const hay = await presencia(hijo)
      if (!hay.fichero) throw noExiste(hijo)
    }
    return new FicheroCut(nombre, hijo)
  }

  async removeEntry(nombre: string, _opciones?: { recursive?: boolean }): Promise<void> {
    const hijo = unir(this.ruta, nombre)
    const respuesta = await fetch(`${RAIZ}/workspace/${codificar(hijo)}`, { method: 'DELETE' })
    olvidar()
    if (!respuesta.ok && respuesta.status !== 404) {
      throw new Error(`No se pudo borrar ${hijo}: ${respuesta.status}`)
    }
  }

  private async listar(): Promise<EntradaListada[]> {
    return conCache(`lista:${this.ruta}`, async () => {
      const respuesta = await fetch(`${RAIZ}/lista/${codificar(this.ruta)}`, { cache: 'no-store' })
      if (!respuesta.ok) return []
      const entradas = (await respuesta.json()) as EntradaListada[]
      // El listado ya sabe qué hay dentro, así que nadie tiene que volver a
      // preguntar por cada hijo. Esto es la mitad de las peticiones de arranque.
      for (const entrada of entradas) {
        recordar(`existe:${unir(this.ruta, entrada.nombre)}`, {
          fichero: !entrada.carpeta,
          carpeta: entrada.carpeta,
        })
      }
      return entradas
    })
  }

  async *values(): AsyncGenerator<DirectorioCut | FicheroCut> {
    for (const entrada of await this.listar()) {
      yield entrada.carpeta
        ? new DirectorioCut(entrada.nombre, unir(this.ruta, entrada.nombre))
        : new FicheroCut(entrada.nombre, unir(this.ruta, entrada.nombre))
    }
  }

  async *keys(): AsyncGenerator<string> {
    for (const entrada of await this.listar()) yield entrada.nombre
  }

  async *entries(): AsyncGenerator<[string, DirectorioCut | FicheroCut]> {
    for await (const hijo of this.values()) yield [hijo.name, hijo]
  }

  async isSameEntry(otro: unknown): Promise<boolean> {
    return otro instanceof DirectorioCut && otro.ruta === this.ruta
  }

  async resolve(hijo: unknown): Promise<string[] | null> {
    const ruta =
      hijo instanceof DirectorioCut || hijo instanceof FicheroCut
        ? ((hijo as { rutaInterna?: string }).rutaInterna ?? null)
        : null
    if (ruta === null) return null
    if (!ruta.startsWith(this.ruta)) return null
    return ruta.slice(this.ruta.length).split('/').filter(Boolean)
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted'
  }
}

/**
 * La raíz del workspace que sirve el motor, con la forma que espera
 * `setWorkspaceRoot`.
 */
export function raizDelMotor(nombre: string): FileSystemDirectoryHandle {
  logger.info(`Workspace servido por el motor: ${nombre}`)
  return new DirectorioCut(nombre, '') as unknown as FileSystemDirectoryHandle
}
