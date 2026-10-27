# balloon-writer

Type, and your text appears as floating foil balloons: each letter is a
physics-simulated balloon on a string that inflates as you type and pops when
you delete it. Selection, the caret, copy/paste and the keyboard all work like
a normal text field.

Built with three.js (WebGPU), Rapier physics and synthesised Web Audio sounds.
No framework needed; a React adapter is included.

```bash
npm install balloon-writer three
```

## Any page

```js
import { createBalloons } from "balloon-writer";

const balloons = createBalloons(document.querySelector("textarea"), { autoZoom: true });
// balloons.setOptions({ sound: "😢" }); balloons.destroy();
```

Attach it to any `<textarea>` or text `<input>`. Its text is hidden at once
(this part is a few KB, including the font that lays it out); three.js, the
physics and the model load in the background, and the balloons appear when
they're ready (`balloons.ready`). The field stays the real,
visible, styled element (borders, padding, scrolling, selection, focus all
work as usual); the balloons draw over it on a canvas placed next to it. Its
value is read every frame, so typing and changes from code both show.

## React

```tsx
import { BalloonArea, BalloonInput } from "balloon-writer/react";

<BalloonArea rows={3} placeholder="Type here" style={{ width: 600, fontSize: 48 }} />
<BalloonInput autoZoom defaultValue="HELLO" style={{ width: 400 }} />
```

`<BalloonArea>` is a drop-in `<textarea>` and `<BalloonInput>` a drop-in text
`<input>`: they take the same props (controlled or not), forward `ref` to the
real element and are styled the same way. Requires React 19.
`containerClassName` / `containerStyle` style the wrapper around the field and
its canvas.

## Options

- `autoZoom`: shrink the text until it all fits, instead of scrolling.
- `sound`: the balloons squeak as they inflate and bang as they pop. The only
  way to turn that off is a sad emoji (`sound: "😢"`; also 😭 😞 😔 🙁 ☹️). A
  singing one (🧑‍🎤, the default, 🎤 🎶 🎵) turns it back on.

The model (`alphabet.glb`, ~470 kB) ships beside the code and is found with
`new URL(..., import.meta.url)`, which Vite, webpack 5, Rollup, Parcel and Next
resolve on their own. Letters A–Z only for now; other characters leave a gap.

## Sound settings

`balloon-writer/sound` exports the live sound settings (`sound`) and the
sounds themselves (`playInflate`, `playPop`), for tuning them.

## Credits

The balloon letters are based on
["Letter-balloons"](https://sketchfab.com/3d-models/letter-balloons-1dddbbd0e345485bbe557e68827ce9be)
by [danny_p3d](https://sketchfab.com/dannyp_3d), licensed under
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).
