import * as THREE from 'three';
import { BOX, PIT } from '../core/constants';
import { fbm, type MapSet } from './textures';
import { SAND_TILE } from './sandTextures';

/**
 * A dusting of fill kicked up onto the frame boards: strips along the top of
 * each board, thickest at the pit edge and thinning out in patches. The
 * coverage is a per-vertex alpha drawn with hashed transparency, so it
 * breaks up into scattered grains with no sorting or blending cost.
 */

/** Top of the timber frame (see court.ts), with a hair of clearance. */
const BOARD_TOP = 0.0125;
/** Vertex spacing along the boards (m). */
const STEP = 0.01;

const materials = new WeakMap<MapSet, THREE.MeshStandardMaterial>();

function dustMaterial(maps: MapSet): THREE.MeshStandardMaterial {
  let m = materials.get(maps);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: maps.map, roughness: 1, metalness: 0, vertexColors: true, alphaHash: true });
    materials.set(maps, m);
  }
  return m;
}

/** The dusting round one pit (centred on the stake at `centerZ`). */
export function spillDusting(maps: MapSet, kind: 'sand' | 'clay', centerZ: number, seed: number): THREE.Mesh {
  const hw = PIT.width / 2, hl = PIT.length / 2, fw = BOX.frameWidth;
  const tile = SAND_TILE[kind];
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  // Each board: a start corner, a unit direction along it, an outward normal and a length.
  const boards: [number, number, number, number, number, number, number][] = [
    [-hw - fw, -hl, 1, 0, 0, -1, PIT.width + 2 * fw],
    [-hw - fw, hl, 1, 0, 0, 1, PIT.width + 2 * fw],
    [-hw, -hl, 0, 1, -1, 0, PIT.length],
    [hw, -hl, 0, 1, 1, 0, PIT.length],
  ];
  const across = [0, 0.3, 1];
  for (const [x0, z0, dx, dz, ox, oz, len] of boards) {
    const n = Math.max(2, Math.round(len / STEP) + 1);
    const base = pos.length / 3;
    for (let s = 0; s < n; s++) {
      const t = (s / (n - 1)) * len;
      // Patchy along the board, heavier where pitchers step past the sides.
      const patch = Math.max(0, fbm(t * 8 + seed, ox + oz * 3 + seed, 1024, 3, seed) * 1.6 - 0.45);
      for (let a = 0; a < across.length; a++) {
        const x = x0 + dx * t + ox * across[a] * fw;
        const z = centerZ + z0 + dz * t + oz * across[a] * fw;
        pos.push(x, BOARD_TOP, z);
        uv.push((x + hw) / tile, (z - centerZ + hl) / tile);
        // A little darker than the pit: loose grains, shadowed between them.
        col.push(0.6, 0.6, 0.6, Math.min(0.55, patch * (1 - across[a]) ** 2));
      }
      if (s > 0)
        for (let a = 0; a < across.length - 1; a++) {
          const p = base + (s - 1) * across.length + a;
          const q = p + across.length;
          // Wound to face up whichever way the board runs.
          if (dx * oz - dz * ox < 0) idx.push(p, q, p + 1, p + 1, q, q + 1);
          else idx.push(p, p + 1, q, p + 1, q + 1, q);
        }
    }
  }
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, dustMaterial(maps));
  mesh.receiveShadow = true;
  mesh.name = 'pit-spill';
  return mesh;
}
