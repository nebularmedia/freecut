/**
 * Cuando el montador lo sirve el motor de Polimake.
 *
 * FreeCut nació leyendo el disco él mismo, con la API de ficheros del
 * navegador. Eso obliga a meter cada bruto entero en memoria para poder
 * reproducirlo, y con montajes grandes la pestaña se cae.
 *
 * Si quien sirve la página es `cut servir --workspace <carpeta>`, hay una
 * alternativa: pedirle los medios por HTTP y dejar que el navegador se traiga
 * solo los trozos que necesita. Un reel con 20 GB de brutos deja de tener que
 * caber.
 *
 * Este módulo **no cambia nada por su cuenta**. Solo dice si el motor está
 * ahí y dónde pedirle las cosas; quien decide usarlo es cada sitio que hoy
 * fabrica un blob.
 */

import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('CutMotor')

export interface EstadoDelMotor {
  /** La marca cuya obra está sirviendo, o `null` si se abrió sin ninguna. */
  workspace: string | null
}

let preguntado: Promise<EstadoDelMotor | null> | null = null

/**
 * Pregunta una sola vez si la página la sirve el motor.
 *
 * Se cachea la promesa, no el resultado: así dos llamadas a la vez durante el
 * arranque no hacen dos peticiones.
 */
export function estadoDelMotor(): Promise<EstadoDelMotor | null> {
  if (preguntado) return preguntado

  preguntado = (async () => {
    // Fuera del navegador —las pruebas de Node— no hay motor ni hace falta.
    if (typeof fetch !== 'function' || typeof window === 'undefined') return null
    try {
      const respuesta = await fetch('/cut/estado', { cache: 'no-store' })
      if (!respuesta.ok) return null
      const cuerpo = (await respuesta.json()) as { motor?: string; workspace?: string | null }
      if (cuerpo?.motor !== 'cut') return null
      const workspace = typeof cuerpo.workspace === 'string' ? cuerpo.workspace : null
      logger.info(`Servido por el motor de Polimake · obra: ${workspace ?? 'ninguna'}`)
      return { workspace }
    } catch {
      // Servido por `npm run preview`, por Vite, o por cualquier otra cosa.
      // No es un error: es el camino de siempre.
      return null
    }
  })()

  return preguntado
}

/**
 * La URL de un medio si el motor puede servirlo, o `null`.
 *
 * Devolver una URL en lugar de un blob es la diferencia entre que el fichero
 * entero esté en memoria y que no lo esté: con una URL, el navegador pide
 * tramos con `Range` según va reproduciendo.
 *
 * Solo sirve con obra abierta: sin `--workspace` el motor no sabe de qué
 * mediateca hablar.
 */
export async function urlDelMedio(mediaId: string): Promise<string | null> {
  const estado = await estadoDelMotor()
  if (!estado || !estado.workspace) return null
  if (!mediaId || mediaId.includes('/') || mediaId.includes('\\')) return null
  return `/cut/media/${encodeURIComponent(mediaId)}`
}

/** Solo para las pruebas: olvida lo que se preguntó. */
export function olvidarEstadoDelMotor(): void {
  preguntado = null
}
