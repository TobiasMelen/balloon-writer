// The caret: a glowing capsule at the caret slot that blinks like a real
// caret, and a slab in the physics that nudges balloons out of its way.
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three/webgpu";
import { CARET_COLLISION, NO_COLLISION } from "./letters";

// Real carets blink about every 530ms and stay solid for a moment after
// each keystroke or move. This one blinks by quickly scaling to nothing.
const BLINK_HALF = 0.53;
const BLINK_HOLD = 0.5;
/** Seconds a blink takes to scale out (and back in). */
const BLINK_EDGE = 0.06;
const RADIUS = 0.035;
/** Half-depth of the caret's collider: a deep slab, so letters can't slide
 *  in front of or behind it. */
const DEPTH = 0.6;

export function createCaret(world: RAPIER.World, scene: THREE.Scene, height: number) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(RADIUS * 1.5, (height * 0.85) / 2 + RADIUS, DEPTH).setContactSkin(0.04).setCollisionGroups(NO_COLLISION),
    body,
  );
  // Drawn over everything, like a real caret, so it isn't buried in the
  // balloons it nudges. At the slot's own depth: drawn nearer the camera,
  // perspective would push it off its slot.
  const material = new THREE.MeshStandardMaterial({ emissiveIntensity: 2, toneMapped: false, depthTest: false, transparent: true });
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(RADIUS, height * 0.85, 8, 16), material);
  mesh.renderOrder = 10;
  const light = new THREE.PointLight(0xffffff, 0, 1.6, 1.5);
  const visual = new THREE.Group().add(mesh, light);
  scene.add(visual);
  const show = { x: 0, v: 0 };
  let at = { x: NaN, y: NaN };
  let lastMove = 0;

  return {
    setColor(color: THREE.Color) {
      material.color.copy(color);
      material.emissive.copy(color);
      light.color.copy(color);
    },
    update(x: number, y: number, visible: boolean, time: number, dt: number) {
      // Jump straight to the new slot like a real caret. setTranslation
      // teleports without giving the body velocity, so it doesn't swat
      // balloons on the way; they ease out of the slab once it's there.
      if (x !== at.x || y !== at.y) {
        body.setTranslation({ x, y, z: 0 }, true);
        visual.position.set(x, y, 0);
        at = { x, y };
        lastMove = time;
      }
      collider.setCollisionGroups(visible ? CARET_COLLISION : NO_COLLISION);
      show.v += ((visible ? 1 : 0) - show.x) * 400 * dt - show.v * 24 * dt;
      show.x += show.v * dt;
      // Blink: shown while typing, then on/off on a real caret's rhythm,
      // scaling to nothing and back quickly.
      const sinceMove = time - lastMove;
      let blink = 1;
      if (sinceMove > BLINK_HOLD) {
        const cycle = (sinceMove - BLINK_HOLD) % (BLINK_HALF * 2);
        const edge = (t: number) => THREE.MathUtils.smootherstep(t, 0, BLINK_EDGE);
        blink = cycle < BLINK_HALF ? 1 - edge(cycle) : edge(cycle - BLINK_HALF);
      }
      const scale = Math.max(blink * show.x, 0.0001);
      visual.scale.setScalar(scale);
      light.intensity = 1.5 * scale;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
