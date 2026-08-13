/**
 * Enlaces a la comunidad del proyecto original.
 *
 * NO SE USAN EN ESTE FORK — 2026-08-13. Docs, Discord y GitHub se quitaron de
 * las cuatro cabeceras (portada, listado de proyectos, proyecto nuevo y barra
 * del editor). Esto no es una herramienta pública: es el motor de montaje de
 * una sola casa, y esos botones mandaban fuera a alguien que ya está dentro.
 *
 * La constante se queda a propósito, y vacía de usos. Es una decisión de fork:
 * `main` es espejo limpio de upstream y lo nuestro se rebasa encima, así que
 * borrar el fichero convertiría cada cambio suyo aquí en un conflicto, mientras
 * que dejarlo hace que un `git rebase` lo resuelva solo. Si algún día vuelven
 * los enlaces, el sitio del que salen sigue siendo éste.
 */
export const DISCORD_INVITE_URL = 'https://discord.gg/aQtQ7NyUBd'
