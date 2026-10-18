import * as THREE from 'three';
import { HALF_COURT } from '../core/constants';
import { BODY_MATS, type BodyMesh } from './humanBody';

/**
 * Spectators and scoreboards: instanced seated people (any venue can seat
 * them, on bleachers or park benches) and the big canvas-drawn boards at
 * the championship grounds.
 */

/** A place to sit: the seat surface point, which way the sitter faces, and which stand (culling group) it belongs to. */
export interface Seat {
  x: number;
  y: number;
  z: number;
  facing: number;
  stand: number;
}

/** Height of the seated body's seat contact above its origin. */
const SEAT_Y = 0.79;

/** Instanced seated spectators who fidget and jump up to cheer. */
export class Crowd {
  /** One instanced mesh per stand so an off-screen stand is culled whole. */
  private stands: { mesh: THREE.InstancedMesh; from: number; to: number }[] = [];
  private seats: { pos: THREE.Vector3; facing: number; phase: number; scale: number; stand: number }[] = [];
  private excitement = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(group: THREE.Group, seats: Seat[], crowdBody: BodyMesh) {
    // Seats grouped by stand: one instanced mesh per stand so an off-screen stand is culled whole.
    const sorted = [...seats].sort((a, b) => a.stand - b.stand);
    for (const s of sorted)
      this.seats.push({
        pos: new THREE.Vector3(s.x, s.y + 0.03 - SEAT_Y, s.z),
        facing: s.facing,
        phase: Math.random() * 10,
        scale: 0.9 + Math.random() * 0.2,
        stand: s.stand,
      });
    const n = this.seats.length;
    // Seated spectators: the sculpted body, with per-person shirt, skin and trousers.
    const src = crowdBody.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('normal', src.getAttribute('normal'));
    geo.setIndex(src.getIndex());
    const ao = src.getAttribute('color');
    const vc = ao.count;
    const base = new Float32Array(vc * 3);
    const masks = new Float32Array(vc * 3);
    const aoA = new Float32Array(vc);
    const fixed: Record<string, THREE.Color> = { belt: new THREE.Color('#2e2015'), shoe: new THREE.Color('#d8d6d0'), sole: new THREE.Color('#5a4630'), hair: new THREE.Color('#2a1d12') };
    for (let i = 0; i < vc; i++) {
      const a = BODY_MATS[crowdBody.vmats[i * 2]], b = BODY_MATS[crowdBody.vmats[i * 2 + 1]], w = crowdBody.vmatW[i];
      const o = ao.getX(i);
      aoA[i] = o;
      const mask = (m: string) => (a === m ? w : 0) + (b === m ? 1 - w : 0);
      masks[i * 3] = mask('shirt');
      masks[i * 3 + 1] = mask('skin');
      masks[i * 3 + 2] = mask('pants');
      const fa = fixed[a] ?? new THREE.Color(0, 0, 0), fb = fixed[b] ?? new THREE.Color(0, 0, 0);
      base[i * 3] = (fa.r * (fixed[a] ? w : 0) + fb.r * (fixed[b] ? 1 - w : 0)) * o;
      base[i * 3 + 1] = (fa.g * (fixed[a] ? w : 0) + fb.g * (fixed[b] ? 1 - w : 0)) * o;
      base[i * 3 + 2] = (fa.b * (fixed[a] ? w : 0) + fb.b * (fixed[b] ? 1 - w : 0)) * o;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(base, 3));
    geo.setAttribute('masks', new THREE.BufferAttribute(masks, 3));
    geo.setAttribute('aoV', new THREE.BufferAttribute(aoA, 1));
    const shirts = ['#c0392b', '#2471a3', '#f4d03f', '#ffffff', '#27ae60', '#e67e22', '#34495e', '#8e44ad', '#ecf0f1', '#1abc9c', '#d35400', '#7f8c8d', '#13294b', '#b03060'];
    const skins = ['#e8b98f', '#d39a72', '#b5774c', '#8d5524', '#f1cfae', '#a0623a'];
    const pants = ['#2c3e5c', '#3b3f46', '#6b5a43', '#22324d', '#4a4a4a', '#8a7a5a'];
    const sc = new Float32Array(n * 3), kc = new Float32Array(n * 3), pc = new Float32Array(n * 3);
    const c = new THREE.Color();
    const pick = (arr: string[]) => c.set(arr[Math.floor(Math.random() * arr.length)]);
    for (let i = 0; i < n; i++) {
      pick(shirts).toArray(sc, i * 3);
      pick(skins).toArray(kc, i * 3);
      pick(pants).toArray(pc, i * 3);
    }
    geo.setAttribute('shirtCol', new THREE.InstancedBufferAttribute(sc, 3));
    geo.setAttribute('skinCol', new THREE.InstancedBufferAttribute(kc, 3));
    geo.setAttribute('pantsCol', new THREE.InstancedBufferAttribute(pc, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 masks;\nattribute float aoV;\nattribute vec3 shirtCol;\nattribute vec3 skinCol;\nattribute vec3 pantsCol;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = color.rgb + aoV * (masks.x * shirtCol + masks.y * skinCol + masks.z * pantsCol);');
    };
    for (let from = 0; from < n; ) {
      let to = from + 1;
      while (to < n && this.seats[to].stand === this.seats[from].stand) to++;
      const mesh = new THREE.InstancedMesh(geo, mat, to - from);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      group.add(mesh);
      this.stands.push({ mesh, from, to });
      from = to;
    }
    this.update(0, 0);
    for (const st of this.stands) {
      st.mesh.computeBoundingSphere();
      st.mesh.boundingSphere!.radius += 0.6;
    }
  }

  /** 0..1 burst of excitement (ringer, double ringer…). */
  cheer(amount: number) {
    this.excitement = Math.min(1.5, this.excitement + amount);
  }

  update(dt: number, time: number) {
    this.excitement = Math.max(0, this.excitement - dt * 0.45);
    const ex = this.excitement;
    for (const stand of this.stands)
      for (let i = stand.from; i < stand.to; i++) {
        const st = this.seats[i];
        const idle = Math.sin(time * 1.3 + st.phase) * 0.01;
        const jump = ex > 0.05 ? Math.max(0, Math.sin(time * 9 + st.phase * 3)) * 0.12 * Math.min(1, ex) * (0.5 + (st.phase % 1)) : 0;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), st.facing + Math.sin(time * 0.4 + st.phase) * 0.15);
        this.s.setScalar(st.scale);
        this.m.compose(this.v.copy(st.pos).setY(st.pos.y + idle + jump), this.q, this.s);
        stand.mesh.setMatrixAt(i - stand.from, this.m);
      }
    for (const st of this.stands) st.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Big end-of-court scoreboard drawn to a canvas texture. */
export class Scoreboard {
  readonly mesh: THREE.Group;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;

  constructor(end: 0 | 1) {
    this.canvas.width = 1024;
    this.canvas.height = 512;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mesh = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.3, 0.25), new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6 }));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 2.05), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    face.position.z = 0.13;
    const legMat = new THREE.MeshStandardMaterial({ color: 0x4a4f55, metalness: 0.6, roughness: 0.5 });
    for (const sx of [-1.6, 1.6]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.2, 0.15), legMat);
      leg.position.set(sx, -2.2, -0.05);
      this.mesh.add(leg);
    }
    this.mesh.add(frame, face);
    const z = end === 0 ? -(HALF_COURT + 7.5) : HALF_COURT + 7.5;
    this.mesh.position.set(0, 3.9, z);
    this.mesh.rotation.y = end === 0 ? 0 : Math.PI;
    this.draw(['—', '—'], [0, 0], 'RINGERS', '');
  }

  draw(names: [string, string] | string[], scores: number[], title: string, sub: string) {
    const g = this.canvas.getContext('2d')!;
    const W = 1024, H = 512;
    g.fillStyle = '#07090c';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2c14e';
    g.font = '700 54px Oswald, Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(title.toUpperCase(), W / 2, 56);
    g.fillStyle = '#7f8b99';
    g.font = '500 32px Oswald, Impact, sans-serif';
    g.fillText(sub.toUpperCase(), W / 2, 106);
    for (let i = 0; i < 2; i++) {
      const y = 210 + i * 150;
      g.textAlign = 'left';
      g.fillStyle = '#e8edf2';
      g.font = '600 62px Oswald, Impact, sans-serif';
      g.fillText((names[i] ?? '').toUpperCase().slice(0, 18), 50, y);
      g.textAlign = 'right';
      g.fillStyle = '#ff9f1c';
      g.font = '700 110px Oswald, Impact, sans-serif';
      g.fillText(String(scores[i] ?? 0), W - 50, y + 6);
    }
    this.tex.needsUpdate = true;
  }
}
