// Pure text layout for the balloon font. Units are "glyph units" (the
// letter meshes' native size); the scene scales the whole block to fit.

export type Point = { x: number; y: number };

export type Layout = {
  /** Center of each character of the text (invisible ones included). */
  chars: Point[];
  /** Caret slot for each index 0..text.length. */
  carets: Point[];
  /** Line index of each caret slot, for up/down navigation. */
  caretLines: number[];
  lineCount: number;
  width: number;
  height: number;
};

export type Metrics = {
  /** Visual width of a character, 0 for characters without a balloon. */
  width: (char: string) => number;
  glyphHeight: number;
  space: number;
  /** Gap between neighbours as a fraction of their average width (negative
   *  overlaps), so narrow letters aren't crowded more than wide ones. */
  tracking: number;
  lineHeight: number;
};

/**
 * Lay out `text` in fixed coordinates: the first line at y = 0 with later
 * lines below it, left-aligned lines starting at x = 0 (centred ones around
 * it). Slots only move when the text changes; the camera does the framing.
 * With `wrap` off (the default), lines only break at \n, like a textarea with
 * wrap="off"; with it on, they also break to fit `maxWidth`.
 */
export function layoutText(
  text: string,
  m: Metrics,
  maxWidth: number,
  { align = "left", wrap = false }: { align?: "left" | "center"; wrap?: boolean } = {},
): Layout {
  const widthOf = (c: string) => {
    if (c === " ") return m.space;
    const w = m.width(c);
    return w > 0 ? w : m.space; // unsupported characters leave a gap
  };
  /** Gap between character i and the next one. */
  const gap = (i: number) => (m.tracking * (widthOf(text[i]!) + widthOf(text[i + 1] ?? text[i]!))) / 2;

  // Split into lines: hard breaks on \n, soft breaks at spaces (or mid-word
  // when a single word is wider than maxWidth).
  const lines: { start: number; end: number }[] = [];
  let paragraphStart = 0;
  for (let p = 0; p <= text.length; p++) {
    if (p < text.length && text[p] !== "\n") continue;
    let lineStart = paragraphStart;
    let x = 0;
    let lastSpace = -1;
    for (let i = paragraphStart; i < p; i++) {
      const c = text[i]!;
      const w = widthOf(c);
      if (wrap && c !== " " && i > lineStart && x + w > maxWidth) {
        if (lastSpace >= lineStart) {
          lines.push({ start: lineStart, end: lastSpace });
          lineStart = lastSpace + 1;
        } else {
          lines.push({ start: lineStart, end: i });
          lineStart = i;
        }
        lastSpace = -1;
        x = 0;
        for (let j = lineStart; j < i; j++) x += widthOf(text[j]!) + gap(j);
      }
      if (c === " ") lastSpace = i;
      x += w + gap(i);
    }
    lines.push({ start: lineStart, end: p });
    paragraphStart = p + 1;
  }

  const chars: Point[] = new Array(text.length);
  const carets: Point[] = new Array(text.length + 1);
  const caretLines: number[] = new Array(text.length + 1);
  const height = (lines.length - 1) * m.lineHeight;
  let width = 0;

  lines.forEach((line, li) => {
    let lineWidth = 0;
    for (let i = line.start; i < line.end; i++) lineWidth += widthOf(text[i]!) + (i + 1 < line.end ? gap(i) : 0);
    width = Math.max(width, lineWidth);

    const y = -li * m.lineHeight;
    let x = align === "left" ? 0 : -lineWidth / 2;
    for (let i = line.start; i <= line.end; i++) {
      // Later lines overwrite the shared slot of a mid-word soft break, so
      // the caret lands at the start of the next line, like a normal textarea.
      carets[i] = { x: i === line.start ? x : x - gap(i - 1) / 2, y };
      caretLines[i] = li;
      if (i === line.end) break;
      const w = widthOf(text[i]!);
      chars[i] = { x: x + w / 2, y };
      x += w + (i + 1 < line.end ? gap(i) : 0);
    }
  });

  // Characters swallowed by a line break (\n, wrapped space) sit at their caret.
  for (let i = 0; i < text.length; i++) chars[i] ??= carets[i]!;

  return { chars, carets, caretLines, lineCount: lines.length, width, height: height + m.glyphHeight };
}

/** Caret index nearest to a point in layout space. */
export function nearestCaret(layout: Layout, p: Point): number {
  let best = 0;
  let bestScore = Infinity;
  layout.carets.forEach((c, i) => {
    // Weight vertical distance heavily so the closest line wins first.
    const score = Math.abs(c.y - p.y) * 1000 + Math.abs(c.x - p.x);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** Caret index one line up (-1) or down (+1) from `index`, keeping x. */
export function verticalCaret(layout: Layout, index: number, dir: -1 | 1): number {
  const line = layout.caretLines[index]! + dir;
  if (line < 0) return 0;
  if (line >= layout.lineCount) return layout.carets.length - 1;
  const x = layout.carets[index]!.x;
  let best = index;
  let bestDist = Infinity;
  layout.caretLines.forEach((l, i) => {
    if (l !== line) return;
    const d = Math.abs(layout.carets[i]!.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

const charClass = (c: string | undefined) => (c === undefined ? -1 : /\s/.test(c) ? 0 : /[\p{L}\p{N}_]/u.test(c) ? 1 : 2);

/** The word (or run of spaces / punctuation) at `index`, for double-click. */
export function wordRange(text: string, index: number): [number, number] {
  // Prefer the character after the caret, like native double-click.
  const at = index < text.length && text[index] !== "\n" ? index : Math.max(0, index - 1);
  const cls = charClass(text[at]);
  if (cls < 0 || text[at] === "\n") return [index, index];
  let start = at;
  let end = at + 1;
  while (start > 0 && text[start - 1] !== "\n" && charClass(text[start - 1]) === cls) start--;
  while (end < text.length && text[end] !== "\n" && charClass(text[end]) === cls) end++;
  return [start, end];
}

/** The paragraph (hard line) at `index`, for triple-click. */
export function paragraphRange(text: string, index: number): [number, number] {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index);
  return [start, newline < 0 ? text.length : newline];
}
