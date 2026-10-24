# balloon-writer

Type, and your text appears as floating foil balloons: each letter is a
physics-simulated balloon on a string that inflates as you type and pops when
you delete it. Selection, the caret, copy/paste and the keyboard all work like
a normal text field.

Built with React, React Three Fiber (three.js, WebGPU), Rapier physics and
synthesised Web Audio sounds.

## Running

```bash
bun install
bun dev        # development server with hot reload
bun run build  # production build into dist/
bun start      # production server
```

Open with `?sound` for a panel to tune the sounds.

## Credits

The balloon letters are based on
["Letter-balloons"](https://sketchfab.com/3d-models/letter-balloons-1dddbbd0e345485bbe557e68827ce9be)
by [danny_p3d](https://sketchfab.com/dannyp_3d), licensed under
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).
