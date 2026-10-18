import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { beam, box, catenary, rod } from './venueKit';

/**
 * Furniture and fittings shared by the venues: picnic tables, benches,
 * windows, trash cans, lamp posts and string lights. Each builder returns
 * geometry in its own local frame, split by the material it wants, for
 * the venue to `place` and batch.
 */

/** Turn local geometry `rot` about the vertical and move it to (x, y, z). */
export function place<T extends THREE.BufferGeometry | THREE.BufferGeometry[]>(geo: T, x: number, z: number, rot = 0, y = 0): T {
  for (const g of Array.isArray(geo) ? geo : [geo]) {
    if (rot) g.rotateY(rot);
    g.translate(x, y, z);
  }
  return geo;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Classic picnic table with attached benches: 1.8 m long along x. */
export function picnicTable(): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  const len = 1.8;
  for (let i = 0; i < 5; i++) g.push(box(len, 0.04, 0.135, 0, 0.76, (i - 2) * 0.15));
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) g.push(box(len, 0.04, 0.12, 0, 0.45, s * (0.55 + i * 0.13)));
    // A-frame legs from the bench rail up under the top, splayed out to the bench feet.
    for (const lx of [-0.62, 0.62]) {
      g.push(beam(V(lx + s * 0.02, 0.74, s * 0.28), V(lx, 0.02, s * 0.72), 0.04, 0.09));
      g.push(beam(V(lx, 0.74, -0.32), V(lx, 0.74, 0.32), 0.04, 0.09));
    }
  }
  for (const lx of [-0.62, 0.62]) g.push(box(0.05, 0.09, 1.55, lx, 0.4, 0));
  g.push(beam(V(-0.6, 0.42, 0), V(0, 0.72, 0), 0.04, 0.08), beam(V(0.6, 0.42, 0), V(0, 0.72, 0), 0.04, 0.08));
  return g;
}

/** Park bench (1.8 m along x, facing +z): timber slats on cast-iron ends. */
export function parkBench(): { wood: THREE.BufferGeometry[]; iron: THREE.BufferGeometry[] } {
  const wood: THREE.BufferGeometry[] = [];
  const iron: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) wood.push(box(1.8, 0.035, 0.11, 0, 0.45, 0.12 - i * 0.125));
  for (let i = 0; i < 2; i++) wood.push(box(1.8, 0.1, 0.03, 0, 0, 0).rotateX(-0.22).translate(0, 0.63 + i * 0.15, -0.21 - i * 0.034));
  for (const lx of [-0.78, 0.78]) {
    iron.push(beam(V(lx, 0, 0.2), V(lx, 0.44, 0.12), 0.05, 0.035));
    iron.push(beam(V(lx, 0, -0.2), V(lx, 0.9, -0.26), 0.05, 0.035));
    iron.push(beam(V(lx, 0.43, 0.2), V(lx, 0.43, -0.22), 0.05, 0.03));
    iron.push(beam(V(lx, 0.66, 0.18), V(lx, 0.62, -0.22), 0.045, 0.03));
  }
  return { wood, iron };
}

/**
 * Window on a wall facing +z (local origin at the centre of the opening on
 * the wall face): painted trim, a sill, glazing bars and the glass set just
 * proud of the wall, inside the trim.
 */
export function windowUnit(w: number, h: number, bars = true): { trim: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] } {
  const t = 0.09, d = 0.05;
  const trim = [
    box(w + 2 * t, t, d, 0, h / 2 + t / 2, d / 2),
    box(t, h, d, -w / 2 - t / 2, 0, d / 2),
    box(t, h, d, w / 2 + t / 2, 0, d / 2),
    box(w + 2 * t + 0.08, 0.05, d + 0.06, 0, -h / 2 - 0.025, (d + 0.06) / 2),
  ];
  if (bars) trim.push(box(0.035, h, 0.02, 0, 0, 0.026), box(w, 0.035, 0.02, 0, 0, 0.026));
  return { trim, glass: [box(w, h, 0.01, 0, 0, 0.01)] };
}

/** Green steel litter bin, about 0.9 m tall, with a full liner showing at the top. */
export function trashCan(): THREE.BufferGeometry[] {
  return [
    new THREE.CylinderGeometry(0.29, 0.27, 0.86, 16, 1, true).translate(0, 0.45, 0),
    new THREE.CylinderGeometry(0.275, 0.275, 0.02, 16).translate(0, 0.8, 0),
    new THREE.CylinderGeometry(0.27, 0.27, 0.03, 16).translate(0, 0.035, 0),
    new THREE.TorusGeometry(0.29, 0.02, 6, 16).rotateX(Math.PI / 2).translate(0, 0.88, 0),
    new THREE.TorusGeometry(0.283, 0.012, 4, 16).rotateX(Math.PI / 2).translate(0, 0.3, 0),
    new THREE.TorusGeometry(0.288, 0.012, 4, 16).rotateX(Math.PI / 2).translate(0, 0.6, 0),
  ];
}

/** Black lamp post with a lantern head; `lamp` is the glowing glass. */
export function lampPost(height: number): { metal: THREE.BufferGeometry[]; lamp: THREE.BufferGeometry[]; light: THREE.Vector3 } {
  const metal = [
    new THREE.CylinderGeometry(0.11, 0.14, 0.45, 10).translate(0, 0.225, 0),
    rod(V(0, 0.4, 0), V(0, height, 0), 0.055, 10, 0.045),
    new THREE.CylinderGeometry(0.12, 0.07, 0.12, 10).translate(0, height + 0.06, 0),
    new THREE.ConeGeometry(0.26, 0.24, 10, 1, true).translate(0, height + 0.62, 0),
    new THREE.CylinderGeometry(0.035, 0.035, 0.1, 6).translate(0, height + 0.78, 0),
  ];
  const lamp = [new THREE.CylinderGeometry(0.17, 0.12, 0.38, 10).translate(0, height + 0.31, 0)];
  return { metal, lamp, light: V(0, height + 0.32, 0) };
}

/** Thin wire along a polyline of points (for string lights). */
export function wire(points: THREE.Vector3[], r = 0.006): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i + 1 < points.length; i++) if (points[i].distanceTo(points[i + 1]) > 1e-3) out.push(rod(points[i], points[i + 1], r, 4));
  return out;
}

/**
 * Festoon string lights hung between points: dark wire, a small bulb every
 * `spacing` metres, and at night the bulbs burn bright (blooming on capable
 * devices) with a soft glow sprite each.
 */
export class StringLights {
  readonly object = new THREE.Group();
  private bulbMat = new THREE.MeshBasicMaterial({ color: 0xd9d2c4 });
  private glow: THREE.Points;

  constructor(strands: { a: THREE.Vector3; b: THREE.Vector3; sag: number }[], spacing: number, wireMat: THREE.Material, glowMap: THREE.Texture) {
    const wires: THREE.BufferGeometry[] = [];
    const bulbs: THREE.BufferGeometry[] = [];
    const glowPos: number[] = [];
    for (const { a, b, sag } of strands) {
      const n = Math.max(2, Math.round(a.distanceTo(b) / spacing));
      const pts = catenary(a, b, sag, n);
      wires.push(...wire(pts));
      for (let i = 1; i < n; i++) {
        const p = pts[i];
        bulbs.push(new THREE.CylinderGeometry(0.012, 0.012, 0.04, 5).translate(p.x, p.y - 0.025, p.z));
        bulbs.push(new THREE.IcosahedronGeometry(0.028, 0).scale(1, 1.25, 1).translate(p.x, p.y - 0.07, p.z));
        glowPos.push(p.x, p.y - 0.07, p.z);
      }
    }
    this.object.add(new THREE.Mesh(mergeGeometries(wires.map((g) => g.toNonIndexed()))!, wireMat));
    this.object.add(new THREE.Mesh(mergeGeometries(bulbs.map((g) => (g.index ? g.toNonIndexed() : g)).map(stripUV))!, this.bulbMat));
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
    this.glow = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ map: glowMap, color: 0xffc77a, size: 0.5, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.glow.visible = false;
    this.object.add(this.glow);
  }

  setNight(night: boolean) {
    // Above the bloom threshold at night: the filaments glow on high quality.
    if (night) this.bulbMat.color.setRGB(7, 4.6, 2.2);
    else this.bulbMat.color.set(0xd9d2c4);
    this.glow.visible = night;
  }
}

function stripUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  return g;
}
