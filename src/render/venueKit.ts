import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Lighting } from './environment';
import type { Crowd, Scoreboard } from './venueStands';
import { flat } from './geo';
import { Grass, type GrassOptions } from './grass';
import type { BodyMesh } from './humanBody';
import { buildLawn, type GrassStyle } from './lawn';
import type { MapSet, Quality } from './textures';
import { softShadow } from './venueTextures';

/**
 * Building blocks shared by the venues: what a venue gives the environment,
 * geometry helpers that keep every triangle clean (merged meshes drop
 * degenerate triangles, so no zero-length normal can ever reach the
 * renderer), prop materials that darken toward the ground, and soft contact
 * shadows that seat props on the lawn.
 */

/** What every venue builder receives. */
export interface VenueContext {
  q: Quality;
  grass: MapSet;
  crowdBody: BodyMesh;
  /** Centre x of each court at this venue. */
  courts: number[];
}

/** A built venue: its own scenery group plus the parts the game talks to. */
export interface VenueScene {
  readonly group: THREE.Group;
  readonly scoreboards: Scoreboard[];
  readonly crowd: Crowd | null;
  /** Time of day changed (lamps come on at night; water and skies follow the light). */
  setLighting(L: Lighting): void;
  update(dt: number, time: number): void;
}

/** Lawn ground plus grass blades for a venue (both follow the venue's courts). */
export function buildGround(ctx: VenueContext, style: GrassStyle, group: THREE.Group, opts: Omit<GrassOptions, 'style' | 'courts'> = {}): Grass {
  group.add(buildLawn(ctx.grass, ctx.q, { style, size: 240, courts: ctx.courts }));
  const grass = new Grass(ctx.q, { style, courts: ctx.courts, ...opts });
  group.add(grass.mesh);
  return grass;
}

/** Axis-aligned rectangles (x0, z0, x1, z1) as a grass `blocked` test. */
export function blockedBy(rects: [number, number, number, number][]): (x: number, z: number) => boolean {
  return (x, z) => rects.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
}

/** Seeded random generator (0..1). */
export function rng(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---------------------------------------------------------------- geometry

/** Box of size w × h × d centred at (x, y, z), turned `rotY` about the vertical. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  return g.translate(x, y, z);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Orient a geometry built along +y (centred on the origin) to run from `a` to `b`. */
function alongSegment(g: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyQuaternion(q);
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** Round rod (post, pole, rail, log) from `a` to `b`. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, segs = 8, r2 = r): THREE.BufferGeometry {
  return alongSegment(new THREE.CylinderGeometry(r2, r, a.distanceTo(b), segs, 1), a, b);
}

/** Square-section beam from `a` to `b` (w across, h deep), kept upright around its axis. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, h, len);
  const dir = b.clone().sub(a).normalize();
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, Math.abs(dir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : UP);
  g.applyMatrix4(m);
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/**
 * A building's shell: the five-sided cross-section (walls `h` high, ridge
 * `ridge` high, `w` wide) extruded `len` along x, centred on (x, z).
 */
export function gableShell(w: number, len: number, h: number, ridge: number, x: number, z: number, rotY = 0): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(0, ridge);
  s.lineTo(-w / 2, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  // Shape lies in xy and extrudes along +z: turn it so the length runs along x.
  g.translate(0, 0, -len / 2).rotateY(Math.PI / 2);
  if (rotY) g.rotateY(rotY);
  return g.translate(x, 0, z);
}

/**
 * Pitched roof over a `gableShell`: two slabs `t` thick meeting at the
 * ridge, overhanging the walls by `eave` and the gable ends by `rake`.
 */
export function gableRoof(w: number, len: number, h: number, ridge: number, x: number, z: number, opts: { eave?: number; rake?: number; t?: number; rotY?: number } = {}): THREE.BufferGeometry[] {
  const { eave = 0.4, rake = 0.3, t = 0.1, rotY = 0 } = opts;
  const run = w / 2, rise = ridge - h;
  const pitch = Math.atan2(rise, run);
  const slope = Math.hypot(run, rise) + eave / Math.cos(pitch);
  const cap = new THREE.BoxGeometry(len + rake * 2, t * 1.2, 2 * t * Math.sin(pitch) + 0.1).translate(0, ridge + 0.02 + t * Math.cos(pitch), 0);
  if (rotY) cap.rotateY(rotY);
  const slabs = [-1, 1].map((side) => {
    const g = new THREE.BoxGeometry(len + rake * 2, t, slope);
    // Slab centre: halfway down the slope from the ridge, lifted to sit on the walls.
    g.translate(0, t / 2, side * slope / 2);
    g.rotateX(side * pitch);
    g.translate(0, ridge + 0.02, 0);
    if (rotY) g.rotateY(rotY);
    return g.translate(x, 0, z);
  });
  return [...slabs, cap.translate(x, 0, z)];
}

/** Points along a hanging string from `a` to `b`, sagging `sag` at mid-span. */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, n: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)));
  }
  return pts;
}

/**
 * Re-map UVs in metres: each triangle is projected onto the plane its
 * normal faces most (walls get u along the wall and v up), `tile` metres
 * per texture repeat; `swap` exchanges u and v.
 */
export function worldUV(g: THREE.BufferGeometry, tile: number, swap = false): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(b.clone().sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      let u = ay >= ax && ay >= az ? v.x : ax >= az ? v.z : v.x;
      let w = ay >= ax && ay >= az ? v.z : v.y;
      if (swap) [u, w] = [w, u];
      uv[(i + k) * 2] = u / tile;
      uv[(i + k) * 2 + 1] = w / tile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Drop zero-area triangles from a non-indexed geometry and make sure every
 * normal is finite and unit length (rebuilt from the face where it is not).
 */
export function cleanGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position'), nAttr = g.getAttribute('normal'), uvAttr = g.getAttribute('uv');
  const keep: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    if (c.sub(a).cross(b.sub(a)).length() > 1e-9) keep.push(i);
  }
  const pos = new Float32Array(keep.length * 9), nrm = new Float32Array(keep.length * 9), uv = new Float32Array(keep.length * 6);
  const n = new THREE.Vector3(), face = new THREE.Vector3();
  keep.forEach((i, t) => {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    face.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    for (let k = 0; k < 3; k++) {
      const j = (t * 3 + k) * 3;
      const v = k === 0 ? a : k === 1 ? b : c;
      pos[j] = v.x;
      pos[j + 1] = v.y;
      pos[j + 2] = v.z;
      n.fromBufferAttribute(nAttr, i + k);
      const len = n.length();
      if (!(len > 1e-4) || !Number.isFinite(len)) n.copy(face);
      else n.divideScalar(len);
      nrm[j] = n.x;
      nrm[j + 1] = n.y;
      nrm[j + 2] = n.z;
      uv[(t * 3 + k) * 2] = uvAttr ? uvAttr.getX(i + k) : 0;
      uv[(t * 3 + k) * 2 + 1] = uvAttr ? uvAttr.getY(i + k) : 0;
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/** Only position, normal and uv survive merging (every helper above provides all three). */
function core(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const f = flat(g);
  for (const name of Object.keys(f.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') f.deleteAttribute(name);
  if (!f.getAttribute('uv')) f.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(f.getAttribute('position').count * 2), 2));
  f.clearGroups();
  return f;
}

/**
 * Collects prop geometry per material and merges it into one clean mesh
 * per material, so a whole venue's buildings cost a handful of draw calls.
 */
export class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** Add geometry; `tile` (metres per texture repeat) re-maps its UVs in world units. */
  add(mat: THREE.Material, geo: THREE.BufferGeometry | THREE.BufferGeometry[], tile?: number, swap = false) {
    const list = this.parts.get(mat) ?? [];
    for (const g of Array.isArray(geo) ? geo : [geo]) {
      const f = core(g);
      list.push(tile ? worldUV(f, tile, swap) : f);
    }
    this.parts.set(mat, list);
  }

  /** Merge everything into `group` (shadow casting stays off: the sun's shadow map only covers the pits). */
  build(group: THREE.Group): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, geos] of this.parts) {
      const mesh = new THREE.Mesh(cleanGeometry(mergeGeometries(geos)!), mat);
      mesh.receiveShadow = true;
      group.add(mesh);
      out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}

// --------------------------------------------------------------- materials

/**
 * Standard material for props: darkens toward the ground (and under its
 * own footing) like ambient occlusion, so buildings and furniture sit on
 * the lawn instead of floating over it.
 */
export function propMaterial(params: THREE.MeshStandardMaterialParameters & { ao?: number } = {}): THREE.MeshStandardMaterial {
  const { ao = 0.55, ...rest } = params;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, ...rest });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPropAO = { value: ao };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vPropY;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 propWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          propWorld = instanceMatrix * propWorld;
        #endif
        vPropY = (modelMatrix * propWorld).y;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPropY;\nuniform float uPropAO;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(uPropAO, 1.0, smoothstep(0.0, 0.55, vPropY));');
  };
  mat.customProgramCacheKey = () => 'venue-prop';
  return mat;
}

/** A MapSet as a prop material (texture maps cloned so each use can set its own repeat). */
export function mapped(maps: { map: THREE.Texture; normalMap: THREE.Texture }, params: THREE.MeshStandardMaterialParameters & { ao?: number; normal?: number } = {}): THREE.MeshStandardMaterial {
  const { normal = 1, ...rest } = params;
  return propMaterial({ map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(normal, normal), ...rest });
}

/**
 * Soft contact shadows under props, all in one transparent mesh. Each
 * entry is a rectangle (centre x, z, width, depth, rotation, darkness).
 */
export function contactShadows(group: THREE.Group, rects: [number, number, number, number, number?, number?][]) {
  const geos = rects.map(([x, z, w, d, rot = 0, k = 0.5]) => {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    if (rot) g.rotateY(rot);
    g.translate(x, 0.015, z);
    const n = g.getAttribute('position').count;
    g.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    return g;
  });
  const mesh = new THREE.Mesh(
    mergeGeometries(geos)!,
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: softShadow(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );
  // Darkness per rectangle rides in the `shade` attribute, scaling opacity.
  (mesh.material as THREE.MeshBasicMaterial).onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float shade;\nvarying float vShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vShade;')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vShade;');
  };
  mesh.renderOrder = 1;
  group.add(mesh);
}

/**
 * A flat ribbon (gravel path, beach) following a smoothed line of (x, z)
 * points: `width` wide, `y` above the lawn, u running along it in metres
 * and v across it 0..1 (for an edge-fade alpha map).
 */
export function ribbon(points: [number, number][], width: number, y = 0.012, step = 0.6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  const pts = curve.getSpacedPoints(n);
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [];
  let along = 0;
  const side = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const p = pts[i];
    const t = pts[Math.min(n, i + 1)].clone().sub(pts[Math.max(0, i - 1)]);
    side.set(-t.z, 0, t.x).normalize().multiplyScalar(width / 2);
    if (i > 0) along += p.distanceTo(pts[i - 1]);
    pos.push(p.x - side.x, y, p.z - side.z, p.x + side.x, y, p.z + side.z);
    uv.push(along, 0, along, 1);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
