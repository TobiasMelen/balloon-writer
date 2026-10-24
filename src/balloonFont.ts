// Balloon glyphs generated in code, no model file: each character is a
// skeleton (centrelines, all the same stroke width, like real foil letter
// balloons: monoline, rounded, open counters, no thin joins), turned into a
// puffy shell. The shell is a distance field around the skeleton (squashed in
// depth so strokes are flattened tubes, blended where strokes meet so joints
// puff out) with a thin flat seam around the outline where the two foil
// sheets are welded, and fine crinkles near it. Surface nets turn the field
// into a mesh.
//
// Units: cap height 1, baseline at 0, x from 0 to the glyph's advance.
import * as THREE from "three";

type Point = [number, number];
/** A glyph: polylines (strokes) and dots, its advance, and optionally a
 *  thinner stroke for busy shapes. */
type GlyphDef = { strokes: Point[][]; dots?: Point[]; advance: number; stroke?: number };

/** Half the stroke width, as a share of the cap height. */
const STROKE = 0.13;
/** A stroke's depth is its width divided by this: foil balloons are flatter
 *  than round. */
const FLATTEN = 1.8;
/** Dots (umlauts, periods) are a little smaller than the stroke. */
const DOT = 0.85;
/** The seam: how far the flat lip sticks out past the puffy part, and how
 *  thick it is. */
const SEAM_WIDTH = 0.022;
const SEAM_THICKNESS = 0.006;
/** Crinkles near the seam: depth and size (per cap height). */
const CRINKLE = 0.007;
const CRINKLE_SCALE = 26;
/** How smoothly strokes blend where they meet (the puff at joints). */
const BLEND = 0.045;
/** Mesh resolution: grid step, as a share of the cap height. */
const STEP = 0.014;

/** An arc of a circle as polyline points (angles in degrees, counter-
 *  clockwise from +x). */
function arc(cx: number, cy: number, r: number, from: number, to: number, n = 20): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = THREE.MathUtils.degToRad(from + ((to - from) * i) / n);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

const X_HEIGHT = 0.68;

export const GLYPHS: Record<string, GlyphDef> = {
  A: {
    strokes: [
      [[0.08, 0], [0.41, 1], [0.74, 0]],
      [[0.21, 0.34], [0.61, 0.34]],
    ],
    advance: 0.82,
  },
  "7": {
    strokes: [[[0.06, 0.98], [0.62, 0.98], [0.22, 0]]],
    advance: 0.7,
  },
  a: {
    strokes: [arc(0.3, 0.32, 0.22, 0, 360, 28), [[0.56, X_HEIGHT - 0.06], [0.56, 0]]],
    advance: 0.72,
  },
  "ä": {
    strokes: [arc(0.3, 0.32, 0.22, 0, 360, 28), [[0.56, X_HEIGHT - 0.06], [0.56, 0]]],
    dots: [[0.17, 0.92], [0.45, 0.92]],
    advance: 0.72,
  },
  ".": { strokes: [], dots: [[0.13, 0.1]], advance: 0.28 },
  "@": {
    strokes: [
      // The small inner "a" and its stem, then the outer ring, open at the
      // lower right where it runs out of the stem.
      arc(0.5, 0.46, 0.15, 0, 360, 24),
      [[0.65, 0.62], [0.65, 0.34], ...arc(0.76, 0.34, 0.11, 180, 360, 8)],
      arc(0.5, 0.46, 0.4, 5, 320, 36),
    ],
    advance: 1.02,
    stroke: 0.085,
  },
};

// Smooth 3D value noise, for the crinkles.
function hash(x: number, y: number, z: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const [u, v, w] = [s(fx), s(fy), s(fz)];
  let total = 0;
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        total += hash(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  return total * 2 - 1;
}

/** Smooth minimum (polynomial), so strokes blend into each other. */
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function segmentDistance(px: number, py: number, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Signed distance to the balloon's surface (negative inside). */
function glyphField(def: GlyphDef) {
  const r = def.stroke ?? STROKE;
  const segments: [Point, Point][] = def.strokes.flatMap((line) => line.slice(1).map((b, i) => [line[i]!, b] as [Point, Point]));
  return (x: number, y: number, z: number) => {
    // Distance in the letter's plane to the skeleton: strokes blended, dots
    // kept separate (they're their own balloons).
    let strokes = Infinity;
    for (const [a, b] of segments) strokes = smin(strokes, segmentDistance(x, y, a, b), BLEND);
    let field = Math.hypot(strokes, z * FLATTEN) - r;
    let plane = strokes;
    for (const [dx, dy] of def.dots ?? []) {
      const d = Math.hypot(x - dx, y - dy);
      field = Math.min(field, Math.hypot(d, z * FLATTEN) - r * DOT);
      plane = Math.min(plane, d + r * (1 - DOT));
    }
    // The welded seam: a thin flat lip around the outline.
    const seam = Math.max(plane - (r + SEAM_WIDTH), Math.abs(z) - SEAM_THICKNESS);
    field = Math.min(field, seam);
    // Crinkles, strongest near the seam's plane, fading toward the faces.
    const nearSeam = 1 - Math.min(1, Math.abs(z) / (r / FLATTEN));
    return field + CRINKLE * nearSeam * noise(x * CRINKLE_SCALE, y * CRINKLE_SCALE, z * CRINKLE_SCALE);
  };
}

/** Surface nets: a vertex in each grid cell the surface passes through (at
 *  the average of its edge crossings), quads across each crossed edge. */
function surfaceNets(field: (x: number, y: number, z: number) => number, min: THREE.Vector3, max: THREE.Vector3, step: number) {
  const nx = Math.ceil((max.x - min.x) / step) + 1;
  const ny = Math.ceil((max.y - min.y) / step) + 1;
  const nz = Math.ceil((max.z - min.z) / step) + 1;
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const values = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) values[at(i, j, k)] = field(min.x + i * step, min.y + j * step, min.z + k * step);

  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as const;
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as const;
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const v = corners.map(([a, b, c]) => values[at(i + a, j + b, k + c)]!);
        if (v.every((x) => x > 0) || v.every((x) => x <= 0)) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [e0, e1] of edges) {
          const a = v[e0]!, b = v[e1]!;
          if (a > 0 === b > 0) continue;
          const t = a / (a - b);
          const [ax, ay, az] = corners[e0]!, [bx, by, bz] = corners[e1]!;
          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          n++;
        }
        cellVertex[at(i, j, k)] = positions.length / 3;
        positions.push(min.x + (i + sx / n) * step, min.y + (j + sy / n) * step, min.z + (k + sz / n) * step);
      }

  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, b, c, a, c, d);
    else index.push(a, c, b, a, d, c);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const inside = values[at(i, j, k)]! <= 0;
        // Edges toward +x, +y and +z from this grid point.
        if (inside !== values[at(i + 1, j, k)]! <= 0)
          quad(cellVertex[at(i, j - 1, k - 1)]!, cellVertex[at(i, j, k - 1)]!, cellVertex[at(i, j, k)]!, cellVertex[at(i, j - 1, k)]!, inside);
        if (inside !== values[at(i, j + 1, k)]! <= 0)
          quad(cellVertex[at(i - 1, j, k - 1)]!, cellVertex[at(i - 1, j, k)]!, cellVertex[at(i, j, k)]!, cellVertex[at(i, j, k - 1)]!, inside);
        if (inside !== values[at(i, j, k + 1)]! <= 0)
          quad(cellVertex[at(i - 1, j - 1, k)]!, cellVertex[at(i, j - 1, k)]!, cellVertex[at(i, j, k)]!, cellVertex[at(i - 1, j, k)]!, inside);
      }

  // Normals from the field's gradient: smooth, unlike the faceted mesh's.
  const normals = new Float32Array(positions.length);
  const h = step * 0.5;
  for (let p = 0; p < positions.length; p += 3) {
    const [x, y, z] = [positions[p]!, positions[p + 1]!, positions[p + 2]!];
    const n = new THREE.Vector3(field(x + h, y, z) - field(x - h, y, z), field(x, y + h, z) - field(x, y - h, z), field(x, y, z + h) - field(x, y, z - h)).normalize();
    normals.set([n.x, n.y, n.z], p);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

/** The balloon mesh for `char`, or null if there's no glyph for it. */
export function balloonGlyph(char: string) {
  const def = GLYPHS[char];
  if (!def) return null;
  const r = def.stroke ?? STROKE;
  const pad = r + SEAM_WIDTH + STEP * 3;
  const points = [...def.strokes.flat(), ...(def.dots ?? [])];
  const min = new THREE.Vector3(Math.min(...points.map((p) => p[0])) - pad, Math.min(...points.map((p) => p[1])) - pad, -(r / FLATTEN) - STEP * 3);
  const max = new THREE.Vector3(Math.max(...points.map((p) => p[0])) + pad, Math.max(...points.map((p) => p[1])) + pad, r / FLATTEN + STEP * 3);
  return { geometry: surfaceNets(glyphField(def), min, max, STEP), advance: def.advance };
}
