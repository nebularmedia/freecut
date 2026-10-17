/**
 * Si una composición lleva audio audible.
 *
 * Vive aparte porque lo miran los dos lados: el worker, para negarse a
 * renderizar lo que no puede, y `render-pipeline`, para no arrancarlo siquiera.
 * Tenerlo escrito dos veces era garantizar que un día dijeran cosas distintas y
 * el worker se levantara para morirse.
 */

export interface PistaConAudio {
  items: Array<{ type: string; muted?: boolean }>
}

/** Un clip de audio, o un vídeo sin silenciar, hacen que haya que mezclar. */
export function compositionHasAudio(tracks: readonly PistaConAudio[]): boolean {
  for (const track of tracks) {
    for (const item of track.items ?? []) {
      if ((item.type === 'audio' || item.type === 'video') && item.muted !== true) {
        return true
      }
    }
  }
  return false
}
