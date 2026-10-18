import * as THREE from 'three';

/**
 * One material family for every instanced lawn plant (grass shoots, long
 * meadow grass, clover and weeds, flowers). Built on the standard PBR
 * material so blades are lit, shadowed and fogged like everything else,
 * with: analytic arc-bent shapes whose normals never depend on size (a
 * faded or distant plant collapses without ever producing a zero normal),
 * rounded normals blended toward the lawn's up vector for soft field
 * shading, soft translucency when the sun is behind the blades, gentle IBL
 * sheen, wind sway, and a fade with camera distance into the ground.
 */

export type PlantKind = 'blade' | 'leaf' | 'flower';

export interface PlantUniforms {
  uTime: { value: number };
  uWind: { value: number };
}

export interface PlantLook {
  /** Lawn surface height the plants root in. */
  groundY: number;
  /** Full size within `fade[0]` metres of the camera, gone by `fade[1]`. */
  fade: [number, number];
  /** Sway amplitude (fraction of height at the tip). */
  sway: number;
  /** Root colour as a multiple of the tip colour (blades). */
  rootMul?: THREE.Color;
  /** Ripe seed colour (meadow seed stalks). */
  seed?: THREE.Color;
  /** Mowing stripe contrast and width (blades). */
  stripes?: [number, number];
  /** Blade thinning with distance: start, gone (last-ranked blades), widening of the rest (default none). */
  thin?: [number, number, number];
  /** Back-lit translucency strength. */
  translucency: number;
  /** How far normals lean toward the lawn's up vector (0..0.9; never 0.5, where opposite normals would cancel). */
  upBlend: number;
  roughness: number;
}

const VERTEX_PARS = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iShape;
attribute vec3 iColor;
uniform float uTime, uWind, uGroundY, uSway;
uniform vec2 uFade;
varying vec3 vCol;
varying vec3 vAux;
varying float vTrans;
float plantDistance(vec2 root) {
  return length(cameraPosition - vec3(root.x, uGroundY, root.y));
}
float plantFade(vec2 root) {
  return 1.0 - smoothstep(uFade.x, uFade.y, plantDistance(root));
}
// Plants shrunk below this are collapsed to a single point: a vanishing
// plant then has no sliver triangles left to rasterise.
const float MIN_SIZE = 0.04;
vec2 plantSway(vec2 root, float h) {
  float gust = 0.55 + 0.3 * sin(uTime * 1.6 + root.x * 0.7 + root.y * 0.45) + 0.15 * sin(uTime * 3.1 + root.y * 1.9 - root.x * 0.6);
  return vec2(0.8, 0.6) * (gust * uWind * uSway * h);
}
`;

/**
 * Blades: position = (across, t, seed head), blade = (fan, height, width,
 * bend), bladeRoot = root offset, bladeRank = thinning order; iPos = (x, z,
 * height, yaw), iShape = (bend, spread, half-width, size fade), iColor =
 * tip colour.
 */
const BLADE = {
  pars: /* glsl */ `
attribute vec4 blade;
attribute vec2 bladeRoot;
attribute float bladeRank;
uniform vec3 uRootMul, uSeedCol;
uniform vec2 uStripe;
// Thinning with distance: where it starts, where the last-ranked blades are
// gone, and how much wider the remaining blades grow to keep the cover.
uniform vec3 uThin;`,
  normal: /* glsl */ `
float bt = position.y;
// Per-blade variety from a hash of the shoot position and the blade.
float bladeHash = fract(sin(dot(iPos.xy, vec2(127.1, 311.7)) + blade.x * 17.13) * 43758.5453);
float yaw = iPos.w + blade.x * iShape.y;
vec3 dirD = vec3(sin(yaw), 0.0, cos(yaw));
vec3 dirW = vec3(-dirD.z, 0.0, dirD.x);
float bend = max(iShape.x * blade.w * (0.7 + 0.6 * bladeHash), 0.05);
float theta = bend * bt;
// Top-face normal of the arc, cupped across the blade (|normal| >= 1).
vec3 objectNormal = -cos(theta) * dirD + vec3(0.0, sin(theta), 0.0) + dirW * (sign(position.x) * 0.45);`,
  position: /* glsl */ `
// Edge and distance fades shrink the whole blade, keeping its triangles well
// shaped; lower-ranked blades of a shoot fade out nearer the camera.
float eyeDist = plantDistance(iPos.xy);
float size = iShape.w * (1.0 - smoothstep(mix(uFade.x, uThin.x, bladeRank), mix(uFade.y, uThin.y, bladeRank), eyeDist));
float h = iPos.z * blade.y * size;
vec3 arc = dirD * ((1.0 - cos(theta)) / bend) + vec3(0.0, sin(theta) / bend, 0.0);
vec2 rootOff = vec2(bladeRoot.x * cos(iPos.w) + bladeRoot.y * sin(iPos.w), bladeRoot.y * cos(iPos.w) - bladeRoot.x * sin(iPos.w));
vec3 transformed = vec3(iPos.x + rootOff.x, uGroundY, iPos.y + rootOff.y) + arc * h;
transformed += dirW * (position.x * iShape.z * blade.z * size * (1.0 + uThin.z * smoothstep(uThin.x, uThin.y, eyeDist)));
transformed.xz += plantSway(iPos.xy, h) * bt * bt;
if (size < MIN_SIZE) transformed = vec3(iPos.x, uGroundY, iPos.y);
// Root-to-tip shading, settling to an even tone with distance so far blades never sparkle.
vCol = iColor * mix(mix(uRootMul, vec3(1.0), smoothstep(0.0, 0.9, bt)), vec3(0.8), smoothstep(uFade.x * 0.5, uFade.y, length(cameraPosition - transformed)));
// Each blade its own shade, from deep blue-green to a yellower green.
vCol *= mix(vec3(0.88, 0.96, 1.1), vec3(1.1, 1.03, 0.84), fract(bladeHash * 7.0)) * (0.74 + 0.4 * bladeHash);
vCol = mix(vCol, uSeedCol * (0.75 + 0.4 * bt), position.z);
if (uStripe.x > 0.0) {
  // Mown stripes: blades laid away from the eye look light, toward it dark.
  vec2 toEye = cameraPosition.xz - iPos.xy;
  float lane = floor(iPos.x / uStripe.y + 0.5);
  float dir = mod(lane, 2.0) < 0.5 ? 1.0 : -1.0;
  vCol *= 1.0 + uStripe.x * dir * (0.25 - toEye.y / max(length(toEye), 1e-3));
}
vAux = vec3(0.0);
vTrans = bt;`,
  color: /* glsl */ `diffuseColor.rgb = clamp(vCol, 0.0, 1.0);`,
};

/**
 * Clover leaflets and weed rosettes: iPos = (x, z, leaflet size, yaw),
 * iShape = (stalk height, elongation, droop, size fade), iColor = leaf.
 */
const LEAF = {
  pars: '',
  normal: /* glsl */ `
float isStalk = step(position.z, -0.5);
float ang = iPos.w + max(position.z, 0.0) * 2.0944;
vec3 ld = vec3(sin(ang), 0.0, cos(ang));
vec3 lw = vec3(-ld.z, 0.0, ld.x);
float elong = max(iShape.y, 0.2);
// Leaflet surface y = stalk - droop * size * along^2; its slope tilts the normal.
float slope = -2.0 * iShape.z * position.x / elong;
vec3 objectNormal = isStalk > 0.5 ? -ld : vec3(0.0, 1.0, 0.0) - ld * slope;`,
  position: /* glsl */ `
float fade = plantFade(iPos.xy) * iShape.w;
float size = iPos.z * fade;
float stalk = iShape.x * fade;
vec3 root = vec3(iPos.x, uGroundY, iPos.y);
vec3 transformed;
if (isStalk > 0.5) {
  transformed = root + vec3(0.0, stalk * position.y, 0.0) + lw * (position.x * 0.0006 * fade);
  vAux = vec3(-1.0, 0.0, 0.0);
} else {
  float tip = position.x > 0.8 && abs(position.y) < 0.01 ? (elong > 1.5 ? 1.25 : 0.82) : position.x;
  transformed = root + vec3(0.0, stalk - iShape.z * size * position.x * position.x, 0.0) + ld * (tip * size * elong) + lw * (position.y * size * 0.5);
  vAux = vec3(position.x, position.y, elong > 1.5 ? 1.0 : 0.0);
}
transformed.xz += plantSway(iPos.xy, stalk) * (isStalk > 0.5 ? position.y : 1.0);
if (fade < MIN_SIZE) transformed = root;
vCol = iColor;
vTrans = 0.5;`,
  color: /* glsl */ `
vec3 leafCol = clamp(vCol, 0.0, 1.0);
if (vAux.x >= 0.0) {
  // White clover's pale chevron; a pale midrib on weed leaves.
  float chevron = 1.0 - smoothstep(0.03, 0.09, abs(vAux.x - 0.36 - 0.32 * abs(vAux.y)));
  float rib = 1.0 - smoothstep(0.0, 0.1, abs(vAux.y));
  leafCol = mix(leafCol, leafCol * 1.6 + vec3(0.015), chevron * (1.0 - vAux.z));
  leafCol = mix(leafCol, leafCol * 1.25, rib * vAux.z);
}
diffuseColor.rgb = leafCol;`,
};

/**
 * Flowers: iPos = (x, z, stem height, yaw), iShape = (bend, head radius,
 * petal notch radius, size fade), iColor = petals, iColor2 = centre.
 */
const FLOWER = {
  pars: /* glsl */ `
attribute vec3 iColor2;
varying vec3 vCol2;`,
  normal: /* glsl */ `
float isStem = step(position.z, -0.5);
vec3 dirD = vec3(sin(iPos.w), 0.0, cos(iPos.w));
vec3 dirW = vec3(-dirD.z, 0.0, dirD.x);
float bend = max(iShape.x, 0.05);
float theta = bend * (isStem > 0.5 ? position.y : 1.0);
float tilt = min(bend * 1.2, 1.0);
vec3 headN = cos(tilt) * vec3(0.0, 1.0, 0.0) + sin(tilt) * dirD;
vec3 headV = -cos(tilt) * dirD + sin(tilt) * vec3(0.0, 1.0, 0.0);
vec3 objectNormal = isStem > 0.5 ? -cos(theta) * dirD + vec3(0.0, sin(theta), 0.0) + dirW * (position.x * 0.5) : headN;`,
  position: /* glsl */ `
float fade = plantFade(iPos.xy) * iShape.w;
float h = iPos.z * fade;
vec3 root = vec3(iPos.x, uGroundY, iPos.y);
vec3 transformed;
if (isStem > 0.5) {
  vec3 arc = dirD * ((1.0 - cos(theta)) / bend) + vec3(0.0, sin(theta) / bend, 0.0);
  transformed = root + arc * h + dirW * (position.x * 0.0011 * fade);
  vAux = vec3(-1.0, 0.0, 0.0);
} else {
  vec3 top = dirD * ((1.0 - cos(bend)) / bend) + vec3(0.0, sin(bend) / bend, 0.0);
  float r = position.z > 1.5 ? iShape.z : position.z;
  float R = iShape.y * fade;
  transformed = root + top * h + (dirW * position.x + headV * position.y) * (r * R) + headN * (r * r * R * 0.3);
  vAux = vec3(r, 0.0, 0.0);
}
float swayT = isStem > 0.5 ? position.y : 1.0;
transformed.xz += plantSway(iPos.xy, h) * swayT * swayT;
if (fade < MIN_SIZE) transformed = root;
vCol = iColor;
vCol2 = iColor2;
vTrans = isStem > 0.5 ? 0.3 : 0.8;`,
  color: /* glsl */ `
diffuseColor.rgb = vAux.x < 0.0 ? uStemCol : clamp(mix(vCol2, vCol, smoothstep(0.26, 0.36, vAux.x)), 0.0, 1.0);`,
};

const KINDS = { blade: BLADE, leaf: LEAF, flower: FLOWER };

export function plantMaterial(kind: PlantKind, shared: PlantUniforms, look: PlantLook): THREE.MeshStandardMaterial {
  const k = KINDS[kind];
  const uniforms = {
    ...shared,
    uGroundY: { value: look.groundY },
    uSway: { value: look.sway },
    uFade: { value: new THREE.Vector2(...look.fade) },
    uRootMul: { value: look.rootMul ?? new THREE.Color(0.3, 0.3, 0.3) },
    uSeedCol: { value: look.seed ?? new THREE.Color(0.5, 0.4, 0.2) },
    uStripe: { value: new THREE.Vector2(...(look.stripes ?? [0, 1])) },
    uThin: { value: new THREE.Vector3(...(look.thin ?? [look.fade[0], look.fade[1], 0])) },
    uStemCol: { value: new THREE.Color(0x4f7a2a) },
    uTrans: { value: look.translucency },
    uUpBlend: { value: look.upBlend },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: look.roughness, side: THREE.DoubleSide });
  // Every kind patches the same standard shader differently: keep their programs apart.
  mat.customProgramCacheKey = () => `plant-${kind}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}\n${k.pars}`)
      .replace('#include <beginnormal_vertex>', k.normal)
      .replace('#include <begin_vertex>', k.position);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCol;
        varying vec3 vAux;
        varying float vTrans;
        uniform float uTrans, uUpBlend;
        uniform vec3 uStemCol;
        ${kind === 'flower' ? 'varying vec3 vCol2;' : ''}`,
      )
      .replace('#include <color_fragment>', k.color)
      .replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
        vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        // A sub-pixel sliver can be handed a near-zero interpolated normal:
        // fall back to up rather than normalising zero into NaN.
        float normalLen2 = dot(vNormal, vNormal);
        vec3 normal = normalLen2 > 1e-8 ? vNormal * inversesqrt(max(normalLen2, 1e-8)) * faceDirection : upView;
        // Lean shading toward the lawn's up vector so the field reads as one soft surface.
        normal = normalize(normal * (1.0 - uUpBlend) + upView * uUpBlend);
        vec3 nonPerturbedNormal = normal;
        float plantT = clamp(vTrans, 0.0, 1.0);`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
        #if NUM_DIR_LIGHTS > 0
        {
          // Sunlight through thin leaves: strongest looking toward the sun, on the shaded side.
          float toward = pow(saturate(dot(geometryViewDir, -directLight.direction)), 3.0);
          float behind = saturate(dot(-geometryNormal, directLight.direction));
          reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * vec3(0.9, 1.2, 0.45) * (uTrans * plantT * (0.6 * behind + 1.5 * toward)) * RECIPROCAL_PI;
        }
        #endif`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // A soft waxy sheen rather than a full dielectric highlight.
        reflectedLight.directSpecular *= 0.45;
        reflectedLight.indirectSpecular *= 0.2;
        // Down in the turf the sky is hidden by the blades around.
        reflectedLight.indirectDiffuse *= mix(0.45, 1.0, plantT);`,
      );
  };
  return mat;
}
