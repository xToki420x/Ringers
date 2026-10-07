import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BRANDS, FINISHES, type Loadout, type ShapeId } from '../core/equipment';
import { bandWidth, centerline, centerNormal, centerTangent, shoeGeometry, type ShoeGeometry } from '../core/shoeShape';
import { fbm } from './textures';
import { flat } from './geo';

/**
 * Builds a detailed forged-shoe mesh by sweeping a rounded, lipped
 * cross-section along the shoe centreline, capping the heels and adding
 * calks and hooks. The finish texture carries paint, worn edges and the
 * brand stamp debossed into the toe.
 */

interface Profile {
  pts: { s: number; y: number }[];
  /** Perimeter fraction where the top face starts/ends. */
  vTop: [number, number];
}

function profileFor(g: ShoeGeometry, theta: number, lip: number): Profile {
  const hb = bandWidth(g, theta) / 2;
  const ht = g.thickness / 2;
  const rr = Math.min(0.0022, ht * 0.45);
  const pts: { s: number; y: number }[] = [];
  const arc = (cx: number, cy: number, a0: number, a1: number, n = 4) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ s: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  };
  const P = Math.PI;
  // bottom inner -> bottom outer
  arc(-hb + rr, -ht + rr, P, 1.5 * P);
  arc(hb - rr, -ht + rr, 1.5 * P, 2 * P);
  // outer edge up
  arc(hb - rr, ht - rr, 0, 0.5 * P);
  const topStart = pts.length - 1;
  // top face outer -> inner with a raised inner lip
  const N = 8;
  for (let i = 1; i < N; i++) {
    const s = hb - rr - ((2 * hb - 2 * rr) * i) / N;
    const f = Math.max(0, (-s - hb * 0.25) / (hb * 0.75));
    pts.push({ s, y: ht + lip * Math.sin(Math.min(1, f) * Math.PI * 0.5) * (1 - Math.max(0, f - 0.85) * 3) });
  }
  const topEnd = pts.length;
  arc(-hb + rr, ht - rr + lip * 0.4, 0.5 * P, P);
  // perimeter fractions
  let total = 0;
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].s - pts[i - 1].s, pts[i].y - pts[i - 1].y);
    acc.push(total);
  }
  total += Math.hypot(pts[0].s - pts[pts.length - 1].s, pts[0].y - pts[pts.length - 1].y);
  return { pts, vTop: [acc[topStart] / total, acc[topEnd] / total] };
}

function sweepGeometry(g: ShoeGeometry): { geo: THREE.BufferGeometry; vTop: [number, number] } {
  const N = 150;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let M = 0;
  let vTop: [number, number] = [0.5, 0.7];
  let arcAcc = 0;
  let prev = centerline(g, -g.thetaMax);
  const arcs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const th = -g.thetaMax + (2 * g.thetaMax * i) / N;
    const p = centerline(g, th);
    arcAcc += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
    arcs.push(arcAcc);
  }
  for (let i = 0; i <= N; i++) {
    const th = -g.thetaMax + (2 * g.thetaMax * i) / N;
    const p = centerline(g, th);
    const n = centerNormal(g, th);
    const prof = profileFor(g, th, g.innerLip);
    if (i === 0) {
      M = prof.pts.length;
      vTop = prof.vTop;
    }
    const u = arcs[i] / arcAcc;
    let per = 0;
    let lastP = prof.pts[0];
    const total = prof.pts.reduce((acc, q, k) => (k ? acc + Math.hypot(q.s - prof.pts[k - 1].s, q.y - prof.pts[k - 1].y) : 0), 0) +
      Math.hypot(prof.pts[0].s - prof.pts[M - 1].s, prof.pts[0].y - prof.pts[M - 1].y);
    for (let k = 0; k < M; k++) {
      const q = prof.pts[k];
      per += Math.hypot(q.s - lastP.s, q.y - lastP.y);
      lastP = q;
      positions.push(p.x + n.x * q.s, q.y, p.z + n.z * q.s);
      uvs.push(u, per / total);
    }
  }
  for (let i = 0; i < N; i++)
    for (let k = 0; k < M; k++) {
      const a = i * M + k;
      const b = i * M + ((k + 1) % M);
      const c = (i + 1) * M + k;
      const d = (i + 1) * M + ((k + 1) % M);
      indices.push(a, b, c, b, d, c);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // Fix the seam between first and last profile vertex: fine as is (closed ring shares no vertex).

  // Heel caps.
  const caps: THREE.BufferGeometry[] = [];
  for (const end of [0, N]) {
    const th = -g.thetaMax + (2 * g.thetaMax * end) / N;
    const tg = centerTangent(g, th);
    const dir = end === 0 ? -1 : 1;
    const cp: number[] = [];
    const cn: number[] = [];
    const cu: number[] = [];
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < M; k++) {
      cx += positions[(end * M + k) * 3];
      cy += positions[(end * M + k) * 3 + 1];
      cz += positions[(end * M + k) * 3 + 2];
    }
    cx /= M; cy /= M; cz /= M;
    for (let k = 0; k < M; k++) {
      const a = (end * M + k) * 3;
      const b = (end * M + ((k + 1) % M)) * 3;
      const tri = [
        [cx, cy, cz],
        [positions[a], positions[a + 1], positions[a + 2]],
        [positions[b], positions[b + 1], positions[b + 2]],
      ];
      const order = dir > 0 ? [0, 1, 2] : [0, 2, 1];
      for (const o of order) {
        cp.push(...tri[o]);
        cn.push(tg.x * dir, 0, tg.z * dir);
        cu.push(end === 0 ? 0.001 : 0.999, 0.02);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.setAttribute('normal', new THREE.Float32BufferAttribute(cn, 3));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
    caps.push(cg);
  }
  return { geo: mergeGeometries([flat(geo), ...caps])!, vTop };
}

function calkGeometries(g: ShoeGeometry): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const add = (cx: number, cy: number, cz: number, yaw: number, w: number, h: number, d: number) => {
    const r = Math.min(w, h, d) * 0.3;
    const b = flat(new RoundedBoxGeometry(w, h, d, 2, r));
    b.rotateY(yaw);
    b.translate(cx, cy, cz);
    const uv = b.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, 0.06);
    out.push(b);
  };
  // Toe calk: a ridge across the toe, slightly tapered by using two boxes.
  const toe = centerline(g, 0);
  add(toe.x, -g.thickness / 2 - g.toeCalk / 2 + 0.0008, toe.z, 0, 0.058, g.toeCalk + 0.0016, 0.0085);
  for (const s of [-1, 1]) {
    const th = s * (g.thetaMax - 0.1);
    const p = centerline(g, th);
    const tg = centerTangent(g, th);
    add(p.x, -g.thickness / 2 - g.heelCalk / 2 + 0.0008, p.z, Math.atan2(tg.x, tg.z), bandWidth(g, th) * 0.96, g.heelCalk + 0.0016, 0.011);
  }
  if (g.hook > 0.002) {
    const inner = g.innerPolygon;
    const heelR = inner[inner.length - 2];
    const n = centerNormal(g, g.thetaMax);
    for (const s of [-1, 1]) {
      const root = { x: s * heelR.x, z: heelR.z };
      const tip = { x: root.x - s * n.x * g.hook * Math.sign(heelR.x || 1), z: root.z - n.z * g.hook };
      const len = Math.hypot(tip.x - root.x, tip.z - root.z) + 0.004;
      add((tip.x + root.x) / 2, 0, (tip.z + root.z) / 2, Math.atan2(tip.x - root.x, tip.z - root.z), 0.0062, g.thickness * 0.92, len);
    }
  }
  return out;
}

const geoCache = new Map<ShapeId, { geo: THREE.BufferGeometry; vTop: [number, number] }>();

export function shoeBufferGeometry(shape: ShapeId): { geo: THREE.BufferGeometry; vTop: [number, number] } {
  let c = geoCache.get(shape);
  if (!c) {
    const g = shoeGeometry(shape);
    const sweep = sweepGeometry(g);
    const merged = mergeGeometries([sweep.geo, ...calkGeometries(g)])!;
    merged.computeBoundingSphere();
    c = { geo: merged, vTop: sweep.vTop };
    geoCache.set(shape, c);
  }
  return c;
}

const matCache = new Map<string, THREE.MeshPhysicalMaterial>();

/** Paint + wear + stamp textures for a loadout. */
export function shoeMaterial(l: Loadout, envMap?: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const key = `${l.brand}|${l.finish}|${l.shape}`;
  let m = matCache.get(key);
  if (m) {
    if (envMap !== undefined) m.envMap = envMap;
    return m;
  }
  const fin = FINISHES[l.finish];
  const brand = BRANDS[l.brand];
  const { vTop } = shoeBufferGeometry(l.shape);
  const W = 1024, H = 128;
  const col = document.createElement('canvas');
  col.width = W;
  col.height = H;
  const orm = document.createElement('canvas');
  orm.width = W;
  orm.height = H;
  const bump = document.createElement('canvas');
  bump.width = W;
  bump.height = H;
  const cc = col.getContext('2d')!;
  const oc = orm.getContext('2d')!;
  const bc = bump.getContext('2d')!;
  const ci = cc.createImageData(W, H);
  const oi = oc.createImageData(W, H);
  const bi = bc.createImageData(W, H);
  const paint = new THREE.Color(fin.color);
  const steel = new THREE.Color('#8a8d91');
  const pr = paint.r * 255, pg = paint.g * 255, pb = paint.b * 255;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      // Edges of the profile (near the rounded corners) and the heel tips wear first.
      const top = v > vTop[0] && v < vTop[1];
      const cornerDist = Math.min(Math.abs(v - vTop[0]), Math.abs(v - vTop[1]), Math.abs(v - 0.02), Math.abs(v - 0.27));
      const n = fbm(u * 40, v * 6, 40, 4, 61);
      const tipWear = Math.max(0, 1 - Math.min(u, 1 - u) * 14);
      const toeWear = Math.max(0, 1 - Math.abs(u - 0.5) * 9) * 0.35; // toe strikes the stake
      const wear = fin.wear * Math.min(1, Math.max(0, (0.045 - cornerDist) * 30) * 0.8 + tipWear * 0.9 + toeWear + (n - 0.62) * 2.2);
      const worn = wear > 0.5;
      const i = (y * W + x) * 4;
      const shade = 0.88 + n * 0.24;
      if (worn) {
        ci.data[i] = steel.r * 255 * shade;
        ci.data[i + 1] = steel.g * 255 * shade;
        ci.data[i + 2] = steel.b * 255 * shade;
      } else {
        ci.data[i] = Math.min(255, pr * shade);
        ci.data[i + 1] = Math.min(255, pg * shade);
        ci.data[i + 2] = Math.min(255, pb * shade);
      }
      ci.data[i + 3] = 255;
      oi.data[i] = 255;
      oi.data[i + 1] = (worn ? 0.32 : fin.roughness + (n - 0.5) * 0.12) * 255;
      oi.data[i + 2] = (worn ? 1 : fin.metalness) * 255;
      oi.data[i + 3] = 255;
      const b = 128 + (n - 0.5) * 50 + (top ? 0 : -10);
      bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = b;
      bi.data[i + 3] = 255;
    }
  cc.putImageData(ci, 0, 0);
  oc.putImageData(oi, 0, 0);
  bc.putImageData(bi, 0, 0);
  // Debossed brand stamp across the toe, plus a weight/serial stamp near a heel.
  const y0 = vTop[0] * H, y1 = vTop[1] * H;
  const yc = (y0 + y1) / 2;
  const th = (y1 - y0) * 0.62;
  const stamp = (ctx: CanvasRenderingContext2D, style: string, text: string, x: number, size: number, flip = true) => {
    ctx.save();
    ctx.translate(x, yc);
    if (flip) ctx.scale(-1, 1);
    ctx.font = `700 ${size}px Oswald, Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  stamp(bc, 'rgb(40,40,40)', brand.stamp, W / 2, th);
  stamp(cc, 'rgba(0,0,0,0.38)', brand.stamp, W / 2, th);
  stamp(bc, 'rgb(60,60,60)', l.weight.replace('-', '·'), W * 0.82, th * 0.8);
  stamp(cc, 'rgba(0,0,0,0.3)', l.weight.replace('-', '·'), W * 0.82, th * 0.8);
  stamp(bc, 'rgb(60,60,60)', 'NHPA', W * 0.18, th * 0.8);

  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: tex(col, true),
    roughnessMap: tex(orm, false),
    metalnessMap: tex(orm, false),
    roughness: 1,
    metalness: 1,
    bumpMap: tex(bump, false),
    bumpScale: 1.2,
    clearcoat: fin.clearcoat,
    clearcoatRoughness: 0.25,
    envMap: envMap ?? null,
    envMapIntensity: 1.1,
  });
  matCache.set(key, m);
  return m;
}

export function createShoeMesh(l: Loadout, envMap?: THREE.Texture | null): THREE.Mesh {
  const { geo } = shoeBufferGeometry(l.shape);
  const mesh = new THREE.Mesh(geo, shoeMaterial(l, envMap));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
