import * as THREE from 'three';
import { softDot } from './textures';

/**
 * Sand spray (ballistic grains that settle), dust puffs and steel sparks.
 * One Points draw call per effect type with fixed-size ring buffers.
 */

const GRAIN_VS = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const GRAIN_FS = /* glsl */ `
  uniform sampler2D map;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    if (t.a * vAlpha < 0.02) discard;
    gl_FragColor = vec4(vTint, t.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

class PointPool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private baseSize: Float32Array;
  private alpha: Float32Array;
  private tint: Float32Array;
  private next = 0;

  constructor(
    readonly capacity: number,
    blending: THREE.Blending,
    private readonly drag: number,
    private readonly gravity: number,
    private readonly grow: number,
    private readonly floorY: number | null,
  ) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.tint = new Float32Array(capacity * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: softDot() } },
      vertexShader: GRAIN_VS,
      fragmentShader: GRAIN_FS,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.tint.set([color.r, color.g, color.b], i * 3);
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      const d = Math.exp(-this.drag * dt);
      this.vel[k] *= d;
      this.vel[k + 2] *= d;
      this.vel[k + 1] = this.vel[k + 1] * d - this.gravity * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.floorY !== null && this.pos[k + 1] < this.floorY) {
        this.pos[k + 1] = this.floorY;
        this.vel[k] = this.vel[k + 1] = this.vel[k + 2] = 0;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.baseSize[i] * (1 + this.grow * t);
      this.alpha[i] = Math.min(1, (1 - t) * 1.6);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.tint.needsUpdate = true;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private grains: PointPool;
  private dust: PointPool;
  private sparks: PointPool;
  private readonly v = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private sandColor: THREE.Color) {
    this.grains = new PointPool(900, THREE.NormalBlending, 0.6, 9.81, 0, 0.002);
    this.dust = new PointPool(160, THREE.NormalBlending, 2.2, -0.15, 3.5, null);
    this.sparks = new PointPool(120, THREE.AdditiveBlending, 1.0, 9.81, -0.6, 0.0);
    this.group.add(this.grains.points, this.dust.points, this.sparks.points);
  }

  setSandColor(c: THREE.Color) {
    this.sandColor = c;
  }

  /** Spray of grains and a dust puff where a shoe hits the pit. */
  sandImpact(at: THREE.Vector3, vel: THREE.Vector3, energy: number) {
    const n = Math.min(160, Math.floor(18 + energy * 22));
    const fwd = this.v.set(vel.x, 0, vel.z);
    const speed = fwd.length();
    if (speed > 1e-3) fwd.multiplyScalar(1 / speed);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.4 + Math.random() * 1.6) * Math.min(2.2, 0.4 + energy * 0.22);
      const v = new THREE.Vector3(Math.cos(a) * s * 0.6 + fwd.x * s * 0.9, (0.6 + Math.random() * 1.6) * Math.min(1.8, 0.4 + energy * 0.2), Math.sin(a) * s * 0.6 + fwd.z * s * 0.9);
      this.p.set(at.x + (Math.random() - 0.5) * 0.06, 0.004, at.z + (Math.random() - 0.5) * 0.06);
      this.c.copy(this.sandColor).multiplyScalar(0.75 + Math.random() * 0.4);
      this.grains.spawn(this.p, v, 0.7 + Math.random() * 0.9, 0.012 + Math.random() * 0.012, this.c);
    }
    const puffs = Math.min(14, 3 + Math.floor(energy * 1.5));
    for (let i = 0; i < puffs; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.4 + fwd.x * 0.3, 0.1 + Math.random() * 0.25, (Math.random() - 0.5) * 0.4 + fwd.z * 0.3);
      this.p.set(at.x + (Math.random() - 0.5) * 0.08, 0.03, at.z + (Math.random() - 0.5) * 0.08);
      this.c.copy(this.sandColor).lerp(new THREE.Color(1, 1, 1), 0.25);
      this.dust.spawn(this.p, v, 1.0 + Math.random() * 0.9, 0.14 + Math.random() * 0.1, this.c);
    }
  }

  /** A few short-lived sparks for a hard steel-on-steel strike. */
  steelStrike(at: THREE.Vector3, energy: number) {
    if (energy < 2.5) return;
    const n = Math.min(26, Math.floor((energy - 2) * 5));
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.2, (Math.random() - 0.5) * 3);
      this.c.setRGB(1, 0.75 + Math.random() * 0.2, 0.4);
      this.sparks.spawn(at, v, 0.18 + Math.random() * 0.2, 0.012, this.c);
    }
  }

  update(dt: number) {
    this.grains.update(dt);
    this.dust.update(dt);
    this.sparks.update(dt);
  }
}
