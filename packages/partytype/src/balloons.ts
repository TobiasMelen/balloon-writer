// createBalloons: a <textarea>'s or text <input>'s text drawn as
// physics-simulated foil letter balloons, with no framework.
//
// This part is tiny and runs at once: the field's text goes invisible, laid
// out in the metrics font, so nothing shifts when the balloons appear. The
// balloons (three.js, the physics, the model: engine.ts) load on demand.
import type { TextField } from "./measure";
import { METRICS_FONT, registerMetricsFont } from "./metricsFont";

/** Sound on. */
export type SingingEmoji = "🧑‍🎤" | "🎤" | "🎶" | "🎵";
/** Sound off: the only way to turn it off. */
export type SadEmoji = "😢" | "😭" | "😞" | "😔" | "🙁" | "☹️";

export type BalloonOptions = {
  /** Shrink the text until it all fits, instead of scrolling. */
  autoZoom?: boolean;
  /** The balloons squeak as they inflate and bang as they pop, unless this
   *  is a sad emoji. Default 🧑‍🎤. */
  sound?: SingingEmoji | SadEmoji;
};

export type Balloons = ReturnType<typeof createBalloons>;

/** Draws `field`'s text as balloons. The text is hidden right away (the
 *  native caret stays until the balloons take over); they appear once loaded.
 *  If they can't load (offline, or a CSP that blocks WebAssembly), the field
 *  goes back to plain text and `ready` rejects. */
export function createBalloons(field: TextField, options: BalloonOptions = {}) {
  let current = { ...options };
  let engine: Awaited<ReturnType<typeof import("./engine").start>> | null = null;
  let destroyed = false;
  const restore = { className: field.className, style: field.getAttribute("style") };
  const putBack = () => {
    field.className = restore.className;
    if (restore.style === null) field.removeAttribute("style");
    else field.setAttribute("style", restore.style);
  };
  // The caret keeps its colour (by default the text's, now transparent).
  const caretColor = getComputedStyle(field).caretColor;
  Object.assign(field.style, { fontFamily: `${METRICS_FONT}, system-ui, sans-serif`, color: "transparent", caretColor });
  const ready = Promise.all([import("./engine"), registerMetricsFont()])
    .then(([{ start }]) => start(field, () => current))
    .then((started) => {
      if (destroyed) started.destroy();
      else engine = started;
    })
    .catch((error) => {
      if (!destroyed) putBack();
      throw error;
    });
  return {
    /** Resolves once the balloons are showing; rejects if they can't load. */
    ready,
    setOptions(next: BalloonOptions) {
      current = { ...current, ...next };
      engine?.relayout();
    },
    /** Takes the balloons off, leaving the field as it was. */
    destroy() {
      destroyed = true;
      engine?.destroy();
      putBack();
    },
  };
}
