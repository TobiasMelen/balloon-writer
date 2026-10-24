// Where a textarea or input lays out its text: a hidden mirror element with
// the field's text styles and width, one span per character, measured. Gives
// each character's centre, each caret slot and its line, in px from the
// field's padding box (unscrolled), so balloons can sit exactly where the
// (invisible) characters are and native selection, wrapping and scrolling
// line up with them.

export type TextLayout = {
  /** Centre of each character (x, y), invisible ones included. */
  chars: { x: number; y: number }[];
  /** Caret slot for each index 0..text.length: x and the line's centre y. */
  carets: { x: number; y: number }[];
  /** Line index of each caret slot. */
  caretLines: number[];
  /** Height of a line, px. */
  lineHeight: number;
  /** Size of the laid-out text (its widest line and all its lines), px. */
  width: number;
  height: number;
};

/** A field whose text the balloons draw. */
export type TextField = HTMLTextAreaElement | HTMLInputElement;

/** Styles that decide how text lays out, copied from the field. */
const COPIED = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontKerning",
  "fontFeatureSettings",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "textAlign",
  "tabSize",
  "direction",
  "wordBreak",
  "overflowWrap",
  "hyphens",
] as const;

let mirror: HTMLDivElement | null = null;

export function measureField(field: TextField): TextLayout {
  mirror ??= Object.assign(document.createElement("div"), { ariaHidden: "true" });
  if (!mirror.isConnected) document.body.append(mirror);
  const style = getComputedStyle(field);
  const singleLine = field instanceof HTMLInputElement;
  const m = mirror.style;
  for (const key of COPIED) m[key] = style[key];
  Object.assign(m, {
    position: "absolute",
    visibility: "hidden",
    left: "-99999px",
    top: "0",
    border: "0",
    overflow: "hidden",
    // The field's own wrapping: none in an input, or a textarea with
    // wrap="off" (or white-space set so), otherwise at its content width
    // (scrollbar excluded).
    whiteSpace: singleLine || field.wrap === "off" || style.whiteSpace === "pre" ? "pre" : "pre-wrap",
    boxSizing: "content-box",
    width: `${field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`,
    height: "auto",
  });

  const text = field.value;
  mirror.textContent = "";
  const spans: HTMLSpanElement[] = [];
  // One span per UTF-16 code unit, so indices match the field's
  // selectionStart/End (an emoji is two).
  for (let i = 0; i < text.length; i++) {
    const span = document.createElement("span");
    span.textContent = text[i]!;
    spans.push(span);
    mirror.append(span);
  }
  // A marker for the slot after the last character.
  const end = document.createElement("span");
  end.textContent = "​";
  mirror.append(end);

  const origin = mirror.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  // An input centres its line in its content box.
  const contentHeight = field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const shift = singleLine ? Math.max(0, (contentHeight - lineHeight) / 2) : 0;
  const boxes = [...spans, end].map((s) => {
    const r = s.getBoundingClientRect();
    return { left: r.left - origin.left, right: r.right - origin.left, mid: (r.top + r.bottom) / 2 - origin.top + shift };
  });

  // Line index from each box's vertical centre.
  const lineOf = (y: number) => Math.max(0, Math.round((y - shift - parseFloat(style.paddingTop) - lineHeight / 2) / lineHeight));
  const chars = boxes.slice(0, -1).map((b) => ({ x: (b.left + b.right) / 2, y: b.mid }));
  // A caret slot sits at the left of the character after it, except at the
  // end of a line (before a line break or the end), where it follows the
  // character before it.
  const carets: { x: number; y: number }[] = [];
  const caretLines: number[] = [];
  for (let k = 0; k <= spans.length; k++) {
    const next = boxes[k]!;
    const atLineEnd = k === spans.length || text[k] === "\n";
    const prev = k > 0 ? boxes[k - 1]! : null;
    const slot = atLineEnd && prev && text[k - 1] !== "\n" ? { x: prev.right, y: prev.mid } : { x: next.left, y: next.mid };
    carets.push(slot);
    caretLines.push(lineOf(slot.y));
  }
  const width = Math.max(0, ...boxes.map((b) => b.right)) - parseFloat(style.paddingLeft);
  const height = (Math.max(0, ...caretLines) + 1) * lineHeight;
  return { chars, carets, caretLines, lineHeight, width, height };
}
