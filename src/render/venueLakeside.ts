import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { picnicTable, place, windowUnit } from './props';
import type { Lighting } from './environment';
import { fbm } from './textures';
import { barkMaps } from './treeTextures';
import { Forest, type TreePlacement } from './trees';
import { Batch, beam, box, buildGround, contactShadows, gableRoof, mapped, propMaterial, ribbon, rng, rod, type VenueContext, type VenueScene } from './venueKit';
import { edgeFade, glowTexture, gravelMaps, logMaps, plankMaps, shingleMaps, waterNormal } from './venueTextures';

/**
 * A lakeside campground: two courts in a meadow clearing ringed by pines,
 * a lake with rippling, sky-reflecting water, a timber dock with a canoe
 * tied up, log cabins with porches, a stone campfire ring with log
 * benches (it burns at night) and forested hills all round the horizon.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The lake: an ellipse west of the courts. */
const LAKE = { x: -57, z: 4, rx: 48, rz: 80 };
/** How far inside the shoreline a point is (> 1 outside, < 1 in the water). */
const lakeR = (x: number, z: number) => Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
const DOCK = { x0: -7.6, x1: -18, z: -2, w: 1.8, y: 0.48 };
const FIRE = { x: 11, z: -2 };
/** Cabins: position and facing (their porches look toward the clearing). */
const CABINS: [number, number, number][] = [
  [19, -17, -Math.PI * 0.62],
  [20, 14, -Math.PI * 0.4],
];

export function buildLakeside(ctx: VenueContext): VenueScene {
  const { q } = ctx;
  const group = new THREE.Group();
  const grass = buildGround(ctx, 'meadow', group, {
    blocked: (x, z) =>
      lakeR(x, z) < 1.07 ||
      Math.hypot(x - FIRE.x, z - FIRE.z) < 3.4 ||
      CABINS.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 5.5),
  });

  const bark = barkMaps('pine', q);
  const m = {
    logs: mapped(logMaps(q), { roughness: 0.75, normal: 1 }),
    bark: propMaterial({ map: bark.map, normalMap: bark.normalMap, normalScale: new THREE.Vector2(bark.relief, bark.relief), roughness: 0.95 }),
    boards: mapped(plankMaps(q, 5), { color: 0x968a80, roughness: 0.85 }),
    dock: mapped(plankMaps(q, 7), { color: 0xa4acb6, roughness: 0.9 }),
    roof: mapped(shingleMaps(q), { color: 0x4e5a4c, roughness: 0.9, normal: 1.2 }),
    trim: propMaterial({ color: 0x4b3424, roughness: 0.7 }),
    glass: propMaterial({ color: 0x0b1116, roughness: 0.05, metalness: 0.2, envMapIntensity: 1.5 }),
    stone: propMaterial({ color: 0x66625b, roughness: 0.92, flatShading: true }),
    char: propMaterial({ color: 0x1c1714, roughness: 1 }),
    canoe: new THREE.MeshStandardMaterial({ color: 0xb8402c, roughness: 0.35, side: THREE.DoubleSide }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xd8cfb8 }),
    ember: new THREE.MeshBasicMaterial({ color: 0x3a2116 }),
  };
  const b = new Batch();
  for (const [x, z, rot] of CABINS) cabin(b, m, x, z, rot);
  dock(b, m);
  canoe(b, m);
  campfire(b, m);
  b.add(m.boards, place(picnicTable(), 14.6, 8.5, 0.5), 1);
  b.build(group);

  // Porch lanterns and the fire glow at night.
  const lanternAt = CABINS.map(([x, z, rot]) => V(x, 2.15, z).add(V(1.0, 0, 2.55).applyAxisAngle(V(0, 1, 0), rot)));
  const lanterns = new THREE.Mesh(
    mergeGeometries(lanternAt.map((p) => new THREE.CylinderGeometry(0.07, 0.06, 0.2, 8).translate(p.x, p.y, p.z))),
    m.lamp,
  );
  group.add(lanterns);
  const glowMat = new THREE.PointsMaterial({ map: glowTexture(), color: 0xffb070, size: 1.2, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const lanternGlow = new THREE.Points(new THREE.BufferGeometry().setFromPoints(lanternAt), glowMat);
  lanternGlow.visible = false;
  group.add(lanternGlow);
  const flames = Array.from({ length: 4 }, (_, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: i ? 0xff7a2a : 0xffc060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.visible = false;
    group.add(s);
    return s;
  });

  const water = lake(group, q);
  hills(group, q);
  const forest = new Forest(trees(q), q);
  group.add(forest.object);

  contactShadows(group, [
    ...CABINS.map(([x, z, rot]): [number, number, number, number, number, number] => [x, z, 7.4, 8, rot, 0.6]),
    [FIRE.x, FIRE.z, 2.4, 2.4, 0, 0.5],
    [14.6, 8.5, 2.2, 2.4, 0.5 + Math.PI / 2, 0.4],
  ]);

  let night = false;
  return {
    group,
    scoreboards: [],
    crowd: null,
    setLighting(L) {
      const n = (night = L.night);
      water.setLighting(L);
      lanternGlow.visible = n;
      for (const f of flames) f.visible = n;
      if (n) {
        m.lamp.color.setRGB(6, 4.2, 2.2);
        m.ember.color.setRGB(5, 1.6, 0.4);
      } else {
        m.lamp.color.set(0xd8cfb8);
        m.ember.color.set(0x3a2116);
      }
      m.glass.emissive.set(n ? 0xffa850 : 0x000000);
      m.glass.emissiveIntensity = n ? 0.8 : 0;
    },
    update(_dt, time) {
      water.update(time);
      grass.update(time);
      forest.update(time);
      if (night)
        flames.forEach((f, i) => {
          const flick = 0.75 + 0.25 * Math.sin(time * (9 + i * 2.3) + i) * Math.sin(time * (5.1 + i) + i * 2);
          f.position.set(FIRE.x + Math.sin(i * 2.1) * 0.12, 0.35 + i * 0.12 + flick * 0.08, FIRE.z + Math.cos(i * 2.1) * 0.12);
          f.scale.setScalar((i ? 0.9 : 1.6) * flick);
        });
    },
  };
}

type Mats = Record<'logs' | 'bark' | 'boards' | 'dock' | 'roof' | 'trim' | 'glass' | 'stone' | 'char', THREE.MeshStandardMaterial> & { canoe: THREE.MeshStandardMaterial; ember: THREE.MeshBasicMaterial };

/** A round log with UVs scaled to its size: `aroundU` repeats around it, one repeat per `tile` metres along it (grain runs along V). */
function logRod(a: THREE.Vector3, b: THREE.Vector3, r: number, aroundU = 2, tile = 1.4): THREE.BufferGeometry {
  const g = rod(a, b, r, 10);
  const uv = g.getAttribute('uv');
  const len = a.distanceTo(b);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * aroundU, uv.getY(i) * len / tile);
  return g;
}

/** Bark-covered log or post: bark plates at a natural size. */
const barkRod = (a: THREE.Vector3, b: THREE.Vector3, r: number) => logRod(a, b, r, 1, 0.9);

/**
 * Log cabin (local front faces +z): saddle-notched log walls with
 * overhanging ends, board gables, a shingle roof, a door, windows, a
 * stone chimney and a front porch.
 */
function cabin(b: Batch, m: Mats, cx: number, cz: number, rot: number) {
  const W = 5.6, D = 4.6, r = 0.15, courses = 9, base = 0.3;
  const wall = base + courses * r * 1.8;
  const ridge = wall + 1.7;
  const to = (g: THREE.BufferGeometry | THREE.BufferGeometry[]) => place(g, cx, cz, rot);
  const logs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < courses; k++) {
    const y = base + r + k * r * 1.8;
    for (const s of [-1, 1]) {
      logs.push(logRod(V(-W / 2 - 0.35, y, s * D / 2), V(W / 2 + 0.35, y, s * D / 2), r));
      logs.push(logRod(V(s * W / 2, y + r * 0.9, -D / 2 - 0.35), V(s * W / 2, y + r * 0.9, D / 2 + 0.35), r));
    }
  }
  b.add(m.logs, to(logs));
  b.add(m.stone, to(box(W + 0.2, base, D + 0.2, 0, base / 2, 0)));
  // Board-and-batten gables over the side walls.
  for (const s of [-1, 1]) {
    const tri = new THREE.Shape([new THREE.Vector2(-D / 2 - 0.1, 0), new THREE.Vector2(D / 2 + 0.1, 0), new THREE.Vector2(0, ridge - wall)]);
    const g = new THREE.ExtrudeGeometry(tri, { depth: 0.08, bevelEnabled: false }).translate(0, 0, -0.04).rotateY(Math.PI / 2).translate(s * W / 2, wall, 0);
    b.add(m.boards, to(g), 1, true);
  }
  const roof = gableRoof(D, W, wall, ridge, 0, 0, { eave: 0.7, rake: 0.55, t: 0.12 });
  b.add(m.roof, to(roof), 1.1, true);
  // Door and windows on the front, a window on each side.
  b.add(m.boards, to(box(0.95, 1.95, 0.08, -0.9, base + 0.98, D / 2 + r + 0.02)), 1, true);
  b.add(m.trim, to([box(1.15, 0.1, 0.1, -0.9, base + 2.0, D / 2 + r + 0.03), box(0.1, 2.0, 0.1, -1.42, base + 1.0, D / 2 + r + 0.03), box(0.1, 2.0, 0.1, -0.38, base + 1.0, D / 2 + r + 0.03)]));
  const win = (x: number, z: number, face: number) => {
    const u = windowUnit(0.9, 0.9);
    b.add(m.trim, to(place(u.trim, x, z, face, base + 1.45)));
    b.add(m.glass, to(place(u.glass, x, z, face, base + 1.45)));
  };
  win(1.2, D / 2 + r, 0);
  win(-W / 2 - r, 0, -Math.PI / 2);
  win(W / 2 + r, -0.6, Math.PI / 2);
  // Stone chimney on one gable.
  b.add(m.stone, to([box(0.9, ridge + 0.6, 0.8, -W / 2 - 0.55, (ridge + 0.6) / 2, -0.8), box(1.0, 0.12, 0.9, -W / 2 - 0.55, ridge + 0.62, -0.8)]));
  // Front porch: deck, posts and a shallow roof.
  const pd = 1.8;
  b.add(m.dock, to(box(W + 0.6, 0.06, pd, 0, base - 0.03, D / 2 + 0.25 + pd / 2)), 1, true);
  for (const s of [-1, 1]) b.add(m.bark, to(barkRod(V(s * (W / 2), base, D / 2 + pd), V(s * (W / 2), wall - 0.15, D / 2 + pd), 0.09)));
  b.add(m.logs, to(logRod(V(-W / 2 - 0.3, wall - 0.12, D / 2 + pd), V(W / 2 + 0.3, wall - 0.12, D / 2 + pd), 0.1)));
  const porchRoof = box(W + 0.8, 0.08, pd + 0.4, 0, 0, 0).rotateX(0.2).translate(0, wall + 0.05, D / 2 + pd / 2 + 0.25);
  b.add(m.roof, to(porchRoof), 1.1, true);
  // A step down from the porch.
  b.add(m.dock, to(box(1.4, 0.06, 0.35, -0.9, base * 0.5, D / 2 + 0.25 + pd + 0.2)), 1, true);
}

/** Timber dock on posts running out from the shore. */
function dock(b: Batch, m: Mats) {
  const { x0, x1, z, w, y } = DOCK;
  const len = x0 - x1, cx = (x0 + x1) / 2;
  b.add(m.dock, box(len, 0.06, w, cx, y, z), 1, true);
  for (const s of [-1, 1]) b.add(m.dock, box(len, 0.2, 0.06, cx, y - 0.13, z + s * (w / 2 - 0.03)), 1);
  const n = Math.round(len / 2.1);
  for (let i = 0; i <= n; i++) {
    const x = x0 - (len * i) / n;
    for (const s of [-1, 1]) b.add(m.bark, barkRod(V(x, -0.6, z + s * (w / 2 + 0.06)), V(x, y + 0.3, z + s * (w / 2 + 0.06)), 0.09));
  }
  // Mooring cleat.
  b.add(m.trim, box(0.25, 0.06, 0.06, x1 + 0.8, y + 0.06, z - w / 2 + 0.12));
}

/** A red canoe tied alongside the dock, floating at the waterline, with a paddle across the thwarts. */
function canoe(b: Batch, m: Mats) {
  const L = 4.8, NL = 28, NT = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NL; i++) {
    const t = i / NL;
    const s = Math.sin(Math.PI * t);
    const half = Math.max(0.02, 0.44 * Math.pow(s, 0.65));
    const depth = 0.3 * (0.55 + 0.45 * Math.pow(s, 0.5));
    const top = 0.34 + 0.16 * Math.pow(2 * t - 1, 6);
    for (let j = 0; j <= NT; j++) {
      const a = (j / NT) * Math.PI;
      pos.push((t - 0.5) * L, top - depth * Math.sin(a) - (top - 0.34) * Math.sin(a), half * Math.cos(a));
    }
  }
  for (let i = 0; i < NL; i++)
    for (let j = 0; j < NT; j++) {
      const a = i * (NT + 1) + j;
      idx.push(a, a + NT + 1, a + 1, a + 1, a + NT + 1, a + NT + 2);
    }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hull.setIndex(idx);
  hull.computeVertexNormals();
  hull.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  const cx = DOCK.x1 + 4.5, cz = DOCK.z - DOCK.w / 2 - 0.7, yaw = 0.06;
  const at = (g: THREE.BufferGeometry) => g.rotateY(yaw).translate(cx, -0.12, cz);
  b.add(m.canoe, at(hull));
  for (const s of [-1, 1]) {
    // Gunwales follow the sheer line.
    const rail: THREE.Vector3[] = [];
    for (let i = 1; i < NL; i++) {
      const t = i / NL;
      const half = Math.max(0.02, 0.44 * Math.pow(Math.sin(Math.PI * t), 0.65));
      rail.push(V((t - 0.5) * L, 0.34 + 0.16 * Math.pow(2 * t - 1, 6), s * half));
    }
    for (let i = 0; i + 1 < rail.length; i++) b.add(m.dock, at(rod(rail[i], rail[i + 1], 0.022, 5)));
  }
  for (const tx of [-1.2, 0, 1.25]) b.add(m.dock, at(box(0.08, 0.025, 0.84, tx, 0.33, 0)), 1);
  b.add(m.dock, at(beam(V(-1.3, 0.37, -0.12), V(0.75, 0.37, 0.18), 0.07, 0.02)), 1);
  b.add(m.dock, at(box(0.5, 0.02, 0.17, 0.95, 0.37, 0.22).rotateY(0.15)), 1);
}

/** Ring of stones with charred logs and embers, ringed by log benches. */
function campfire(b: Batch, m: Mats) {
  const r = rng(91);
  const { x, z } = FIRE;
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2 + r() * 0.1;
    const s = new THREE.IcosahedronGeometry(0.17 + r() * 0.06, 0).scale(1.2, 0.75, 1).rotateY(r() * 3);
    b.add(m.stone, s.translate(x + Math.cos(a) * 0.72, 0.08, z + Math.sin(a) * 0.72));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    b.add(m.char, rod(V(x + Math.cos(a) * 0.5, 0.05, z + Math.sin(a) * 0.5), V(x - Math.cos(a) * 0.05, 0.28, z - Math.sin(a) * 0.05), 0.055, 7));
  }
  b.add(m.ember, new THREE.CylinderGeometry(0.36, 0.42, 0.06, 12).translate(x, 0.03, z));
  // Three split-log benches facing the fire.
  for (const a of [0.9, 2.6, 4.4]) {
    const bx = x + Math.cos(a) * 2.3, bz = z + Math.sin(a) * 2.3;
    const t = V(-Math.sin(a), 0, Math.cos(a));
    const p0 = V(bx, 0.42, bz).addScaledVector(t, -0.95), p1 = V(bx, 0.42, bz).addScaledVector(t, 0.95);
    b.add(m.bark, barkRod(p0, p1, 0.2));
    for (const p of [p0.clone().lerp(p1, 0.15), p0.clone().lerp(p1, 0.85)]) b.add(m.bark, barkRod(V(p.x, 0, p.z), V(p.x, 0.26, p.z), 0.14));
  }
}

/**
 * The lake: a pebbly, feathered shore and a rippling surface. Instead of
 * reflecting the shared sky probe (built for polished steel, with bright
 * cloud banks), the water reflects its own surroundings: the dark wooded
 * hills along the horizon and the sky above them in the current light,
 * by Fresnel, with the sun's glints on the ripples. It turns clear in the
 * shallows so the shore shows through.
 */
function lake(group: THREE.Group, q: VenueContext['q']): { update(time: number): void; setLighting(L: Lighting): void } {
  const shore: [number, number][] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    shore.push([LAKE.x + Math.cos(a) * LAKE.rx * 1.005, LAKE.z + Math.sin(a) * LAKE.rz * 1.005]);
  }
  const pebbles = gravelMaps(q);
  const beachMap = pebbles.map.clone();
  beachMap.repeat.set(1.8, 2.6);
  beachMap.needsUpdate = true;
  const beach = new THREE.Mesh(
    ribbon(shore, 4.4, 0.02, 1.5),
    new THREE.MeshStandardMaterial({ map: beachMap, color: 0x8a7a62, roughness: 1, alphaMap: edgeFade(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  );
  group.add(beach);
  const geo = new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2).scale(LAKE.rx, 1, LAKE.rz).translate(LAKE.x, 0.05, LAKE.z);
  const p = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 16, p.getZ(i) / 16);
  const ripples = waterNormal(q);
  const uniforms = {
    uSky: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uHills: { value: new THREE.Color() },
    uLake: { value: new THREE.Vector4(LAKE.x, LAKE.z, 1 / LAKE.rx, 1 / LAKE.rz) },
    uDrift: { value: new THREE.Vector2() },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c2025,
    roughness: 0.12,
    metalness: 0,
    normalMap: ripples,
    normalScale: new THREE.Vector2(0.16, 0.16),
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLakeXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLakeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLakeXZ;\nuniform vec3 uSky, uHorizon, uHills;\nuniform vec4 uLake;\nuniform vec2 uDrift;')
      // Two drifting scales of the same ripples, so the pattern never visibly repeats.
      .replace(
        '#include <normal_fragment_maps>',
        THREE.ShaderChunk.normal_fragment_maps.replace(
          'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;\nvec3 mapN2 = texture2D( normalMap, vNormalMapUv * 0.43 + uDrift ).xyz * 2.0 - 1.0;\nmapN = vec3( ( mapN.xy * 0.7 + mapN2.xy * 0.4 ) / ( 1.0 + length( vViewPosition ) * 0.03 ), max( mapN.z, 0.2 ) );',
        ),
      )
      // The shared sky probe is replaced by the reflection below (scene.environment ignores envMapIntensity).
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nradiance = vec3(0.0);')
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 toEye = normalize(vViewPosition);
          vec3 r = inverseTransformDirection(reflect(-toEye, normal), viewMatrix);
          vec3 refl = mix(uHills, mix(uHorizon, uSky, smoothstep(0.15, 0.7, r.y)), smoothstep(0.05, 0.2, r.y));
          float fres = 0.03 + 0.97 * pow(1.0 - clamp(dot(normal, toEye), 0.0, 1.0), 5.0);
          outgoingLight = mix(outgoingLight, refl, fres);
          float shore = length((vLakeXZ - uLake.xy) * uLake.zw);
          diffuseColor.a = mix(0.97, 0.35, smoothstep(0.955, 0.998, shore));
        }
        #include <opaque_fragment>`,
      );
  };
  const water = new THREE.Mesh(geo, mat);
  water.receiveShadow = true;
  group.add(water);
  const hillTone = new THREE.Color(0x1f2d22);
  return {
    update(time) {
      ripples.offset.set(time * 0.01, time * 0.006);
      uniforms.uDrift.value.set(-time * 0.004, time * 0.0025);
    },
    setLighting(L) {
      uniforms.uHorizon.value.copy(L.fog);
      uniforms.uSky.value.copy(L.hemiSky).multiplyScalar(L.night ? 0.25 : 0.85);
      uniforms.uHills.value.copy(hillTone).lerp(L.fog, 0.2).multiplyScalar(L.night ? 0.25 : 1);
    },
  };
}

/** Forested hills on every horizon: a jagged canopy ring that fades into the haze. */
function hills(group: THREE.Group, q: VenueContext['q']) {
  const NA = q === 'low' ? 360 : 720, NR = 9;
  const r0 = 85, r1 = 330;
  const pos: number[] = [], col: number[] = [], idx: number[] = [], canopyY: number[] = [];
  const dark = new THREE.Color(0x1d2c1c), light = new THREE.Color(0x3b4d30), c = new THREE.Color();
  for (let i = 0; i <= NA; i++) {
    const a = (i / NA) * Math.PI * 2;
    const u = i / NA;
    const peak = 16 + 40 * fbm(u * 6, 0.5, 6, 4, 81);
    for (let j = 0; j <= NR; j++) {
      const t = j / NR;
      const r = r0 + (r1 - r0) * t;
      const profile = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - 0.35 * t);
      // Tree crowns break up the skyline along the ridge tops (lower down the noise would streak the slopes).
      const canopy = (fbm(u * 170, t * 8, 170, 2, 82) - 0.5) * 7 * Math.min(1, Math.max(0, (t - 0.4) / 0.25));
      const ground = Math.max(0, peak * profile) - 0.5;
      pos.push(Math.cos(a) * r, ground, Math.sin(a) * r);
      canopyY.push(Math.max(-0.5, ground + canopy));
      c.copy(dark).lerp(light, fbm(u * 14, t * 5, 14, 3, 83) * 0.8);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NA; i++)
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j;
      idx.push(a, a + NR + 1, a + 1, a + 1, a + NR + 1, a + NR + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // Shade the smooth slopes, then raise the ragged canopy (its noise would streak the lighting).
  g.computeVertexNormals();
  const p = g.getAttribute('position');
  canopyY.forEach((y, i) => p.setY(i, y));
  group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
}

/** Pines ringing the clearing and lining the shore, a few birches by the water. */
function trees(q: VenueContext['q']): TreePlacement[] {
  const out: TreePlacement[] = [];
  const r = rng(29);
  // Pines are the heaviest trees: a dense ring close in, the far forest is the hills.
  const count = q === 'low' ? 40 : q === 'medium' ? 70 : 100;
  let guard = 0;
  while (out.length < count && guard++ < 6000) {
    const a = r() * Math.PI * 2, d = 15 + r() * r() * 60;
    const x = Math.cos(a) * d + 6, z = Math.sin(a) * d * 1.2;
    // The clearing: an open oval around the courts.
    if (Math.hypot((x - 1.8) / 14, z / 25) < 1) continue;
    if (lakeR(x, z) < 1.12) continue;
    if (Math.hypot(x - FIRE.x, z - FIRE.z) < 5 || Math.hypot(x - 14.6, z - 8.5) < 4) continue;
    if (CABINS.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 7)) continue;
    const shore = lakeR(x, z) < 1.3;
    out.push({ x, z, scale: 0.95 + r() * 0.65, rot: r() * Math.PI * 2, species: shore && r() < 0.3 ? 'birch' : 'pine', seed: 200 + out.length });
  }
  return out;
}
