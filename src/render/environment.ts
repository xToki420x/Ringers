import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_COURT } from '../core/constants';
import type { TimeOfDay } from '../game/match';
import { COURT_SPACING } from './court';
import { bannerTexture, fbm, type MapSet, type Quality } from './textures';
import { flat } from './geo';

/**
 * Park setting for a championship: sky and sun, lawn, tree line,
 * aluminium bleachers full of spectators, sponsor banners, flags,
 * light towers and scoreboards.
 */

export interface Lighting {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  exposure: number;
  fog: THREE.Color;
  fogDensity: number;
  turbidity: number;
  rayleigh: number;
  night: boolean;
}

export function lightingFor(t: TimeOfDay): Lighting {
  const dir = (elev: number, az: number) =>
    new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
  switch (t) {
    case 'morning':
      return { sunDir: dir(0.42, 2.2), sunColor: new THREE.Color(1, 0.93, 0.82), sunIntensity: 3.0, hemiSky: new THREE.Color(0.75, 0.84, 1), hemiGround: new THREE.Color(0.34, 0.36, 0.22), hemiIntensity: 0.9, exposure: 0.95, fog: new THREE.Color(0.78, 0.84, 0.9), fogDensity: 0.0065, turbidity: 4, rayleigh: 1.6, night: false };
    case 'afternoon':
      return { sunDir: dir(0.95, -0.7), sunColor: new THREE.Color(1, 0.97, 0.92), sunIntensity: 3.4, hemiSky: new THREE.Color(0.72, 0.82, 1), hemiGround: new THREE.Color(0.32, 0.36, 0.2), hemiIntensity: 1.0, exposure: 0.9, fog: new THREE.Color(0.74, 0.82, 0.92), fogDensity: 0.005, turbidity: 3, rayleigh: 1.2, night: false };
    case 'sunset':
      return { sunDir: dir(0.11, -1.9), sunColor: new THREE.Color(1, 0.62, 0.36), sunIntensity: 3.2, hemiSky: new THREE.Color(0.55, 0.55, 0.78), hemiGround: new THREE.Color(0.3, 0.22, 0.14), hemiIntensity: 0.75, exposure: 1.05, fog: new THREE.Color(0.86, 0.62, 0.48), fogDensity: 0.007, turbidity: 8, rayleigh: 2.6, night: false };
    case 'night':
      return { sunDir: dir(1.15, 0.5), sunColor: new THREE.Color(0.92, 0.95, 1), sunIntensity: 2.6, hemiSky: new THREE.Color(0.12, 0.15, 0.26), hemiGround: new THREE.Color(0.06, 0.07, 0.05), hemiIntensity: 0.6, exposure: 1.0, fog: new THREE.Color(0.03, 0.04, 0.07), fogDensity: 0.012, turbidity: 1, rayleigh: 0.2, night: true };
  }
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  private stars: THREE.Points;
  private nightDome: THREE.Mesh;
  private lampGlows: THREE.Sprite[] = [];
  private lampHeads: THREE.Mesh;
  private flags: { mesh: THREE.Mesh; base: Float32Array; phase: number }[] = [];
  readonly crowd: Crowd;
  readonly scoreboards: Scoreboard[] = [];
  lighting: Lighting = lightingFor('afternoon');

  constructor(
    readonly scene: THREE.Scene,
    grass: MapSet,
    quality: Quality,
  ) {
    scene.add(this.group);
    // Sky.
    this.sky = new Sky();
    this.sky.scale.setScalar(900);
    this.group.add(this.sky);
    const domeGeo = new THREE.SphereGeometry(880, 32, 16);
    const domeCols: number[] = [];
    const p = domeGeo.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 880;
      const t = Math.max(0, y);
      domeCols.push(0.02 + 0.03 * (1 - t), 0.03 + 0.04 * (1 - t), 0.07 + 0.08 * (1 - t));
    }
    domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(domeCols, 3));
    this.nightDome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.group.add(this.nightDome);
    const starPos: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      starPos.push(Math.cos(a) * r * 850, y * 850, Math.sin(a) * r * 850);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
    this.group.add(this.stars);

    // Lights.
    this.hemi = new THREE.HemisphereLight(0xbfd5ff, 0x4a5a2a, 1);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const ms = quality === 'high' ? 2048 : quality === 'medium' ? 1536 : 1024;
    this.sun.shadow.mapSize.set(ms, ms);
    const sc = this.sun.shadow.camera;
    sc.left = -1.6;
    sc.right = 1.6;
    sc.top = 1.6;
    sc.bottom = -1.6;
    sc.near = 0.5;
    sc.far = 40;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.012;
    this.sun.shadow.radius = 3;
    this.group.add(this.sun, this.sun.target);

    // Lawn: a subdivided ground with mowing stripes and macro tonal variation
    // baked into vertex colours so the tiled grass never looks repetitive.
    const lawnMap = grass.map.clone();
    lawnMap.repeat.set(110, 110);
    lawnMap.needsUpdate = true;
    const lawnNormal = grass.normalMap.clone();
    lawnNormal.repeat.set(110, 110);
    lawnNormal.needsUpdate = true;
    const lawnGeo = new THREE.PlaneGeometry(240, 240, 96, 96);
    lawnGeo.rotateX(-Math.PI / 2);
    const lp = lawnGeo.getAttribute('position');
    const lc: number[] = [];
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i), z = lp.getZ(i);
      const stripe = Math.floor((x + 120) / 2.4) % 2 === 0 ? 1.06 : 0.92;
      const macro = 0.85 + fbm(x * 0.03 + 50, z * 0.03 + 50, 64, 3, 81) * 0.3;
      const worn = Math.abs(x) < 10 && Math.abs(z) < HALF_COURT + 3 ? 0.97 : 1;
      const k = stripe * macro * worn;
      lc.push(k, k, k * 0.96);
    }
    lawnGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    const lawn = new THREE.Mesh(lawnGeo, new THREE.MeshStandardMaterial({ map: lawnMap, normalMap: lawnNormal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95, vertexColors: true }));
    lawn.position.y = -0.02;
    lawn.receiveShadow = true;
    this.group.add(lawn);
    // Worn lanes between the boxes (players walk them every inning).
    const laneMat = new THREE.MeshStandardMaterial({ map: lawnMap, normalMap: lawnNormal, color: 0xc9bd96, roughness: 1, transparent: true, opacity: 0.4, depthWrite: false });
    for (let c = -2; c <= 2; c++)
      for (const sx of [-1, 1]) {
        const lane = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2 * HALF_COURT - 2), laneMat);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(c * COURT_SPACING + sx * 0.85, -0.017, 0);
        lane.receiveShadow = true;
        this.group.add(lane);
      }

    this.buildTrees(quality);
    this.crowd = new Crowd(this.group, quality);
    this.buildBannersAndFence();
    this.lampHeads = this.buildLightTowers();
    this.buildFlags();
    for (const end of [0, 1] as const) {
      const sb = new Scoreboard(end);
      this.scoreboards.push(sb);
      this.group.add(sb.mesh);
    }
  }

  private buildTrees(q: Quality) {
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3.2, 7);
    trunkGeo.translate(0, 1.6, 0);
    const crowns: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const g = new THREE.IcosahedronGeometry(1.6 - k * 0.15, q === 'high' ? 2 : 1);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i);
        const n = fbm(v.x * 0.9 + k * 3, v.y * 0.9 + v.z * 0.7, 16, 3, 71 + k);
        v.multiplyScalar(0.8 + n * 0.5);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      g.translate((k % 2 ? 0.6 : -0.5) * (k > 1 ? 1 : 0.4), 3.6 + k * 0.7, (k % 3) * 0.3 - 0.3);
      crowns.push(flat(g));
    }
    const crownGeo = mergeGeometries(crowns)!;
    crownGeo.computeVertexNormals();
    // Darker, bluer leaves inside and underneath; sunlit tips lighter.
    const cp = crownGeo.getAttribute('position');
    const cc: number[] = [];
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i);
      const n = fbm(cp.getX(i) * 1.7 + 9, cp.getZ(i) * 1.7 + y, 16, 3, 91);
      const k = 0.6 + Math.min(1, (y - 2.4) / 3.2) * 0.35 + (n - 0.5) * 0.35;
      cc.push(k * 0.95, k, k * 0.9);
    }
    crownGeo.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
    const count = q === 'low' ? 60 : 140;
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4b3a2a, roughness: 1 }), count);
    const leaves = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true }), count);
    const m = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const c = new THREE.Color();
    let n = 0;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    while (n < count) {
      const a = rnd() * Math.PI * 2;
      const r = 32 + rnd() * 60;
      const x = Math.cos(a) * r * 0.75, z = Math.sin(a) * r * 1.15;
      if (Math.abs(x) < 26 && Math.abs(z) < 24) continue;
      const s = 1.1 + rnd() * 1.6;
      q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, 0, z), q4, new THREE.Vector3(s, s * (0.9 + rnd() * 0.4), s));
      trunks.setMatrixAt(n, m);
      leaves.setMatrixAt(n, m);
      c.setHSL(0.24 + rnd() * 0.08, 0.45 + rnd() * 0.2, 0.2 + rnd() * 0.1);
      leaves.setColorAt(n, c);
      n++;
    }
    leaves.castShadow = false;
    this.group.add(trunks, leaves);
  }

  private buildBannersAndFence() {
    const sponsors: [string[], string, string, string?][] = [
      [['RINGERS', 'WORLD HORSESHOE CHAMPIONSHIP'], '#13294b', '#f2c14e', '#c8102e'],
      [['IRONSIDE FORGE', 'DROP-FORGED SINCE 1921'], '#1c1c1c', '#e8833a'],
      [['PRAIRIE KING', 'PITCHING SHOES'], '#8e1b1b', '#fff3d6'],
      [['THUNDER RIDGE', 'HARD STEEL · LOUD RINGERS'], '#0f2f5c', '#ffffff'],
      [['COPPERHEAD PRO'], '#2a1a12', '#d98b54'],
      [['SILVER STAKE', 'CHROME CLASSICS'], '#d8dde3', '#20262c'],
    ];
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8b9096, metalness: 0.7, roughness: 0.5 });
    const posts: THREE.BufferGeometry[] = [];
    let k = 0;
    for (const end of [-1, 1]) {
      const z = end * (HALF_COURT + 5.5);
      for (let i = -5; i <= 5; i++) {
        const x = i * 4.2;
        const g = new THREE.CylinderGeometry(0.035, 0.035, 1.3, 6);
        g.translate(x, 0.65, z);
        posts.push(g);
        if (i < 5) {
          const [lines, bg, fg, accent] = sponsors[k++ % sponsors.length];
          const tex = bannerTexture(lines, bg, fg, 1024, 256, accent);
          const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 1.0), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
          banner.position.set(x + 2.1, 0.62, z);
          banner.rotation.y = end > 0 ? Math.PI : 0;
          banner.receiveShadow = true;
          this.group.add(banner);
        }
      }
    }
    this.group.add(new THREE.Mesh(mergeGeometries(posts)!, fenceMat));
  }

  private buildLightTowers(): THREE.Mesh {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x7c8288, metalness: 0.6, roughness: 0.5 });
    const headGeos: THREE.BufferGeometry[] = [];
    const poles: THREE.BufferGeometry[] = [];
    const glowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,250,235,1)');
      gr.addColorStop(0.2, 'rgba(255,240,210,0.6)');
      gr.addColorStop(1, 'rgba(255,230,200,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * 16, z = sz * (HALF_COURT + 2);
        const g = new THREE.CylinderGeometry(0.12, 0.2, 14, 8);
        g.translate(x, 7, z);
        poles.push(g);
        for (let i = 0; i < 4; i++) {
          const h = new THREE.BoxGeometry(0.55, 0.45, 0.25);
          const ox = (i - 1.5) * 0.62;
          h.translate(x + ox * Math.abs(sz), 14.2, z + ox * 0);
          headGeos.push(h);
          const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff2d8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
          s.position.set(x + ox, 14.2, z - sz * 0.2);
          s.scale.setScalar(3.2);
          s.visible = false;
          this.lampGlows.push(s);
          this.group.add(s);
        }
      }
    this.group.add(new THREE.Mesh(mergeGeometries(poles)!, poleMat));
    const heads = new THREE.Mesh(mergeGeometries(headGeos)!, new THREE.MeshStandardMaterial({ color: 0x30343a, emissive: 0x000000, roughness: 0.4 }));
    this.group.add(heads);
    return heads;
  }

  private buildFlags() {
    const cols = [['#b22234', '#ffffff', '#3c3b6e'], ['#13294b', '#f2c14e', '#13294b'], ['#c8102e', '#ffffff', '#c8102e']];
    cols.forEach((c, i) => {
      const x = (i - 1) * 6;
      const z = -(HALF_COURT + 8);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 8, 8), new THREE.MeshStandardMaterial({ color: 0xd0d4d8, metalness: 0.8, roughness: 0.3 }));
      pole.position.set(x, 4, z);
      this.group.add(pole);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 160;
      const g = canvas.getContext('2d')!;
      c.forEach((col, k) => {
        g.fillStyle = col;
        g.fillRect(0, (k * 160) / 3, 256, 160 / 3 + 1);
      });
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = new THREE.PlaneGeometry(1.8, 1.1, 18, 6);
      geo.translate(0.9, 0, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
      mesh.position.set(x + 0.05, 7.3, z);
      this.group.add(mesh);
      this.flags.push({ mesh, base: Float32Array.from(geo.getAttribute('position').array as Float32Array), phase: i * 1.3 });
    });
  }

  apply(t: TimeOfDay, renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const L = (this.lighting = lightingFor(t));
    const u = this.sky.material.uniforms;
    u.turbidity.value = L.turbidity;
    u.rayleigh.value = L.rayleigh;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(L.sunDir).multiplyScalar(400);
    this.sky.visible = !L.night;
    this.nightDome.visible = L.night;
    this.stars.visible = L.night;
    this.sun.color.copy(L.sunColor);
    this.sun.intensity = L.sunIntensity;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    this.hemi.intensity = L.hemiIntensity;
    renderer.toneMappingExposure = L.exposure;
    scene.fog = new THREE.FogExp2(L.fog, L.fogDensity);
    for (const g of this.lampGlows) g.visible = L.night;
    (this.lampHeads.material as THREE.MeshStandardMaterial).emissive.set(L.night ? 0xfff1d0 : 0x000000);
    (this.lampHeads.material as THREE.MeshStandardMaterial).emissiveIntensity = L.night ? 3 : 0;
  }

  /** Aim the sun's shadow frustum at a point of interest (the target pit). */
  focusShadows(p: THREE.Vector3) {
    const L = this.lighting;
    const dir = L.night ? new THREE.Vector3(0.25, 1, p.z > 0 ? -0.35 : 0.35).normalize() : L.sunDir;
    // Keep low sunset sun from producing absurdly long shadow volumes.
    const d = dir.clone();
    if (d.y < 0.25) {
      d.y = 0.25;
      d.normalize();
    }
    this.sun.position.copy(p).addScaledVector(d, 15);
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  update(dt: number, time: number) {
    for (const f of this.flags) {
      const pos = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = f.base[i * 3];
        const y = f.base[i * 3 + 1];
        const w = x / 1.8;
        pos.setZ(i, Math.sin(time * 3.1 + x * 3.2 + f.phase) * 0.12 * w + Math.sin(time * 5.3 + y * 4) * 0.03 * w);
      }
      pos.needsUpdate = true;
      f.mesh.geometry.computeVertexNormals();
    }
    this.crowd.update(dt, time);
  }
}

/** Instanced spectators in bleachers along both sides of the courts. */
export class Crowd {
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private caps: THREE.InstancedMesh;
  private seats: { pos: THREE.Vector3; facing: number; phase: number; scale: number }[] = [];
  private excitement = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(group: THREE.Group, q: Quality) {
    const benchMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.8, roughness: 0.35 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x5d6369, metalness: 0.6, roughness: 0.5 });
    const rows = 5;
    const benches: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const sideX = 3 * COURT_SPACING + 2.6;
    const perRow = q === 'low' ? 10 : 18;
    for (const sx of [-1, 1]) {
      for (const seg of [-1, 1]) {
        const zc = seg * 3.4;
        for (let r = 0; r < rows; r++) {
          const x = sx * (sideX + r * 0.75);
          const y = 0.45 + r * 0.42;
          const g = new THREE.BoxGeometry(0.32, 0.05, 5.6);
          g.translate(x, y, zc);
          benches.push(g);
          const f = new THREE.BoxGeometry(0.28, 0.03, 5.6);
          f.translate(x + sx * 0.32, y - 0.22, zc);
          benches.push(f);
          for (let k = 0; k < perRow; k++) {
            if (Math.random() < 0.18) continue;
            this.seats.push({
              pos: new THREE.Vector3(x, y + 0.03, zc - 2.6 + (5.2 * (k + 0.5)) / perRow + (Math.random() - 0.5) * 0.08),
              facing: sx > 0 ? -Math.PI / 2 : Math.PI / 2,
              phase: Math.random() * 10,
              scale: 0.9 + Math.random() * 0.2,
            });
          }
        }
        for (let k = 0; k < 4; k++) {
          const g = new THREE.BoxGeometry(0.06, 0.45 + rows * 0.42, 0.06);
          g.translate(sx * (sideX + (rows - 1) * 0.75 + 0.2), (0.45 + rows * 0.42) / 2, zc - 2.7 + k * 1.8);
          frames.push(g);
        }
      }
    }
    group.add(new THREE.Mesh(mergeGeometries(benches)!, benchMat), new THREE.Mesh(mergeGeometries(frames)!, frameMat));

    const n = this.seats.length;
    const bodyGeo = new THREE.CapsuleGeometry(0.17, 0.42, 3, 8);
    bodyGeo.translate(0, 0.38, 0);
    const legGeo = new THREE.BoxGeometry(0.3, 0.14, 0.42);
    legGeo.translate(0, 0.07, 0.17);
    const body = mergeGeometries([flat(bodyGeo), flat(legGeo)])!;
    const headGeo = new THREE.SphereGeometry(0.11, 10, 7);
    headGeo.translate(0, 0.92, 0);
    const capGeo = new THREE.SphereGeometry(0.118, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    const brim = new THREE.CylinderGeometry(0.12, 0.12, 0.012, 8, 1, false, -Math.PI / 2, Math.PI);
    brim.scale(1, 1, 1.4);
    brim.translate(0, 0, 0.06);
    const capMerged = mergeGeometries([flat(capGeo), flat(brim)])!;
    capMerged.translate(0, 0.94, 0);
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.85 }), n);
    this.heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), n);
    this.caps = new THREE.InstancedMesh(capMerged, new THREE.MeshStandardMaterial({ roughness: 0.8 }), n);
    const shirts = ['#c0392b', '#2471a3', '#f4d03f', '#ffffff', '#27ae60', '#e67e22', '#34495e', '#8e44ad', '#ecf0f1', '#1abc9c', '#d35400', '#7f8c8d'];
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      this.bodies.setColorAt(i, c.set(shirts[Math.floor(Math.random() * shirts.length)]));
      this.heads.setColorAt(i, c.set(skins[Math.floor(Math.random() * skins.length)]));
      this.caps.setColorAt(i, c.set(Math.random() < 0.45 ? shirts[Math.floor(Math.random() * shirts.length)] : skins[0]));
    }
    this.caps.count = n;
    for (const im of [this.bodies, this.heads, this.caps]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(im);
    }
    this.update(0, 0);
  }

  /** 0..1 burst of excitement (ringer, double ringer…). */
  cheer(amount: number) {
    this.excitement = Math.min(1.5, this.excitement + amount);
  }

  update(dt: number, time: number) {
    this.excitement = Math.max(0, this.excitement - dt * 0.45);
    const ex = this.excitement;
    for (let i = 0; i < this.seats.length; i++) {
      const st = this.seats[i];
      const idle = Math.sin(time * 1.3 + st.phase) * 0.01;
      const jump = ex > 0.05 ? Math.max(0, Math.sin(time * 9 + st.phase * 3)) * 0.12 * Math.min(1, ex) * (0.5 + (st.phase % 1)) : 0;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), st.facing + Math.sin(time * 0.4 + st.phase) * 0.15);
      this.s.setScalar(st.scale);
      this.m.compose(this.v.copy(st.pos).setY(st.pos.y + idle + jump), this.q, this.s);
      this.bodies.setMatrixAt(i, this.m);
      this.heads.setMatrixAt(i, this.m);
      this.caps.setMatrixAt(i, this.m);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
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
