import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BOX, FT, HALF_COURT, IN, PIT, STAKE } from '../core/constants';
import { makeStake, stakeZ } from '../physics/physicsWorld';
import type { MapSet } from './textures';
import { flat } from './geo';

/**
 * Regulation court furniture: timber pit frames, pitching platforms,
 * foul lines, leaning steel stakes and backboards. The main court gets
 * full detail; neighbouring courts are merged into a handful of meshes.
 */

export interface CourtMaterials {
  timber: THREE.MeshStandardMaterial;
  platform: THREE.MeshStandardMaterial;
  backboard: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  stake: THREE.MeshStandardMaterial;
  post: THREE.MeshStandardMaterial;
  sandFlat: THREE.MeshStandardMaterial;
}

export function courtMaterials(wood: MapSet, darkWood: MapSet, concrete: MapSet, sand: MapSet): CourtMaterials {
  const clone = (t: THREE.Texture, rx: number, ry: number) => {
    const c = t.clone();
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    return c;
  };
  return {
    timber: new THREE.MeshStandardMaterial({ map: darkWood.map, normalMap: darkWood.normalMap, roughness: 0.85, color: 0x9a8a78 }),
    platform: new THREE.MeshStandardMaterial({ map: clone(wood.map, 1, 2), normalMap: clone(wood.normalMap, 1, 2), roughness: 0.8 }),
    backboard: new THREE.MeshStandardMaterial({ map: clone(darkWood.map, 2, 1), normalMap: clone(darkWood.normalMap, 2, 1), roughness: 0.85, color: 0xb8a58c }),
    concrete: new THREE.MeshStandardMaterial({ map: clone(concrete.map, 1, 3), normalMap: clone(concrete.normalMap, 1, 3), roughness: 0.95, color: 0x9a968c }),
    paint: new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.7 }),
    stake: new THREE.MeshStandardMaterial({ color: 0x4a4c50, metalness: 0.9, roughness: 0.38 }),
    post: new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.9 }),
    sandFlat: new THREE.MeshStandardMaterial({ map: clone(sand.map, 2.2, 3.6), normalMap: clone(sand.normalMap, 2.2, 3.6), roughness: 1, color: 0xf0e6d6 }),
  };
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, uvScale = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (uvScale !== 1) {
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i));
  }
  g.translate(x, y, z);
  return g;
}

/** Stake mesh: steel rod with a battered, polished top. */
export function stakeMesh(end: 0 | 1, mat: THREE.Material): THREE.Mesh {
  const s = makeStake(end);
  const len = STAKE.height / Math.cos(STAKE.lean) + 0.02;
  const g = new THREE.CylinderGeometry(STAKE.radius, STAKE.radius, len, 20, 1);
  // Slightly mushroomed, rounded top from years of hits.
  const top = new THREE.SphereGeometry(STAKE.radius * 1.04, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  top.scale(1, 0.55, 1);
  top.translate(0, len / 2, 0);
  const geo = mergeGeometries([flat(g), flat(top)])!;
  geo.translate(0, len / 2 - 0.02, 0);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(s.base);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.axis);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export interface CourtBuild {
  group: THREE.Group;
  /** Positions (world) where scoreboards / signs can hang. */
  backboardCentres: [THREE.Vector3, THREE.Vector3];
}

/**
 * One full court. If `withPits` is false the pits are drawn as flat raked
 * sand (neighbour courts); the main court's deformable pits are added by the stage.
 */
export function buildCourt(mats: CourtMaterials, x: number, withPits: boolean, detail: boolean): CourtBuild {
  const group = new THREE.Group();
  group.position.x = x;
  const timber: THREE.BufferGeometry[] = [];
  const platform: THREE.BufferGeometry[] = [];
  const backboard: THREE.BufferGeometry[] = [];
  const concrete: THREE.BufferGeometry[] = [];
  const paint: THREE.BufferGeometry[] = [];
  const posts: THREE.BufferGeometry[] = [];
  const sand: THREE.BufferGeometry[] = [];
  const fw = BOX.frameWidth;
  const ft = 0.012;
  const centres: THREE.Vector3[] = [];
  for (const end of [0, 1] as const) {
    const z = stakeZ(end);
    const back = end === 0 ? -1 : 1;
    // Pit frame timbers (top proud of the fill).
    const h = 0.06;
    timber.push(box(PIT.width + 2 * fw, h, fw, 0, ft - h / 2, z - PIT.length / 2 - fw / 2, 3));
    timber.push(box(PIT.width + 2 * fw, h, fw, 0, ft - h / 2, z + PIT.length / 2 + fw / 2, 3));
    timber.push(box(fw, h, PIT.length, -PIT.width / 2 - fw / 2, ft - h / 2, z, 4));
    timber.push(box(fw, h, PIT.length, PIT.width / 2 + fw / 2, ft - h / 2, z, 4));
    // Platforms (6 ft long, either side of the pit).
    const pw = BOX.platformWidth - fw;
    for (const sx of [-1, 1]) {
      platform.push(box(pw, 0.04, BOX.length, sx * (PIT.width / 2 + fw + pw / 2), 0.004 - 0.02, z));
      // Extended 30-ft platform (concrete) out to the 27 ft foul line.
      const front = -back;
      const ext = 10 * FT - (BOX.length / 2 - 3 * FT);
      const zFront = z + front * (BOX.length / 2);
      concrete.push(box(pw, 0.03, ext, sx * (PIT.width / 2 + fw + pw / 2), -0.012, zFront + front * (ext / 2)));
    }
    // Foul lines: 37 ft (front of the box) and 27 ft.
    const z37 = z - back * 3 * FT;
    const z27 = z - back * 13 * FT;
    for (const zl of [z37, z27]) {
      for (const sx of [-1, 1]) paint.push(box(pw, 0.002, 0.05, sx * (PIT.width / 2 + fw + pw / 2), zl === z37 ? 0.0055 : 0.0045, zl));
    }
    // Backboard with posts.
    const bz = z + back * BOX.backboardDistance;
    backboard.push(box(BOX.width, BOX.backboardHeight, 0.05, 0, BOX.backboardHeight / 2 - 0.03, bz, 3));
    for (const sx of [-1, 0, 1]) posts.push(box(0.09, BOX.backboardHeight + 0.15, 0.09, sx * (BOX.width / 2 - 0.05), BOX.backboardHeight / 2 - 0.02, bz + back * 0.07));
    centres.push(new THREE.Vector3(x, BOX.backboardHeight, bz));
    if (!withPits) {
      const g = new THREE.PlaneGeometry(PIT.width, PIT.length);
      g.rotateX(-Math.PI / 2);
      g.translate(0, -0.002, z);
      sand.push(g);
    }
  }
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, cast = true) => {
    if (!geos.length) return;
    const m = new THREE.Mesh(mergeGeometries(geos.map((g) => flat(g)))!, mat);
    m.castShadow = cast && detail;
    m.receiveShadow = true;
    group.add(m);
  };
  add(timber, mats.timber);
  add(platform, mats.platform, false);
  add(backboard, mats.backboard);
  add(concrete, mats.concrete, false);
  add(paint, mats.paint, false);
  add(posts, mats.post);
  add(sand, mats.sandFlat, false);
  group.add(stakeMesh(0, mats.stake), stakeMesh(1, mats.stake));
  return { group, backboardCentres: [centres[0], centres[1]] };
}

export const COURT_SPACING = 12 * FT;
export const COURT_LENGTH = 2 * HALF_COURT;
export const INCH = IN;
