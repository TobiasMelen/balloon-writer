# balloon-writer

Type, and your text appears as floating foil balloons: each letter is a
physics-simulated balloon on a string that inflates as you type and pops when
you delete it. Selection, the caret, copy/paste and the keyboard all work like
a normal text field.

Built with React, React Three Fiber (three.js, WebGPU), Rapier physics and
synthesised Web Audio sounds.

## Using it in your app

```bash
npm install balloon-writer three @react-three/fiber @react-three/drei @react-three/rapier
```

```tsx
import { Suspense } from "react";
import { BalloonArea, BalloonInput } from "balloon-writer";

<Suspense fallback={null}>
  <BalloonArea rows={3} placeholder="Type here" style={{ width: 600, fontSize: 48 }} />
  <BalloonInput autoZoom defaultValue="HELLO" style={{ width: 400 }} />
</Suspense>
```

`<BalloonArea>` is a drop-in `<textarea>` and `<BalloonInput>` a drop-in text
`<input>`: they take the same props (controlled or not), forward `ref` to the
real element and are styled the same way (`className`, `style`, borders,
padding). Extra props:

- `autoZoom`: shrink the text until it all fits, instead of scrolling.
- `containerClassName` / `containerStyle`: for the wrapper around the field
  and its canvas.

They suspend while the balloon model loads, so render them inside
`<Suspense>`. Requires React 19. The model (`alphabet.glb`, ~470 kB) ships
beside the code and is found with `new URL(..., import.meta.url)`, which Vite,
webpack 5, Rollup, Parcel and Next resolve on their own. Letters A–Z only for
now; other characters leave a gap.

## Sound settings

`balloon-writer/sound` exports the live sound settings (`sound`) and the
sounds themselves (`playInflate`, `playPop`), for tuning them.

## Credits

The balloon letters are based on
["Letter-balloons"](https://sketchfab.com/3d-models/letter-balloons-1dddbbd0e345485bbe557e68827ce9be)
by [danny_p3d](https://sketchfab.com/dannyp_3d), licensed under
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).
