import * as THREE from 'three';
import { HALF_COURT } from '../core/constants';
import { fbm } from './textures';
import type { GrassLook } from './grassStyles';

/**
 * Where a lawn has clover, dry patches, worn ground and long wild grass,
 * plus its large-scale tonal variation. The same fields are evaluated on
 * the CPU (to grow, tint and size the 3D blades) and in the ground shader
 * (to colour the turf), from one tileable noise texture sampled the same
 * way in both, so blades and ground always agree.
 */

const N = 256;
let noiseData: Uint8Array | null = null;
let noiseTex: THREE.DataTexture | null = null;

/** Four independent tileable noise channels, each equalised to an even 0..1 spread. */
function buildNoise(): Uint8Array {
  const d = new Uint8Array(N * N * 4);
  const chans: [number, number, number][] = [
    [4, 4, 301],
    [8, 3, 302],
    [8, 3, 303],
    [16, 3, 304],
  ];
  const vals = new Float32Array(N * N);
  const order = new Uint32Array(N * N);
  chans.forEach(([freq, oct, seed], ch) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) vals[y * N + x] = fbm((x / N) * freq, (y / N) * freq, freq, oct, seed);
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => vals[a] - vals[b]);
    for (let r = 0; r < order.length; r++) d[order[r] * 4 + ch] = Math.round((r / (order.length - 1)) * 255);
  });
  return d;
}

function data(): Uint8Array {
  return (noiseData ??= buildNoise());
}

/** The shared noise as a texture (repeat-wrapped, linearly filtered, like the CPU sampler). */
export function fieldNoiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const t = new THREE.DataTexture(data(), N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return (noiseTex = t);
}

/** Bilinear sample of noise channel `ch` at world (x, z), tiling every `scale` metres (matches texture2D). */
export function noiseAt(x: number, z: number, scale: number, ch: number): number {
  const d = data();
  const fx = (x / scale) * N - 0.5, fy = (z / scale) * N - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % N) + N) % N, ya = ((y0 % N) + N) % N;
  const xb = (xa + 1) % N, yb = (ya + 1) % N;
  const a = d[(ya * N + xa) * 4 + ch], b = d[(ya * N + xb) * 4 + ch];
  const c = d[(yb * N + xa) * 4 + ch], e = d[(yb * N + xb) * 4 + ch];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty) / 255;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface LawnFields {
  /** Large-scale brightness (0..1, mean 0.5). */
  macro: number;
  /** Large-scale hue: 0 bluish green .. 1 yellowish green. */
  hue: number;
  /** Clover patch, dry patch, worn ground and long wild grass coverage, 0..1. */
  clover: number;
  dry: number;
  wear: number;
  wild: number;
  /** Fine clumping of the turf (0..1), for blade density. */
  clump: number;
}

/** Coverage thresholds: a share `c` of the ground lies above the returned noise value. */
const above = (c: number) => 1 - c;

export function lawnFields(look: GrassLook, courts: readonly number[], x: number, z: number): LawnFields {
  const rx = 0.8 * x + 0.6 * z, rz = -0.6 * x + 0.8 * z;
  const macro = 0.62 * noiseAt(x, z, 67, 0) + 0.38 * noiseAt(rx, rz, 19, 0);
  const hue = noiseAt(rz, rx, 41, 1);
  const cn = 0.75 * noiseAt(x, z, 6.1, 1) + 0.25 * noiseAt(rx, rz, 2.3, 1);
  const clover = look.cloverCover > 0 ? smooth(above(look.cloverCover) - 0.08, above(look.cloverCover) + 0.1, cn) : 0;
  const dn = 0.7 * noiseAt(x, z, 16, 2) + 0.3 * noiseAt(rx, rz, 5.3, 2);
  const dry = look.dryCover > 0 ? smooth(above(look.dryCover) - 0.1, above(look.dryCover) + 0.12, dn) : 0;
  let wear = 0;
  let cMin = Infinity, cMax = -Infinity;
  const az = Math.abs(z);
  for (const cx of courts) {
    cMin = Math.min(cMin, cx);
    cMax = Math.max(cMax, cx);
    const dx = Math.abs(x - cx);
    // Paths beside the court, the landing apron in front of each pit, and
    // the box corners where pitchers step on and off.
    const lane = (1 - smooth(0.14, 0.4, Math.abs(dx - 1.08))) * (1 - smooth(HALF_COURT - 1.9, HALF_COURT - 1.0, az)) * 0.7;
    const front = 1 - smooth(0.35, 1, Math.hypot(dx / 0.5, (az - (HALF_COURT - 1.3)) / 0.6));
    const corner = (1 - smooth(0.3, 1, Math.hypot((dx - 1.15) / 0.42, (az - (HALF_COURT - 0.55)) / 0.5))) * 0.85;
    wear = Math.max(wear, lane, front, corner);
  }
  const breakup = 0.65 * noiseAt(x, z, 1.3, 3) + 0.35 * noiseAt(rx, rz, 0.41, 3);
  wear = Math.min(1, Math.max(0, wear * (0.55 + 0.9 * breakup) - 0.08)) * look.wear;
  let wild = 0;
  if (look.wild && courts.length) {
    const side = Math.max(cMin - x, x - cMax, 0) - 5;
    const d = Math.max(side, az - (HALF_COURT + 6)) + (noiseAt(x, z, 11, 0) - 0.5) * 3;
    wild = smooth(-0.6, 1.2, d);
  }
  return { macro, hue, clover, dry, wear, wild, clump: noiseAt(x, z, 2.9, 3) };
}

/** GLSL twin of `lawnFields` (needs `lawnFieldUniforms`). Returns clover, dry, wear, wild. */
export const LAWN_FIELDS_GLSL = /* glsl */ `
uniform sampler2D uFieldNoise;
uniform float uCourts[8];
uniform int uCourtCount;
uniform vec4 uFieldCover; // clover cover, dry cover, wear strength, wild (0/1)
vec2 lawnRot(vec2 p) { return vec2(0.8 * p.x + 0.6 * p.y, -0.6 * p.x + 0.8 * p.y); }
float lawnMacro(vec2 p) {
  return 0.62 * texture2D(uFieldNoise, p / 67.0).r + 0.38 * texture2D(uFieldNoise, lawnRot(p) / 19.0).r;
}
float lawnHue(vec2 p) { vec2 r = lawnRot(p); return texture2D(uFieldNoise, vec2(r.y, r.x) / 41.0).g; }
vec4 lawnFieldsAt(vec2 p) {
  vec2 r = lawnRot(p);
  float cn = 0.75 * texture2D(uFieldNoise, p / 6.1).g + 0.25 * texture2D(uFieldNoise, r / 2.3).g;
  float cc = 1.0 - uFieldCover.x;
  float clover = uFieldCover.x > 0.0 ? smoothstep(cc - 0.08, cc + 0.1, cn) : 0.0;
  float dn = 0.7 * texture2D(uFieldNoise, p / 16.0).b + 0.3 * texture2D(uFieldNoise, r / 5.3).b;
  float dc = 1.0 - uFieldCover.y;
  float dry = uFieldCover.y > 0.0 ? smoothstep(dc - 0.1, dc + 0.12, dn) : 0.0;
  float wear = 0.0;
  float cMin = 1e4, cMax = -1e4;
  float az = abs(p.y);
  for (int i = 0; i < 8; i++) {
    if (i >= uCourtCount) break;
    float cx = uCourts[i];
    cMin = min(cMin, cx);
    cMax = max(cMax, cx);
    float dx = abs(p.x - cx);
    float lane = (1.0 - smoothstep(0.14, 0.4, abs(dx - 1.08))) * (1.0 - smoothstep(${(HALF_COURT - 1.9).toFixed(4)}, ${(HALF_COURT - 1.0).toFixed(4)}, az)) * 0.7;
    float front = 1.0 - smoothstep(0.35, 1.0, length(vec2(dx / 0.5, (az - ${(HALF_COURT - 1.3).toFixed(4)}) / 0.6)));
    float corner = (1.0 - smoothstep(0.3, 1.0, length(vec2((dx - 1.15) / 0.42, (az - ${(HALF_COURT - 0.55).toFixed(4)}) / 0.5)))) * 0.85;
    wear = max(wear, max(lane, max(front, corner)));
  }
  float breakup = 0.65 * texture2D(uFieldNoise, p / 1.3).a + 0.35 * texture2D(uFieldNoise, r / 0.41).a;
  wear = clamp(wear * (0.55 + 0.9 * breakup) - 0.08, 0.0, 1.0) * uFieldCover.z;
  float wild = 0.0;
  if (uFieldCover.w > 0.0 && uCourtCount > 0) {
    float side = max(max(cMin - p.x, p.x - cMax), 0.0) - 5.0;
    float d = max(side, az - ${(HALF_COURT + 6).toFixed(4)}) + (texture2D(uFieldNoise, p / 11.0).r - 0.5) * 3.0;
    wild = smoothstep(-0.6, 1.2, d);
  }
  return vec4(clover, dry, wear, wild);
}
`;

/** Uniform values for `LAWN_FIELDS_GLSL`. */
export function lawnFieldUniforms(look: GrassLook, courts: readonly number[]) {
  const list = new Array<number>(8).fill(0);
  courts.slice(0, 8).forEach((c, i) => (list[i] = c));
  return {
    uFieldNoise: { value: fieldNoiseTexture() },
    uCourts: { value: list },
    uCourtCount: { value: Math.min(8, courts.length) },
    uFieldCover: { value: new THREE.Vector4(look.cloverCover, look.dryCover, look.wear, look.wild ? 1 : 0) },
  };
}
