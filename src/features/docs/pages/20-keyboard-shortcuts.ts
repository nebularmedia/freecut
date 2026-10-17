import type { DocPageContent } from '../docs-content'

const page = {
  order: 20,
  slug: 'keyboard-shortcuts',
  title: 'Keyboard Shortcuts',
  description: 'Default shortcuts by group, plus how to search, rebind, and reset them.',
  category: 'Reference',
  sections: [
    {
      title: 'Playback',
      blocks: [
        {
          kind: 'table',
          headers: ['Action', 'Shortcut'],
          rows: [
            ['Play / Pause', '`Space`'],
            ['Previous / Next frame', '`Left` / `Right`'],
            ['Previous / Next snap point', '`Up` / `Down`'],
            ['Go to start / end', '`Home` / `End`'],
          ],
        },
      ],
    },
    {
      title: 'Editing',
      blocks: [
        {
          kind: 'table',
          headers: ['Action', 'Shortcut'],
          rows: [
            ['Split at playhead', '`Alt+C`'],
            ['Split at cursor', '`S`'],
            ['Join', '`Shift+J`'],
            ['Delete / Ripple delete', '`Delete` / `Ctrl+Delete`'],
            ['Insert freeze frame', '`Shift+F`'],
            ['Link / Unlink clips', '`Ctrl+Alt+L` / `Alt+Shift+L`'],
            ['Toggle linked selection', '`Shift+L`'],
            ['Nudge 1px / 10px', '`Shift+Arrow` / `Ctrl+Shift+Arrow`'],
          ],
        },
      ],
    },
    {
      title: 'Tools',
      blocks: [
        {
          kind: 'table',
          headers: ['Tool', 'Shortcut'],
          rows: [
            ['Selection', '`V`'],
            ['Trim edit', '`T`'],
            ['Razor', '`C`'],
            ['Rate stretch', '`R`'],
            ['Slip', '`Y`'],
            ['Slide', '`U`'],
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'Ripple and rolling are trim behaviors of the **Trim edit** tool, not separate tools with their own shortcut.',
        },
      ],
    },
    {
      title: 'History, view, and clipboard',
      blocks: [
        {
          kind: 'table',
          headers: ['Action', 'Shortcut'],
          rows: [
            ['Undo / Redo', '`Ctrl+Z` / `Ctrl+Shift+Z`'],
            ['Copy / Cut / Paste', '`Ctrl+C` / `Ctrl+X` / `Ctrl+V`'],
            ['Toggle snap / canvas snap', '`N` / `Shift+N`'],
            ['Zoom in / out', '`Ctrl+=` / `Ctrl+-`'],
            ['Zoom to fit / 100%', '`\\` / `Shift+\\`'],
            ['Edit / Color / Motion workspace', '`Alt+1` / `Alt+2` / `Alt+3`'],
          ],
        },
      ],
    },
    {
      title: 'Markers and keyframes',
      blocks: [
        {
          kind: 'table',
          headers: ['Action', 'Shortcut'],
          rows: [
            ['Add / Remove marker', '`M` / `Shift+M`'],
            ['Previous / Next marker', '`[` / `]`'],
            ['Clear keyframes', '`Shift+A`'],
            ['Add keyframe to selected Edit layer', '`K`'],
            ['Keyframe graph / sheet / split view', '`1` / `2` / `3`'],
            ['Previous / Next property keyframe', '`Alt+[` / `Alt+]`'],
            ['Toggle auto-key for active property', '`A`'],
            ['Fit selected keyframes', '`F`'],
          ],
        },
      ],
    },
    {
      title: 'Source monitor and project',
      blocks: [
        {
          kind: 'table',
          headers: ['Action', 'Shortcut'],
          rows: [
            ['Mark In / Out', '`I` / `O`'],
            ['Clear In/Out', '`Alt+X`'],
            ['Insert / Overwrite edit', '`,` / `.`'],
            ['Save', '`Ctrl+S`'],
            ['Export', '`Ctrl+Shift+E`'],
            ['Open Scene Browser', '`Ctrl+Shift+F`'],
          ],
        },
      ],
    },
    {
      title: 'Motion modes',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The tables above are the **FreeCut** layout. The editor also ships a **CapCut** motion mode that moves the same commands onto the keys and mouse gestures a CapCut editor already has. Pick one on first launch, or switch any time from the strip at the top of the shortcut editor.',
        },
        {
          kind: 'table',
          headers: ['Action', 'FreeCut', 'CapCut'],
          rows: [
            ['Split at cursor / at playhead', '`S` / `Alt+C`', '`Ctrl+B` / `Ctrl+Shift+B`'],
            ['Delete left / right of playhead', 'unassigned', '`Q` / `W`'],
            ['Select / Blade tool', '`V` / `C`', '`A` / `B`'],
            ['Select left / right of playhead', 'unassigned', '`[` / `]`'],
            ['Deselect everything', 'unassigned', '`Alt+X`'],
            ['Ripple delete', '`Ctrl+Delete`', '`Ctrl+Shift+D`'],
            ['Zoom to fit', '`\\`', '`Shift+Z`'],
            ['Toggle linked selection', '`Shift+L`', 'the `~` key'],
            ['Main track magnet', 'unassigned', '`P`'],
            ['Jump several frames', 'unassigned', '`Shift+Left` / `Shift+Right`'],
            ['Nudge 1px', '`Shift+Arrow`', '`Alt+Arrow`'],
            ['Markers: previous / next', '`[` / `]`', '`Alt+Shift+M` / `Shift+M`'],
            ['Add keyframe', '`K`', '`Alt+K`'],
            ['Clip volume 0.1 dB up / down', 'unassigned', '`Ctrl+.` / `Ctrl+,`'],
          ],
        },
        {
          kind: 'table',
          headers: ['Wheel over the timeline', 'FreeCut', 'CapCut'],
          rows: [
            ['Bare wheel', 'Travel along the timeline', 'Walk across the tracks'],
            ['Travel along the timeline', 'Bare wheel', '`Alt` + wheel'],
            ['Walk across the tracks', '`Shift` + wheel', 'Bare wheel'],
            ['Resize track heights', '`Alt` + wheel', '`Alt+Shift` + wheel'],
            ['Zoom', '`Ctrl` + wheel', '`Ctrl` + wheel'],
            ['Scroll feel', 'Glides and coasts to a stop', 'Steps the exact distance and stops'],
            [
              'Wheel outside a track pane',
              'Nothing to scroll there',
              'Walks the picture pane anyway',
            ],
          ],
        },
        {
          kind: 'note',
          tone: 'tip',
          text: 'CapCut motion also parks the playhead wherever you click in the timeline — over a track row or in the empty room around them, top to bottom — and turns the bottom video track into a **main track magnet**: it keeps no gaps, a drop into it inserts and pushes the rest along, and deleting from it closes the gap. Press `P` to turn the magnet off.',
        },
      ],
    },
    {
      title: 'Customize shortcuts',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Every binding above is a shipped default. Open the redesigned shortcut editor from the **Keyboard Shortcuts** button (keyboard icon) in the editor toolbar to remap any command to the keys you prefer.',
        },
        {
          kind: 'steps',
          items: [
            'Search commands by name, or filter to the **Custom**, **Conflicts**, or **Unassigned** groups.',
            'Pick a command and press **Record**, then hold your modifiers and press the final key.',
            'If the combo is already in use, the editor flags the conflict — choose **Overwrite** to reassign it, or pick different keys.',
            'Use **Unbind** to clear a binding, or add an alternate binding alongside the primary one.',
          ],
        },
        {
          kind: 'note',
          tone: 'tip',
          text: 'Use **Reset** to restore a single command, or **Reset All** to return every shortcut to its default. You can also **Export** your bindings to a preset file and **Import** it on another machine.',
        },
      ],
    },
  ],
} satisfies DocPageContent

export default page
