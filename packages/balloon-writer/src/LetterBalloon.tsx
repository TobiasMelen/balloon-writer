// A balloon letter tied to an anchor below its slot, grown out of an earlier
// rope-balloon demo (a box balloon on a chain of rope segments): same
// buoyancy, damping, torque and drag, with letters scaled to BALLOON_HEIGHT.
// Differences, all needed for text:
// - the rope is a single rope joint (no weightless-but-massive segments to
//   stretch); the string you see is a massless visual rope that sags and trails
// - the anchor is kinematic and eases to the letter's slot when text reflows
// - the letter spawns with a random tilt on every axis, but less than a
//   quarter turn of yaw: past that the face-camera torque can leave it mirrored
// - the collider is the letter's bounding box at full size from the start,
//   with a contact skin so overlapping letters ease apart instead of kicking
// - letters only collide within their own line, and only once they've
//   reached their slot: a letter inserted mid-word rises into a gap that is
//   slightly too tight, and would otherwise wedge under its neighbours
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CuboidCollider, RigidBody, interactionGroups, useRapier, useRopeJoint, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, type Node, type NodeFrame } from "three/webgpu";
import {
  Fn,
  acesFilmicToneMapping,
  attribute,
  clamp,
  cos,
  cross,
  distance,
  dot,
  float,
  floor,
  instanceIndex,
  int,
  ivec2,
  max,
  min,
  mix,
  normalize,
  normalLocal,
  output,
  positionLocal,
  pow,
  sin,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

/** The rope-balloon demo's sizes, which its physics tuning was made for: the
 *  balloon's height (letters are scaled to it) and its rope's segments. */
export const BALLOON_HEIGHT = 1.2;
const SEGMENT_COUNT = 4;
const SEGMENT_LENGTH = 0.2;
import { panFor, playInflate, playPop } from "./sound";

/** How far each drawn string's bottom slides toward its word's centre
 *  (0 = straight down, 1 = all strings meet at one point). */
const GATHER_STRINGS = 0.8;
/** Inward pull on a letter's knot per unit distance from its word's centre
 *  (1/s²), so the letters lean the way their strings run. */
const GATHER_PULL = 0.8;

/** Draw the strings (the rope joint works either way). */
const SHOW_ROPES = true;


/** Same total length as the rope balloons' chain, slack included. */
const ROPE_LENGTH = SEGMENT_COUNT * SEGMENT_LENGTH * 1.5;
const KNOT: [number, number, number] = [0, -BALLOON_HEIGHT / 3, 0];
/** How far below its layout slot a letter's anchor sits (taut rope + knot). */
export const ANCHOR_DROP = ROPE_LENGTH - KNOT[1];

/** Soft margin around letter colliders, so near-touching letters cushion. */
const CONTACT_SKIN = 0.025;

/** Max random spawn rotation per axis, in radians. */
const SPAWN_TILT = { x: 0.7, y: 1.2, z: 0.6 };
const randomTilt = (): [number, number, number] => [
  (Math.random() * 2 - 1) * SPAWN_TILT.x,
  (Math.random() * 2 - 1) * SPAWN_TILT.y,
  (Math.random() * 2 - 1) * SPAWN_TILT.z,
];

/** Foil balloon colours; each letter picks one at random when it's created. */
const FOIL_COLORS = ["#c9a24a", "#c8ccd2", "#d99a86", "#e86fa8", "#d6333f", "#3a6fe0", "#21a6a0", "#3fae5a", "#8a4fd6"];
const randomFoil = () => new THREE.Color(FOIL_COLORS[Math.floor(Math.random() * FOIL_COLORS.length)]);

/** Per-letter physical personality, so no two balloons move alike. */
const randomTraits = () => {
  const between = (min: number, max: number) => min + Math.random() * (max - min);
  return {
    // Heavier letters shove lighter ones and are harder to knock about.
    density: between(0.6, 1.6),
    // Buoyancy scales with mass, so lift is what changes how eagerly it rises.
    buoyancy: -0.5 * between(0.75, 1.3),
    linearDamping: 5 * between(0.65, 1.2),
    angularDamping: 5 * between(0.5, 1.1),
    // Own gust rhythm on top of the shared breeze.
    phase: Math.random() * Math.PI * 2,
    rate: between(0.6, 1.4),
    // A second, faster flutter and its own sway strength, so letters don't
    // move in step.
    phase2: Math.random() * Math.PI * 2,
    rate2: between(1.6, 2.8),
    sway: between(0.7, 1.4),
  };
};

/** Gentle breeze acceleration: a slow wave rolling across the text plus each
 *  letter's own flutter, so letters keep drifting after they settle. */
const BREEZE = { x: 0.45, z: 0.25, roll: 0.0002 };
function breeze(t: number, x: number, traits: ReturnType<typeof randomTraits>) {
  const wave = Math.sin(t * 0.35 - x * 0.45) * 0.6 + Math.sin(t * 0.13 + 1.7) * 0.4;
  const flutter =
    (Math.sin(t * 1.1 * traits.rate + traits.phase) * 0.65 + Math.sin(t * traits.rate2 + traits.phase2) * 0.35) *
    traits.sway;
  return {
    x: BREEZE.x * (wave * 0.5 + flutter * 0.5),
    z: BREEZE.z * Math.sin(t * 0.8 * traits.rate + traits.phase * 2) * traits.sway,
    roll: BREEZE.roll * flutter,
  };
}

/** Face-camera torque relative to the rope balloons' tuning: stronger, so
 *  letters squeezed by tight neighbours turn back instead of staying edge-on. */
const TURN_BACK = 2.5;

/** Yaw inertia of a letter's box relative to the rope balloons' box. */
const yawInertia = (w: number, h: number, d: number) => w * h * d * (w * w + d * d);
const yawInertiaRatio = (g: Glyph) => yawInertia(g.width, g.height, g.depth) / yawInertia(0.8, BALLOON_HEIGHT, 0.4);

// Group 0 is the caret: every seated letter can be nudged by it.
export const CARET_COLLISION = interactionGroups([0], Array.from({ length: 16 }, (_, i) => i));
export const NO_COLLISION = interactionGroups([], []);
const lineCollision = (line: number) => interactionGroups([1 + (line % 15)], [0, 1 + (line % 15)]);
const PASS_THROUGH = interactionGroups([1], []);
// Hysteresis for becoming solid / passing through, as distance from the slot.
const SOLID_WITHIN = 0.25;
const GHOST_BEYOND = 0.8;

export type Glyph = {
  geometry: THREE.BufferGeometry;
  width: number;
  height: number;
  depth: number;
  /** Where the drawn string attaches: the letter's lowest point. Visual
   *  only; the rope joint stays at KNOT so every letter floats at the same height. */
  knot: THREE.Vector3;
};

type LetterProps = {
  /** Stable id: the key the letter's live pose is published under. */
  id: number;
  glyph: Glyph;
  /** Layout slot of the letter; the anchor follows it from below. */
  x: number;
  y: number;
  /** Centre of the letter's word; its string gathers toward a point below it. */
  wordX: number;
  line: number;
  /** Selected: a faint glow in the selection colour (the highlight itself is
   *  drawn over the text, see SelectionHighlight in App). */
  selected: boolean;
  dying: boolean;
};

// memo: a letter only re-renders when its own props change (they're all
// primitives or stable), not on every keystroke or caret move.
export const LetterBalloon = memo(function LetterBalloon(props: LetterProps) {
  const anchorRef = useRef<RapierRigidBody>(null);
  const bodyRef = useRef<RapierRigidBody>(null);
  const camera = useThree((s) => s.camera);
  const poses = useContext(LetterPoseContext);
  // Read when a sound would play, so toggling doesn't re-run the effects.
  const soundOn = useRef(true);
  soundOn.current = useContext(SoundContext);
  // A popped (or removed) letter no longer has a pose to follow.
  useEffect(() => {
    if (props.dying) poses?.delete(props.id);
    return () => void poses?.delete(props.id);
  }, [poses, props.id, props.dying]);
  const [spawn] = useState(() => new THREE.Vector3(props.x, props.y - ANCHOR_DROP, 0));
  const [rotation] = useState(randomTilt);
  const [traits] = useState(randomTraits);
  const [color] = useState(randomFoil);
  const [pop] = useState(() => randomPop(props.glyph.geometry));
  const [inflated, setInflated] = useState(false);
  const [solid, setSolid] = useState(false);
  const anchor = useRef({ pos: spawn.clone(), vel: new THREE.Vector3() });
  /** Seconds since popping, and whether the scrap has been shot off yet. */
  const popped = useRef({ for: 0, launched: false });

  // Auto-inflate on mount
  useEffect(() => {
    setInflated(true);
    if (soundOn.current) playInflate(panFor(props.x));
  }, []);

  const { world } = useRapier();
  const ropeJoint = useRopeJoint(anchorRef as React.RefObject<RapierRigidBody>, bodyRef as React.RefObject<RapierRigidBody>, [
    [0, 0, 0],
    KNOT,
    ROPE_LENGTH,
  ]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 1 / 30);

    // Ease the anchor to the slot with a critically damped spring, so a
    // reflow tows the letter along instead of yanking it.
    const a = anchor.current;
    const goal = _v.set(props.x, props.y - ANCHOR_DROP, 0);
    const omega = 9;
    a.vel.addScaledVector(goal.sub(a.pos), omega * omega * dt).multiplyScalar(Math.max(0, 1 - 2 * omega * dt));
    a.pos.addScaledVector(a.vel, dt);
    anchorRef.current?.setNextKinematicTranslation(a.pos);

    const body = bodyRef.current;
    if (!body) return;

    const here = body.translation();
    const away = Math.hypot(here.x - props.x, here.y - props.y);
    if (!solid && away < SOLID_WITHIN) setSolid(true);
    else if (solid && away > GHOST_BEYOND) setSolid(false);

    // Popping: air keeps jetting out of the puncture while it collapses,
    // pushing the balloon away from it, so it zips off a little. Once it has
    // collapsed, the leftover scrap drops.
    const r = body.rotation();
    const rotation = _q.set(r.x, r.y, r.z, r.w);
    // Publish where the letter is now, for the selection highlight.
    if (poses && !props.dying) {
      const pose = poses.get(props.id) ?? { x: 0, y: 0, slotX: 0, slotY: 0, roll: 0 };
      pose.x = here.x;
      pose.y = here.y;
      pose.slotX = props.x;
      pose.slotY = props.y;
      // Roll in the text plane, from where the letter's up points. (Not
      // 2·atan2(q.z, q.w): q and -q are the same rotation, and a balloon
      // that had tumbled could sit upright reading as nearly a full turn.)
      const up = _v2.set(0, 1, 0).applyQuaternion(rotation);
      pose.roll = Math.atan2(-up.x, up.y);
      poses.set(props.id, pose);
    }
    if (props.dying) {
      const p = popped.current;
      p.for += dt;
      if (p.for < pop.delay + pop.duration) {
        const away = _v.copy(pop.puncture).negate().normalize().applyQuaternion(rotation);
        body.applyImpulse(away.multiplyScalar(pop.thrust * body.mass() * dt), true);
      } else if (!p.launched) {
        p.launched = true;
        // It falls like the released string: from rest vertically (it kept
        // the pop's motion, which threw scraps whose puncture was low
        // upwards), drifting on a little sideways, under plain gravity with
        // the string's air drag (4% of its speed a frame). No spin: the scrap
        // sits off the body's centre, where it collapsed to, so spinning
        // would swing it around in circles.
        const v = body.linvel();
        body.setLinvel({ x: v.x * 0.3, y: 0, z: v.z * 0.3 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        body.setGravityScale(1, true);
        body.setLinearDamping(-Math.log(0.96) * 60);
      }
    }

    // Gathered strings: pull each letter's knot toward its word's centre,
    // more the further out it sits. Pulling at the knot (below the centre of
    // mass) gathers the bottoms and fans the tops out, like a bouquet.
    if (!props.dying) {
      const knot = _v.set(...KNOT).applyQuaternion(rotation).add(here);
      // Push in the letter's own depth: a knot tilted in front of or behind
      // the centre would turn a sideways push into a twist, spinning the
      // outermost letters of each word edge-on.
      knot.z = here.z;
      body.applyImpulseAtPoint({ x: (props.wordX - props.x) * GATHER_PULL * body.mass() * dt, y: 0, z: 0 }, knot, true);
    }

    // Breeze: impulses scaled by mass, so every letter feels the same air
    // and its traits decide how it responds.
    if (!props.dying) {
      const gust = breeze(clock.elapsedTime, here.x, traits);
      const m = body.mass();
      body.applyImpulse({ x: gust.x * m * dt, y: 0, z: gust.z * m * dt }, true);
      body.applyTorqueImpulse({ x: 0, y: 0, z: gust.roll * traits.density * yawInertiaRatio(props.glyph) }, true);
    }

    // Apply gentle torque to make balloon face camera
    const targetYRot = Math.atan2(camera.position.x - here.x, camera.position.z - here.z);
    // Yaw from the direction the letter faces, not from Euler angles: XYZ
    // Euler yaw locks up at ±90°, so an edge-on letter got no (or the wrong)
    // turn-back and could stay edge-on.
    const facing = _v2.set(0, 0, 1).applyQuaternion(rotation);
    let diff = targetYRot - Math.atan2(facing.x, facing.z);
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // The rope balloons' 0.001 (times TURN_BACK), scaled by how much harder
    // this letter is to spin than their 0.8 × 1.2 × 0.4 box.
    const torqueStrength = 0.001 * TURN_BACK * yawInertiaRatio(props.glyph) * traits.density;
    // Per second, not per frame (the rope balloons' value is per 60fps frame),
    // so it turns back just as firmly at any frame rate.
    body.applyTorqueImpulse({ x: 0, y: diff * torqueStrength * dt * 60, z: 0 }, true);
  });

  // Hover while popping (falling made the letter jump away as it shrank).
  // Set on the body, not as a prop.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.setGravityScale(props.dying ? 0 : traits.buoyancy, true);
    if (!props.dying) return;
    // The pop sounds as the collapse starts.
    if (soundOn.current) playPop(panFor(body.translation().x), pop.delay);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    // The rope lets go (like the drawn string), so nothing holds it back.
    const joint = ropeJoint.current;
    if (joint && world.getImpulseJoint(joint.handle)) world.removeImpulseJoint(joint, true);
    // Air rushing out of the puncture: a kick away from it and a spin.
    const r = body.rotation();
    const away = pop.puncture.clone().negate().normalize().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const m = body.mass();
    body.applyImpulse(away.multiplyScalar(pop.kick * m), true);
    body.applyTorqueImpulse(pop.spin.clone().multiplyScalar(m * 0.05), true);
    body.setLinearDamping(1); // so the escaping air actually carries it off
  }, [props.dying, traits.buoyancy, pop, ropeJoint, world]);

  // Start just above the anchor with the rope slack, then float up.
  const startHeightMultiplier = 0.6;
  const start: [number, number, number] = [
    spawn.x,
    spawn.y + ((SEGMENT_COUNT - 1) * SEGMENT_LENGTH + BALLOON_HEIGHT) * startHeightMultiplier,
    0,
  ];

  return (
    <>
      <RigidBody ref={anchorRef} type="kinematicPosition" colliders={false} position={spawn.toArray()} />
      <RigidBody
        // An object ref, not a callback: @react-three/rapier only calls a
        // callback ref when the body is first created, so after a re-create
        // (StrictMode mounts twice) it kept pointing at a removed body stuck at
        // the spawn point, and popping snapped the letter to it.
        ref={bodyRef}
        position={start}
        rotation={rotation}
        colliders={false}
        // These props must stay constant: when a RigidBody prop changes,
        // @react-three/rapier re-syncs the body from its object, which put
        // popping letters back at their spawn point. Gravity is switched on
        // the body directly instead (see the effect above).
        gravityScale={traits.buoyancy}
        linearDamping={traits.linearDamping}
        angularDamping={traits.angularDamping}
        type="dynamic"
      >
        <LetterWithCollider
          letter={props}
          color={color}
          inflated={inflated && !props.dying}
          pop={pop}
          deflating={props.dying}
          solid={solid}
          density={traits.density}
        />
      </RigidBody>
      {SHOW_ROPES && (
        <VisualRope
          anchorRef={anchorRef}
          bodyRef={bodyRef}
          dying={props.dying}
          gatherX={(props.wordX - props.x) * GATHER_STRINGS}
          knot={props.glyph.knot}
        />
      )}
    </>
  );
});

/** How a letter will pop, rolled when it's created so every pop differs. */
type Pop = {
  /** Point on the surface (local space) where it bursts: the collapse
   *  starts there. */
  puncture: THREE.Vector3;
  /** Point (local space) the balloon collapses to, where the fray ends up. */
  collapseTo: THREE.Vector3;
  /** Length of the fray of skin left after the collapse, as a fraction of
   *  the letter's size. */
  scrap: number;
  seed: number;
  /** Seconds before the collapse starts (the pop sound is timed to it). It
   *  used to swell up first, but that read as growing at the moment of
   *  bursting. */
  delay: number;
  /** Seconds the collapse takes. */
  duration: number;
  /** Kick away from the puncture (velocity change) and a random spin axis. */
  kick: number;
  /** Push from the escaping air while it collapses (acceleration). */
  thrust: number;
  spin: THREE.Vector3;
};

function randomPop(geometry: THREE.BufferGeometry): Pop {
  const position = geometry.getAttribute("position");
  const between = (min: number, max: number) => min + Math.random() * (max - min);
  // A random vertex, favouring the edges: the furthest out of four (most
  // of a letter's vertices sit fairly central, so pops looked centred).
  const vertex = () => new THREE.Vector3().fromBufferAttribute(position, Math.floor(Math.random() * position.count));
  const puncture = Array.from({ length: 4 }, vertex).reduce((a, b) => (b.lengthSq() > a.lengthSq() ? b : a));
  // Where it collapses to: toward the puncture, sometimes past it, and off
  // to one side a little.
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const reach = Math.max(size.x, size.y);
  const collapseTo = puncture
    .clone()
    .multiplyScalar(between(0.85, 1.3))
    .add(new THREE.Vector3(between(-1, 1), between(-1, 1), 0).multiplyScalar(reach * 0.23));
  return {
    puncture,
    collapseTo,
    seed: Math.random() * 100,
    delay: between(0.01, 0.03),
    duration: between(0.055, 0.1),
    kick: between(1.2, 2.5),
    thrust: between(8, 20),
    spin: new THREE.Vector3(between(-1, 1), between(-1, 1), between(-1, 1)),
    scrap: between(0.17, 0.28),
  };
}


/** A selected letter's faint glow: the selection colour, dimmed. */
const SELECTED_GLOW = new THREE.Color("#1f6bff").multiplyScalar(0.35);
const NO_GLOW = new THREE.Color(0, 0, 0);
/** Sets the glow from the selection colour (the system's, see App). */
export function setSelectionGlow(color: THREE.Color) {
  SELECTED_GLOW.copy(color).multiplyScalar(0.35);
}
/** The fray of skin left after a pop: its width as a fraction of its
 *  length, how much it curls, and how many crinkles run along it (radians
 *  across its length). */
const FRAY_WIDTH = 0.25;
const FRAY_CURL = 0.6;
const FRAY_CRINKLES = 14;
/** How far it scrunches in as it falls (fraction of its length lost at
 *  uScrunch = 1), and the spring that drives it: stiff and well damped, so
 *  it scrunches in steadily (95% by ~0.2 s). (Lightly damped, it overshot
 *  and sprang back out, and the fray pulsed.) */
const FRAY_SCRUNCH = 0.65;
const SCRUNCH_TENSION = 500;
const SCRUNCH_FRICTION = 40;
/** How unevenly a letter blows up: midway through inflating, parts of it are
 *  up to this fraction bigger or smaller than the rest, evening out by the
 *  time it's full. */
const UNEVEN_INFLATE = 0.5;
/** The inflate spring: a little softer than the rope balloons' 200/12 (95%
 *  size at ~0.2 s instead of ~0.15 s), with a bouncy overshoot (22%), settled
 *  by ~0.7 s. */
const INFLATE_TENSION = 105;
const INFLATE_FRICTION = 8.5;
/** How lopsided inflating is: how far behind the far side starts puffing up
 *  (as a share of the inflate). */
const INFLATE_SWEEP = 1.3;
/** The fold a letter unfolds from: where the crease is (from the centre, as
 *  a fraction of the letter's size) and how far it starts folded (radians;
 *  about 165°, nearly flat back over itself). */
const FOLD_AT = 0.12;
const FOLD_ANGLE = 2.9;
/** Extra puff mid-inflate: the letter swells up to this much thicker than
 *  when full, then settles. */
const INFLATE_PUFF = 0.5;
/** Wobble while moving about: how far the foil flexes along its two creases
 *  at full wobble (radians, ~26°), the wobble's spring (~5 Hz, firmly
 *  damped: it flexes and comes back with barely a bounce), how much acceleration drives it, and the
 *  acceleration below which it's left alone (so the breeze doesn't set it
 *  off). */
const MOVE_CREASE = 0.45;
const WOBBLE_TENSION = 800;
const WOBBLE_FRICTION = 22;
const WOBBLE_DRIVE = 8;
const WOBBLE_DEAD_ZONE = 4;
/** Faster than this (units/s) between frames is a jump, not motion. */
const WOBBLE_TELEPORT = 30;
/** Deflating: how far behind the far side starts collapsing (as a share of
 *  the collapse), how deep the smooth dents go (fraction), and how much it
 *  wrinkles along the surface (letter units). */
const DEFLATE_SPREAD = 0.3;
const DEFLATE_DENTS = 0.25;
const DEFLATE_WRINKLE = 0.06;
/** How far it folds over as it collapses (radians, ~90°). */
const DEFLATE_FOLD = 1.6;

/** Per-balloon values for the shared material, kept on mesh.userData. The
 *  shape's are packed into vec4s: each uniform is a callback per balloon
 *  per frame, and eleven of them were ~7 ms a second. */
type BalloonLook = {
  color: THREE.Color;
  emissive: THREE.Color;
  /** x: how far inflated (0 flat, 1 full; the inflate spring, which
   *  overshoots); y: how far collapsed when popped (0 → 1); z: how far the
   *  fallen scrap has scrunched in; w: the scrap crumpling away (0 → 1). */
  state: THREE.Vector4;
  /** Where it bursts (xyz, local space), and its random seed (w). */
  puncture: THREE.Vector4;
  /** Where it collapses to (xyz), and the fray's length (w, a fraction of
   *  the letter's size). */
  collapse: THREE.Vector4;
  /** x: the letter's size (its larger dimension); y: its wobble while it
   *  moves about (springy, about -1..1, see WOBBLE_*). */
  size: THREE.Vector2;
};
const lookOf = (frame: NodeFrame) => (frame.object as THREE.Object3D).userData.balloon as BalloonLook;

type ShapeUniforms = {
  uInflate: Node<"float">;
  uScrap: Node<"float">;
  uScrunch: Node<"float">;
  uVanish: Node<"float">;
  uDeflate: Node<"float">;
  uPuncture: Node<"vec3">;
  uCollapseTo: Node<"vec3">;
  uSeed: Node<"float">;
  uReach: Node<"float">;
  uWobble: Node<"float">;
};

// The balloon's shape (TSL). Inflating, it unfolds and puffs up unevenly;
// deflating, it does much the same backwards and fast, ending as a fray of
// skin (see below). Full and not popping, it leaves the balloon untouched.
const balloonPosition = ({ uInflate, uScrap, uScrunch, uVanish, uDeflate, uPuncture, uCollapseTo, uSeed, uReach, uWobble }: ShapeUniforms) =>
  Fn(() => {
    // Wonky inflate, only while inflating (all of it settles by full size).
    // Lumps: smooth parts of the letter (a pattern of its own, from its seed)
    // puff up ahead of or behind the rest. The bump is 0 when flat and full.
    const u = clamp(uInflate, 0, 1);
    const bump = u.mul(float(1).sub(u)).mul(4);
    const lumps = sin(positionLocal.x.mul(3.1).add(uSeed))
      .mul(sin(positionLocal.y.mul(2.3).add(uSeed.mul(1.7))))
      .mul(0.6)
      .add(sin(positionLocal.x.add(positionLocal.y).mul(4.7).add(uSeed.mul(2.3))).mul(0.4));
    const lumpy = positionLocal.mul(lumps.mul(bump).mul(UNEVEN_INFLATE).add(1));

    // Asymmetric: the puff sweeps across the letter from one side (a
    // direction of its own). Where it hasn't arrived the foil is still flat
    // (thin) and a little smaller.
    const sweepDir = vec3(cos(uSeed.mul(2.1)), sin(uSeed.mul(2.1)), 0);
    const reached = dot(positionLocal, sweepDir).div(uReach).add(0.5); // 0..1 across
    const puff = smoothstep(0, 1, clamp(u.mul(1 + INFLATE_SWEEP).sub(reached.mul(INFLATE_SWEEP)), 0, 1));
    // Thickness also swells past full mid-inflate, then settles.
    const swell = bump.mul(INFLATE_PUFF).add(1);
    const swept = vec3(lumpy.xy.mul(mix(float(0.65), float(1), puff)), lumpy.z.mul(mix(float(0.08), float(1), puff)).mul(swell));

    // Folding out: the part of the letter past a crease (a line of its own)
    // starts folded back over it and swings out flat as it inflates.
    const unfolded = foldOver(swept, uReach, uSeed.mul(3.7), FOLD_AT, float(1).sub(smoothstep(0, 0.75, u)).mul(FOLD_ANGLE));

    // Moving about, the foil flexes back and forth along two creases of its
    // own, crossing at an angle, with the wobble (a springy -1..1): sharper
    // creases than the fold, flexing the same way (opposite ways made an
    // S-shaped squiggle).
    const flex = uWobble.mul(MOVE_CREASE);
    const creased = foldOver(unfolded, uReach, uSeed.mul(7.1), 0.1, flex, 0.025);
    const base = foldOver(creased, uReach, uSeed.mul(9.7).add(1.2), -0.15, flex.mul(0.6), 0.025);

    // Deflating, the inflate run backwards and fast: a smooth wave from the
    // puncture outwards (in by uDeflate = 1 even at the far end, ~1.3 away)
    // in which the foil goes flat, dents in smooth lumps and wrinkles, and
    // folds over a crease of its own, while turning into the fray.
    const reach = distance(base, uPuncture).div(uReach);
    const local = clamp(uDeflate.mul(1 + DEFLATE_SPREAD * 1.3).sub(reach.mul(DEFLATE_SPREAD)), 0, 1);
    const k = smoothstep(0, 1, local);
    const midway = k.mul(float(1).sub(k)).mul(4); // 0 → 1 → 0 as each part goes
    const dents = sin(base.x.mul(4.3).add(uSeed.mul(1.9))).mul(sin(base.y.mul(3.1).add(uSeed.mul(0.7))));
    // Dents only push in (dents is -1..1), so nothing grows as it bursts.
    const inward = dents.sub(1).mul(0.5);
    const flattened = vec3(base.xy.mul(inward.mul(midway).mul(DEFLATE_DENTS).add(1)), base.z.mul(mix(float(1), float(0.08), k)));
    const crumpled = foldOver(flattened, uReach, uSeed.mul(5.3), -0.05, k.mul(DEFLATE_FOLD));
    const wrinkle = sin(dot(base, vec3(7.3, 5.1, 0)).add(uSeed.mul(4.1))).mul(DEFLATE_WRINKLE).mul(midway);
    // It ends as a single fray of balloon skin at the collapse point: the
    // whole surface folded onto a short, narrow strip (along a direction of
    // its own), crinkled along its length and curled a little. Where a vertex
    // sits across the letter decides where it lands along and across the strip.
    // As it falls it scrunches in on itself (uScrunch, a springy 0 → 1):
    // shorter, narrower, more curled and more deeply crinkled; at the end it
    // crumples away to nothing (uVanish).
    const centre = uCollapseTo;
    const along = vec3(sin(uSeed), cos(uSeed.mul(1.3)), 0).normalize();
    const across = vec3(along.y.negate(), along.x, 0);
    const t = dot(base, along).div(uReach); // about -0.5..0.5
    const w = dot(base, across).div(uReach);
    const squeeze = float(1).sub(uScrunch.mul(FRAY_SCRUNCH)).mul(float(1).sub(uVanish));
    const length = uScrap.mul(uReach).mul(squeeze);
    const curl = uScrunch.mul(FRAY_CURL).add(FRAY_CURL);
    const crinkle = length.mul(uScrunch.mul(0.25).add(0.12));
    const scrap = centre
      .add(along.mul(t.mul(length)))
      .add(across.mul(w.mul(length).mul(FRAY_WIDTH).mul(squeeze).add(t.mul(t).mul(length).mul(curl))))
      .add(vec3(0, 0, sin(t.mul(uScrunch.mul(FRAY_CRINKLES).add(FRAY_CRINKLES)).add(uSeed)).mul(crinkle)))
      // Front and back would land on the same sheet: keep them apart.
      .add(normalLocal.mul(0.004));
    // Heading for the fray from the first frame: quickly at first (from the
    // linear progress; smoothstep's k starts flat), so it shrinks the moment
    // it bursts.
    const toward = float(1).sub(float(1).sub(local).mul(float(1).sub(local)));
    const collapsed = mix(crumpled, scrap, toward);
    return collapsed.add(normalLocal.mul(wrinkle));
  })();

/** `p` folded over a crease (a line through a point `at` of the letter's size
 *  from its centre, its direction from `turn`) by `angle`: the part past the
 *  crease turns about it. The crease is soft over `soft` of the letter's
 *  size, so the foil bends. */
function foldOver(p: Node<"vec3">, reach: Node<"float">, turn: Node<"float">, at: number, angle: Node<"float">, soft = 0.06) {
  const dir = vec3(cos(turn), sin(turn), 0);
  const hinge = vec3(dir.y.negate(), dir.x, 0);
  const pivot = dir.mul(reach.mul(at));
  const q = p.sub(pivot);
  const a = smoothstep(0, reach.mul(soft), dot(q, dir)).mul(angle);
  // Rodrigues' rotation of q about the hinge line.
  return q
    .mul(cos(a))
    .add(cross(hinge, q).mul(sin(a)))
    .add(hinge.mul(dot(hinge, q)).mul(float(1).sub(cos(a))))
    .add(pivot);
}

/** One material for every balloon, built once. Colour, selection glow and
 *  shape (inflate and pop state) are per-object uniforms read from
 *  mesh.userData.balloon as each balloon is drawn, so a new letter doesn't
 *  build a new shader. */
let sharedBalloonMaterial: MeshPhysicalNodeMaterial | null = null;
function balloonMaterial() {
  if (sharedBalloonMaterial) return sharedBalloonMaterial;
  const material = new MeshPhysicalNodeMaterial({ metalness: 0.85, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 });
  material.colorNode = uniform(new THREE.Color()).onObjectUpdate((f) => lookOf(f).color);
  material.emissiveNode = uniform(new THREE.Color()).onObjectUpdate((f) => lookOf(f).emissive);
  const state = uniform(new THREE.Vector4(1, 0, 0, 0)).onObjectUpdate((f) => lookOf(f).state);
  const size = uniform(new THREE.Vector2(1, 0)).onObjectUpdate((f) => lookOf(f).size);
  const puncture = uniform(new THREE.Vector4()).onObjectUpdate((f) => lookOf(f).puncture);
  const collapse = uniform(new THREE.Vector4()).onObjectUpdate((f) => lookOf(f).collapse);
  material.positionNode = balloonPosition({
    uInflate: state.x,
    uDeflate: state.y,
    uScrunch: state.z,
    uVanish: state.w,
    uPuncture: puncture.xyz,
    uSeed: puncture.w,
    uCollapseTo: collapse.xyz,
    uScrap: collapse.w,
    uReach: size.x,
    uWobble: size.y,
  });
  // The renderer runs without tone mapping (so the background stays
  // white); the balloons tone map themselves, like WebGL's default ACES.
  // (acesFilmicToneMapping is typed as returning a plain Node.)
  const toneMapped = acesFilmicToneMapping(output.rgb, float(1)) as Node<"vec3">;
  material.outputNode = vec4(toneMapped, output.a);
  return (sharedBalloonMaterial = material);
}

/** Compiles the balloon and string shaders in the background, so the first
 *  letter typed doesn't stall on building them. Call once the scene's environment map is set: it's part of
 *  the compiled shader. */
export function compileShaders(renderer: { compileAsync: (o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene) => Promise<void> }, camera: THREE.Camera, scene: THREE.Scene, glyph: Glyph, rope: RopeResources) {
  const balloon = new THREE.Mesh(glyph.geometry, balloonMaterial());
  balloon.userData = { balloon: { color: new THREE.Color(), emissive: new THREE.Color(), state: new THREE.Vector4(1, 0, 0, 0), puncture: new THREE.Vector4(), collapse: new THREE.Vector4(0, 0, 0, 0.1), size: new THREE.Vector2(1, 0) } satisfies BalloonLook };
  const { geometry, material } = rope;
  const group = new THREE.Group().add(balloon, new THREE.Mesh(geometry, material));
  return renderer.compileAsync(group, camera, scene);
}

function LetterWithCollider({
  letter,
  color,
  inflated,
  deflating,
  solid,
  density,
  pop,
}: {
  letter: LetterProps;
  color: THREE.Color;
  inflated: boolean;
  deflating: boolean;
  solid: boolean;
  density: number;
  pop: Pop;
}) {
  const { glyph } = letter;
  const selected = useRef(letter.selected);
  selected.current = letter.selected;
  const look = useMemo<BalloonLook>(
    () => ({
      color,
      emissive: new THREE.Color(0, 0, 0),
      state: new THREE.Vector4(0, 0, 0, 0),
      puncture: new THREE.Vector4(pop.puncture.x, pop.puncture.y, pop.puncture.z, pop.seed),
      collapse: new THREE.Vector4(pop.collapseTo.x, pop.collapseTo.y, pop.collapseTo.z, pop.scrap),
      size: new THREE.Vector2(Math.max(glyph.width, glyph.height), 0),
    }),
    [color, pop, glyph],
  );
  const userData = useMemo(() => ({ balloon: look }), [look]);

  // Inflate and pop are stepped here rather than with react-spring: a
  // declarative `to` sequence is rebuilt every render, so popping another
  // letter replayed this one's deflate from the start. Inflate is a spring
  // (INFLATE_TENSION/FRICTION) the vertex shader makes wonky; the pop is a
  // short delay, then the vertex shader collapses the balloon from its
  // puncture to a point near it (pop.collapseTo).
  const meshRef = useRef<THREE.Mesh>(null);
  const anim = useRef({ scale: 0, velocity: 0, deflateTime: -1, scrunchVelocity: 0 });
  /** For the wobble: where the balloon was last frame, its velocity then,
   *  and the wobble spring's own velocity. */
  const motion = useRef({ at: null as THREE.Vector3 | null, velocity: new THREE.Vector3(), wobbleVelocity: 0 });
  const state = useRef({ inflated, deflating });
  state.current = { inflated, deflating };

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    const a = anim.current;
    const { inflated, deflating } = state.current;
    if (deflating) {
      if (a.deflateTime < 0) a.deflateTime = 0;
      a.deflateTime += delta;
      if (a.deflateTime >= pop.delay) {
        look.state.y = Math.min((a.deflateTime - pop.delay) / pop.duration, 1); // deflate
        // Once collapsed, the scrap falls, scrunching in, then at
        // the end crumples away to nothing (in the shader; shrinking the
        // whole mesh instead looked like it was going off into the distance).
        const falling = (a.deflateTime - pop.delay - pop.duration) / SCRAP_LIFE;
        if (falling > 0) {
          // Scrunching in (see SCRUNCH_TENSION).
          const dt = Math.min(delta, 1 / 30);
          const scrunch = look.state.z;
          a.scrunchVelocity += ((1 - scrunch) * SCRUNCH_TENSION - a.scrunchVelocity * SCRUNCH_FRICTION) * dt;
          look.state.z = Math.min(Math.max(scrunch + a.scrunchVelocity * dt, 0), 1.4);
        }
        if (falling > SCRAP_SOLID) {
          // Slow at first, then quickly gone.
          const out = Math.min((falling - SCRAP_SOLID) / (1 - SCRAP_SOLID), 1);
          look.state.w = out * out; // vanish
        }
      }
    } else {
      const [target, tension, friction] = inflated ? [1, INFLATE_TENSION, INFLATE_FRICTION] : [0, 300, 10];
      const dt = Math.min(delta, 1 / 30);
      a.velocity += ((target - a.scale) * tension - a.velocity * friction) * dt;
      a.scale += a.velocity * dt;
      look.state.x = a.scale; // inflate
      if (mesh) wobble(mesh, Math.min(delta, 1 / 30));
    }
    if (mesh) {
      mesh.scale.setScalar(Math.max(a.scale, 0.0001));
    }
    look.emissive.lerp(selected.current ? SELECTED_GLOW : NO_GLOW, 1 - Math.exp(-delta * 12));
  });

  /** Jiggles the wobble from how sharply the balloon accelerates. */
  function wobble(mesh: THREE.Mesh, dt: number) {
    const m = motion.current;
    const here = _wobbleAt.setFromMatrixPosition(mesh.matrixWorld);
    if (!m.at || dt <= 0) {
      m.at = here.clone();
      return;
    }
    const velocity = _wobbleVelocity.subVectors(here, m.at).divideScalar(dt);
    // A jump (a new balloon placed at its spawn point) isn't motion.
    if (velocity.lengthSq() > WOBBLE_TELEPORT ** 2) {
      m.at.copy(here);
      m.velocity.set(0, 0, 0);
      return;
    }
    const acceleration = Math.max(0, velocity.distanceTo(m.velocity) / dt - WOBBLE_DEAD_ZONE);
    m.at.copy(here);
    m.velocity.copy(velocity);
    const w = look.size.y;
    m.wobbleVelocity += (-w * WOBBLE_TENSION - m.wobbleVelocity * WOBBLE_FRICTION + Math.min(acceleration, 60) * WOBBLE_DRIVE) * dt;
    look.size.y = Math.max(-1, Math.min(1, w + m.wobbleVelocity * dt));
  }

  // The collider stays full size while the mesh inflates: resizing it every
  // frame keeps creating fresh overlaps for the solver to shove apart.
  return (
    <>
      <CuboidCollider
        args={[glyph.width / 2, glyph.height / 2, glyph.depth / 2]}
        collisionGroups={solid && !deflating ? lineCollision(letter.line) : PASS_THROUGH}
        contactSkin={CONTACT_SKIN}
        density={density}
        restitution={0.01}
      />
      <mesh
        ref={meshRef}
        scale={0.0001}
        geometry={glyph.geometry}
        material={balloonMaterial()}
        userData={userData}
        raycast={() => null}
      />
    </>
  );
}

// Scratch objects reused every frame instead of allocating new ones.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ropeStart = new THREE.Vector3();
const _wobbleAt = new THREE.Vector3();
const _wobbleVelocity = new THREE.Vector3();
const _ropeEnd = new THREE.Vector3();

/** Simulated points and constraint passes per string; the vertex shader
 *  draws a smooth curve through the points. 13 points and 6 passes stay
 *  within ~2px of 17 and 12 (straight pieces), even while a reflow tows the
 *  letters; 9 points visibly lose the arc. */
const ROPE_POINTS = 13;
const ROPE_PASSES = 6;
/** Only the top part of the string is drawn (from the knot down), fading
 *  out toward the bottom; the full length is still simulated for its shape.
 *  The drawn part is this fraction of a string hanging straight down, and the
 *  same length on every string: gathered strings (at the ends of words) are
 *  longer, and a fraction of them looked like longer tethers. */
const ROPE_VISIBLE_FRACTION = 0.375;

/** After a pop: when the string lets go of the letter (right away), and how
 *  long it takes to fall and fade out. */
const ROPE_RELEASE_AFTER = 0;
const ROPE_FALL_FADE = 0.4;
/** Seconds the leftover scrap falls before it's gone: as long as the
 *  string takes to fall and fade. */
const SCRAP_LIFE = ROPE_FALL_FADE;
/** Fraction of SCRAP_LIFE before the scrap starts crumpling away. */
const SCRAP_SOLID = 0.75;
/** Seconds a popped letter stays mounted: long enough for the slowest pop
 *  (0.03s delay + 0.1s collapse) and its scrap, and for the string to fall
 *  and fade. */
export const POP_LIFETIME = Math.max(0.03 + 0.1 + SCRAP_LIFE, ROPE_RELEASE_AFTER + ROPE_FALL_FADE) + 0.05;

/** Every string's simulated points, by rope id, drawn together by RopeBatch. */
export type RopeRegistry = Map<number, { pos: Float32Array; fade: number; visibleLinks: number }>;
export const RopeContext = createContext<RopeRegistry | null>(null);

/** Every live letter's position and roll (and its slot), by item id, for the
 *  selection highlight to follow. */
export type LetterPoses = Map<number, { x: number; y: number; slotX: number; slotY: number; roll: number }>;
export const LetterPoseContext = createContext<LetterPoses | null>(null);

/** Whether the letters make their inflate and pop sounds. */
export const SoundContext = createContext(true);
let nextRopeId = 0;

/** Massless verlet string between anchor and knot. It never pulls on the
 *  letter; the rope joint does that. It just sags when slack and trails, and
 *  once the letter has popped it lets go and falls. Draws nothing itself:
 *  its points go into the RopeRegistry for RopeBatch. */
function VisualRope({
  anchorRef,
  bodyRef,
  dying,
  gatherX,
  knot,
}: {
  anchorRef: React.RefObject<RapierRigidBody | null>;
  bodyRef: React.RefObject<RapierRigidBody | null>;
  dying: boolean;
  /** Sideways offset of the string's bottom, toward the word's centre. */
  gatherX: number;
  knot: THREE.Vector3;
}) {
  const ropes = useContext(RopeContext);
  const [id] = useState(() => nextRopeId++);
  /** Points as flat x, y, z triples, from the anchor (0) to the knot (last). */
  const sim = useRef<{ pos: Float32Array; prev: Float32Array } | null>(null);
  const deadFor = useRef(0);
  useEffect(() => () => void ropes?.delete(id), [ropes, id]);

  useFrame((_, delta) => {
    const anchor = anchorRef.current;
    const body = bodyRef.current;
    if (!anchor || !body || !ropes) return;
    const a = anchor.translation();
    const t = body.translation();
    const r = body.rotation();
    const start = _ropeStart.set(a.x + gatherX, a.y, a.z);
    // Rest length from where the anchor and this letter's knot sit at rest,
    // so the string reaches without stretching.
    const length = Math.hypot(gatherX - knot.x, ANCHOR_DROP + knot.y);
    const rest = length / (ROPE_POINTS - 1);
    // Links to draw: a straight-down string's visible length, in this one's links.
    const visibleLinks = (ROPE_VISIBLE_FRACTION * Math.hypot(knot.x, ANCHOR_DROP + knot.y)) / rest;
    const end = _ropeEnd.copy(knot).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(t);
    const lastPoint = (ROPE_POINTS - 1) * 3;

    if (!sim.current) {
      const pos = new Float32Array(ROPE_POINTS * 3);
      for (let i = 0; i < ROPE_POINTS; i++) _v.lerpVectors(start, end, i / (ROPE_POINTS - 1)).toArray(pos, i * 3);
      sim.current = { pos, prev: pos.slice() };
    }
    const { pos, prev } = sim.current;
    const dt = Math.min(delta, 1 / 30);
    if (dying) deadFor.current += dt;
    const released = deadFor.current > ROPE_RELEASE_AFTER;
    const fade = released ? Math.max(0, 1 - (deadFor.current - ROPE_RELEASE_AFTER) / ROPE_FALL_FADE) : 1;

    // Integrate with a little gravity and air drag; a released string falls
    // properly and its loose top end comes down with it.
    const fall = (released ? -9.81 : -3) * dt * dt;
    const last = released ? ROPE_POINTS : ROPE_POINTS - 1;
    for (let k = 3; k < last * 3; k++) {
      const velocity = (pos[k]! - prev[k]!) * 0.96;
      prev[k] = pos[k]!;
      pos[k] = pos[k]! + velocity + (k % 3 === 1 ? fall : 0);
    }
    start.toArray(pos, 0);
    if (!released) end.toArray(pos, lastPoint);

    // Rope constraint: links may go slack but never stretch
    for (let pass = 0; pass < ROPE_PASSES; pass++) {
      for (let p = 0; p < lastPoint; p += 3) {
        const q = p + 3;
        const dx = pos[q]! - pos[p]!;
        const dy = pos[q + 1]! - pos[p + 1]!;
        const dz = pos[q + 2]! - pos[p + 2]!;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len <= rest) continue;
        const pinnedP = p === 0;
        const pinnedQ = q === lastPoint && !released;
        if (pinnedP && pinnedQ) continue;
        // Share of the overshoot each end takes back.
        const k = (len - rest) / len;
        const kp = pinnedP ? 0 : pinnedQ ? k : k / 2;
        const kq = pinnedQ ? 0 : k - kp;
        pos[p] = pos[p]! + dx * kp;
        pos[p + 1] = pos[p + 1]! + dy * kp;
        pos[p + 2] = pos[p + 2]! + dz * kp;
        pos[q] = pos[q]! - dx * kq;
        pos[q + 1] = pos[q + 1]! - dy * kq;
        pos[q + 2] = pos[q + 2]! - dz * kq;
      }
    }

    const entry = ropes.get(id);
    if (entry) {
      entry.fade = fade;
      entry.visibleLinks = visibleLinks;
    } else ropes.set(id, { pos, fade, visibleLinks });
  });

  return null;
}

const ROPE_HALF_WIDTH = 0.006;
const ROPE_COLOR = "#8a8a8a";
/** Pieces each drawn string is made of, however few points are simulated. */
const ROPE_DRAWN_SEGMENTS = 12;

/** The ribbon strip, its material and its points texture: one set per
 *  scene (a shared set would mix the strings of two BalloonAreas). */
export type RopeResources = ReturnType<typeof buildRopeResources>;
export function buildRopeResources() {
  // The strip: along = 0 at the knot to 1 at the bottom of the visible
  // part, side = which edge of the ribbon.
  const vertices = (ROPE_DRAWN_SEGMENTS + 1) * 2;
  const along = new Float32Array(vertices);
  const side = new Float32Array(vertices);
  for (let j = 0; j < vertices; j++) {
    along[j] = Math.floor(j / 2) / ROPE_DRAWN_SEGMENTS;
    side[j] = j % 2 ? 1 : -1;
  }
  const index: number[] = [];
  for (let s = 0; s < ROPE_DRAWN_SEGMENTS; s++) index.push(s * 2, s * 2 + 1, s * 2 + 2, s * 2 + 1, s * 2 + 3, s * 2 + 2);
  const geometry = new THREE.InstancedBufferGeometry();
  // Unused (the shader places every vertex), but the renderer expects it.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute("ropeAlong", new THREE.BufferAttribute(along, 1));
  geometry.setAttribute("ropeSide", new THREE.BufferAttribute(side, 1));
  geometry.setIndex(index);
  geometry.instanceCount = 0;

  const points = texture(ropeTexture(1));
  const row = int(instanceIndex);
  const point = (i: Node<"int">) => textureLoad(points, ivec2(i, row)).xyz;
  const along_ = attribute<"float">("ropeAlong", "float");
  // Position in points, counting down from the knot over this string's
  // visible links (in the second texel's w).
  const visibleLinks = textureLoad(points, ivec2(1, row)).w;
  const s = float(ROPE_POINTS - 1).sub(along_.mul(visibleLinks));
  const k = clamp(floor(s), 0, ROPE_POINTS - 2);
  const f = s.sub(k);
  const p1 = point(int(k));
  const p2 = point(int(k.add(1)));
  // Catmull-Rom through the neighbouring points.
  const p0 = point(int(max(k.sub(1), 0)));
  const p3 = point(int(min(k.add(2), ROPE_POINTS - 1)));
  const a = p2.sub(p0);
  const b = p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3);
  const c = p1.sub(p2).mul(3).add(p3).sub(p0);
  const position = p1.mul(2).add(a.mul(f)).add(b.mul(f.mul(f))).add(c.mul(f.mul(f).mul(f))).mul(0.5);
  const tangent = a.add(b.mul(f.mul(2))).add(c.mul(f.mul(f).mul(3))).mul(0.5);
  // Ribbon width across the local direction, in the text plane.
  const across = normalize(vec2(tangent.y.negate(), tangent.x).add(vec2(0, 1e-6)));
  const material = new MeshBasicNodeMaterial({ color: ROPE_COLOR, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // A flat ribbon: one pass for both sides. (Transparent double-sided
  // materials otherwise draw back then front, two pipelines the warm-up
  // in compileShaders doesn't compile.)
  material.forceSinglePass = true;
  material.positionNode = position.add(vec3(across.mul(attribute<"float">("ropeSide", "float").mul(ROPE_HALF_WIDTH)), 0));
  // Opaque at the knot, fading out toward the bottom, times the string's fade.
  const fade = textureLoad(points, ivec2(0, row)).w;
  material.opacityNode = varying(pow(float(1).sub(along_), 1.5).mul(fade));
  return { geometry, material, points };
}

/** Draws every string as one instanced ribbon: one draw call however many
 *  letters. The ribbon is a fixed strip; each string's simulated points go
 *  into a float texture (one row per string; its fade in the first texel's
 *  w, how many links to draw in the second's), and the vertex shader bends
 *  the strip along a curve through them. */
export function RopeBatch({ resources }: { resources: RopeResources }) {
  const ropes = useContext(RopeContext);
  const meshRef = useRef<THREE.Mesh>(null);
  const capacity = useRef(0);
  const { geometry, material, points } = resources;
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      points.value.dispose();
    },
    [geometry, material, points],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || !ropes) return;
    // Grow the texture (doubling) when there are more strings than rows.
    if (ropes.size > capacity.current) {
      const n = Math.max(32, capacity.current * 2, ropes.size);
      points.value.dispose();
      points.value = ropeTexture(n);
      capacity.current = n;
    }
    const data = (points.value as THREE.DataTexture).image.data as Float32Array;
    let r = 0;
    for (const { pos, fade, visibleLinks } of ropes.values()) {
      const row = r * ROPE_POINTS * 4;
      for (let i = 0; i < ROPE_POINTS; i++) {
        data[row + i * 4] = pos[i * 3]!;
        data[row + i * 4 + 1] = pos[i * 3 + 1]!;
        data[row + i * 4 + 2] = pos[i * 3 + 2]!;
      }
      data[row + 3] = fade;
      data[row + 7] = visibleLinks;
      r++;
    }
    points.value.needsUpdate = true;
    geometry.instanceCount = r;
    mesh.visible = r > 0;
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} visible={false} frustumCulled={false} raycast={() => null} />;
}

/** Float texture holding `rows` strings' points (x, y, z, and fade in w). */
function ropeTexture(rows: number) {
  const tex = new THREE.DataTexture(new Float32Array(ROPE_POINTS * rows * 4), ROPE_POINTS, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  return tex;
}
