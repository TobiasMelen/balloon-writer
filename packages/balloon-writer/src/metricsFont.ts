// A blank web font with the balloons' widths, for the textarea's invisible
// text: each letter's advance is its balloon's width (less the tracking
// overlap), so the textarea lays out, wraps, scrolls and selects text exactly
// where the balloons are drawn. Built at runtime from the loaded glyphs.
//
// One em is a balloon's height. The content box (ascent to descent) is
// centred on the baseline, so a character's box centre is where its balloon
// centre goes.
import opentype from "opentype.js";
import { TRACKING, type Glyphs } from "./glyphs";

export const METRICS_FONT = "BalloonMetrics";
/** Line height (in em) that fits a row of balloons. */
export const LINE_HEIGHT = 1.08;
const EM = 1000;
// OS/2 fsSelection bits.
const REGULAR = 1 << 6;
const USE_TYPO_METRICS = 1 << 7;
/** Space between words, in em. */
const SPACE = 0.8;

let registering: Promise<void> | null = null;

/** Registers the metrics font (once), resolving when it's ready to use. */
export function registerMetricsFont({ glyphs, glyphHeight }: Glyphs) {
  return (registering ??= (async () => {
    const advance = (width: number) => Math.round(((width * (1 + TRACKING)) / glyphHeight) * EM);
    const blank = (name: string, unicode: number | undefined, advanceWidth: number) =>
      new opentype.Glyph({ name, unicode, advanceWidth, path: new opentype.Path() });
    const list = [blank(".notdef", undefined, Math.round(SPACE * EM)), blank("space", 32, Math.round(SPACE * EM))];
    for (const [letter, glyph] of glyphs) {
      list.push(blank(letter, letter.charCodeAt(0), advance(glyph.width)));
      // Lowercase is drawn as the same balloons.
      list.push(blank(letter.toLowerCase(), letter.toLowerCase().charCodeAt(0), advance(glyph.width)));
    }
    const font = new opentype.Font({
      familyName: METRICS_FONT,
      styleName: "Regular",
      unitsPerEm: EM,
      ascender: (LINE_HEIGHT / 2) * EM,
      descender: -(LINE_HEIGHT / 2) * EM,
      glyphs: list,
    });
    // The glyphs are blank, so the Windows metrics (derived from their
    // outlines) would come out zero and browsers pick some other "normal"
    // line height. Set them, and prefer the typo metrics, so line-height:
    // normal is LINE_HEIGHT everywhere (give or take browsers rounding it).
    // (Merged into the generated OS/2 table; the typings want a whole one.)
    Object.assign(font.tables, { os2: { usWinAscent: (LINE_HEIGHT / 2) * EM, usWinDescent: (LINE_HEIGHT / 2) * EM, fsSelection: REGULAR | USE_TYPO_METRICS } });
    const face = new FontFace(METRICS_FONT, font.toArrayBuffer());
    document.fonts.add(await face.load());
  })());
}
