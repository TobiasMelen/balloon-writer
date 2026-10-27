// A blank web font with the balloons' widths, for the field's invisible text:
// each letter's advance is its balloon's width (less the tracking overlap), so
// the field lays out, wraps, scrolls and selects text exactly where the
// balloons are drawn. Baked from the model at build time (scripts/font.ts) and
// tiny, so it's in place before the balloons have loaded.
import data from "./metricsFontData";

export const METRICS_FONT = "BalloonMetrics";

let registering: Promise<void> | null = null;
/** Registers the metrics font (once), resolving when it's ready to use. */
export const registerMetricsFont = () =>
  (registering ??= new FontFace(METRICS_FONT, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
    .load()
    .then((face) => void document.fonts.add(face)));
