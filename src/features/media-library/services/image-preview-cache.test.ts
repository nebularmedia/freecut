// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { imagePreviewCache } from './image-preview-cache'

/**
 * The point of the copy is that a photo reel can be edited at all: 29 camera
 * photos painted from their originals are ~1 GB of bitmap in the tab. What is
 * checked here is that it only works when it saves something, that it is built
 * once, and that it never takes the picture away from the caller when it fails
 * — the original is always a good enough answer.
 */

const OCHO_MP = { width: 2362, height: 3541 }
const PEQUENA = { width: 1080, height: 1920 }

let creados = 0

function stubDelNavegador({ falla = false } = {}) {
  const globales = globalThis as unknown as Record<string, unknown>
  globales.fetch = vi.fn(async () => ({ blob: async () => ({ size: 11_752_332 }) }))
  globales.createImageBitmap = vi.fn(async (_blob: unknown, options: { resizeWidth: number }) => {
    if (falla) throw new Error('decode failed')
    return { width: options.resizeWidth, height: options.resizeWidth * 1.5, close: vi.fn() }
  })
  globales.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return { drawImage: vi.fn() }
    }
    async convertToBlob() {
      return { size: 40_000 }
    }
  }
  globales.URL = {
    createObjectURL: vi.fn(() => `blob:copia-${++creados}`),
    revokeObjectURL: vi.fn(),
  }
}

beforeEach(() => {
  creados = 0
  imagePreviewCache.clear()
  stubDelNavegador()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('la copia ligera de una foto', () => {
  it('se construye una sola vez aunque la pidan varios clips', async () => {
    const [uno, dos, tres] = await Promise.all([
      imagePreviewCache.resolve('foto', 'blob:original', OCHO_MP.width, OCHO_MP.height),
      imagePreviewCache.resolve('foto', 'blob:original', OCHO_MP.width, OCHO_MP.height),
      imagePreviewCache.resolve('foto', 'blob:original', OCHO_MP.width, OCHO_MP.height),
    ])

    expect(uno).toBe('blob:copia-1')
    expect(dos).toBe('blob:copia-1')
    expect(tres).toBe('blob:copia-1')
    expect(creados).toBe(1)
    expect(imagePreviewCache.get('foto')).toBe('blob:copia-1')
  })

  it('la pide al decodificador ya reducida, que es de donde sale el ahorro', async () => {
    await imagePreviewCache.resolve('foto', 'blob:original', OCHO_MP.width, OCHO_MP.height)

    const createImageBitmapMock = (
      globalThis as unknown as { createImageBitmap: ReturnType<typeof vi.fn> }
    ).createImageBitmap
    const opciones = createImageBitmapMock.mock.calls[0]?.[1] as {
      resizeWidth: number
      resizeHeight: number
    }
    // Lado largo a 640, y la foto sigue siendo vertical.
    expect(opciones.resizeHeight).toBe(640)
    expect(opciones.resizeWidth).toBe(427)
  })

  it('no decodifica más de dos fotos a la vez, que es el pico que se quiere evitar', async () => {
    let a_la_vez = 0
    let maximo = 0
    const sueltas: Array<() => void> = []
    const globales = globalThis as unknown as Record<string, unknown>
    globales.createImageBitmap = vi.fn(async (_blob: unknown, options: { resizeWidth: number }) => {
      a_la_vez += 1
      maximo = Math.max(maximo, a_la_vez)
      await new Promise<void>((resolve) => sueltas.push(resolve))
      a_la_vez -= 1
      return { width: options.resizeWidth, height: 640, close: vi.fn() }
    })

    let terminadas = false
    const todas = Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) =>
        imagePreviewCache.resolve(id, 'blob:original', OCHO_MP.width, OCHO_MP.height),
      ),
    ).then((urls) => {
      terminadas = true
      return urls
    })

    // Va soltando decodificaciones hasta que las cinco han pasado. El tope de
    // vueltas es para que un fallo salga como fallo y no como test colgado.
    for (let vuelta = 0; vuelta < 50 && !terminadas; vuelta++) {
      while (sueltas.length > 0) sueltas.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(await todas).toHaveLength(5)
    expect(maximo).toBe(2)
  })

  it('no toca una foto que ya es pequeña: copiarla no ahorraría nada', async () => {
    const url = await imagePreviewCache.resolve(
      'pequena',
      'blob:original',
      PEQUENA.width,
      PEQUENA.height,
    )

    expect(url).toBeNull()
    expect(creados).toBe(0)
  })

  it('si no se puede construir, devuelve null y el clip pinta del original', async () => {
    stubDelNavegador({ falla: true })

    const url = await imagePreviewCache.resolve(
      'rota',
      'blob:original',
      OCHO_MP.width,
      OCHO_MP.height,
    )

    expect(url).toBeNull()
    expect(imagePreviewCache.get('rota')).toBeNull()
  })

  it('en un navegador sin OffscreenCanvas tampoco se queda a medias', async () => {
    delete (globalThis as unknown as Record<string, unknown>).OffscreenCanvas

    const url = await imagePreviewCache.resolve(
      'sinapi',
      'blob:original',
      OCHO_MP.width,
      OCHO_MP.height,
    )

    expect(url).toBeNull()
  })
})
