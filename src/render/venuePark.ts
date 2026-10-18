import * as THREE from 'three';
import { lampPost, parkBench, picnicTable, place, trashCan } from './props';
import { Forest, type TreePlacement } from './trees';
import { Batch, beam, box, buildGround, contactShadows, gableRoof, mapped, propMaterial, ribbon, rng, rod, type VenueContext, type VenueScene } from './venueKit';
import { Crowd, type Seat } from './venueStands';
import { chainLinkAlpha, edgeFade, facadeMaps, glowTexture, gravelMaps, plankMaps, shingleMaps, slabMaps } from './venueTextures';

/**
 * A city park: three public courts on a mown park lawn under big oaks and
 * maples, benches with a few locals watching, gravel paths, a picnic
 * shelter with tables, trash cans, park lamps (lit at night), a ball-field
 * backstop and the city skyline far beyond the trees.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Gravel paths (x, z polylines). */
const PATHS: [number, number][][] = [
  [[-60, -15], [-30, -14.5], [-10.5, -14], [10, -14.5], [30, -16], [60, -18]],
  [[-10.5, -14], [-10.6, 0], [-10.5, 14], [-13, 30], [-18, 60]],
  [[-10.5, 14], [8, 14.5], [30, 13], [60, 10]],
  [[-10.6, -3], [-15.6, -3]],
];
/** Picnic shelter: centre, footprint (x by z). */
const SHELTER = { x: -19, z: -3, w: 7, d: 10 };
/** Bench spots beside the courts: x, z, facing (toward the courts). */
const BENCHES: [number, number, number][] = [
  [-8.3, -4.5, Math.PI / 2], [-8.3, 0.4, Math.PI / 2], [-8.3, 5.3, Math.PI / 2],
  [8.3, -4.5, -Math.PI / 2], [8.3, 0.4, -Math.PI / 2], [8.3, 5.3, -Math.PI / 2],
];
const LAMPS: [number, number][] = [[-11.8, -13], [-11.8, 1], [-11.8, 13], [9, -15.6], [9, 15.8], [26, -16.8], [26, 14.6]];

/** Distance from (x, z) to the nearest path centreline. */
function pathDistance(x: number, z: number): number {
  let best = Infinity;
  for (const path of PATHS)
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
  return best;
}

export function buildPark(ctx: VenueContext): VenueScene {
  const { q } = ctx;
  const group = new THREE.Group();
  const grass = buildGround(ctx, 'park', group, {
    blocked: (x, z) => pathDistance(x, z) < 1.1 || BENCHES.some(([bx, bz]) => Math.abs(x - bx) < 0.7 && Math.abs(z - bz) < 1.2),
  });

  const m = {
    wood: mapped(plankMaps(q, 5), { color: 0xa79583, roughness: 0.8 }),
    timber: mapped(plankMaps(q, 2), { color: 0x8f7b6d, roughness: 0.85 }),
    ceiling: mapped(plankMaps(q, 7), { color: 0xc8bbab, roughness: 0.85 }),
    iron: propMaterial({ color: 0x1d2420, roughness: 0.45, metalness: 0.5 }),
    green: propMaterial({ color: 0x2f5a3a, roughness: 0.5, metalness: 0.4 }),
    roof: mapped(shingleMaps(q), { color: 0x7a3f2e, roughness: 0.9, normal: 1.2 }),
    concrete: mapped(slabMaps(q), { color: 0xb5b0a6, roughness: 0.95 }),
    galv: propMaterial({ color: 0xa7adb2, roughness: 0.45, metalness: 0.8 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xe9e4d8 }),
  };
  const b = new Batch();

  // Benches beside the courts, a trash can at the end of each row.
  for (const [x, z, rot] of BENCHES) {
    const bench = parkBench();
    b.add(m.wood, place(bench.wood, x, z, rot), 1);
    b.add(m.iron, place(bench.iron, x, z, rot));
  }
  for (const [x, z] of [[-8.4, -7.4], [8.4, 8.2], [-11.8, 15.2], [11.5, -15.6]]) b.add(m.green, place(trashCan(), x, z));
  shelter(b, m);
  backstop(b, m);
  const lampGlass: THREE.BufferGeometry[] = [];
  const glowAt: THREE.Vector3[] = [];
  for (const [x, z] of LAMPS) {
    const lp = lampPost(3.6);
    b.add(m.iron, place(lp.metal, x, z));
    lampGlass.push(...place(lp.lamp, x, z));
    glowAt.push(lp.light.add(V(x, 0, z)));
  }
  b.add(m.lamp, lampGlass);
  b.build(group);

  // Gravel paths with feathered edges.
  const gravel = gravelMaps(q);
  const pathMat = new THREE.MeshStandardMaterial({ map: gravel.map, normalMap: gravel.normalMap, color: 0xa39a8c, roughness: 1, alphaMap: edgeFade(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  pathMat.map!.repeat.set(0.5, 1);
  for (const path of PATHS) {
    const mesh = new THREE.Mesh(ribbon(path, 2.2), pathMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // A few locals on the benches.
  const r = rng(5);
  const seats: Seat[] = [];
  BENCHES.forEach(([x, z, rot], i) => {
    if (i === 1 || i === 5) return;
    const n = 1 + Math.floor(r() * 2.6);
    for (let k = 0; k < n; k++) {
      const along = (k - (n - 1) / 2) * 0.62 + (r() - 0.5) * 0.12;
      seats.push({ x: x + Math.cos(rot) * along, y: 0.47, z: z - Math.sin(rot) * along, facing: rot, stand: x > 0 ? 1 : 0 });
    }
  });
  const crowd = new Crowd(group, seats, ctx.crowdBody);

  const glows = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(glowAt),
    new THREE.PointsMaterial({ map: glowTexture(), color: 0xffd9a0, size: 1.6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glows.visible = false;
  group.add(glows);

  const city = skyline(group, q);
  const forest = new Forest(trees(q), q);
  group.add(forest.object);

  contactShadows(group, [
    [SHELTER.x, SHELTER.z, SHELTER.w + 2, SHELTER.d + 2, 0, 0.55],
    ...BENCHES.map(([x, z, rot]): [number, number, number, number, number, number] => [x, z, 2.1, 0.9, rot, 0.4]),
  ]);

  return {
    group,
    scoreboards: [],
    crowd,
    setLighting({ night }) {
      glows.visible = night;
      if (night) m.lamp.color.setRGB(6, 5, 3.4);
      else m.lamp.color.set(0xe9e4d8);
      city.emissiveIntensity = night ? 1.6 : 0;
    },
    update(dt, time) {
      crowd.update(dt, time);
      grass.update(time);
      forest.update(time);
    },
  };
}

type Mats = Record<'wood' | 'timber' | 'ceiling' | 'iron' | 'green' | 'roof' | 'concrete' | 'galv', THREE.MeshStandardMaterial>;

/** Open-sided picnic shelter: slab, timber posts and beams, a boarded ceiling under a shingle roof, and tables. */
function shelter(b: Batch, m: Mats) {
  const { x, z, w, d } = SHELTER;
  const eave = 2.75, ridge = 4.5;
  b.add(m.concrete, box(w + 0.6, 0.12, d + 0.6, x, 0.05, z), 2);
  for (const sx of [-1, 1])
    for (const k of [-1, 0, 1]) b.add(m.timber, box(0.2, eave, 0.2, x + sx * (w / 2 - 0.15), eave / 2 + 0.1, z + k * (d / 2 - 0.15)), 1, true);
  for (const sx of [-1, 1]) b.add(m.timber, box(0.18, 0.3, d, x + sx * (w / 2 - 0.15), eave + 0.1, z), 1);
  for (const k of [-1, 0, 1]) b.add(m.timber, box(w, 0.22, 0.14, x, eave + 0.05, z + k * (d / 2 - 0.15)), 1);
  // Roof (ridge along z) and the boarded ceiling just beneath it.
  const rot = Math.PI / 2;
  b.add(m.roof, gableRoof(w, d, eave + 0.25, ridge, x, z, { eave: 0.7, rake: 0.6, t: 0.12, rotY: rot }), 1.1);
  const under = gableRoof(w, d, eave + 0.12, ridge - 0.13, x, z, { eave: 0.66, rake: 0.56, t: 0.02, rotY: rot });
  b.add(m.ceiling, under.slice(0, 2), 1, true);
  for (const k of [-1, 0, 1]) b.add(m.timber, [beam(V(x - w / 2, eave + 0.2, z + k * (d / 2 - 0.15)), V(x, ridge - 0.12, z + k * (d / 2 - 0.15)), 0.14, 0.18), beam(V(x + w / 2, eave + 0.2, z + k * (d / 2 - 0.15)), V(x, ridge - 0.12, z + k * (d / 2 - 0.15)), 0.14, 0.18)], 1);
  for (const k of [-1, 0, 1]) b.add(m.wood, place(picnicTable(), x + (k === 0 ? 0.5 : -0.4), z + k * 3, Math.PI / 2 + k * 0.05, 0.11), 1);
}

/** Ball-field backstop beyond the far trees: galvanised posts, chain-link panels and a dirt apron. */
function backstop(b: Batch, m: Mats) {
  const cx = 34, cz = 34, face = Math.PI * 0.25;
  const mesh: THREE.BufferGeometry[] = [];
  for (let i = -2; i <= 2; i++) {
    const a0 = face + i * 0.32 - 0.16, a1 = a0 + 0.32;
    const p0 = V(cx + Math.sin(a0) * 6, 0, cz + Math.cos(a0) * 6), p1 = V(cx + Math.sin(a1) * 6, 0, cz + Math.cos(a1) * 6);
    b.add(m.galv, rod(p0, p0.clone().setY(4.2), 0.05, 8));
    b.add(m.galv, rod(p0.clone().setY(4.15), p1.clone().setY(4.15), 0.03, 6));
    if (i === 2) b.add(m.galv, rod(p1, p1.clone().setY(4.2), 0.05, 8));
    const panel = new THREE.PlaneGeometry(p0.distanceTo(p1), 4.1);
    panel.rotateY(Math.atan2(-(p1.z - p0.z), p1.x - p0.x)).translate((p0.x + p1.x) / 2, 2.07, (p0.z + p1.z) / 2);
    const uv = panel.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * p0.distanceTo(p1) / 0.06, uv.getY(k) * 4.1 / 0.06);
    mesh.push(panel);
  }
  const link = new THREE.MeshStandardMaterial({ color: 0xb4b9bd, metalness: 0.7, roughness: 0.45, alphaMap: chainLinkAlpha(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
  b.add(link, mesh);
  const dirt = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 1, alphaMap: edgeFade(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  b.add(dirt, ribbon([[cx - 7, cz + 3], [cx - 2, cz - 3], [cx + 4, cz - 6]], 7, 0.01));
}

/** City towers on the horizon (windows light up at night); returns their material. */
function skyline(group: THREE.Group, q: VenueContext['q']): THREE.MeshStandardMaterial {
  const f = facadeMaps();
  const mat = new THREE.MeshStandardMaterial({ map: f.map, color: 0x6c737c, emissiveMap: f.lit, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6, metalness: 0.2 });
  const r = rng(77);
  const geos: THREE.BufferGeometry[] = [];
  const count = q === 'low' ? 10 : 22;
  for (let i = 0; i < count; i++) {
    const a = 0.35 + (i / count) * 1.9 + (r() - 0.5) * 0.08;
    const d = 185 + r() * 60;
    const w = 14 + r() * 18, h = 30 + r() * r() * 80;
    const g = new THREE.BoxGeometry(w, h, w * (0.7 + r() * 0.5));
    const uv = g.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * w / 24, uv.getY(k) * h / 48);
    geos.push(g.rotateY(r() * Math.PI).translate(Math.sin(a) * d, h / 2 - 2, Math.cos(a) * d));
  }
  const b = new Batch();
  b.add(mat, geos);
  b.build(group);
  return mat;
}

/** Big shade oaks and maples around the courts, then the park's trees out to the skyline. */
function trees(q: VenueContext['q']): TreePlacement[] {
  const out: TreePlacement[] = [
    { x: -14.5, z: 10, scale: 1.75, rot: 0.3, species: 'oak', seed: 1 },
    { x: 14, z: -6.5, scale: 1.6, rot: 2.0, species: 'maple', seed: 2 },
    { x: 14.5, z: 7.5, scale: 1.8, rot: 4.1, species: 'oak', seed: 4 },
    { x: -14, z: -16.5, scale: 1.5, rot: 1.2, species: 'maple', seed: 5 },
    { x: 8.5, z: -21, scale: 1.45, rot: 5.2, species: 'oak', seed: 6 },
    { x: -7.5, z: 21.5, scale: 1.55, rot: 0.8, species: 'maple', seed: 7 },
  ];
  const r = rng(19);
  const count = q === 'low' ? 34 : 80;
  let guard = 0;
  while (out.length < count && guard++ < 4000) {
    const a = r() * Math.PI * 2, d = 18 + r() * 62;
    const x = Math.cos(a) * d * 1.1, z = Math.sin(a) * d;
    if (Math.abs(x) < 13 && Math.abs(z) < 18) continue;
    if (pathDistance(x, z) < 2.5) continue;
    if (Math.abs(x - SHELTER.x) < 7 && Math.abs(z - SHELTER.z) < 8) continue;
    if (Math.hypot(x - 34, z - 34) < 16) continue;
    out.push({ x, z, scale: 1.1 + r() * 0.8, rot: r() * Math.PI * 2, species: r() < 0.55 ? 'oak' : 'maple', seed: 50 + out.length });
  }
  return out;
}
