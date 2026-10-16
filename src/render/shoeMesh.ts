import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FINISHES, MODELS, hsvToRgb, type Loadout, type ModelId, type WeightId } from '../core/equipment';
import { polygonArea, shoeGeometry, type Calk, type ShoeGeometry, type Vec2 } from '../core/shoeShape';
import { fbm } from './textures';

/**
 * Builds a shoe mesh from the model's plan outline: the plate is the outline
 * extruded with rounded edges, the calks are solids hanging below it, and a
 * planar texture carries the raised badge, stamped lettering and the cast
 * surface grain. Colour and finish are plain material properties, so they
 * can be changed live (the pro shop's sliders do exactly that).
 */

/** Plan-view square covered by the texture, metres either side of the centre. */
const SPAN = 0.1;
const TEX_W = 1024;
const TEX_H = 512;
/** Canvas pixels per metre of plan (each half of the texture covers the plan square). */
const PX = TEX_H / (2 * SPAN);

function planUv(x: number, z: number, top: boolean): [number, number] {
  return [((x + SPAN) / (2 * SPAN)) * 0.5 + (top ? 0 : 0.5), (z + SPAN) / (2 * SPAN)];
}

function plateGeometry(g: ShoeGeometry): THREE.BufferGeometry {
  const bevel = 0.0018;
  const shape = new THREE.Shape(g.outline.map((p) => new THREE.Vector2(p.x, p.z)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: g.thickness - 2 * bevel,
    steps: 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 1,
  });
  // Shape plane (x, z) with the extrusion along +Z → plan (x, z) with thickness along Y.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, g.thickness / 2 - bevel, 0);
  geo.deleteAttribute('normal');
  return geo;
}

function calkGeometry(c: Calk, baseY: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = c.base.length;
  const cx = c.base.reduce((s, p) => s + p.x, 0) / n;
  const cz = c.base.reduce((s, p) => s + p.z, 0) / n;
  const cy = (baseY + c.tip.reduce((s, p) => s + p.y, 0) / n) / 2;
  const tri = (a: number[], b: number[], d: number[], outward: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) pos.push(...a, ...d, ...b);
    else pos.push(...a, ...b, ...d);
  };
  // Start slightly inside the plate so there is no seam.
  const y0 = baseY + 0.0007;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = [c.base[i].x, y0, c.base[i].z], b1 = [c.base[j].x, y0, c.base[j].z];
    const t0 = [c.tip[i].x, c.tip[i].y, c.tip[i].z], t1 = [c.tip[j].x, c.tip[j].y, c.tip[j].z];
    const mid = [(b0[0] + b1[0] + t0[0] + t1[0]) / 4 - cx, (b0[1] + b1[1] + t0[1] + t1[1]) / 4 - cy, (b0[2] + b1[2] + t0[2] + t1[2]) / 4 - cz];
    tri(b0, b1, t1, mid);
    tri(b0, t1, t0, mid);
  }
  // Bottom face of the calk.
  const ring = c.tip.map((p) => new THREE.Vector2(p.x, p.z));
  if (Math.abs(polygonArea(c.tip.map((p) => ({ x: p.x, z: p.z })))) > 1e-8) {
    for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(ring, [])) {
      const A = c.tip[a], B = c.tip[b], D = c.tip[d];
      tri([A.x, A.y, A.z], [B.x, B.y, B.z], [D.x, D.y, D.z], [0, -1, 0]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

/** Planar UVs: top-facing triangles map to the left half of the texture, the rest to the right. */
function applyPlanarUv(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let t = 0; t < p.count; t += 3) {
    const top = (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3 > 0;
    for (let k = t; k < t + 3; k++) {
      const [u, v] = planUv(p.getX(k), p.getZ(k), top);
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const geoCache = new Map<ModelId, THREE.BufferGeometry>();

export function shoeBufferGeometry(model: ModelId): THREE.BufferGeometry {
  let geo = geoCache.get(model);
  if (!geo) {
    const g = shoeGeometry(model);
    const parts = [plateGeometry(g), ...g.calks.map((c) => calkGeometry(c, -g.thickness / 2))].map(applyPlanarUv);
    for (const p of parts) for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'uv') p.deleteAttribute(k);
    const merged = mergeGeometries(parts)!;
    geo = toCreasedNormals(merged, 0.62);
    geo.computeBoundingSphere();
    geoCache.set(model, geo);
  }
  return geo;
}

// ------------------------------------------------------------ texture

interface Frame {
  p: Vec2;
  n: Vec2;
  t: Vec2;
  hb: number;
}

/** Centreline frame at a signed arc position (negative = left side). */
function frameAt(g: ShoeGeometry, s: number): Frame {
  const c = g.center;
  const a = Math.min(Math.abs(s), c[c.length - 1].s);
  let i = 0;
  while (i < c.length - 2 && c[i + 1].s < a) i++;
  const f = (a - c[i].s) / Math.max(1e-9, c[i + 1].s - c[i].s);
  const lerp = (u: number, v: number) => u + (v - u) * f;
  let p = { x: lerp(c[i].p.x, c[i + 1].p.x), z: lerp(c[i].p.z, c[i + 1].p.z) };
  let n = { x: lerp(c[i].n.x, c[i + 1].n.x), z: lerp(c[i].n.z, c[i + 1].n.z) };
  const l = Math.hypot(n.x, n.z) || 1;
  n = { x: n.x / l, z: n.z / l };
  if (s < 0) {
    p = { x: -p.x, z: p.z };
    n = { x: -n.x, z: n.z };
  }
  return { p, n, t: { x: -n.z, z: n.x }, hb: lerp(c[i].hb, c[i + 1].hb) };
}

const toCanvas = (p: Vec2): [number, number] => [(p.x + SPAN) * PX, (SPAN - p.z) * PX];

/** Draw `text` along the centreline, centred at arc position `s`, `radial` metres out from it. */
function arcText(ctx: CanvasRenderingContext2D, g: ShoeGeometry, text: string, s: number, radial: number, size: number, opts: { along?: boolean; weight?: number; spacing?: number } = {}) {
  const mm = 0.001;
  ctx.save();
  ctx.font = `${opts.weight ?? 700} ${size / mm}px Oswald, Impact, sans-serif`;
  const widths = [...text].map((ch) => ctx.measureText(ch).width * mm + (opts.spacing ?? 0));
  const total = widths.reduce((a, b) => a + b, 0) - (opts.spacing ?? 0);
  let cursor = -total / 2;
  [...text].forEach((ch, i) => {
    const w = widths[i];
    // Straight text when `along` (legs); otherwise each glyph follows the bow.
    const fr = frameAt(g, opts.along ? s : s + cursor + w / 2);
    const base = { x: fr.p.x + fr.n.x * radial, z: fr.p.z + fr.n.z * radial };
    const off = opts.along ? cursor + w / 2 : 0;
    const q = { x: base.x + fr.t.x * off, z: base.z + fr.t.z * off };
    const [qx, qy] = toCanvas(q);
    // Local glyph axes: reading direction t, "down" = -n, 1 unit = 1 mm.
    const rx = fr.t.x * PX * mm, ry = -fr.t.z * PX * mm;
    const dx = -fr.n.x * PX * mm, dy = fr.n.z * PX * mm;
    ctx.setTransform(rx, ry, dx, dy, qx, qy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 0);
    cursor += w;
  });
  ctx.restore();
}

/** A rounded badge lying along the centreline from s0 to s1, between radial offsets r0 and r1. */
function badgePath(g: ShoeGeometry, s0: number, s1: number, r0: number, r1: number): Path2D {
  const path = new Path2D();
  const steps = 40;
  const rad = (r1 - r0) / 2;
  const mid = (r0 + r1) / 2;
  const pts: Vec2[] = [];
  const at = (s: number, r: number) => {
    const f = frameAt(g, s);
    return { x: f.p.x + f.n.x * r, z: f.p.z + f.n.z * r };
  };
  for (let i = 0; i <= steps; i++) pts.push(at(s0 + ((s1 - s0) * i) / steps, r1));
  {
    const f = frameAt(g, s1);
    const c = at(s1, mid);
    for (let i = 1; i < 12; i++) {
      const a = (Math.PI * i) / 12;
      pts.push({ x: c.x + (f.n.x * Math.cos(a) + f.t.x * Math.sin(a)) * rad, z: c.z + (f.n.z * Math.cos(a) + f.t.z * Math.sin(a)) * rad });
    }
  }
  for (let i = steps; i >= 0; i--) pts.push(at(s0 + ((s1 - s0) * i) / steps, r0));
  {
    const f = frameAt(g, s0);
    const c = at(s0, mid);
    for (let i = 1; i < 12; i++) {
      const a = Math.PI + (Math.PI * i) / 12;
      pts.push({ x: c.x + (f.n.x * Math.cos(a) + f.t.x * Math.sin(a)) * rad, z: c.z + (f.n.z * Math.cos(a) + f.t.z * Math.sin(a)) * rad });
    }
  }
  pts.forEach((p, i) => {
    const [x, y] = toCanvas(p);
    if (i) path.lineTo(x, y);
    else path.moveTo(x, y);
  });
  path.closePath();
  return path;
}

const texCache = new Map<string, THREE.CanvasTexture>();

/**
 * One texture per model and weight: red = surface height (badge, lettering,
 * cast grain) for the bump map, green = roughness variation.
 */
function shoeTexture(model: ModelId, weight: WeightId): THREE.CanvasTexture {
  const key = `${model}|${weight}`;
  let tex = texCache.get(key);
  if (tex) return tex;
  const g = shoeGeometry(model);
  const stamp = MODELS[model].stamp;
  const relief = document.createElement('canvas');
  relief.width = TEX_W;
  relief.height = TEX_H;
  const rc = relief.getContext('2d')!;
  rc.fillStyle = 'rgb(128,128,128)';
  rc.fillRect(0, 0, TEX_W, TEX_H);
  const legEnd = g.center[g.center.length - 1].s;
  const toeHb = g.center[0].hb;
  const raised = (v: number) => `rgb(${v},${v},${v})`;
  rc.lineJoin = 'round';
  if (stamp.style === 'oval') {
    const size = Math.min(0.0058, toeHb * 0.5);
    rc.font = `700 ${size * 1000}px Oswald, Impact, sans-serif`;
    const half = (rc.measureText(stamp.text).width / 1000 + stamp.text.length * 0.0004) / 2 + 0.003;
    const path = badgePath(g, -half, half, -toeHb * 0.4, toeHb * 0.4);
    rc.fillStyle = raised(120);
    rc.fill(path);
    rc.strokeStyle = raised(168);
    rc.lineWidth = 0.0009 * PX;
    rc.stroke(path);
    rc.fillStyle = raised(170);
    arcText(rc, g, stamp.text, 0, 0, size, { spacing: 0.0004 });
  } else if (stamp.style === 'panel') {
    const half = 0.044;
    const path = badgePath(g, -half, half, -toeHb * 0.62, toeHb * 0.62);
    rc.fillStyle = raised(146);
    rc.fill(path);
    rc.strokeStyle = raised(160);
    rc.lineWidth = 0.0006 * PX;
    rc.stroke(path);
    rc.fillStyle = raised(176);
    arcText(rc, g, stamp.text, 0, toeHb * 0.2, toeHb * 0.36, { weight: 500, spacing: 0.0003 });
    if (stamp.under) arcText(rc, g, stamp.under, 0, -toeHb * 0.24, toeHb * 0.28, { weight: 500 });
    if (stamp.sides) {
      arcText(rc, g, stamp.sides[0], -half * 0.72, -toeHb * 0.22, toeHb * 0.2, { weight: 500 });
      arcText(rc, g, stamp.sides[1], half * 0.72, -toeHb * 0.22, toeHb * 0.2, { weight: 500 });
    }
  } else {
    // Badge on the right leg, reading down the leg.
    const s = legEnd * 0.62;
    const hb = frameAt(g, s).hb;
    const size = hb * 0.5;
    rc.font = `700 ${size * 1000}px Oswald, Impact, sans-serif`;
    const half = (rc.measureText(stamp.text).width / 1000) / 2 + 0.003;
    const path = badgePath(g, s - half, s + half, -hb * 0.42, hb * 0.42);
    rc.fillStyle = raised(120);
    rc.fill(path);
    rc.strokeStyle = raised(166);
    rc.lineWidth = 0.0008 * PX;
    rc.stroke(path);
    rc.fillStyle = raised(168);
    arcText(rc, g, stamp.text, s, 0, size, { along: true });
  }
  // Weight stamp on the left leg.
  {
    const s = -legEnd * 0.62;
    const hb = frameAt(g, s).hb;
    rc.fillStyle = raised(106);
    arcText(rc, g, weight.replace('-', ' · '), s, 0, hb * 0.42, { along: true, weight: 600 });
  }
  const img = rc.getImageData(0, 0, TEX_W, TEX_H);
  const d = img.data;
  for (let y = 0; y < TEX_H; y++)
    for (let x = 0; x < TEX_W; x++) {
      const i = (y * TEX_W + x) * 4;
      const u = x / TEX_W, v = y / TEX_H;
      const grain = fbm(u * 96, v * 48, 96, 3, 23) - 0.5;
      const pit = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const stipple = pit - Math.floor(pit) - 0.5;
      d[i] = Math.max(0, Math.min(255, d[i] + grain * 7 + stipple * 3.5));
      d[i + 1] = Math.max(0, Math.min(255, 228 + grain * 46));
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  rc.putImageData(img, 0, 0);
  tex = new THREE.CanvasTexture(relief);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  texCache.set(key, tex);
  return tex;
}

// ------------------------------------------------------------ material

/** Apply a loadout's colour and finish to a shoe material (cheap: no new textures). */
export function applyShoeLook(m: THREE.MeshPhysicalMaterial, l: Loadout) {
  const fin = FINISHES[l.finish];
  const [r, g, b] = hsvToRgb(l.color);
  const metal = fin.metalness > 0.5;
  m.color.setRGB(r, g, b, THREE.SRGBColorSpace);
  // Paint albedo sits below the picked swatch so that, under the full sun of
  // the court, the shoe reads as the colour on the slider rather than a
  // washed-out pastel of it.
  if (!metal) m.color.multiplyScalar(0.5);
  // The texture's green channel averages ~0.9 of full roughness.
  m.roughness = fin.roughness / 0.9;
  m.metalness = fin.metalness;
  m.clearcoat = fin.clearcoat;
  m.clearcoatRoughness = 0.035;
  // Under a clear coat the paint itself is barely specular, and the open sky
  // reflected in it is kept modest so the colour stays rich.
  m.specularIntensity = metal ? 1 : 0.3;
  m.envMapIntensity = metal ? 0.95 : 0.8;
}

const matCache = new Map<string, THREE.MeshPhysicalMaterial>();

function lookKey(l: Loadout) {
  return `${l.model}|${l.weight}|${l.finish}|${l.color.map((v) => v.toFixed(3)).join(',')}`;
}

/** Shared material for a loadout; `unique` returns a fresh one that can be recoloured live. */
export function shoeMaterial(l: Loadout, envMap?: THREE.Texture | null, unique = false): THREE.MeshPhysicalMaterial {
  const key = lookKey(l);
  let m = unique ? undefined : matCache.get(key);
  if (m) {
    if (envMap !== undefined) m.envMap = envMap;
    return m;
  }
  const tex = shoeTexture(l.model, l.weight);
  m = new THREE.MeshPhysicalMaterial({
    bumpMap: tex,
    bumpScale: 2.4,
    roughnessMap: tex,
    envMap: envMap ?? null,
    envMapIntensity: 1.35,
  });
  applyShoeLook(m, l);
  if (!unique) matCache.set(key, m);
  return m;
}

export function createShoeMesh(l: Loadout, envMap?: THREE.Texture | null, unique = false): THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial> {
  const mesh = new THREE.Mesh(shoeBufferGeometry(l.model), shoeMaterial(l, envMap, unique));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
