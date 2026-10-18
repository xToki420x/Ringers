import * as THREE from 'three';
import type { MapSet } from './textures';
import { sandMapsQuality } from './sandTextures';

/**
 * The pit fill's material: three's standard PBR material, extended so the
 * fill shows no texture tiling and reads damp where it has been turned over.
 *
 * - On medium and high, every map is sampled a second time, rotated and at
 *   a different scale, and the two layers are blended by a per-vertex mask
 *   (`sandState.y`). The blend is height-aware (the brighter, higher grains
 *   of either layer win), so a transition is a patch of different grains
 *   rather than a soft smear, and no repeat survives across the pit.
 * - The roughness map's R channel is crevice occlusion between grains (or
 *   drying cracks in clay).
 * - Damp fill (`sandState.x`, 0..1) is smoother and glossier and its gaps
 *   fill in; its darker colour rides in the vertex colours.
 */

/** Per kind: roughness when soaked, how much of the normal detail damp smooths away, how far crevices close. */
const DAMP = {
  sand: new THREE.Vector3(0.62, 0.5, 0.6),
  clay: new THREE.Vector3(0.52, 0.55, 0.85),
};

const VERTEX_PARS = /* glsl */ `
attribute vec2 sandState;
varying vec2 vSandState;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 sandDamp;
varying vec2 vSandState;
// Second layer: rotated about 53 degrees and scaled by 0.71 (texture coordinates).
const mat2 sandRot = mat2(0.6, -0.8, 0.8, 0.6);
`;

const MAP = /* glsl */ `
float sandWet = clamp(vSandState.x, 0.0, 1.0);
vec4 sandSurf = vec4(1.0);
#ifdef SAND_DETAIL
	vec2 sandUvB = sandRot * vMapUv * 0.71 + vec2(0.37, 0.61);
	vec4 sandTexA = texture2D(map, vMapUv);
	vec4 sandTexB = texture2D(map, sandUvB);
	float sandHA = dot(sandTexA.rgb, vec3(0.3, 0.59, 0.11)) + (1.0 - vSandState.y);
	float sandHB = dot(sandTexB.rgb, vec3(0.3, 0.59, 0.11)) + vSandState.y;
	float sandTop = max(sandHA, sandHB) - 0.08;
	float sandWA = max(sandHA - sandTop, 0.0);
	float sandWB = max(sandHB - sandTop, 0.0);
	// One of the two weights is always 0.08, so this never divides by zero.
	float sandBlend = sandWB / (sandWA + sandWB);
	vec4 sampledDiffuseColor = mix(sandTexA, sandTexB, sandBlend);
	#ifdef USE_ROUGHNESSMAP
		sandSurf = mix(texture2D(roughnessMap, vMapUv), texture2D(roughnessMap, sandUvB), sandBlend);
	#endif
#else
	vec4 sampledDiffuseColor = texture2D(map, vMapUv);
	#ifdef USE_ROUGHNESSMAP
		sandSurf = texture2D(roughnessMap, vMapUv);
	#endif
#endif
diffuseColor *= sampledDiffuseColor;
diffuseColor.rgb *= mix(sandSurf.r, 1.0, sandWet * sandDamp.z);
`;

const ROUGHNESS = /* glsl */ `
float roughnessFactor = mix(roughness * sandSurf.g, sandDamp.x, sandWet);
`;

const NORMAL = /* glsl */ `
#ifdef SAND_DETAIL
	vec3 sandNA = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
	vec3 sandNB = texture2D(normalMap, sandUvB).xyz * 2.0 - 1.0;
	// Back into the first layer's tangent frame (v * M is the inverse rotation).
	sandNB.xy = sandNB.xy * sandRot;
	vec3 mapN = mix(sandNA, sandNB, sandBlend);
#else
	vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
#endif
mapN.xy *= normalScale * (1.0 - sandDamp.y * sandWet);
// Keep the perturbed normal in the upper hemisphere so it can never vanish.
mapN.z = max(mapN.z, 0.05);
normal = normalize(tbn * mapN);
`;

const cache = new WeakMap<MapSet, THREE.MeshStandardMaterial>();

/** The (shared) material for pits filled with these maps. */
export function sandPitMaterial(maps: MapSet, kind: 'sand' | 'clay'): THREE.MeshStandardMaterial {
  const hit = cache.get(maps);
  if (hit) return hit;
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap ?? null,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  if (sandMapsQuality(maps) !== 'low') mat.defines = { SAND_DETAIL: '' };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.sandDamp = { value: DAMP[kind] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSandState = sandState;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', MAP)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS)
      .replace('#include <normal_fragment_maps>', NORMAL);
  };
  mat.customProgramCacheKey = () => 'sand-pit';
  cache.set(maps, mat);
  return mat;
}
