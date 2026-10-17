import * as THREE from 'three';
import { HALF_COURT } from '../core/constants';
import { fbm, type MapSet, type Quality } from './textures';

/**
 * The ground around the courts. Each venue picks a grass style: a striped,
 * manicured championship lawn, a homeowner's backyard, a public park, or a
 * natural lakeside meadow.
 */

export type GrassStyle = 'manicured' | 'backyard' | 'park' | 'meadow';

export interface LawnOptions {
  style: GrassStyle;
  /** Side length of the square ground, metres. */
  size: number;
  /** Centre x of each court (worn walking lanes run beside them). */
  courts: number[];
}

export function buildLawn(grass: MapSet, q: Quality, opts: LawnOptions): THREE.Group {
  void q;
  const group = new THREE.Group();
  // Lawn: a subdivided ground with mowing stripes and macro tonal variation
  // baked into vertex colours so the tiled grass never looks repetitive.
  const lawnMap = grass.map.clone();
  lawnMap.repeat.set(110, 110);
  lawnMap.needsUpdate = true;
  const lawnNormal = grass.normalMap.clone();
  lawnNormal.repeat.set(110, 110);
  lawnNormal.needsUpdate = true;
  const lawnGeo = new THREE.PlaneGeometry(opts.size, opts.size, 96, 96);
  lawnGeo.rotateX(-Math.PI / 2);
  const lp = lawnGeo.getAttribute('position');
  const lc: number[] = [];
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i), z = lp.getZ(i);
    const stripe = opts.style === 'manicured' ? (Math.floor((x + 120) / 2.4) % 2 === 0 ? 1.06 : 0.92) : 1;
    const macro = 0.85 + fbm(x * 0.03 + 50, z * 0.03 + 50, 64, 3, 81) * 0.3;
    const worn = Math.abs(x) < 10 && Math.abs(z) < HALF_COURT + 3 ? 0.97 : 1;
    const k = stripe * macro * worn;
    lc.push(k, k, k * 0.96);
  }
  lawnGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  const lawn = new THREE.Mesh(lawnGeo, new THREE.MeshStandardMaterial({ map: lawnMap, normalMap: lawnNormal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95, vertexColors: true }));
  lawn.position.y = -0.02;
  lawn.receiveShadow = true;
  group.add(lawn);
  // Worn lanes between the boxes (players walk them every inning).
  const laneMat = new THREE.MeshStandardMaterial({ map: lawnMap, normalMap: lawnNormal, color: 0xc9bd96, roughness: 1, transparent: true, opacity: 0.4, depthWrite: false });
  for (const cx of opts.courts)
    for (const sx of [-1, 1]) {
      const lane = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2 * HALF_COURT - 2), laneMat);
      lane.rotation.x = -Math.PI / 2;
      lane.position.set(cx + sx * 0.85, -0.017, 0);
      lane.receiveShadow = true;
      group.add(lane);
    }
  return group;
}
