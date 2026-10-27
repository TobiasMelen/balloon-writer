# partytype

![Balloon letters typed out and popped](docs/balloons.webp)

**[Try it](https://tobiasmelen.github.io/partytype/)**

Type, and your text appears as floating foil balloons: each letter is a
physics-simulated balloon on a string that inflates as you type and pops when
you delete it. Selection, the caret, copy/paste and the keyboard all work like
a normal text field.

Built with three.js (WebGPU), Rapier physics and synthesised Web Audio sounds;
the core needs no framework, and there's a React adapter.

## Repository

- `packages/partytype/`: the npm package (`createBalloons` for any page,
  `<BalloonArea>` and `<BalloonInput>` for React). Its [README](packages/partytype/README.md) covers
  installing and using it.
- `demo/`: the demo site, a Vite app that uses the package through its build
  (`dist/`) like any other app would.

```bash
bun install
bun dev             # rebuilds the package on change, runs the demo with hot reload
bun run build       # the package into packages/partytype/dist/
bun run build:demo  # the package, then the demo site into build/
bun start           # serves the built demo site
```

The demo is at `/`, docs and examples at `/docs.html`, and a page with no framework at `/vanilla.html`. Open it with `?sound`
for a panel to tune the sounds.

To publish: `cd packages/partytype && npm publish`.

## Credits

The balloon letters are based on
["Letter-balloons"](https://sketchfab.com/3d-models/letter-balloons-1dddbbd0e345485bbe557e68827ce9be)
by [danny_p3d](https://sketchfab.com/dannyp_3d), licensed under
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).
