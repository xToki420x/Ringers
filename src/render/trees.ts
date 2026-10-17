import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flat } from './geo';
import type { Quality } from './textures';

/**
 * Trees around the grounds. Venues decide where trees stand and which
 * species; this module builds them (instanced, so hundreds are cheap).
 */

export type TreeSpecies = 'oak' | 'maple' | 'birch' | 'pine';

export interface TreePlacement {
  x: number;
  z: number;
  /** Overall size multiplier (1 ≈ an 8 m tree). */
  scale: number;
  /** Rotation about the vertical, radians. */
  rot: number;
  species: TreeSpecies;
  /** Per-tree random seed (shape and colour variation). */
  seed?: number;
}

function rand(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Forest {
  readonly object = new THREE.Group();

  constructor(placements: TreePlacement[], q: Quality) {
    const leafTex = leafClusterTexture();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Trunk with a few limbs.
    const wood: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.13, 0.26, 3.6, 10, 4);
    trunk.translate(0, 1.8, 0);
    wood.push(trunk);
    for (let i = 0; i < 4; i++) {
      const limb = new THREE.CylinderGeometry(0.04, 0.09, 1.7, 7);
      limb.translate(0, 0.85, 0);
      limb.rotateZ(0.7 + rnd() * 0.3);
      limb.rotateY((i / 4) * Math.PI * 2 + rnd());
      limb.translate(0, 2.4 + rnd() * 0.9, 0);
      wood.push(limb);
    }
    const trunkGeo = mergeGeometries(wood.map(flat))!;
    // Crown: leaf cards on an ellipsoid shell, with normals pointing out of the
    // crown so the foliage shades as one soft volume.
    const cards: THREE.BufferGeometry[] = [];
    const centre = new THREE.Vector3(0, 4.3, 0);
    const nCards = q === 'high' ? 70 : q === 'medium' ? 52 : 34;
    for (let i = 0; i < nCards; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = 0.55 + rnd() * 0.45;
      const dir = new THREE.Vector3(Math.sqrt(1 - u * u) * Math.cos(a), u * 0.85, Math.sqrt(1 - u * u) * Math.sin(a));
      const p = centre.clone().add(new THREE.Vector3(dir.x * 2.3 * r, dir.y * 1.9 * r, dir.z * 2.3 * r));
      const size = 1.5 + rnd() * 0.9;
      const g = new THREE.PlaneGeometry(size, size);
      g.rotateY(rnd() * Math.PI);
      g.rotateX((rnd() - 0.5) * 1.2);
      g.translate(p.x, p.y, p.z);
      const nrm = g.getAttribute('normal');
      const pos = g.getAttribute('position');
      const col: number[] = [];
      for (let k = 0; k < nrm.count; k++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, k).sub(centre);
        const n = v.clone().normalize();
        nrm.setXYZ(k, n.x, n.y, n.z);
        const shade = 0.55 + 0.45 * Math.min(1, Math.max(0, (v.y + 1.6) / 3.4)) * (0.7 + r * 0.3);
        col.push(shade, shade, shade);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      cards.push(g);
    }
    const crownGeo = mergeGeometries(cards)!;
    const count = placements.length;
    const barkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2b, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8 });
    const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, count);
    const leaves = new THREE.InstancedMesh(crownGeo, leafMat, count);
    const m = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const c = new THREE.Color();
    placements.forEach((pl, n) => {
      const r2 = rand(pl.seed ?? n);
      q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot);
      m.compose(new THREE.Vector3(pl.x, 0, pl.z), q4, new THREE.Vector3(pl.scale, pl.scale * (0.9 + r2() * 0.35), pl.scale));
      trunks.setMatrixAt(n, m);
      leaves.setMatrixAt(n, m);
      c.setHSL(0.22 + r2() * 0.08, 0.35 + r2() * 0.25, 0.42 + r2() * 0.18);
      leaves.setColorAt(n, c);
    });
    this.object.add(trunks, leaves);
  }

  /** Wind sway (time in seconds). */
  update(time: number) {
    void time;
  }
}

/** A cluster of leaves on transparent background for foliage cards. */
function leafClusterTexture(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 170; i++) {
    const r = Math.sqrt(rnd()) * S * 0.44;
    const a = rnd() * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
    const len = 12 + rnd() * 12, wid = len * (0.42 + rnd() * 0.15);
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * Math.PI * 2);
    const l = 30 + rnd() * 30;
    const grad = g.createLinearGradient(-len, 0, len, 0);
    grad.addColorStop(0, `hsl(${95 + rnd() * 25}, ${45 + rnd() * 20}%, ${l * 0.7}%)`);
    grad.addColorStop(1, `hsl(${85 + rnd() * 25}, ${50 + rnd() * 20}%, ${l}%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(20,40,10,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-len * 0.9, 0);
    g.lineTo(len * 0.9, 0);
    g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
