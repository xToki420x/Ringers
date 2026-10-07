import * as THREE from 'three';
import { HALF_COURT, STAKE, foulLineFromTarget, type PitchDistance } from '../core/constants';
import type { Loadout } from '../core/equipment';
import type { TimeOfDay } from '../game/match';
import { stakeZ, type PhysicsWorld, type PitMaterial } from '../physics/physicsWorld';
import { PLATFORM_X } from '../physics/throwModel';
import { buildCourt, courtMaterials, COURT_SPACING } from './court';
import { Environment } from './environment';
import { Particles } from './particles';
import { LOOKS, Pitcher } from './pitcher';
import { SandPit } from './sandPit';
import { createShoeMesh } from './shoeMesh';
import { concreteMaps, grassMaps, sandMaps, woodMaps, type MapSet, type Quality } from './textures';

/**
 * The 3D world: renderer, scene graph, court, deformable pits, shoes,
 * avatars, particles and the camera rig.
 */

export interface Shot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

/** Canonical (pitching toward +z from end 0) → world for a given pitching end. */
export function toWorld(v: THREE.Vector3, pitchFrom: 0 | 1): THREE.Vector3 {
  return pitchFrom === 0 ? v : v.set(-v.x, v.y, -v.z);
}

export class CameraRig {
  readonly pos = new THREE.Vector3(0, 2, -10);
  readonly look = new THREE.Vector3(0, 0, 0);
  fov = 40;
  private target: Shot = { pos: new THREE.Vector3(0, 2, -10), look: new THREE.Vector3(), fov: 40 };
  /** Exponential smoothing rate (1/s). */
  rate = 4;
  shake = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  set(shot: Shot, instant = false, rate?: number) {
    this.target.pos.copy(shot.pos);
    this.target.look.copy(shot.look);
    this.target.fov = shot.fov;
    if (rate !== undefined) this.rate = rate;
    if (instant) {
      this.pos.copy(shot.pos);
      this.look.copy(shot.look);
      this.fov = shot.fov;
    }
  }

  update(dt: number) {
    const k = 1 - Math.exp(-this.rate * dt);
    this.pos.lerp(this.target.pos, k);
    this.look.lerp(this.target.look, k);
    this.fov += (this.target.fov - this.fov) * k;
    this.camera.position.copy(this.pos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 3);
      const s = this.shake * 0.01;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

interface ShoeVisual {
  mesh: THREE.Mesh;
  /** Visual offset blended out after release (viewmodel → physics). */
  offset: THREE.Vector3;
  lastPos: THREE.Vector3;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly rig: CameraRig;
  env!: Environment;
  pits!: [SandPit, SandPit];
  particles!: Particles;
  readonly pitchers: [Pitcher, Pitcher];
  private shoes = new Map<number, ShoeVisual>();
  private envMap: THREE.Texture | null = null;
  private maps: { sand: MapSet; clay: MapSet; grass: MapSet } | null = null;
  pitKind: PitMaterial = 'sand';
  /** Shoe held in first-person view. */
  viewShoe: THREE.Mesh | null = null;
  private viewShoeLoadout = '';
  private clock = 0;
  readonly quality: Quality;
  private timeOfDay: TimeOfDay = 'afternoon';

  constructor(readonly canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.04, 1200);
    this.scene.add(this.camera);
    this.rig = new CameraRig(this.camera);
    this.pitchers = [new Pitcher(LOOKS[0]), new Pitcher(LOOKS[1])];
    this.resize();
  }

  /** Build all geometry and textures. Yields between heavy steps so a loading bar can update. */
  async build(progress: (f: number, label: string) => void) {
    const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const q = this.quality;
    progress(0.05, 'Raking the pits');
    await yieldFrame();
    const sand = sandMaps(q, 'sand');
    progress(0.2, 'Mixing blue clay');
    await yieldFrame();
    const clay = sandMaps(q, 'clay');
    progress(0.32, 'Mowing the lawn');
    await yieldFrame();
    const grass = grassMaps(q);
    this.maps = { sand, clay, grass };
    progress(0.45, 'Cutting timber');
    await yieldFrame();
    const wood = woodMaps(q, [168, 132, 92]);
    const darkWood = woodMaps(q, [112, 86, 62]);
    const concrete = concreteMaps(q);
    progress(0.6, 'Driving stakes');
    await yieldFrame();
    const mats = courtMaterials(wood, darkWood, concrete, sand);
    for (let c = -2; c <= 2; c++) {
      const court = buildCourt(mats, c * COURT_SPACING, c === 0, c === 0 || Math.abs(c) === 1);
      this.scene.add(court.group);
    }
    this.pits = [
      new SandPit(0, stakeZ(0), sand, 'sand'),
      new SandPit(1, stakeZ(1), sand, 'sand'),
    ];
    this.scene.add(this.pits[0].mesh, this.pits[1].mesh);
    progress(0.72, 'Filling the bleachers');
    await yieldFrame();
    this.env = new Environment(this.scene, grass, q);
    this.particles = new Particles(new THREE.Color(0.77, 0.64, 0.46));
    this.scene.add(this.particles.group);
    for (const p of this.pitchers) this.scene.add(p.root);
    progress(0.85, 'Lighting the courts');
    await yieldFrame();
    this.setTimeOfDay('afternoon');
    progress(1, 'Ready');
  }

  setTimeOfDay(t: TimeOfDay) {
    this.timeOfDay = t;
    this.env.apply(t, this.renderer, this.scene);
    // Environment map for metal reflections, from the sky.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    if (t === 'night') {
      envScene.background = new THREE.Color(0x0b1020);
      const l = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff0d0 }));
      l.position.set(30, 60, 30);
      envScene.add(l);
      const l2 = l.clone();
      l2.position.set(-30, 60, -30);
      envScene.add(l2);
    } else {
      const sky = this.env.sky.clone();
      sky.material = this.env.sky.material;
      envScene.add(sky);
      const ground = new THREE.Mesh(new THREE.CircleGeometry(800, 16), new THREE.MeshBasicMaterial({ color: 0x3d5226 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -1;
      envScene.add(ground);
    }
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
    if (this.envMap) this.envMap.dispose();
    this.envMap = rt.texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = t === 'night' ? 0.5 : 1.0;
    pmrem.dispose();
  }

  get time(): TimeOfDay {
    return this.timeOfDay;
  }

  setPitMaterial(kind: PitMaterial) {
    if (!this.maps || kind === this.pitKind) return;
    this.pitKind = kind;
    for (const end of [0, 1] as const) {
      this.scene.remove(this.pits[end].mesh);
      this.pits[end].mesh.geometry.dispose();
      this.pits[end] = new SandPit(end, stakeZ(end), kind === 'sand' ? this.maps.sand : this.maps.clay, kind);
      this.scene.add(this.pits[end].mesh);
    }
    this.particles.setSandColor(kind === 'sand' ? new THREE.Color(0.77, 0.64, 0.46) : new THREE.Color(0.46, 0.5, 0.53));
  }

  rakePits() {
    for (const p of this.pits) p.rake();
  }

  addShoe(id: number, l: Loadout): THREE.Mesh {
    this.removeShoe(id);
    const mesh = createShoeMesh(l, this.envMap);
    this.scene.add(mesh);
    this.shoes.set(id, { mesh, offset: new THREE.Vector3(), lastPos: new THREE.Vector3() });
    return mesh;
  }

  removeShoe(id: number) {
    const s = this.shoes.get(id);
    if (!s) return;
    this.scene.remove(s.mesh);
    this.shoes.delete(id);
  }

  clearShoes() {
    for (const id of [...this.shoes.keys()]) this.removeShoe(id);
  }

  /** Start a shoe's visual a little away from its physical pose (blends out quickly). */
  setShoeVisualOffset(id: number, offset: THREE.Vector3) {
    this.shoes.get(id)?.offset.copy(offset);
  }

  /** Sync shoe meshes from physics, carve the pits under moving shoes. */
  syncShoes(world: PhysicsWorld, dt: number) {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const [id, vis] of this.shoes) {
      const b = world.shoes.get(id);
      if (!b) continue;
      b.pose(p, q);
      vis.offset.multiplyScalar(Math.exp(-dt * 14));
      vis.mesh.position.copy(p).add(vis.offset);
      vis.mesh.quaternion.copy(q);
      // Carve the fill under any part of a moving shoe that is below the surface.
      if (!b.sleeping && b.py < 0.05) {
        const pit = this.pits[b.pz > 0 ? 1 : 0];
        const dx = p.x - vis.lastPos.x, dz = p.z - vis.lastPos.z;
        const ws = b.ws, sp = b.spheres;
        for (let i = 0; i < b.sphereCount; i += 1) {
          const r = sp[i * 4 + 3];
          const x = ws[i * 3], y = ws[i * 3 + 1] - r, z = ws[i * 3 + 2];
          if (y < 0.006 && pit.contains(x, z)) pit.carve(x, y + r * 0.35, z, r * 1.1, dx, dz);
        }
      }
      vis.lastPos.copy(p);
    }
  }

  // ------------------------------------------------------------ positions

  /** Where a pitcher stands (canonical → world). */
  standPoint(pitchFrom: 0 | 1, distance: PitchDistance, side: 1 | -1): THREE.Vector3 {
    const foulZ = HALF_COURT - foulLineFromTarget(distance);
    return toWorld(new THREE.Vector3(side * PLATFORM_X, 0, foulZ - 0.42), pitchFrom);
  }

  placePitchers(pitchFrom: 0 | 1, distance: PitchDistance, active: 0 | 1, sides: [1 | -1, 1 | -1], hands: [1 | -1, 1 | -1]) {
    const foulZ = HALF_COURT - foulLineFromTarget(distance);
    for (const i of [0, 1] as const) {
      const p = this.pitchers[i];
      p.setHand(hands[i]);
      if (i === active) {
        p.root.position.copy(toWorld(new THREE.Vector3(sides[i] * PLATFORM_X + hands[i] * 0.02, 0, foulZ - 0.42), pitchFrom));
        p.root.rotation.y = pitchFrom === 0 ? 0 : Math.PI;
      } else {
        // Waiting pitcher stands off the box, watching.
        const wp = toWorld(new THREE.Vector3(-sides[active] * 1.35, 0, foulZ - 1.6), pitchFrom);
        p.root.position.copy(wp);
        p.root.rotation.y = (pitchFrom === 0 ? 0 : Math.PI) + (pitchFrom === 0 ? 1 : 1) * -sides[active] * 0.5;
      }
    }
  }

  // ----------------------------------------------------------------- shots

  aimShot(pitchFrom: 0 | 1, distance: PitchDistance, side: 1 | -1, hand: 1 | -1, zoom = false): Shot {
    const foulZ = HALF_COURT - foulLineFromTarget(distance);
    const pos = toWorld(new THREE.Vector3(side * PLATFORM_X - hand * 0.06, 1.62, foulZ - 0.55), pitchFrom);
    const look = toWorld(new THREE.Vector3(0, STAKE.height * 0.45, HALF_COURT - 0.05), pitchFrom);
    return { pos, look, fov: zoom ? 13 : 24 };
  }

  broadcastShot(pitchFrom: 0 | 1, distance: PitchDistance, side: 1 | -1): Shot {
    // TV angle from behind and outside the pitcher: full body plus the court ahead.
    const foulZ = HALF_COURT - foulLineFromTarget(distance);
    const px = side * PLATFORM_X;
    const pos = toWorld(new THREE.Vector3(px + side * 1.7, 1.7, foulZ - 4.9), pitchFrom);
    const look = toWorld(new THREE.Vector3(-side * 0.35, 0.7, foulZ + 4.5), pitchFrom);
    return { pos, look, fov: 40 };
  }

  stakeShot(targetEnd: 0 | 1, side = 1): Shot {
    const z = stakeZ(targetEnd);
    const dir = targetEnd === 1 ? 1 : -1; // direction of travel toward this stake
    return {
      pos: new THREE.Vector3(side * 0.95, 0.5, z - dir * 1.35),
      look: new THREE.Vector3(0, 0.08, z),
      fov: 36,
    };
  }

  resultShot(targetEnd: 0 | 1): Shot {
    const z = stakeZ(targetEnd);
    const dir = targetEnd === 1 ? 1 : -1;
    return { pos: new THREE.Vector3(0.35, 1.05, z - dir * 0.62), look: new THREE.Vector3(0, 0, z + dir * 0.02), fov: 42 };
  }

  followShot(shoe: THREE.Vector3, targetEnd: 0 | 1, progress: number): Shot {
    const z = stakeZ(targetEnd);
    const dir = targetEnd === 1 ? 1 : -1;
    const behind = new THREE.Vector3(shoe.x * 0.6 + 0.35, Math.max(0.6, shoe.y + 0.55), shoe.z - dir * 2.2);
    const stake = this.stakeShot(targetEnd);
    const t = Math.min(1, Math.max(0, (progress - 0.45) / 0.45));
    const e = t * t * (3 - 2 * t);
    const pos = behind.lerp(stake.pos, e);
    const look = new THREE.Vector3(shoe.x, shoe.y, shoe.z).lerp(new THREE.Vector3(0, 0.1, z), e * 0.85);
    return { pos, look, fov: 40 - e * 4 };
  }

  menuShot(t: number): Shot {
    const a = 0.45 + Math.sin(t * 0.045) * 0.7;
    const z = stakeZ(1);
    const r = 1.7;
    return {
      pos: new THREE.Vector3(Math.sin(a) * r, 0.62 + Math.sin(t * 0.09) * 0.05, z - Math.cos(a) * r),
      look: new THREE.Vector3(0, 0.16, z + 0.06),
      fov: 30,
    };
  }

  // ---------------------------------------------------------- first person

  showViewShoe(l: Loadout | null) {
    const key = l ? `${l.brand}${l.shape}${l.finish}` : '';
    if (key !== this.viewShoeLoadout) {
      if (this.viewShoe) this.camera.remove(this.viewShoe);
      this.viewShoe = l ? createShoeMesh(l, this.envMap) : null;
      if (this.viewShoe) {
        this.viewShoe.castShadow = false;
        this.camera.add(this.viewShoe);
      }
      this.viewShoeLoadout = key;
    }
    if (this.viewShoe) this.viewShoe.visible = !!l;
  }

  /** Pose the held shoe: swing −1 (full backswing) … 0 (set) … +1 (release). */
  poseViewShoe(swing: number, hand: 1 | -1, grip: 'flip' | 'turn114' | 'turn134') {
    const s = this.viewShoe;
    if (!s) return;
    // Place it relative to the current field of view so it reads the same
    // whether or not the aim view is zoomed.
    const dist = 0.5;
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * dist;
    const halfW = halfH * this.camera.aspect;
    const scale = halfH / 0.24;
    s.scale.setScalar(scale);
    const back = Math.max(0, -swing);
    s.position.set(hand * halfW * 0.42, -halfH * (0.62 + back * 0.55) + Math.max(0, swing) * halfH * 0.5, -dist);
    s.rotation.set(0, 0, 0);
    if (grip === 'flip') {
      // Held flat, heels toward the stake; tips back on the backswing.
      s.rotation.x = 0.75 + back * 0.6 - Math.max(0, swing) * 0.4;
      s.rotation.z = -hand * 0.12;
    } else {
      s.rotation.x = 0.7 + back * 0.4;
      s.rotation.y = ((grip === 'turn134' ? 1 : -1) * hand * Math.PI) / 2;
    }
  }

  /** Shift the projection so the subject sits in the top part of the screen (menus). */
  setViewShift(fraction: number) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (fraction === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, 0, h * fraction, w, h);
    this.viewShift = fraction;
  }
  private viewShift = 0;

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.viewShift) this.camera.setViewOffset(w, h, 0, h * this.viewShift, w, h);
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    this.clock += dt;
    this.rig.update(dt);
    this.env.update(dt, this.clock);
    for (const p of this.pitchers) p.update(dt);
    this.particles.update(dt);
    this.pits[0].update();
    this.pits[1].update();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
