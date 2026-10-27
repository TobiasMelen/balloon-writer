// A text-editor-style selection: a translucent overlay in the system's
// selection colour, in front of the selected characters (spaces too), from
// caret slot to caret slot. It's one ribbon per line: at each boundary
// between two characters the edge drifts and tilts part of the way with
// their balloons (the average of the two), so the highlight sways a little
// with the letters but neighbouring blocks share their edges and never split.
import * as THREE from "three/webgpu";
import type { Letter } from "./letters";
import type { SystemColor } from "./systemColors";

/** The text's layout in world units (y up): character centres, caret slots
 *  and their lines. */
export type Layout = { chars: { x: number; y: number }[]; carets: { x: number; y: number }[]; caretLines: number[] };

/** How far the highlight follows its letters away from their slots (0 =
 *  fixed to the line like real text, 1 = stuck to the balloons). */
const FOLLOW = 0.85;
/** Depth of the highlight: in front of the balloons. */
const Z = 0.6;
/** How far an edge may drift (fraction of the line height) and tilt
 *  (radians, ~20°) with its balloons. */
const MAX_DRIFT = 0.4;
const MAX_ROLL = 0.35;

type Drift = { x: number; y: number; roll: number };
/** A selection block edge: its bottom and top points (x, y). */
type Edge = [[number, number], [number, number]];
const average = (a: Drift | null, b: Drift | null): Drift =>
  a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, roll: (a.roll + b.roll) / 2 } : (a ?? b ?? { x: 0, y: 0, roll: 0 });
const clampTo = (v: number, max: number) => Math.max(-max, Math.min(max, v));

export function createSelection(scene: THREE.Scene) {
  // Neighbouring blocks only share edges, so the transparency has no darker
  // seams where they meet.
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  scene.add(mesh);
  // Two triangles per character, with room to spare: rebuilt bigger when a
  // selection outgrows it.
  let capacity = 0;
  const grow = (characters: number) => {
    capacity = Math.max(64, 2 ** Math.ceil(Math.log2(characters)));
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BufferGeometry();
    mesh.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 18), 3).setUsage(THREE.DynamicDrawUsage));
  };
  grow(0);

  return {
    setColor({ color, alpha }: SystemColor) {
      material.color.copy(color);
      material.opacity = alpha;
    },
    /** Redraws it for the selection [start, end) of the text laid out as
     *  `layout`, whose characters' letters (if any) are `letters`. */
    update(layout: Layout, letters: (Letter | null | undefined)[], start: number, end: number, height: number, camera: THREE.Camera) {
      if (end - start > capacity) grow(end - start);
      const sameLine = (i: number, j: number) => layout.caretLines[i] === layout.caretLines[j];
      // Offset (and roll) of character i from its slot, scaled by the follow
      // and limited, so neighbouring edges can't cross (a bow-tie) however
      // far unsettled balloons wander or tilt; null for characters without a
      // balloon (spaces) or outside the selection.
      const drift = (i: number): Drift | null => {
        const letter = i >= start && i < end ? letters[i] : null;
        if (!letter) return null;
        const limit = height * MAX_DRIFT;
        return {
          x: clampTo((letter.pose.x - letter.slot.x) * FOLLOW, limit),
          y: clampTo((letter.pose.y - letter.slot.y) * FOLLOW, limit),
          roll: clampTo(letter.pose.roll * FOLLOW, MAX_ROLL),
        };
      };
      // In front of the balloons, so scale positions in toward the camera to
      // line up with the letters on screen.
      const c = camera.position;
      const depth = (c.z - Z) / c.z;
      const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const out = position.array as Float32Array;
      let v = 0;
      // Character i's drift, a space taking its neighbours' (null if it has
      // no block: outside the selection, or a line break).
      const hasBlock = (i: number) => i >= start && i < end && sameLine(i, i + 1);
      const own = (i: number): Drift | null =>
        hasBlock(i) ? (drift(i) ?? average(sameLine(i - 1, i) ? drift(i - 1) : null, sameLine(i + 1, i + 2) ? drift(i + 1) : null)) : null;
      // The edge at caret slot k, between characters k - 1 and k: bottom and
      // top. Shared by the two blocks meeting there.
      const edge = (k: number): Edge => {
        const d = average(own(k - 1), own(k));
        const x = layout.carets[k]!.x + d.x;
        const y = layout.carets[k]!.y + d.y;
        const ux = -Math.sin(d.roll) * (height / 2);
        const uy = Math.cos(d.roll) * (height / 2);
        const project = (px: number, py: number): [number, number] => [c.x + (px - c.x) * depth, c.y + (py - c.y) * depth];
        return [project(x - ux, y - uy), project(x + ux, y + uy)];
      };
      const put = ([x, y]: [number, number]) => {
        out[v++] = x;
        out[v++] = y;
        out[v++] = Z;
      };
      // Per run of blocks on a line: every edge once, then kept in
      // left-to-right order (bottoms and tops separately), so however
      // unsettled the balloons a block can't turn inside out into a bow-tie.
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
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
