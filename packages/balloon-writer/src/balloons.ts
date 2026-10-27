// createBalloons: draws a <textarea>'s or text <input>'s text as floating
// foil balloons. No framework: the adapters (react.tsx, …) and plain pages
// all attach it to a real field.
//
// The field stays the visible, styled element: className, style, borders,
// padding, rows/cols, resize, scrolling, typing, IME, paste, selection
// (mouse, keyboard, touch handles) and focus all work as on a plain one. Its
// text is invisible, set in a metrics font whose letters are as wide as the
// balloons (metricsFont.ts), so its native layout is where the balloons go:
// a transparent canvas over it draws a balloon on each character (measured,
// see measure.ts), a caret on its caret and a highlight on its selection.
// The field is read every frame (its text, selection, scroll, size), so
// anything that changes it, typing or code, shows.
//
// autoZoom shrinks the field's font until all the text fits instead of
// scrolling; the balloons keep their physical size and the camera pulls back.
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three/webgpu";
import { createCaret } from "./caret";
import { loadGlyphs, type Glyphs } from "./glyphs";
import {
  ANCHOR_DROP,
  POP_LIFETIME,
  compileShaders,
  createLetter,
  createRopes,
  placeLetter,
  popLetter,
  removeLetter,
  setSelectionGlow,
  stepLetter,
  type Letter,
} from "./letters";
import { measureField, type TextField } from "./measure";
import { METRICS_FONT, registerMetricsFont } from "./metricsFont";
import { createSelection, type Layout } from "./selection";
import { prepareAudio } from "./sound";
import { watchSystemColors } from "./systemColors";

/** Sound on. */
export type SingingEmoji = "🧑‍🎤" | "🎤" | "🎶" | "🎵";
/** Sound off: the only way to turn it off. */
export type SadEmoji = "😢" | "😭" | "😞" | "😔" | "🙁" | "☹️";
const SAD = new Set<string>(["😢", "😭", "😞", "😔", "🙁", "☹️"] satisfies SadEmoji[]);

export type BalloonOptions = {
  /** Shrink the text until it all fits, instead of scrolling. */
  autoZoom?: boolean;
  /** The balloons squeak as they inflate and bang as they pop, unless this
   *  is a sad emoji. Default 🧑‍🎤. */
  sound?: SingingEmoji | SadEmoji;
};

/** The camera's vertical field of view, degrees, narrowed for wide boxes so
 *  no letter is more than MAX_HALF_WIDTH (radians) off straight ahead. */
const FOV = 40;
const MAX_HALF_WIDTH = THREE.MathUtils.degToRad(24);
/** Zoom spring stiffness (1/s²): settles in about 0.6 s. */
const ZOOM_STIFFNESS = 60;
/** iOS zooms the page into inputs with text under 16px: autoZoom stops
 *  there (or at the field's own size, if that's smaller). */
const MIN_FONT_SIZE = 16;
/** How far (in em of the field's own font) the balloons may drift out past
 *  its padding box before they're cut off, fading out over the outer half. */
const OVERFLOW = 0.6;

/** The native selection is hidden (the balloons draw their own); the
 *  placeholder is real text in a real font. Nothing else: the field keeps
 *  the browser's (and the page's) own styles. */
const BASE_CSS = `
.balloon-area::selection { background: transparent; color: transparent; }
.balloon-area::placeholder { color: #8e8e8e; font-family: system-ui, sans-serif; }
`;

let loading: Promise<Glyphs> | null = null;
/** Loads what the balloons need, once: the letters, the physics engine and
 *  the metrics font. */
export const loadBalloons = () =>
  (loading ??= (async () => {
    const [glyphs] = await Promise.all([loadGlyphs(), RAPIER.init()]);
    await registerMetricsFont(glyphs);
    if (!document.getElementById("balloon-area-css"))
      document.head.prepend(Object.assign(document.createElement("style"), { id: "balloon-area-css", textContent: BASE_CSS }));
    return glyphs;
  })());

export type Balloons = ReturnType<typeof createBalloons>;

/** Draws `field`'s text as balloons, once they've loaded (the field works as
 *  a plain one until then). */
export function createBalloons(field: TextField, options: BalloonOptions = {}) {
  let current = { ...options };
  let instance: Awaited<ReturnType<typeof start>> | null = null;
  let destroyed = false;
  const ready = loadBalloons()
    .then((glyphs) => (destroyed ? null : start(field, glyphs, () => current)))
    .then((started) => {
      if (destroyed) started?.destroy();
      else instance = started;
    });
  return {
    /** Resolves once the balloons are showing. */
    ready,
    setOptions(next: BalloonOptions) {
      current = { ...current, ...next };
      instance?.relayout();
    },
    destroy() {
      destroyed = true;
      instance?.destroy();
    },
  };
}

async function start(field: TextField, { glyphs, glyphHeight }: Glyphs, options: () => BalloonOptions) {
  const soundOn = () => !SAD.has(options().sound ?? "");
  const multiline = field instanceof HTMLTextAreaElement;

  // The canvas: next to the field, over its padding box and a margin round
  // it (see OVERFLOW), letting clicks through to the field.
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "absolute", pointerEvents: "none" });
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  await renderer.init();
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  field.after(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 6, 8);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4), sun);
  // Reflections on the foil: a few soft light panels around the text,
  // rendered once into a cube map.
  const studio = new THREE.Scene();
  for (const [intensity, x, y, z, w, h, color] of [
    [2, 0, 5, 5, 10, 2, 0xffffff],
    [1.5, -6, 0, 3, 8, 4, 0xffffff],
    [1.5, 6, 0, 3, 8, 4, 0xffffff],
    [0.6, 0, -4, 4, 10, 2, 0xffd9a0],
  ]) {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity!), side: THREE.DoubleSide, toneMapped: false });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    panel.position.set(x!, y!, z!);
    panel.scale.set(w!, h!, 1);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  const environment = new THREE.CubeRenderTarget(256, { type: THREE.HalfFloatType });
  new THREE.CubeCamera(1, 1000, environment).update(renderer, studio);
  scene.environment = environment.texture;

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // Softer contact correction (default 30): overlapping letters ease apart
  // instead of being kicked out of each other, but still push each other firmly.
  world.integrationParameters.contact_natural_frequency = 8;
  const ropes = createRopes();
  scene.add(ropes.mesh);
  const caret = createCaret(world, scene, glyphHeight);
  const selection = createSelection(scene);
  const stopColors = watchSystemColors(field, ({ highlight, accent }) => {
    setSelectionGlow(highlight.color);
    selection.setColor(highlight);
    caret.setColor(accent.color);
  });
  // The first letter typed shouldn't stall on building shaders or sounds.
  compileShaders(renderer, camera, scene, glyphs.get("A")!, ropes.resources);
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 500));
  idle(() => soundOn() && prepareAudio());

  // The field's text is laid out but not drawn: the balloons are.
  const restore = { className: field.className, style: field.getAttribute("style") };
  field.classList.add("balloon-area");
  Object.assign(field.style, { fontFamily: `${METRICS_FONT}, system-ui, sans-serif`, color: "transparent", caretColor: "transparent" });

  let text = "";
  /** A letter per character (null where there's no balloon, e.g. spaces;
   *  undefined until laid out), and popped letters still on their way out. */
  let letters: (Letter | null | undefined)[] = [];
  const dying: Letter[] = [];
  let layout: Layout = { chars: [], carets: [{ x: 0, y: 0 }], caretLines: [0] };
  /** World units per px, the text's origin (the content box's top-left) in
   *  the padding box, and the canvas's margin round the padding box, px. */
  let scale = 1;
  let origin = { x: 0, y: 0 };
  let margin = 0;
  /** autoZoom's font size (null: the field's own), and the field's own. */
  let zoomFont: number | null = null;
  let baseFont = 0;
  let ownFontSize = field.style.fontSize;
  // With autoZoom, a letter typed at the edge overflows for a frame, and the
  // field scrolls to it until the font shrinks: the camera ignores that,
  // following the scroll only once the font can't shrink further.
  let followScroll = true;
  /** The field's box when last laid out, and the canvas's size. */
  let seen = "";
  let size = "";
  const boxOf = () => [field.offsetLeft, field.offsetTop, field.clientLeft, field.clientTop, field.clientWidth, field.clientHeight].join();

  const setZoom = (size: number | null) => {
    zoomFont = size;
    field.style.fontSize = size === null ? ownFontSize : `${size}px`;
  };

  // Lay the text out where the field does; with autoZoom, shrink (or regrow)
  // the font until it all fits.
  const relayout = () => {
    let measured = measureField(field);
    let fontSize = 0;
    for (let tries = 0; tries < 4; tries++) {
      const css = getComputedStyle(field);
      fontSize = parseFloat(css.fontSize);
      if (zoomFont === null) baseFont = fontSize;
      if (!options().autoZoom) {
        if (zoomFont === null) break;
        setZoom(null);
      } else {
        const availW = field.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        const availH = field.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        // Room for the strings below the last line too. An input is one line
        // tall whatever its font size: only its width counts.
        const drop = (ANCHOR_DROP * 0.6 * fontSize) / glyphHeight;
        const fitH = multiline ? availH / Math.max(measured.height + drop, 1) : Infinity;
        const fit = Math.min(availW / Math.max(measured.width, 1), fitH);
        const next = Math.max(Math.min(MIN_FONT_SIZE, baseFont), Math.min(baseFont, Math.floor(fontSize * fit * 2) / 2));
        if (Math.abs(next - fontSize) < 0.5) break;
        setZoom(next === baseFont ? null : next);
      }
      measured = measureField(field);
    }
    const css = getComputedStyle(field);
    fontSize = parseFloat(css.fontSize);
    scale = glyphHeight / fontSize;
    origin = { x: parseFloat(css.paddingLeft), y: parseFloat(css.paddingTop) };
    followScroll = !options().autoZoom || fontSize <= Math.min(MIN_FONT_SIZE, baseFont);
    // From the field's own font, so it stays put while autoZoom zooms.
    margin = Math.round(baseFont * OVERFLOW);

    // The measured layout in world units (y up).
    const at = (p: { x: number; y: number }) => ({ x: (p.x - origin.x) * scale, y: -(p.y - origin.y) * scale });
    layout = { chars: measured.chars.map(at), carets: measured.carets.map(at), caretLines: measured.caretLines };
    // Each letter's slot, and the centre of its word (a run of non-spaces on
    // one line), where the word's strings gather. New letters start there.
    for (let i = 0; i < text.length; ) {
      let end = i;
      if (!/\s/.test(text[i]!)) while (end + 1 < text.length && !/\s/.test(text[end + 1]!) && layout.caretLines[end + 1] === layout.caretLines[i]) end++;
      const wordX = (layout.chars[i]!.x + layout.chars[end]!.x) / 2;
      for (let j = i; j <= end; j++) {
        const slot = { ...layout.chars[j]!, wordX, line: layout.caretLines[j]! };
        const glyph = glyphs.get(text[j]!.toUpperCase());
        if (letters[j] === undefined) letters[j] = glyph ? createLetter(world, scene, glyph, slot, soundOn()) : null;
        else if (letters[j]) letters[j]!.slot = slot;
      }
      i = end + 1;
    }
    place();
  };

  // The canvas over the padding box and margin, sized to it.
  const place = () => {
    seen = boxOf();
    const width = field.clientWidth + 2 * margin;
    const height = field.clientHeight + 2 * margin;
    Object.assign(canvas.style, { left: `${field.offsetLeft + field.clientLeft - margin}px`, top: `${field.offsetTop + field.clientTop - margin}px` });
    if (`${width},${height}` === size) return;
    size = `${width},${height}`;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    // Solid over the field and the inner half of the margin, fading out
    // over the outer half.
    const fade = (to: string) => `linear-gradient(to ${to}, transparent, #000 ${margin / 2}px, #000 calc(100% - ${margin / 2}px), transparent)`;
    canvas.style.maskImage = `${fade("right")}, ${fade("bottom")}`;
    canvas.style.maskComposite = "intersect";
  };

  // A changed value: letters that went pop, new characters get letters when
  // laid out. Ids stay put for unchanged text before and after the edit, so
  // only what changed (de)inflates.
  const sync = () => {
    const value = field.value;
    let start = 0;
    while (start < text.length && start < value.length && text[start] === value[start]) start++;
    let end = 0;
    while (end < text.length - start && end < value.length - start && text[text.length - 1 - end] === value[value.length - 1 - end]) end++;
    for (const letter of letters.slice(start, letters.length - end))
      if (letter) {
        popLetter(world, letter, soundOn());
        dying.push(letter);
      }
    letters = [...letters.slice(0, start), ...Array<undefined>(value.length - start - end), ...letters.slice(letters.length - end)];
    text = value;
    relayout();
  };

  // Font size, class or layout attributes changed: relaid out. A font size
  // set from outside (or a new class) while zoomed starts autoZoom over from it.
  const attributes = new MutationObserver((records) => {
    if (zoomFont !== null && (field.style.fontSize !== `${zoomFont}px` || records.some((r) => r.attributeName === "class"))) {
      if (field.style.fontSize !== `${zoomFont}px`) ownFontSize = field.style.fontSize;
      setZoom(null);
    }
    relayout();
  });
  attributes.observe(field, { attributes: true, attributeFilter: ["style", "class", "wrap", "rows", "cols", "size"] });
  document.fonts.addEventListener("loadingdone", relayout);

  // The camera frames exactly the field's visible padding box (and margin),
  // so each balloon sits over its (invisible) character. A change of scale
  // (autoZoom stepping the font size) is eased: the text's world positions
  // don't change with it (px and units-per-px change inversely), so easing
  // only the camera zooms smoothly, about the text's top-left. (The padding
  // is fixed in px, so it's left out of world positions: it would grow in
  // world units as the font shrinks and drag every letter.) A critically
  // damped spring on the log of the scale, so each new step carries on the
  // zoom's current speed instead of kicking off a new ease.
  const zoom = { log: NaN, speed: 0 };
  const frameCamera = (dt: number) => {
    const target = Math.log(scale);
    if (Number.isNaN(zoom.log)) zoom.log = target;
    zoom.speed += (ZOOM_STIFFNESS * (target - zoom.log) - 2 * Math.sqrt(ZOOM_STIFFNESS) * zoom.speed) * dt;
    zoom.log += zoom.speed * dt;
    const u = Math.exp(zoom.log);
    const left = (followScroll ? field.scrollLeft : 0) - origin.x - margin;
    const top = (followScroll ? field.scrollTop : 0) - origin.y - margin;
    const width = field.clientWidth + 2 * margin;
    const height = field.clientHeight + 2 * margin;
    // A wide, short box would need a very wide-angle view from close up:
    // letters toward its ends turn to face the camera and pack together.
    // Narrowing the view keeps them within MAX_HALF_WIDTH of straight ahead.
    camera.fov = Math.min(FOV, 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(MAX_HALF_WIDTH) / (width / height))));
    camera.updateProjectionMatrix();
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set((left + width / 2) * u, -(top + height / 2) * u, ((height / 2) * u) / tan);
  };

  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const delta = Math.max(0, (now - last) / 1000);
    last = now;
    const dt = Math.min(delta, 1 / 30);
    const time = now / 1000;
    // Typed or set from code, or moved or resized: laid out again.
    if (field.value !== text) sync();
    else if (boxOf() !== seen) relayout();
    frameCamera(Math.min(delta, 0.1));

    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    letters.forEach((letter, i) => letter && (letter.selected = i >= start && i < end));
    for (const letter of letters) if (letter) stepLetter(letter, camera, time, dt);
    for (const letter of dying) stepLetter(letter, camera, time, dt);
    if (dt > 0) {
      world.timestep = dt;
      world.step();
    }
    for (const letter of letters) if (letter) placeLetter(letter, dt);
    for (const letter of dying) placeLetter(letter, dt);
    // Popped letters go once their deflate animation and string are done.
    for (let i = dying.length - 1; i >= 0; i--)
      if (dying[i]!.dead > POP_LIFETIME) removeLetter(world, dying.splice(i, 1)[0]!);
    ropes.update([...letters, ...dying].filter((l): l is Letter => !!l));

    // The caret sits where the letters belong on the line, not where the
    // balloons have drifted to.
    const caretAt = layout.carets[Math.min(field.selectionDirection === "backward" ? start : end, text.length)] ?? { x: 0, y: 0 };
    caret.update(caretAt.x, caretAt.y, document.activeElement === field && start === end, time, dt);
    selection.update(layout, letters, start, end, glyphHeight, camera);
    renderer.render(scene, camera);
  });

  return {
    relayout,
    destroy() {
      renderer.setAnimationLoop(null);
      attributes.disconnect();
      document.fonts.removeEventListener("loadingdone", relayout);
      stopColors();
      ropes.dispose();
      caret.dispose();
      selection.dispose();
      environment.dispose();
      studio.traverse((o) => o instanceof THREE.Mesh && (o.geometry.dispose(), o.material.dispose()));
      world.free();
      renderer.dispose();
      canvas.remove();
      field.className = restore.className;
      if (restore.style === null) field.removeAttribute("style");
      else field.setAttribute("style", restore.style);
    },
  };
}
