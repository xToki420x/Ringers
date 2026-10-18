import * as THREE from 'three';
import { parkBench, picnicTable, place, StringLights, windowUnit } from './props';
import { Forest, type TreePlacement, type TreeSpecies } from './trees';
import { Batch, beam, blockedBy, box, buildGround, contactShadows, gableRoof, gableShell, mapped, propMaterial, rng, type VenueContext, type VenueScene } from './venueKit';
import { glowTexture, plankMaps, shingleMaps, sidingMaps, slabMaps } from './venueTextures';

/**
 * A back yard: one court on the family lawn behind a sided house with a
 * raised deck, steps and a kettle grill, inside a tall cedar privacy
 * fence, with a garden shed, a picnic table, string lights on posts (lit
 * at night), shade trees and the neighbours' roofs over the fence.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Yard fence lines (x, z pairs); the house closes the far end. */
const FENCE: [number, number, number, number][] = [
  [-12, -17, 12, -17],
  [-12, -17, -12, 24],
  [12, -17, 12, 24],
  [-12, 24, -6.5, 24],
  [6.5, 24, 12, 24],
];

/** The family house: back wall faces the yard at z = 22.5. */
const HOUSE = { x: 0, z: 27, len: 13, depth: 9, wall: 3.3, ridge: 5.7, floor: 0.72 };
const DECK = { x0: -5, x1: 3, z0: 18.3, z1: 22.5 };
const SHED = { x: -9, z: -13.2 };
const TABLE = { x: 7.6, z: -1, rot: Math.PI / 2 + 0.12 };

export function buildBackyard(ctx: VenueContext): VenueScene {
  const { q } = ctx;
  const group = new THREE.Group();
  const grass = buildGround(ctx, 'backyard', group, {
    blocked: blockedBy([[TABLE.x - 1.1, TABLE.z - 2.0, TABLE.x + 1.1, TABLE.z + 2.0]]),
  });

  const m = {
    siding: mapped(sidingMaps(q), { color: 0xaebdc4, roughness: 0.7, normal: 0.8 }),
    neighbourA: mapped(sidingMaps(q), { color: 0xe3dccb, roughness: 0.75, normal: 0.8 }),
    neighbourB: mapped(sidingMaps(q), { color: 0x9aa58c, roughness: 0.75, normal: 0.8 }),
    trim: propMaterial({ color: 0xf1efe8, roughness: 0.55 }),
    shutter: propMaterial({ color: 0x2c3b33, roughness: 0.5 }),
    glass: propMaterial({ color: 0x18222a, roughness: 0.05, metalness: 0.2, envMapIntensity: 1.5 }),
    roof: mapped(shingleMaps(q), { color: 0x6e655e, roughness: 0.9, normal: 1.2 }),
    roofB: mapped(shingleMaps(q), { color: 0x4b4f55, roughness: 0.9, normal: 1.2 }),
    concrete: mapped(slabMaps(q), { color: 0xb1aca2, roughness: 0.95 }),
    deck: mapped(plankMaps(q, 7), { color: 0xb39b87, roughness: 0.8 }),
    fence: mapped(plankMaps(q, 7), { color: 0xcdb7a4, roughness: 0.88 }),
    shed: mapped(plankMaps(q, 5), { color: 0xae5454, roughness: 0.8 }),
    enamel: propMaterial({ color: 0x141619, roughness: 0.32, metalness: 0.25 }),
    steel: propMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.85 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xd8d0bf }),
  };
  const b = new Batch();

  house(b, m);
  deck(b, m);
  fence(b, m);
  shed(b, m);
  neighbours(b, m);
  b.add(m.deck, place(picnicTable(), TABLE.x, TABLE.z, TABLE.rot), 1);
  // Two garden chairs at the end of the table.
  for (const [dx, dz, r] of [[0.2, -1.55, 0.25], [-0.3, 1.5, Math.PI - 0.2]] as const) {
    const chair = parkBench();
    for (const g of [...chair.wood, ...chair.iron]) g.scale(0.32, 1, 1);
    b.add(m.deck, place(chair.wood, TABLE.x + dx, TABLE.z + dz, r), 1);
    b.add(m.enamel, place(chair.iron, TABLE.x + dx, TABLE.z + dz, r));
  }
  b.build(group);

  // Porch light beside the patio door.
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.2, 8).translate(-2.45, 2.3, HOUSE.z - HOUSE.depth / 2 - 0.1), m.lamp));

  // String lights from the eaves to posts down both sides of the yard, and across it.
  const lights = new StringLights(
    [
      { a: V(-6.2, 2.95, 22.05), b: V(-9.2, 3.05, 10), sag: 0.3 },
      { a: V(6.2, 2.95, 22.05), b: V(9.2, 3.05, 10), sag: 0.3 },
      { a: V(-9.2, 3.05, 10), b: V(9.2, 3.05, 10), sag: 0.5 },
      { a: V(-9.2, 3.05, 10), b: V(-9.2, 3.05, -10), sag: 0.45 },
      { a: V(9.2, 3.05, 10), b: V(9.2, 3.05, -10), sag: 0.45 },
      { a: V(-9.2, 3.05, -10), b: V(9.2, 3.05, -10), sag: 0.5 },
    ],
    q === 'low' ? 0.7 : 0.45,
    m.enamel,
    glowTexture(),
  );
  group.add(lights.object);
  const posts = new Batch();
  for (const [x, z] of [[-9.2, 10], [9.2, 10], [-9.2, -10], [9.2, -10]]) posts.add(m.fence, box(0.1, 3.15, 0.1, x, 1.575, z), 1, true);
  posts.build(group);

  const forest = new Forest(trees(q), q);
  group.add(forest.object);

  contactShadows(group, [
    [HOUSE.x, HOUSE.z, HOUSE.len + 1.6, HOUSE.depth + 1.6, 0, 0.6],
    [(DECK.x0 + DECK.x1) / 2, (DECK.z0 + DECK.z1) / 2 - 0.3, DECK.x1 - DECK.x0 + 1, DECK.z1 - DECK.z0 + 1.2, 0, 0.5],
    [SHED.x, SHED.z, 3.8, 3.4, 0, 0.55],
    [TABLE.x, TABLE.z, 2.2, 2.4, TABLE.rot, 0.45],
    [TABLE.x + 0.2, TABLE.z - 1.55, 0.9, 0.8, 0.25, 0.35],
    [TABLE.x - 0.3, TABLE.z + 1.5, 0.9, 0.8, -0.2, 0.35],
    [0, -17, 24.5, 0.7, 0, 0.35],
    [-12, 3.5, 0.7, 41.5, 0, 0.35],
    [12, 3.5, 0.7, 41.5, 0, 0.35],
  ]);

  return {
    group,
    scoreboards: [],
    crowd: null,
    setLighting({ night }) {
      lights.setNight(night);
      m.glass.emissive.set(night ? 0xffb35c : 0x000000);
      m.glass.emissiveIntensity = night ? 0.9 : 0;
      if (night) m.lamp.color.setRGB(6, 4.4, 2.4);
      else m.lamp.color.set(0xd8d0bf);
    },
    update(_dt, time) {
      grass.update(time);
      forest.update(time);
    },
  };
}

type Mats = Record<'siding' | 'neighbourA' | 'neighbourB' | 'trim' | 'shutter' | 'glass' | 'roof' | 'roofB' | 'concrete' | 'deck' | 'fence' | 'shed' | 'enamel' | 'steel', THREE.MeshStandardMaterial>;

/** Sided single-storey house with trim, gutters, shuttered windows and a sliding patio door. */
function house(b: Batch, m: Mats) {
  const { x, z, len, depth, wall, ridge, floor } = HOUSE;
  const back = z - depth / 2;
  b.add(m.siding, gableShell(depth, len, wall, ridge, x, z), 1.4);
  b.add(m.concrete, box(len + 0.06, 0.6, depth + 0.06, x, 0.3, z), 2);
  b.add(m.roof, gableRoof(depth, len, wall, ridge, x, z, { eave: 0.45, rake: 0.35, t: 0.12 }), 1.1, true);
  for (const s of [-1, 1]) {
    // Fascia and gutter along each eave, corner boards, a downspout.
    b.add(m.trim, box(len + 0.72, 0.2, 0.05, x, 3.0, z + s * (depth / 2 + 0.47)));
    b.add(m.trim, box(len + 0.72, 0.1, 0.12, x, 2.93, z + s * (depth / 2 + 0.55)));
    for (const sz of [-1, 1]) b.add(m.trim, box(0.12, wall - 0.6, 0.12, x + s * len / 2, 0.6 + (wall - 0.6) / 2, z + sz * depth / 2));
    b.add(m.trim, box(0.08, 2.4, 0.08, x + s * (len / 2 - 0.25), 1.6, back - 0.62));
  }
  const win = (wx: number, wy: number, w: number, h: number, face: number, at: number, shutters = true) => {
    const u = windowUnit(w, h);
    const rot = face === 0 ? Math.PI : face > 0 ? Math.PI / 2 : -Math.PI / 2;
    const px = face === 0 ? wx : at, pz = face === 0 ? at : wx;
    b.add(m.trim, place(u.trim, px, pz, rot, wy));
    b.add(m.glass, place(u.glass, px, pz, rot, wy));
    if (shutters)
      for (const s of [-1, 1]) b.add(m.shutter, place([box(0.42, h + 0.1, 0.03, s * (w / 2 + 0.33), 0, 0.03)], px, pz, rot, wy), 1);
  };
  win(-4.6, 1.95, 1.1, 1.35, 0, back);
  win(4.4, 1.95, 1.1, 1.35, 0, back);
  win(2.0, 2.15, 0.8, 0.9, 0, back, false);
  win(z - 1.5, 1.95, 1.1, 1.35, 1, x + len / 2);
  win(z + 1.5, 1.95, 1.1, 1.35, -1, x - len / 2);
  // Sliding patio door onto the deck.
  const door = windowUnit(1.8, 2.05, false);
  door.trim.push(box(0.06, 2.05, 0.03, 0, 0, -0.01));
  b.add(m.trim, place(door.trim, -1.0, back, Math.PI, floor + 1.06));
  b.add(m.glass, place(door.glass, -1.0, back, Math.PI, floor + 1.06));
}

/** Raised timber deck across the back of the house, with railings, skirting, steps and a kettle grill. */
function deck(b: Batch, m: Mats) {
  const { x0, x1, z0, z1 } = DECK;
  const top = HOUSE.floor;
  const cx = (x0 + x1) / 2, w = x1 - x0, d = z1 - z0;
  b.add(m.deck, box(w, 0.04, d, cx, top - 0.02, (z0 + z1) / 2), 1);
  b.add(m.deck, [box(w + 0.05, 0.62, 0.04, cx, top - 0.33, z0), box(0.04, 0.62, d, x0, top - 0.33, (z0 + z1) / 2), box(0.04, 0.62, d, x1, top - 0.33, (z0 + z1) / 2)], 1, true);
  const stepX = -1.0, stepW = 1.8;
  // Railing: posts, top and bottom rails and balusters, leaving the stair opening.
  const rail = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 1.6));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.add(m.trim, box(0.1, 1.0, 0.1, ax + (bx - ax) * t, top + 0.45, az + (bz - az) * t));
    }
    b.add(m.trim, beam(V(ax, top + 0.93, az), V(bx, top + 0.93, bz), 0.14, 0.05));
    b.add(m.trim, beam(V(ax, top + 0.1, az), V(bx, top + 0.1, bz), 0.08, 0.05));
    const k = Math.floor(len / 0.13);
    for (let i = 1; i < k; i++) {
      const t = i / k;
      b.add(m.trim, box(0.035, 0.78, 0.035, ax + (bx - ax) * t, top + 0.51, az + (bz - az) * t));
    }
  };
  rail(x0, z1 - 0.05, x0, z0);
  rail(x0, z0, stepX - stepW / 2, z0);
  rail(stepX + stepW / 2, z0, x1, z0);
  rail(x1, z0, x1, z1 - 0.05);
  // Three steps down to a small concrete pad.
  for (let k = 1; k <= 3; k++) {
    const y = top - k * 0.18, zz = z0 - k * 0.28;
    b.add(m.deck, box(stepW, 0.04, 0.3, stepX, y, zz + 0.13), 1);
    b.add(m.deck, box(stepW, 0.16, 0.03, stepX, y - 0.1, zz), 1, true);
  }
  for (const s of [-1, 1]) b.add(m.deck, beam(V(stepX + s * stepW / 2, top - 0.05, z0), V(stepX + s * stepW / 2, 0.05, z0 - 0.9), 0.05, 0.24));
  b.add(m.concrete, box(2.4, 0.06, 1.1, stepX, 0.0, z0 - 1.35), 2);
  // Kettle grill.
  const gx = 1.7, gz = DECK.z0 + 1.1, gy = top + 0.74;
  b.add(m.enamel, new THREE.SphereGeometry(0.29, 18, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(gx, gy, gz));
  b.add(m.enamel, new THREE.SphereGeometry(0.295, 18, 7, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(1, 0.8, 1).translate(gx, gy - 0.02, gz));
  b.add(m.steel, new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8).translate(gx, gy + 0.23, gz));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.add(m.steel, beam(V(gx + Math.cos(a) * 0.2, gy - 0.18, gz + Math.sin(a) * 0.2), V(gx + Math.cos(a) * 0.3, top, gz + Math.sin(a) * 0.3), 0.025, 0.025));
  }
  b.add(m.steel, new THREE.TorusGeometry(0.2, 0.01, 4, 16).rotateX(Math.PI / 2).translate(gx, top + 0.28, gz));
}

/** Cedar privacy fence: board panels, posts, two rails on the yard side and a cap. */
function fence(b: Batch, m: Mats) {
  const H = 1.82;
  for (const [ax, az, bx, bz] of FENCE) {
    const len = Math.hypot(bx - ax, bz - az);
    const along = Math.atan2(bz - az, bx - ax);
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    // Yard side is toward the court (the origin).
    const nx = -Math.sin(along), nz = Math.cos(along);
    const inward = nx * -cx + nz * -cz > 0 ? 1 : -1;
    const ix = nx * inward, iz = nz * inward;
    b.add(m.fence, box(len, H, 0.025, cx, 0.02 + H / 2, cz, -along), 1, true);
    b.add(m.fence, box(len + 0.08, 0.035, 0.14, cx, H + 0.035, cz, -along), 1);
    for (const y of [0.32, H - 0.3]) b.add(m.fence, box(len, 0.09, 0.04, cx + ix * 0.035, y, cz + iz * 0.035, -along), 1);
    const n = Math.round(len / 2.4);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.add(m.fence, box(0.1, H + 0.12, 0.1, ax + (bx - ax) * t + ix * 0.06, (H + 0.12) / 2, az + (bz - az) * t + iz * 0.06, -along), 1, true);
    }
  }
}

/** Barn-red garden shed with double doors facing the court. */
function shed(b: Batch, m: Mats) {
  const { x, z } = SHED;
  const w = 2.6, len = 3.0, h = 2.1, ridge = 2.85;
  b.add(m.shed, gableShell(w, len, h, ridge, x, z), 1, true);
  b.add(m.roofB, gableRoof(w, len, h, ridge, x, z, { eave: 0.25, rake: 0.2, t: 0.08 }), 1.1, true);
  b.add(m.concrete, box(len + 0.3, 0.12, w + 0.3, x, 0.04, z), 2);
  const fx = x + len / 2;
  // Doors on the gable end: panels, white frame and Z braces.
  for (const s of [-1, 1]) {
    b.add(m.shed, box(0.04, 1.8, 0.62, fx + 0.02, 1.0, z + s * 0.32), 1, true);
    b.add(m.trim, beam(V(fx + 0.05, 0.2, z + s * 0.05), V(fx + 0.05, 1.8, z + s * 0.6), 0.04, 0.09));
  }
  b.add(m.trim, [box(0.06, 1.95, 0.1, fx + 0.04, 1.0, z - 0.68), box(0.06, 1.95, 0.1, fx + 0.04, 1.0, z + 0.68), box(0.06, 0.1, 1.46, fx + 0.04, 1.95, z)]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(m.trim, box(0.1, h, 0.1, x + sx * len / 2, h / 2, z + sz * w / 2));
  const u = windowUnit(0.6, 0.5);
  b.add(m.trim, place(u.trim, x, z + w / 2, 0, 1.45));
  b.add(m.glass, place(u.glass, x, z + w / 2, 0, 1.45));
}

/** Neighbouring houses beyond the fence: only their upper walls and roofs show. */
function neighbours(b: Batch, m: Mats) {
  const homes: [number, number, number, number, number, number, 'neighbourA' | 'neighbourB' | 'siding'][] = [
    // x, z, length, depth, wall height, rotation, siding
    [-17, -29, 12, 9, 5.6, 0, 'neighbourA'],
    [1, -30, 11, 8, 3.2, 0, 'neighbourB'],
    [18, -28, 12, 9, 5.6, 0, 'siding'],
    [-27, -4, 11, 8, 3.2, Math.PI / 2, 'neighbourB'],
    [-26, 15, 12, 9, 5.6, Math.PI / 2, 'neighbourA'],
    [27, 2, 12, 9, 3.2, Math.PI / 2, 'neighbourA'],
    [26, 20, 11, 8, 5.6, Math.PI / 2, 'neighbourB'],
  ];
  homes.forEach(([x, z, len, depth, wall, rot, siding], i) => {
    const ridge = wall + depth * 0.27;
    b.add(m[siding], gableShell(depth, len, wall, ridge, x, z, rot), 1.4);
    b.add(i % 2 ? m.roof : m.roofB, gableRoof(depth, len, wall, ridge, x, z, { eave: 0.4, rake: 0.3, t: 0.12, rotY: rot }), 1.1, true);
    // A row of upstairs (or high) windows on the side facing the yard.
    const toward = rot ? (x > 0 ? -1 : 1) : 1;
    for (let k = -1; k <= 1; k++) {
      const u = windowUnit(1.0, 1.2);
      const wy = wall - 1.2;
      if (rot) {
        b.add(m.trim, place(u.trim, x + toward * depth / 2, z + k * 3.4, toward * Math.PI / 2, wy));
        b.add(m.glass, place(u.glass, x + toward * depth / 2, z + k * 3.4, toward * Math.PI / 2, wy));
      } else {
        b.add(m.trim, place(u.trim, x + k * 3.4, z + depth / 2, 0, wy));
        b.add(m.glass, place(u.glass, x + k * 3.4, z + depth / 2, 0, wy));
      }
    }
  });
}

/** A maple and a birch clump in the yard, and the neighbourhood's trees beyond the fence. */
function trees(q: VenueContext['q']): TreePlacement[] {
  const out: TreePlacement[] = [
    { x: -9.4, z: 4, scale: 1.05, rot: 0.4, species: 'maple', seed: 3 },
    { x: 9.7, z: -12.6, scale: 0.8, rot: 1.1, species: 'birch', seed: 11 },
    { x: 10.6, z: -14.2, scale: 0.7, rot: 2.3, species: 'birch', seed: 12 },
    { x: 8.9, z: -14.6, scale: 0.62, rot: 4.0, species: 'birch', seed: 13 },
  ];
  const r = rng(41);
  const count = q === 'low' ? 18 : 40;
  const species: TreeSpecies[] = ['oak', 'maple', 'maple', 'oak', 'birch'];
  let guard = 0;
  while (out.length < count && guard++ < 2000) {
    const a = r() * Math.PI * 2, d = 21 + r() * 36;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    // Keep clear of the yard, the house and the neighbours' houses.
    if (Math.abs(x) < 15 && z < 24 && z > -20) continue;
    if (Math.abs(x) < 9 && z > 20) continue;
    if (Math.abs(z + 29) < 6 && Math.abs(x) < 25) continue;
    if (Math.abs(Math.abs(x) - 26.5) < 6 && Math.abs(z - 8) < 18) continue;
    out.push({ x, z, scale: 0.9 + r() * 0.7, rot: r() * Math.PI * 2, species: species[Math.floor(r() * species.length)], seed: 100 + out.length });
  }
  return out;
}
