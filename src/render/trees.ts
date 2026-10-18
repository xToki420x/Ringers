import * as THREE from 'three';
import type { Quality } from './textures';
import { growTree, rng, VARIANTS } from './treeGrowth';
import { buildTreeGeometry, type TreeGeometry } from './treeMesh';
import { barkMaps, contactShadow, leafAtlas } from './treeTextures';

/**
 * Trees around the grounds. Venues decide where trees stand and which
 * species; this module grows a few distinct variants of each species
 * (treeGrowth.ts), meshes them (treeMesh.ts) and instances every placement
 * onto its variant, so a hundred trees cost a few draw calls. Foliage
 * shading: crown-shaped normals, interior occlusion, sunlight glowing
 * through the leaves and a gentle wind that leaves trunks still and lets
 * the outer sprays move.
 */

export type TreeSpecies = 'oak' | 'maple' | 'birch' | 'pine';

export interface TreePlacement {
  x: number;
  z: number;
  /** Overall size multiplier (1 ≈ an 8 m tree; pines stand a little taller). */
  scale: number;
  /** Rotation about the vertical, radians. */
  rot: number;
  species: TreeSpecies;
  /** Per-tree random seed (which variant, proportions and colour). */
  seed?: number;
}

/** Wind shared by every forest: time, and direction × strength in the ground plane. */
const WIND = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.8, 0, 0.6) } };

/**
 * Vertex wind: the whole tree leans slowly (more with height), limbs sway by
 * their `bend` with a phase shared down each limb, and leaf sprays flutter.
 * Wind is applied in the tree's own frame so it blows the same way for every
 * instance, whatever its rotation.
 */
const WIND_VERTEX = /* glsl */ `
vec3 transformed = vec3( position );
{
  vec3 w = uWind;
  float ph = 0.0;
  #ifdef USE_INSTANCING
    mat3 im = mat3( instanceMatrix );
    w = transpose( im ) * uWind * inversesqrt( max( dot( im[ 0 ], im[ 0 ] ), 1e-8 ) );
    ph = dot( instanceMatrix[ 3 ].xz, vec2( 0.37, 0.23 ) );
  #endif
  float t = uTime;
  float gust = 0.6 + 0.4 * sin( t * 0.31 + ph ) * sin( t * 0.19 + ph * 1.7 );
  float sway = ( sin( t * 1.15 + wind.y + ph ) * 0.65 + sin( t * 2.4 + wind.y * 1.7 ) * 0.35 ) * gust;
  float lean = position.y * position.y * 0.0005 * ( 1.2 + sin( t * 0.55 + ph ) ) * gust;
  transformed += w * ( lean + wind.x * ( 0.1 * sway + 0.06 * gust ) );
  transformed.y -= wind.x * abs( sway ) * 0.025;
  transformed += objectNormal * ( wind.z * 0.03 * gust * sin( t * 6.3 + wind.w ) * sin( t * 2.7 + wind.w * 0.6 ) );
}
`;

function windShader(sh: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(sh.uniforms, WIND);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 wind;\nuniform float uTime;\nuniform vec3 uWind;')
    .replace('#include <begin_vertex>', WIND_VERTEX);
}

function barkMaterial(species: TreeSpecies, q: Quality): THREE.MeshStandardMaterial {
  const maps = barkMaps(species, q);
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(maps.relief, maps.relief),
    vertexColors: true,
    roughness: species === 'birch' ? 0.8 : 0.94,
  });
  mat.onBeforeCompile = windShader;
  mat.customProgramCacheKey = () => 'tree-bark';
  return mat;
}

function leafMaterial(q: Quality): THREE.MeshStandardMaterial {
  const atlas = leafAtlas(q);
  // Alpha to coverage gives soft leaf edges where the post pipeline multisamples (medium and high).
  const coverage = q !== 'low';
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: coverage ? 0.5 : 0.42,
    alphaToCoverage: coverage,
    roughness: 0.72,
    envMapIntensity: 0.85,
  });
  const atlasSize = new THREE.Vector2(atlas.image.width, atlas.image.height);
  mat.onBeforeCompile = (sh) => {
    windShader(sh);
    sh.uniforms.uAtlasSize = { value: atlasSize };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uAtlasSize;')
      // Keep distant sprays solid: coarse mip levels average leaf alpha away, so restore it by level.
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 texel = vMapUv * uAtlasSize;
          float lod = 0.5 * log2( max( max( dot( dFdx( texel ), dFdx( texel ) ), dot( dFdy( texel ), dFdy( texel ) ) ), 1e-8 ) );
          diffuseColor.a *= 1.0 + max( lod, 0.0 ) * 0.3;
        }`,
      )
      // Both faces of a card share the crown's normal (no flip for back faces).
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // The crown-shaped normals would give every spray on the crown's rim a grazing,
          // sky-white sheen; leaves only glint a little, less still deep in the crown.
          float occ = clamp( dot( vColor.rgb, vec3( 0.3333 ) ), 0.0, 1.0 );
          reflectedLight.directSpecular *= 0.2;
          reflectedLight.indirectSpecular *= 0.35 * occ;
          #if NUM_DIR_LIGHTS > 0
            // Sunlight through the leaves: strongest looking toward the sun, softer on the shaded side.
            vec3 L = directionalLights[ 0 ].direction;
            vec3 V = vViewPosition * inversesqrt( max( dot( vViewPosition, vViewPosition ), 1e-8 ) );
            float through = 0.35 * saturate( - dot( normal, L ) ) + 1.6 * pow( saturate( dot( - V, L ) ), 5.0 );
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3( 1.05, 1.15, 0.55 ) * directionalLights[ 0 ].color * RECIPROCAL_PI * through * occ * occ;
          #endif
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'tree-leaf';
  return mat;
}

/** Built textures, materials and meshes are shared by every forest (a venue change rebuilds nothing). */
const shared = new Map<string, unknown>();
function memo<T>(key: string, make: () => T): T {
  if (!shared.has(key)) shared.set(key, make());
  return shared.get(key) as T;
}

const treeGeometry = (species: TreeSpecies, variant: number, q: Quality) =>
  memo<TreeGeometry>(`geo:${species}:${variant}:${q}`, () => buildTreeGeometry(growTree(species, variant, q), q, 17 + variant * 131));

/** Per-tree foliage colour: brightness range and warm/cool spread around the atlas colours. */
const LEAF_TINT: Record<TreeSpecies, { bright: [number, number]; warm: number }> = {
  oak: { bright: [0.82, 1.06], warm: 0.12 },
  maple: { bright: [0.86, 1.1], warm: 0.22 },
  birch: { bright: [0.86, 1.06], warm: 0.16 },
  pine: { bright: [0.8, 1.0], warm: 0.08 },
};

export class Forest {
  readonly object = new THREE.Group();

  constructor(placements: TreePlacement[], q: Quality) {
    // Sort placements onto their species' variants.
    const groups = new Map<string, { species: TreeSpecies; variant: number; trees: { pl: TreePlacement; seed: number }[] }>();
    placements.forEach((pl, n) => {
      const seed = pl.seed ?? n;
      const variant = Math.floor(rng(seed + 1)() * VARIANTS);
      const key = `${pl.species}:${variant}`;
      if (!groups.has(key)) groups.set(key, { species: pl.species, variant, trees: [] });
      groups.get(key)!.trees.push({ pl, seed });
    });
    const shadows = new THREE.InstancedMesh(
      memo('shadow-geo', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      memo(
        `shadow-mat:${q}`,
        () =>
          new THREE.MeshBasicMaterial({
            color: 0x0b1206,
            alphaMap: memo('shadow-tex', contactShadow),
            transparent: true,
            // Low quality blends straight into the sRGB canvas, where the same alpha reads darker.
            opacity: q === 'low' ? 0.38 : 0.55,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -4,
          }),
      ),
      placements.length,
    );
    const leaves = memo(`leaf-mat:${q}`, () => leafMaterial(q));
    const m = new THREE.Matrix4(), rotation = new THREE.Quaternion(), at = new THREE.Vector3(), size = new THREE.Vector3();
    const colour = new THREE.Color();
    let s = 0;
    for (const { species, variant, trees } of groups.values()) {
      const geo = treeGeometry(species, variant, q);
      const bark = memo(`bark-mat:${species}:${q}`, () => barkMaterial(species, q));
      const wood = new THREE.InstancedMesh(geo.wood, bark, trees.length);
      const foliage = new THREE.InstancedMesh(geo.foliage, leaves, trees.length);
      const tint = LEAF_TINT[species];
      trees.forEach(({ pl, seed }, i) => {
        const r = rng(seed * 7 + 3);
        rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, pl.rot);
        m.compose(at.set(pl.x, 0, pl.z), rotation, size.set(pl.scale, pl.scale * (0.93 + 0.14 * r()), pl.scale));
        wood.setMatrixAt(i, m);
        foliage.setMatrixAt(i, m);
        wood.setColorAt(i, colour.setScalar(0.88 + 0.2 * r()));
        const b = tint.bright[0] + (tint.bright[1] - tint.bright[0]) * r();
        const warm = (r() - 0.5) * tint.warm;
        foliage.setColorAt(i, colour.setRGB(b * (1 + warm), b, b * (1 - warm * 1.5)));
        m.compose(at.set(pl.x, 0.02, pl.z), rotation, size.setScalar(geo.spread * pl.scale * 2.3));
        shadows.setMatrixAt(s++, m);
      });
      this.object.add(wood, foliage);
    }
    this.object.add(shadows);
  }

  /** Wind sway (time in seconds). */
  update(time: number) {
    WIND.uTime.value = time;
  }
}
