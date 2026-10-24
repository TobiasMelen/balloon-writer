// The balloon letters, loaded once and shared: their meshes (scaled to
// BALLOON_HEIGHT, centred) and widths. Loaded outside any canvas, so the
// metrics font (metricsFont.ts) can be built from the widths before the text
// is laid out.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import alphabetUrl from "./assets/alphabet.glb";
import { BALLOON_HEIGHT, type Glyph } from "./LetterBalloon";

/** Overlap between neighbours as a share of a letter's width: letters are
 *  packed tighter than their colliders, so they squeeze and jostle. */
export const TRACKING = -0.03;

export type Glyphs = {
  /** By uppercase letter. */
  glyphs: Map<string, Glyph>;
  /** A letter's height (the H's), world units. */
  glyphHeight: number;
};

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

async function load(): Promise<Glyphs> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const { scene } = await loader.loadAsync(alphabetUrl);
  scene.updateMatrixWorld(true);
  const glyphs = new Map<string, Glyph>();
  // Size letters like the original rope balloons so their physics tuning
  // applies as is.
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
  return { glyphs, glyphHeight: glyphs.get("H")?.height ?? BALLOON_HEIGHT };
}

let loading: Promise<Glyphs> | null = null;
/** The balloon letters, loading them on first call. */
export const loadGlyphs = () => (loading ??= load());
