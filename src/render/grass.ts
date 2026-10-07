import * as THREE from 'three';
import { BOX, HALF_COURT, PIT } from '../core/constants';
import type { Quality } from './textures';

/**
 * Instanced 3D grass: individual mown blades with a root-to-tip colour
 * ramp, per-blade lean and tint, wind sway and soft rounded normals, lit,
 * shadowed and fogged by the standard PBR pipeline. Blades fill the main
 * court and the lawn around both pitching boxes (where close-up cameras go),
 * and thin out across neighbouring courts.
 */

export interface GrassRegion {
  /** Exclusion test: true where grass must not grow (pits, boxes, platforms). */
  blocked(x: number, z: number): boolean;
}

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Grass {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = { uTime: { value: 0 }, uWind: { value: 1 } };

  constructor(q: Quality) {
    // One blade: a tapered, slightly cupped strip of 4 segments.
    const seg = 4;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const w = 0.0034 * (1 - t * 0.92);
      pos.push(-w, t, 0.0006, w, t, 0.0006);
      uv.push(0, t, 1, t);
      if (i < seg) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const blade = new THREE.InstancedBufferGeometry();
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    blade.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    blade.setIndex(idx);

    // Scatter blades. Density per square metre by zone.
    const dens = q === 'high' ? 1 : q === 'medium' ? 0.5 : 0.2;
    const rnd = rand(1234);
    const offsets: number[] = [];
    const params: number[] = [];
    const blocked = (x: number, z: number) => {
      for (const zc of [-HALF_COURT, HALF_COURT]) {
        const dz = Math.abs(z - zc);
        // Pitcher's box (pit, frame and platforms) plus the backboard footing.
        if (Math.abs(x) < BOX.width / 2 + 0.03 && dz < BOX.length / 2 + 0.03) return true;
        if (Math.abs(x) < BOX.width / 2 + 0.05 && Math.abs(dz - BOX.backboardDistance) < 0.06) return true;
        // Extended 30 ft platforms.
        const inner = PIT.width / 2 + BOX.frameWidth;
        if (Math.abs(x) > inner - 0.02 && Math.abs(x) < BOX.width / 2 + 0.03 && dz > BOX.length / 2 - 0.05 && dz < BOX.length / 2 + 3.06 && Math.sign(z - zc) === -Math.sign(zc)) return true;
      }
      return false;
    };
    const scatter = (x0: number, x1: number, z0: number, z1: number, perM2: number) => {
      const n = Math.floor((x1 - x0) * (z1 - z0) * perM2 * dens);
      for (let i = 0; i < n; i++) {
        const x = x0 + rnd() * (x1 - x0);
        const z = z0 + rnd() * (z1 - z0);
        if (blocked(x, z)) continue;
        offsets.push(x, -0.02, z);
        // height, yaw, lean, tint
        params.push(0.035 + rnd() * 0.035, rnd() * Math.PI * 2, 0.25 + rnd() * 0.5, rnd());
      }
    };
    // Main court and the lawn beyond each box (close-up territory).
    scatter(-2.0, 2.0, -HALF_COURT - 3.2, HALF_COURT + 3.2, 820);
    scatter(-4.5, -2.0, -HALF_COURT - 3.2, HALF_COURT + 3.2, 220);
    scatter(2.0, 4.5, -HALF_COURT - 3.2, HALF_COURT + 3.2, 220);
    blade.setAttribute('offset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 3));
    blade.setAttribute('params', new THREE.InstancedBufferAttribute(new Float32Array(params), 4));
    blade.instanceCount = offsets.length / 3;

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uWind = this.uniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec3 offset;
          attribute vec4 params;
          uniform float uTime;
          uniform float uWind;
          varying float vT;
          varying float vTint;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `float yaw = params.y;
          float cy = cos(yaw), sy = sin(yaw);
          // Rounded, mostly-up normals give soft lawn shading.
          vec3 objectNormal = normalize(vec3(sy * 0.35, 1.0, cy * 0.35));`,
        )
        .replace(
          '#include <begin_vertex>',
          `float h = params.x;
          float t = position.y;
          vec3 transformed = vec3(position.x, 0.0, position.z);
          transformed = vec3(transformed.x * cy - transformed.z * sy, 0.0, transformed.x * sy + transformed.z * cy);
          float lean = params.z * t * t;
          float gust = sin(uTime * 1.7 + offset.x * 0.9 + offset.z * 0.6) * 0.5 + sin(uTime * 3.1 + offset.z * 2.3) * 0.25;
          vec2 bend = vec2(sy, cy) * lean * 0.6 + vec2(0.35, 0.15) * gust * uWind * t * t * 0.35;
          transformed.x += bend.x * h;
          transformed.z += bend.y * h;
          transformed.y = t * h * (1.0 - 0.15 * lean);
          transformed += offset;
          vT = t;
          vTint = params.w;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying float vT;
          varying float vTint;`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
          vec3 normal = normalize( vNormal );
          vec3 nonPerturbedNormal = normal;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec3 root = vec3(0.045, 0.085, 0.022);
          vec3 tipA = vec3(0.19, 0.33, 0.07);
          vec3 tipB = vec3(0.3, 0.38, 0.1);
          vec3 tip = mix(tipA, tipB, smoothstep(0.55, 1.0, vTint));
          diffuseColor.rgb = mix(root, tip, smoothstep(0.0, 0.85, vT)) * (0.85 + vTint * 0.3);`,
        );
    };
    this.mesh = new THREE.Mesh(blade, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  get count() {
    return (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }
}
