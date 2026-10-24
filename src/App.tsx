import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, useGLTF } from "@react-three/drei";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import alphabetUrl from "./assets/alphabet.glb";
import {
  layoutText,
  nearestCaret,
  paragraphRange,
  verticalCaret,
  wordRange,
  type Layout,
  type Metrics,
  type Point,
} from "./layout";
import {
  ANCHOR_DROP,
  BALLOON_HEIGHT,
  CARET_COLLISION,
  LetterBalloon,
  LetterPoseContext,
  compileShaders,
  setSelectionGlow,
  NO_COLLISION,
  POP_LIFETIME,
  RopeBatch,
  RopeContext,
  type Glyph,
  type LetterPoses,
  type RopeRegistry,
} from "./LetterBalloon";
import { useSystemColors, type SystemColor } from "./systemColors";
import { prepareAudio } from "./sound";
import "./index.css";

// Overlap between neighbours as a share of their average width: letters are
// packed tighter than their colliders, so they squeeze and jostle, but a
// narrow I isn't crowded more than a wide W.
const TRACKING = -0.09;

type Item = { id: number; char: string };

/** Semi-implicit damped spring step on a scalar. */
function spring(state: { x: number; v: number }, target: number, k: number, c: number, dt: number) {
  state.v += ((target - state.x) * k - state.v * c) * dt;
  state.x += state.v * dt;
}
type Ghost = Item & { diedAt: number };

let nextId = 0;

// The GLB uses quantized (int16) attributes; transforming those in place
// would clamp, so copy them to float before baking the node transforms.
function toFloatGeometry(source: THREE.BufferGeometry) {
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal"]) {
    const attr = source.getAttribute(name);
    if (!attr) continue;
    const array = new Float32Array(attr.count * attr.itemSize);
    for (let i = 0; i < attr.count; i++)
      for (let k = 0; k < attr.itemSize; k++) array[i * attr.itemSize + k] = attr.getComponent(i, k);
    geometry.setAttribute(name, new THREE.BufferAttribute(array, attr.itemSize));
  }
  if (source.index) geometry.setIndex(source.index.clone());
  return geometry;
}

/** Where a letter's string attaches: its horizontal centre, at the lowest
 *  part of the letter there (an A ties on under its crossbar, a U at its
 *  bottom). Widens the search band if nothing sits right at the centre. */
function lowestPoint(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  for (let band = 0.04; band < 1; band *= 2) {
    let minY = Infinity;
    for (let i = 0; i < position.count; i++)
      if (Math.abs(position.getX(i)) < band) minY = Math.min(minY, position.getY(i));
    if (minY < Infinity) return new THREE.Vector3(0, minY, 0);
  }
  return new THREE.Vector3(0, geometry.boundingBox?.min.y ?? 0, 0);
}

function useGlyphs() {
  const { scene } = useGLTF(alphabetUrl, false, true);
  return useMemo(() => {
    scene.updateMatrixWorld(true);
    const glyphs = new Map<string, Glyph>();
    // Size letters like the rope balloons so their physics tuning applies as is.
    const reference = scene.getObjectByName("H") as THREE.Mesh;
    reference.geometry.computeBoundingBox();
    const refHeight = reference.geometry.boundingBox!.getSize(new THREE.Vector3()).z * reference.matrixWorld.getMaxScaleOnAxis();
    const toBalloon = new THREE.Matrix4().makeScale(...(Array(3).fill(BALLOON_HEIGHT / refHeight) as [number, number, number]));
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !/^[A-Z]$/.test(mesh.name)) return;
      const geometry = toFloatGeometry(mesh.geometry);
      geometry.applyMatrix4(mesh.matrixWorld).applyMatrix4(toBalloon);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const size = box.getSize(new THREE.Vector3());
      geometry.translate(...box.getCenter(new THREE.Vector3()).negate().toArray());
      geometry.computeBoundingSphere();
      glyphs.set(mesh.name, { geometry, width: size.x, height: size.y, depth: size.z, knot: lowestPoint(geometry) });
    });
    const glyphHeight = glyphs.get("H")?.height ?? 3;
    const metrics: Metrics = {
      width: (c) => glyphs.get(c.toUpperCase())?.width ?? 0,
      glyphHeight,
      space: glyphHeight * 0.8,
      tracking: TRACKING,
      lineHeight: glyphHeight * 1.08,
    };
    return { glyphs, metrics };
  }, [scene]);
}

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
      {/* Drawn a little in front so it isn't buried in the balloons it nudges. */}
      <group ref={visual} position-z={0.15}>
        <mesh raycast={() => null}>
          <capsuleGeometry args={[CARET_RADIUS, height * 0.85, 8, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} toneMapped={false} />
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
function ShaderWarmup({ glyph }: { glyph: Glyph }) {
  const started = useRef(false);
  useFrame(({ gl, camera, scene }) => {
    if (started.current || !scene.environment) return;
    started.current = true;
    compileShaders(gl as unknown as WebGPURenderer, camera, scene, glyph);
  });
  return null;
}

function BalloonText({
  textarea,
  text,
  items,
  ghosts,
  selection,
  focused,
  layoutRef,
  pickRef,
}: {
  textarea: HTMLTextAreaElement | null;
  text: string;
  items: Item[];
  ghosts: Ghost[];
  selection: [number, number];
  focused: boolean;
  layoutRef: React.RefObject<Layout | null>;
  pickRef: React.RefObject<((clientX: number, clientY: number) => number) | null>;
}) {
  const { glyphs, metrics } = useGlyphs();
  const ropes = useMemo<RopeRegistry>(() => new Map(), []);
  const poses = useMemo<LetterPoses>(() => new Map(), []);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;

  // No automatic wrapping: lines only break where you press Enter. The text
  // sits still in the world (see layoutText); the camera pulls back until the
  // widest line and all the lines (strings included) fit, and pans to keep a
  // left margin and the block vertically centred. Physics needs fixed units,
  // so the text itself is never scaled or moved to fit.
  const { layout, cameraTarget } = useMemo(() => {
    const aspect = size.width / size.height;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const H = metrics.glyphHeight;
    const layout = layoutText(text, metrics, Infinity);
    const distance = Math.max(
      Math.max(H / 0.22, (3 * H) / (0.88 * aspect)) / (2 * tan), // resting size
      layout.width / (2 * tan * aspect * 0.88), // widest line fits
      (layout.height + ANCHOR_DROP * 0.6) / (2 * tan * 0.85), // all lines fit
    );
    const visibleWidth = 2 * distance * tan * aspect;
    const cameraTarget = new THREE.Vector3(
      visibleWidth * 0.44, // text's x = 0 sits 6% in from the left edge
      -(layout.height - H) / 2 - ANCHOR_DROP * 0.3,
      distance,
    );
    return { layout, cameraTarget };
  }, [text, metrics, size.width, size.height, camera.fov]);
  layoutRef.current = layout;

  useFrame((_, delta) => {
    camera.position.x = THREE.MathUtils.damp(camera.position.x, cameraTarget.x, 4, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, cameraTarget.y, 4, delta);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, cameraTarget.z, 4, delta);
  });

  // Each letter's slot plus the centre of its word (a run of non-spaces on
  // one line), where the word's strings gather. Popped letters keep theirs.
  type Placement = Point & { wordX: number };
  const lastPositions = useRef(new Map<number, Placement>());
  const positions = new Map<number, Placement>();
  for (let i = 0; i < items.length; ) {
    if (/\s/.test(text[i]!)) {
      positions.set(items[i]!.id, { ...layout.chars[i]!, wordX: layout.chars[i]!.x });
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < items.length && !/\s/.test(text[end + 1]!) && layout.caretLines[end + 1] === layout.caretLines[i])
      end++;
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

  // Screen point -> caret index in the balloon layout, for the textarea's
  // own pointer handling (see App). Uses the camera as currently drawn.
  const gl = useThree((s) => s.gl);
  pickRef.current = (clientX, clientY) => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit)) return text.length;
    return nearestCaret(layout, hit);
  };

  const [selStart, selEnd] = selection;
  // Caret and selection colours: the input's CSS, else the system's.
  const system = useSystemColors(textarea);
  useEffect(() => setSelectionGlow(system.highlight.color), [system]);
  const caretIndex = Math.min(textarea?.selectionDirection === "backward" ? selStart : selEnd, text.length);

  // The caret sits where the letters belong on the line, not where the
  // balloons have drifted to.
  const caretSlot = layout.carets[caretIndex]!;

  return (
    <>
      {/* Softer contact correction (default 30): overlapping letters ease
          apart instead of being kicked out of each other, but still push
          each other firmly. */}
      <LetterPoseContext.Provider value={poses}>
        <RopeContext.Provider value={ropes}>
          <Physics gravity={[0, -9.81, 0]} contactNaturalFrequency={12}>
            {renderOrder.map((id) => {
              const item = byId.get(id)!;
              const glyph = glyphs.get(item.char.toUpperCase());
              if (!glyph) return null;
              const p = positions.get(item.id)!;
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
            <Caret x={caretSlot.x} y={caretSlot.y} height={metrics.glyphHeight} visible={focused && selStart === selEnd} color={system.accent.color} />
          </Physics>
          <RopeBatch />
        </RopeContext.Provider>
      </LetterPoseContext.Provider>
      <SelectionHighlight layout={layout} items={items} start={selStart} end={selEnd} height={metrics.glyphHeight} poses={poses} color={system.highlight} />
      <ShaderWarmup glyph={glyphs.get("A")!} />
    </>
  );
}

export function App() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const pickRef = useRef<((clientX: number, clientY: number) => number) | null>(null);
  const textRef = useRef("");
  const itemsRef = useRef<Item[]>([]);
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);

  // Set up the sounds while the page is idle after loading, so the first
  // letter typed doesn't stall on it (~0.1 s).
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => prepareAudio(), { timeout: 2000 });
    return () => cancel(id);
  }, []);
  const [text, setText] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setTextarea(textareaRef.current);
    textareaRef.current?.focus();
  }, []);

  // The hidden textarea is the source of truth for text and selection.
  useEffect(() => {
    if (!textarea) return;
    const sync = () => {
      const value = textarea.value;
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
      }
      setSelection((prev) =>
        prev[0] === textarea.selectionStart && prev[1] === textarea.selectionEnd
          ? prev
          : [textarea.selectionStart, textarea.selectionEnd],
      );
    };
    const head = () => (textarea.selectionDirection === "backward" ? textarea.selectionStart : textarea.selectionEnd);
    const tail = () => (textarea.selectionDirection === "backward" ? textarea.selectionEnd : textarea.selectionStart);
    /** Select from `anchor` to `focus`, keeping the direction native-like. */
    const selectTo = (anchor: number, focus: number) => {
      textarea.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? "backward" : "forward");
      sync();
    };

    // Everything else is the real textarea's native behaviour (it doesn't
    // wrap either, so its lines are the balloon lines and Home/End just
    // work). Only Up/Down is mapped: the same column on the next line lands
    // differently with balloons than with the hidden 16px text.
    const onKeyDown = (e: KeyboardEvent) => {
      const layout = layoutRef.current;
      if (!layout || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const next = verticalCaret(layout, head(), e.key === "ArrowUp" ? -1 : 1);
      if (e.shiftKey) selectTo(tail(), next);
      else selectTo(next, next);
    };

    // Clicks and drags: the textarea covers the scene, so it gets focus,
    // the context menu (paste) and touch natively. Only where a mouse click
    // lands is mapped, from the balloon layout instead of the hidden text.
    let dragAnchor: number | null = null;
    const pick = (e: MouseEvent) => pickRef.current?.(e.clientX, e.clientY) ?? textarea.value.length;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !pickRef.current) return; // right-click keeps the native menu
      e.preventDefault();
      textarea.focus({ preventScroll: true });
      const index = pick(e);
      dragAnchor = null;
      if (e.detail === 2) {
        const [start, end] = wordRange(textarea.value, index);
        selectTo(start, end);
      } else if (e.detail >= 3) {
        const [start, end] = paragraphRange(textarea.value, index);
        selectTo(start, end);
      } else if (e.shiftKey) {
        dragAnchor = tail();
        selectTo(dragAnchor, index);
      } else {
        dragAnchor = index;
        selectTo(index, index);
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (dragAnchor === null) return;
      if (!(e.buttons & 1)) {
        dragAnchor = null;
        return;
      }
      selectTo(dragAnchor, pick(e));
    };
    const onMouseUp = () => {
      dragAnchor = null;
    };
    // Touch: let the native tap focus the field (and open the keyboard),
    // then move the caret to where the tap landed on the balloons.
    let touchStart: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      touchStart = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!touchStart || Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 10) return;
      const index = pickRef.current?.(e.clientX, e.clientY);
      touchStart = null;
      if (index !== undefined) setTimeout(() => selectTo(index, index));
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    textarea.addEventListener("input", sync);
    textarea.addEventListener("select", sync);
    textarea.addEventListener("selectionchange", sync);
    textarea.addEventListener("keydown", onKeyDown);
    textarea.addEventListener("mousedown", onMouseDown);
    textarea.addEventListener("pointerdown", onPointerDown);
    textarea.addEventListener("pointerup", onPointerUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    textarea.addEventListener("focus", onFocus);
    textarea.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", sync);
    setFocused(document.activeElement === textarea);
    sync();
    return () => {
      textarea.removeEventListener("input", sync);
      textarea.removeEventListener("select", sync);
      textarea.removeEventListener("selectionchange", sync);
      textarea.removeEventListener("keydown", onKeyDown);
      textarea.removeEventListener("mousedown", onMouseDown);
      textarea.removeEventListener("pointerdown", onPointerDown);
      textarea.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", sync);
    };
  }, [textarea]);

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

  return (
    <div className="balloon-field">
      {SHOW_SOUND_PANEL && (
        <Suspense fallback={null}>
          <SoundPanel />
        </Suspense>
      )}
      <textarea
        ref={textareaRef}
        className="balloon-input"
        wrap="off"
        aria-label="Balloon text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {!text && !focused && <div className="balloon-hint">Click and type</div>}
      <Canvas
        camera={{ position: [0, 0, 6], fov: 40, far: 1000 }}
        dpr={[1, 2]}
        flat
        // WebGPU, falling back to WebGL2 where it's unavailable. The balloons'
        // deflate is a TSL node (see LetterBalloon); plain three materials are
        // converted to node materials by the renderer. `flat`: WebGPU tone
        // maps the whole frame, background included (white came out grey),
        // so the balloons apply ACES in their own material instead.
        gl={async (props) => {
          const renderer = new WebGPURenderer({ ...(props as object), antialias: true });
          await renderer.init();
          // Benchmark hook: open with ?bench to read renderer.info from outside.
          if (new URLSearchParams(location.search).has("bench")) Object.assign(window, { __renderer: renderer });
          return renderer;
        }}
      >
        <color attach="background" args={["#ffffff"]} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[4, 6, 8]} intensity={1.4} />
        <Environment resolution={256}>
          <Lightformer intensity={2} position={[0, 5, 5]} scale={[10, 2, 1]} />
          <Lightformer intensity={1.5} position={[-6, 0, 3]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
          <Lightformer intensity={1.5} position={[6, 0, 3]} rotation-y={-Math.PI / 2} scale={[8, 4, 1]} />
          <Lightformer intensity={0.6} color="#ffd9a0" position={[0, -4, 4]} scale={[10, 2, 1]} />
        </Environment>
        <Suspense fallback={null}>
          <BalloonText
            textarea={textarea}
            text={text}
            items={items}
            ghosts={ghosts}
            selection={selection}
            focused={focused}
            layoutRef={layoutRef}
            pickRef={pickRef}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

useGLTF.preload(alphabetUrl, false, true);

/** ?sound shows the sound tuning panel, loaded only then (it brings leva). */
const SHOW_SOUND_PANEL = new URLSearchParams(location.search).has("sound");
const SoundPanel = lazy(() => import("./SoundPanel").then((m) => ({ default: m.SoundPanel })));

export default App;
