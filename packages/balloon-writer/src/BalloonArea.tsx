// <BalloonArea> and <BalloonInput>: a textarea and an input whose text is
// drawn as floating foil balloons.
//
// The real <textarea> (or <input>) is the visible, styled element:
// className, style, borders, padding, rows/cols, resize, scrolling and a ref
// all work as on a plain one, and so do typing, IME, paste, selection (mouse,
// keyboard, touch handles) and focus. Its text is invisible, set in a metrics
// font whose letters are as wide as the balloons (metricsFont.ts), so its
// native layout is where the balloons go: a transparent canvas over its
// padding box draws a balloon on each character (measured, see measure.ts),
// a caret on its caret and a highlight on its selection.
//
// autoZoom shrinks the field's font until all the text fits instead of
// scrolling; the balloons keep their physical size and the camera pulls back.
import {
  Suspense,
  createElement,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type Ref,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { loadGlyphs, type Glyphs } from "./glyphs";
import { measureField, type TextField, type TextLayout } from "./measure";
import { METRICS_FONT, registerMetricsFont } from "./metricsFont";
import {
  ANCHOR_DROP,
  CARET_COLLISION,
  LetterBalloon,
  LetterPoseContext,
  compileShaders,
  setSelectionGlow,
  NO_COLLISION,
  POP_LIFETIME,
  RopeBatch,
  RopeContext,
  SoundContext,
  buildRopeResources,
  type RopeResources,
  type Glyph,
  type LetterPoses,
  type RopeRegistry,
} from "./LetterBalloon";
import { useSystemColors, type SystemColor } from "./systemColors";
import { prepareAudio } from "./sound";

type Item = { id: number; char: string };

/** The text's layout in world units (y up): character centres, caret slots
 *  and their lines. */
type Layout = { chars: { x: number; y: number }[]; carets: { x: number; y: number }[]; caretLines: number[] };

/** Semi-implicit damped spring step on a scalar. */
function spring(state: { x: number; v: number }, target: number, k: number, c: number, dt: number) {
  state.v += ((target - state.x) * k - state.v * c) * dt;
  state.x += state.v * dt;
}
type Ghost = Item & { diedAt: number };

let nextId = 0;

/** Keep stable ids per character so edits only (de)inflate what changed. */
function diffItems(prev: Item[], prevText: string, text: string) {
  let start = 0;
  while (start < prevText.length && start < text.length && prevText[start] === text[start]) start++;
  let end = 0;
  while (
    end < prevText.length - start &&
    end < text.length - start &&
    prevText[prevText.length - 1 - end] === text[text.length - 1 - end]
  )
    end++;
  const removed = prev.slice(start, prev.length - end);
  const added = Array.from(text.slice(start, text.length - end), (char) => ({ id: nextId++, char }));
  return { items: [...prev.slice(0, start), ...added, ...prev.slice(prev.length - end)], removed };
}

// Real carets blink about every 530ms and stay solid for a moment after
// each keystroke or move. This one blinks by quickly scaling to nothing.
const BLINK_HALF = 0.53;
const BLINK_HOLD = 0.5;
/** Seconds a blink takes to scale out (and back in). */
const BLINK_EDGE = 0.06;
const CARET_RADIUS = 0.035;
/** Half-depth of the caret's collider: a deep slab, so letters can't slide
 *  in front of or behind it. */
const CARET_DEPTH = 0.6;

function Caret({ x, y, height, visible, color }: { x: number; y: number; height: number; visible: boolean; color: THREE.Color }) {
  const body = useRef<RapierRigidBody>(null);
  const visual = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const props = useRef({ x, y, visible });
  props.current = { x, y, visible };
  const anim = useRef({ show: { x: 0, v: 0 }, lastMove: 0, at: { x: NaN, y: NaN } });

  useFrame(({ clock }, delta) => {
    const b = body.current;
    if (!b) return;
    const dt = Math.min(delta, 1 / 30);
    const a = anim.current;
    const p = props.current;
    const now = clock.elapsedTime;

    // Jump straight to the new slot like a real caret. setTranslation
    // teleports without giving the body velocity, so it doesn't swat
    // balloons on the way; they ease out of the slab once it's there.
    if (p.x !== a.at.x || p.y !== a.at.y) {
      b.setTranslation({ x: p.x, y: p.y, z: 0 }, true);
      a.at = { x: p.x, y: p.y };
      a.lastMove = now;
    }
    spring(a.show, p.visible ? 1 : 0, 400, 24, dt);

    // Blink: shown while typing, then on/off on a real caret's rhythm,
    // scaling to nothing and back quickly.
    const sinceMove = now - a.lastMove;
    let blink = 1;
    if (sinceMove > BLINK_HOLD) {
      const cycle = (sinceMove - BLINK_HOLD) % (BLINK_HALF * 2);
      const edge = (x: number) => THREE.MathUtils.smootherstep(x, 0, BLINK_EDGE);
      blink = cycle < BLINK_HALF ? 1 - edge(cycle) : edge(cycle - BLINK_HALF);
    }
    const scale = Math.max(blink * a.show.x, 0.0001);
    visual.current?.scale.setScalar(scale);
    const scaleY = scale;
    if (light.current) light.current.intensity = 1.5 * scaleY;
  });

  return (
    <RigidBody ref={body} type="kinematicPosition" position={[x, y, 0]} colliders={false}>
      <CuboidCollider
        args={[CARET_RADIUS * 1.5, (height * 0.85) / 2 + CARET_RADIUS, CARET_DEPTH]}
        collisionGroups={visible ? CARET_COLLISION : NO_COLLISION}
        contactSkin={0.04}
      />
      {/* Drawn over everything, like a real caret, so it isn't buried in the
          balloons it nudges. At the slot's own depth: drawn nearer the
          camera, perspective would push it off its slot. */}
      <group ref={visual}>
        <mesh raycast={() => null} renderOrder={10}>
          <capsuleGeometry args={[CARET_RADIUS, height * 0.85, 8, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} toneMapped={false} depthTest={false} transparent />
        </mesh>
        <pointLight ref={light} color={color} distance={1.6} decay={1.5} />
      </group>
    </RigidBody>
  );
}

/** How far the selection highlight follows its letters away from their slots
 *  (0 = fixed to the line like real text, 1 = stuck to the balloons). */
const SELECTION_FOLLOW = 0.85;
/** Depth of the highlight: in front of the balloons. */
const SELECTION_Z = 0.6;
/** How far an edge may drift (fraction of the line height) and tilt
 *  (radians, ~20°) with its balloons. */
const SELECTION_MAX_DRIFT = 0.4;
const SELECTION_MAX_ROLL = 0.35;

type Drift = { x: number; y: number; roll: number };
/** A selection block edge: its bottom and top points (x, y). */
type Edge = [[number, number], [number, number]];
const average = (a: Drift | null, b: Drift | null): Drift =>
  a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, roll: (a.roll + b.roll) / 2 } : (a ?? b ?? { x: 0, y: 0, roll: 0 });

/** A text-editor-style selection: a translucent overlay in the system's
 *  selection colour, in front of the selected characters (spaces too), from caret slot to caret slot. It's one ribbon per line: at each
 *  boundary between two characters the edge drifts and tilts part of the way
 *  with their balloons (the average of the two), so the highlight sways a
 *  little with the letters but neighbouring blocks share their edges and
 *  never split. */
function SelectionHighlight({
  layout,
  items,
  start,
  end,
  height,
  poses,
  color,
}: {
  layout: Layout;
  items: Item[];
  start: number;
  end: number;
  height: number;
  poses: LetterPoses;
  /** The system's text selection colour (and its alpha). */
  color: SystemColor;
}) {
  const camera = useThree((s) => s.camera);
  const [mesh, setMesh] = useState<THREE.Mesh | null>(null);
  const props = useRef({ layout, items, start, end, height });
  props.current = { layout, items, start, end, height };

  // Two triangles per character; rebuilt with room to spare when a
  // selection outgrows it.
  const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, end - start))));
  useEffect(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    // Neighbouring blocks only share edges, so the transparency has no
    // darker seams where they meet.
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geometry, material);
    m.renderOrder = 1;
    m.frustumCulled = false;
    m.raycast = () => {};
    setMesh(m);
    return () => {
      geometry.dispose();
      (m.material as THREE.Material).dispose();
    };
  }, [capacity]);

  useEffect(() => {
    if (!mesh) return;
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color.copy(color.color);
    material.opacity = color.alpha;
  }, [mesh, color]);

  useFrame(() => {
    if (!mesh) return;
    const { layout, items, start, end, height } = props.current;
    const sameLine = (i: number, j: number) => layout.caretLines[i] === layout.caretLines[j];
    // Offset (and roll) of character i from its slot, scaled by the follow;
    // null for characters without a balloon (spaces) or outside the selection.
    const drift = (i: number): Drift | null => {
      if (i < start || i >= end) return null;
      const pose = items[i] && poses.get(items[i]!.id);
      if (!pose) return null;
      // Limited, so neighbouring edges can't cross (a bow-tie) however far
      // unsettled balloons wander or tilt.
      const limit = height * SELECTION_MAX_DRIFT;
      const clampTo = (v: number, max: number) => Math.max(-max, Math.min(max, v));
      return {
        x: clampTo((pose.x - pose.slotX) * SELECTION_FOLLOW, limit),
        y: clampTo((pose.y - pose.slotY) * SELECTION_FOLLOW, limit),
        roll: clampTo(pose.roll * SELECTION_FOLLOW, SELECTION_MAX_ROLL),
      };
    };
    // In front of the balloons, so scale positions in toward the camera to
    // line up with the letters on screen.
    const depth = (camera.position.z - SELECTION_Z) / camera.position.z;
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = position.array as Float32Array;
    let v = 0;
    // Character i's drift, a space taking its neighbours' (null if it has no
    // block: outside the selection, or a line break).
    const hasBlock = (i: number) => i >= start && i < end && sameLine(i, i + 1);
    const own = (i: number): Drift | null =>
      hasBlock(i) ? (drift(i) ?? average(sameLine(i - 1, i) ? drift(i - 1) : null, sameLine(i + 1, i + 2) ? drift(i + 1) : null)) : null;
    // The edge at caret slot k, between characters k - 1 and k: bottom and
    // top. Shared by the two blocks meeting there.
    const edge = (k: number): Edge => {
      const d = average(own(k - 1), own(k));
      const c = layout.carets[k]!;
      const x = c.x + d.x;
      const y = c.y + d.y;
      const ux = -Math.sin(d.roll) * (height / 2);
      const uy = Math.cos(d.roll) * (height / 2);
      const project = (px: number, py: number): [number, number] => [
        camera.position.x + (px - camera.position.x) * depth,
        camera.position.y + (py - camera.position.y) * depth,
      ];
      return [project(x - ux, y - uy), project(x + ux, y + uy)];
    };
    const put = ([x, y]: [number, number]) => {
      out[v++] = x;
      out[v++] = y;
      out[v++] = SELECTION_Z;
    };
    // Per run of blocks on a line: every edge once, then kept in left-to-right
    // order (bottoms and tops separately), so however unsettled the balloons
    // a block can't turn inside out into a bow-tie.
    const blocks = (i: number) => hasBlock(i) && layout.carets[i + 1]!.x > layout.carets[i]!.x;
    for (let i = start; i < end; i++) {
      if (!blocks(i)) continue;
      let last = i;
      while (last + 1 < end && blocks(last + 1) && sameLine(last, last + 1)) last++;
      const edges: Edge[] = [];
      for (let k = i; k <= last + 1; k++) edges.push(edge(k));
      for (let e = 1; e < edges.length; e++)
        for (const side of [0, 1] as const) edges[e]![side][0] = Math.max(edges[e]![side][0], edges[e - 1]![side][0]);
      for (let e = 0; e + 1 < edges.length && v + 18 <= out.length; e++) {
        const [bl, tl] = edges[e]!;
        const [br, tr] = edges[e + 1]!;
        put(bl), put(br), put(tr);
        put(bl), put(tr), put(tl);
      }
      i = last;
    }
    mesh.geometry.setDrawRange(0, v / 3);
    position.needsUpdate = true;
  });

  return mesh ? <primitive object={mesh} /> : null;
}

/** Compiles the balloon and string shaders as soon as the environment map is
 *  ready (it's baked into them), so the first letter typed doesn't stall. */
function ShaderWarmup({ glyph, rope }: { glyph: Glyph; rope: RopeResources }) {
  const started = useRef(false);
  useFrame(({ gl, camera, scene }) => {
    if (started.current || !scene.environment) return;
    started.current = true;
    compileShaders(gl as unknown as WebGPURenderer, camera, scene, glyph, rope);
  });
  return null;
}

/** Where the camera looks: the textarea's visible padding box (scrolled,
 *  px, from the text's origin at the content box's top-left) and the world
 *  units per px, kept in a ref so scrolling needn't re-render. */
type View = { left: number; top: number; width: number; height: number; scale: number };

function BalloonScene({
  glyphs: { glyphs, glyphHeight },
  layout,
  view,
  field,
  text,
  items,
  ghosts,
  selection,
  focused,
  soundOn,
}: {
  glyphs: Glyphs;
  layout: Layout;
  view: React.RefObject<View>;
  field: TextField;
  text: string;
  items: Item[];
  ghosts: Ghost[];
  selection: [number, number];
  focused: boolean;
  soundOn: boolean;
}) {
  const ropes = useMemo<RopeRegistry>(() => new Map(), []);
  const poses = useMemo<LetterPoses>(() => new Map(), []);
  const rope = useMemo(buildRopeResources, []);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;

  // The camera frames exactly the textarea's visible padding box, so each
  // balloon sits over its (invisible) character. A change of scale (autoZoom
  // stepping the font size) is eased rather than jumped to: the text's world
  // positions don't change with it (px and units-per-px change inversely),
  // so easing only the camera zooms smoothly, about the text's top-left.
  // (The padding is fixed in px, so it's left out of world positions: it
  // would grow in world units as the font shrinks and drag every letter.)
  // A critically damped spring on the log of the scale, so each new step
  // carries on the zoom's current speed instead of kicking off a new ease.
  const zoom = useRef<{ log: number; speed: number } | null>(null);
  useFrame((_, delta) => {
    const v = view.current;
    const target = Math.log(v.scale);
    const z = (zoom.current ??= { log: target, speed: 0 });
    const dt = Math.min(delta, 0.1);
    z.speed += (ZOOM_STIFFNESS * (target - z.log) - 2 * Math.sqrt(ZOOM_STIFFNESS) * z.speed) * dt;
    z.log += z.speed * dt;
    const u = Math.exp(z.log);
    // A wide, short box would need a very wide-angle view from close up:
    // letters toward its ends turn to face the camera and pack together.
    // Narrowing the view keeps them within MAX_HALF_WIDTH of straight ahead.
    const fov = Math.min(FOV, 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(MAX_HALF_WIDTH) / (v.width / v.height))));
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    camera.position.set((v.left + v.width / 2) * u, -(v.top + v.height / 2) * u, ((v.height / 2) * u) / tan);
  });

  // Each letter's slot plus the centre of its word (a run of non-spaces on
  // one line), where the word's strings gather. Popped letters keep theirs.
  type Placement = { x: number; y: number; wordX: number };
  const lastPositions = useRef(new Map<number, Placement>());
  const positions = new Map<number, Placement>();
  for (let i = 0; i < items.length; ) {
    if (/\s/.test(text[i]!)) {
      positions.set(items[i]!.id, { ...layout.chars[i]!, wordX: layout.chars[i]!.x });
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < items.length && !/\s/.test(text[end + 1]!) && layout.caretLines[end + 1] === layout.caretLines[i]) end++;
    const wordX = (layout.chars[i]!.x + layout.chars[end]!.x) / 2;
    for (let j = i; j <= end; j++) positions.set(items[j]!.id, { ...layout.chars[j]!, wordX });
    i = end + 1;
  }
  ghosts.forEach((g) => positions.set(g.id, lastPositions.current.get(g.id) ?? { x: 0, y: 0, wordX: 0 }));
  lastPositions.current = positions;

  // Render letters in a stable order: new ones are appended and gone ones
  // dropped, but none is ever moved. Moving a keyed letter (e.g. to the end
  // when it pops) makes React re-insert its object, which put the rigid body
  // back at its spawn point.
  const indexById = new Map(items.map((item, i) => [item.id, i]));
  const byId = new Map([...items, ...ghosts].map((item) => [item.id, item] as const));
  const renderOrderRef = useRef<number[]>([]);
  const kept = renderOrderRef.current.filter((id) => byId.has(id));
  const keptSet = new Set(kept);
  const renderOrder = [...kept, ...[...byId.keys()].filter((id) => !keptSet.has(id))];
  renderOrderRef.current = renderOrder;

  const [selStart, selEnd] = selection;
  // Caret and selection colours: the input's CSS, else the system's.
  const system = useSystemColors(field);
  useEffect(() => setSelectionGlow(system.highlight.color), [system]);
  const caretIndex = Math.min(field.selectionDirection === "backward" ? selStart : selEnd, text.length);
  // The caret sits where the letters belong on the line, not where the
  // balloons have drifted to.
  const caretSlot = layout.carets[caretIndex] ?? { x: 0, y: 0 };

  return (
    <>
      {/* Softer contact correction (default 30): overlapping letters ease
          apart instead of being kicked out of each other, but still push
          each other firmly. */}
      <SoundContext.Provider value={soundOn}>
        <LetterPoseContext.Provider value={poses}>
          <RopeContext.Provider value={ropes}>
            <Physics gravity={[0, -9.81, 0]} contactNaturalFrequency={8}>
              {renderOrder.map((id) => {
                const item = byId.get(id)!;
                const glyph = glyphs.get(item.char.toUpperCase());
                const p = positions.get(item.id);
                if (!glyph || !p) return null;
                const i = indexById.get(id) ?? -1;
                const dying = i < 0;
                return (
                  <LetterBalloon
                    key={item.id}
                    id={item.id}
                    glyph={glyph}
                    x={p.x}
                    y={p.y}
                    wordX={p.wordX}
                    line={dying ? -1 : layout.caretLines[i]!}
                    selected={!dying && i >= selStart && i < selEnd}
                    dying={dying}
                  />
                );
              })}
              <Caret x={caretSlot.x} y={caretSlot.y} height={glyphHeight} visible={focused && selStart === selEnd} color={system.accent.color} />
            </Physics>
            <RopeBatch resources={rope} />
          </RopeContext.Provider>
        </LetterPoseContext.Provider>
      </SoundContext.Provider>
      <SelectionHighlight layout={layout} items={items} start={selStart} end={selEnd} height={glyphHeight} poses={poses} color={system.highlight} />
      <ShaderWarmup glyph={glyphs.get("A")!} rope={rope} />
    </>
  );
}

/** The scene's lighting: environment reflections on the foil, plus soft
 *  direct light. Its own memoized component, so re-rendering the text doesn't
 *  re-render the environment map. */
function Lighting() {
  return useMemo(
    () => (
      <>
        <ambientLight intensity={0.4} />
        <directionalLight position={[4, 6, 8]} intensity={1.4} />
        <Environment resolution={256}>
          <Lightformer intensity={2} position={[0, 5, 5]} scale={[10, 2, 1]} />
          <Lightformer intensity={1.5} position={[-6, 0, 3]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
          <Lightformer intensity={1.5} position={[6, 0, 3]} rotation-y={-Math.PI / 2} scale={[8, 4, 1]} />
          <Lightformer intensity={0.6} color="#ffd9a0" position={[0, -4, 4]} scale={[10, 2, 1]} />
        </Environment>
      </>
    ),
    [],
  );
}

/** Sound on. */
export type SingingEmoji = "🧑‍🎤" | "🎤" | "🎶" | "🎵";
/** Sound off: the only way to turn it off. */
export type SadEmoji = "😢" | "😭" | "😞" | "😔" | "🙁" | "☹️";

type BalloonOptions = {
  /** Shrink the text until it all fits, instead of scrolling. */
  autoZoom?: boolean;
  /** The balloons squeak as they inflate and bang as they pop, unless this
   *  is a sad emoji. Default 🧑‍🎤. */
  sound?: SingingEmoji | SadEmoji;
  /** For the wrapper around the field and its canvas (sizing it, e.g.
   *  width: 100%, when the field fills it). */
  containerClassName?: string;
  containerStyle?: CSSProperties;
};
export type BalloonAreaProps = ComponentProps<"textarea"> & BalloonOptions;
/** Text only: other input types have no text to draw. */
export type BalloonInputProps = Omit<ComponentProps<"input">, "type"> & BalloonOptions;

/** The native selection is hidden (the balloons draw their own); the
 *  placeholder is real text in a real font. Nothing else: the field keeps
 *  the browser's (and the page's) own styles. */
const BASE_CSS = `
.balloon-area::selection { background: transparent; color: transparent; }
.balloon-area::placeholder { color: #8e8e8e; font-family: system-ui, sans-serif; }
`;
let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  document.head.prepend(style);
}

const SAD = new Set<string>(["😢", "😭", "😞", "😔", "🙁", "☹️"] satisfies SadEmoji[]);

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

/** A drop-in <textarea> whose text floats as foil balloons. */
export function BalloonArea(props: BalloonAreaProps) {
  return <BalloonField {...(props as FieldProps)} multiline />;
}

/** A drop-in text <input> whose text floats as foil balloons. */
export function BalloonInput(props: BalloonInputProps) {
  return <BalloonField {...(props as FieldProps)} multiline={false} />;
}

type FieldProps = Omit<BalloonAreaProps, "ref"> & { ref?: Ref<TextField>; multiline: boolean };

function BalloonField({
  multiline,
  autoZoom = false,
  sound = "🧑‍🎤",
  containerClassName,
  containerStyle,
  className,
  style,
  ref,
  spellCheck = false,
  ...props
}: FieldProps) {
  const glyphs = use(loadGlyphs());
  use(registerMetricsFont(glyphs));
  injectCss();

  const [field, setField] = useState<TextField | null>(null);
  const forwarded = useRef(ref);
  forwarded.current = ref;
  const setRef = useMemo(
    () => (el: TextField | null) => {
      setField(el);
      const r = forwarded.current;
      if (typeof r === "function") r(el);
      else if (r) r.current = el;
    },
    [],
  );

  const soundOn = !SAD.has(sound);

  // Set up the sounds while the page is idle, so the first letter typed
  // doesn't stall on it (~0.1 s). Not at all while they're off.
  useEffect(() => {
    if (!soundOn) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => prepareAudio(), { timeout: 2000 });
    return () => cancel(id);
  }, [soundOn]);

  const textRef = useRef("");
  const itemsRef = useRef<Item[]>([]);
  const [text, setText] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const [layout, setLayout] = useState<TextLayout | null>(null);
  // autoZoom's font size (null: the textarea's own) and the textarea's own.
  const [zoomFont, setZoomFont] = useState<number | null>(null);
  const baseFont = useRef(48);
  // Box geometry for placing the canvas, and the scroll position.
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0, margin: 0 });
  // The canvas reaches this far (px) out past the padding box all round.
  const margin = useRef(0);
  const view = useRef<View>({ left: 0, top: 0, width: 1, height: 1, scale: 1 });
  const scale = useRef(1);
  // The text's origin (the content box's top-left) in the padding box, px.
  const origin = useRef({ x: 0, y: 0 });
  // With autoZoom, a letter typed at the edge overflows for a frame, and the
  // textarea scrolls to it until the font shrinks: the camera ignores that,
  // following the scroll only once the font can't shrink further.
  const followScroll = useRef(true);

  const updateView = (t: TextField) => {
    const { x, y } = origin.current;
    const [scrollLeft, scrollTop] = followScroll.current ? [t.scrollLeft, t.scrollTop] : [0, 0];
    const m = margin.current;
    view.current = { left: scrollLeft - x - m, top: scrollTop - y - m, width: t.clientWidth + 2 * m, height: t.clientHeight + 2 * m, scale: scale.current };
  };

  // Lay the text out where the textarea does; with autoZoom, shrink (or
  // regrow) the font until it all fits.
  const remeasure = () => {
    const t = field;
    if (!t) return;
    const measured = measureField(t);
    const css = getComputedStyle(t);
    const fontSize = parseFloat(css.fontSize);
    if (zoomFont === null) baseFont.current = fontSize;
    scale.current = glyphs.glyphHeight / fontSize; // world units per px
    origin.current = { x: parseFloat(css.paddingLeft), y: parseFloat(css.paddingTop) };
    const minFont = Math.min(MIN_FONT_SIZE, baseFont.current);
    followScroll.current = !autoZoom || fontSize <= minFont;
    // From the field's own font, so it stays put while autoZoom zooms.
    margin.current = Math.round(baseFont.current * OVERFLOW);
    setLayout(measured);
    setBox({ left: t.offsetLeft + t.clientLeft, top: t.offsetTop + t.clientTop, width: t.clientWidth, height: t.clientHeight, margin: margin.current });
    updateView(t);
    if (autoZoom) {
      const availW = t.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const availH = t.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
      // Room for the strings below the last line too. An input is one line
      // tall whatever its font size: only its width counts.
      const drop = (ANCHOR_DROP * 0.6) / scale.current;
      const fitH = multiline ? availH / Math.max(measured.height + drop, 1) : Infinity;
      const fit = Math.min(availW / Math.max(measured.width, 1), fitH);
      const next = Math.max(minFont, Math.min(baseFont.current, Math.floor(fontSize * fit * 2) / 2));
      if (Math.abs(next - fontSize) >= 0.5) setZoomFont(next === baseFont.current ? null : next);
    } else if (zoomFont !== null) setZoomFont(null);
  };
  const syncRef = useRef(() => {});
  const remeasureRef = useRef(remeasure);
  remeasureRef.current = remeasure;

  // The textarea is the source of truth for text and selection.
  useEffect(() => {
    if (!field) return;
    const sync = () => {
      const value = field.value;
      if (value !== textRef.current) {
        const { items, removed } = diffItems(itemsRef.current, textRef.current, value);
        textRef.current = value;
        itemsRef.current = items;
        setText(value);
        setItems(items);
        if (removed.length) {
          const diedAt = performance.now();
          setGhosts((g) => [...g, ...removed.map((r) => ({ ...r, diedAt }))]);
        }
        remeasureRef.current();
      }
      setSelection((prev) =>
      {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? start;
        return prev[0] === start && prev[1] === end ? prev : [start, end];
      },
      );
    };
    syncRef.current = sync;
    // After the event has run its course: updating state during it would
    // re-render a controlled textarea with its old value (the parent's
    // onChange hasn't run yet) and undo the keystroke. A task, not a
    // microtask: microtasks run between listeners, still mid-event.
    const syncLater = () => setTimeout(sync);
    const onScroll = () => updateView(field);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const relayout = () => remeasureRef.current();
    field.addEventListener("input", syncLater);
    field.addEventListener("select", syncLater);
    field.addEventListener("selectionchange", syncLater);
    document.addEventListener("selectionchange", syncLater);
    field.addEventListener("scroll", onScroll);
    field.addEventListener("focus", onFocus);
    field.addEventListener("blur", onBlur);
    // Size, font and style changes move the text.
    const resize = new ResizeObserver(relayout);
    resize.observe(field);
    const attributes = new MutationObserver(relayout);
    attributes.observe(field, { attributes: true, attributeFilter: ["style", "class", "wrap", "rows", "cols", "size"] });
    document.fonts.addEventListener("loadingdone", relayout);
    setFocused(document.activeElement === field);
    sync();
    relayout();
    return () => {
      field.removeEventListener("input", syncLater);
      field.removeEventListener("select", syncLater);
      field.removeEventListener("selectionchange", syncLater);
      document.removeEventListener("selectionchange", syncLater);
      field.removeEventListener("scroll", onScroll);
      field.removeEventListener("focus", onFocus);
      field.removeEventListener("blur", onBlur);
      resize.disconnect();
      attributes.disconnect();
      document.fonts.removeEventListener("loadingdone", relayout);
    };
  }, [field]);

  // A controlled value changes without an input event: pick it up.
  useLayoutEffect(() => syncRef.current(), [field, props.value]);
  // New styles or zoom settings: back to the textarea's own font, measured
  // afresh.
  useLayoutEffect(() => setZoomFont(null), [style, className, autoZoom]);
  useLayoutEffect(() => remeasureRef.current(), [zoomFont, field]);

  // Drop each popped balloon once its deflate animation is done. Timed from
  // the oldest pop, so popping more doesn't keep postponing earlier ones.
  useEffect(() => {
    if (!ghosts.length) return;
    const POP_MS = POP_LIFETIME * 1000;
    const oldest = Math.min(...ghosts.map((g) => g.diedAt));
    const timer = setTimeout(
      () => {
        const cutoff = performance.now() - POP_MS;
        setGhosts((g) => g.filter((ghost) => ghost.diedAt > cutoff));
      },
      Math.max(0, oldest + POP_MS - performance.now()) + 20,
    );
    return () => clearTimeout(timer);
  }, [ghosts]);

  // The measured layout in world units (y up).
  const world = useMemo<Layout | null>(() => {
    if (!layout) return null;
    const u = scale.current;
    const { x, y } = origin.current;
    const at = (p: { x: number; y: number }) => ({ x: (p.x - x) * u, y: -(p.y - y) * u });
    return { chars: layout.chars.map(at), carets: layout.carets.map(at), caretLines: layout.caretLines };
  }, [layout]);

  return (
    <div className={containerClassName} style={{ position: "relative", display: "inline-block", ...containerStyle }}>
      {createElement(multiline ? "textarea" : "input", {
        ref: setRef,
        className: className ? `balloon-area ${className}` : "balloon-area",
        spellCheck,
        ...props,
        ...(!multiline && { type: "text" }),
        style: {
          ...style,
          ...(zoomFont !== null && { fontSize: zoomFont }),
          // The text is laid out but not drawn: the balloons are.
          fontFamily: `${METRICS_FONT}, system-ui, sans-serif`,
          color: "transparent",
          caretColor: "transparent",
        },
      })}
      {field && world && box.width > 0 && (
        <div
          style={{
            position: "absolute",
            left: box.left - box.margin,
            top: box.top - box.margin,
            width: box.width + 2 * box.margin,
            height: box.height + 2 * box.margin,
            pointerEvents: "none",
            overflow: "hidden",
            // Solid over the field and the inner half of the margin, fading
            // out over the outer half.
            maskImage: [
              `linear-gradient(to right, transparent, #000 ${box.margin / 2}px, #000 calc(100% - ${box.margin / 2}px), transparent)`,
              `linear-gradient(to bottom, transparent, #000 ${box.margin / 2}px, #000 calc(100% - ${box.margin / 2}px), transparent)`,
            ].join(", "),
            maskComposite: "intersect",
          }}
        >
          <Canvas
            // Clicks, drags and taps go to the textarea underneath (R3F's
            // wrapper turns pointer events back on otherwise).
            style={{ pointerEvents: "none" }}
            camera={{ position: [0, 0, 6], fov: FOV, far: 1000 }}
            dpr={[1, 2]}
            flat
            // WebGPU, falling back to WebGL2 where it's unavailable.
            // Transparent, so the textarea's own background shows. `flat`:
            // the balloons tone map themselves (see LetterBalloon).
            gl={async (glProps) => {
              const renderer = new WebGPURenderer({ ...(glProps as object), antialias: true, alpha: true });
              await renderer.init();
              renderer.setClearColor(0x000000, 0);
              // Benchmark hook: open with ?bench to read renderer.info from outside.
              if (new URLSearchParams(location.search).has("bench")) Object.assign(window, { __renderer: renderer });
              return renderer;
            }}
          >
            <Lighting />
            <Suspense fallback={null}>
              <BalloonScene
                glyphs={glyphs}
                layout={world}
                view={view}
                field={field}
                text={text}
                items={items}
                ghosts={ghosts}
                selection={selection}
                focused={focused}
                soundOn={soundOn}
              />
            </Suspense>
          </Canvas>
        </div>
      )}
    </div>
  );
}
