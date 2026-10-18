import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { TimeOfDay } from '../game/match';
import { COURT_SPACING } from './court';
import type { BodyMesh } from './humanBody';
import type { MapSet, Quality } from './textures';
import { buildBackyard } from './venueBackyard';
import { buildChampionship } from './venueChampionship';
import type { VenueContext, VenueScene } from './venueKit';
import { buildLakeside } from './venueLakeside';
import { buildPark } from './venuePark';
import { courtSlots, type VenueId } from './venues';
import type { Crowd, Scoreboard } from './venueStands';

/**
 * The world around the courts: sky, sun, stars and ambient light shared by
 * every venue, plus the venues themselves (each built the first time it is
 * visited, then kept and shown or hidden).
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
      return { sunDir: dir(1.15, 0.5), sunColor: new THREE.Color(1, 0.97, 0.9), sunIntensity: 3.2, hemiSky: new THREE.Color(0.3, 0.34, 0.45), hemiGround: new THREE.Color(0.12, 0.14, 0.1), hemiIntensity: 1.0, exposure: 1.05, fog: new THREE.Color(0.03, 0.04, 0.07), fogDensity: 0.012, turbidity: 1, rayleigh: 0.2, night: true };
  }
}

const BUILDERS: Record<VenueId, (ctx: VenueContext) => VenueScene> = {
  championship: buildChampionship,
  backyard: buildBackyard,
  park: buildPark,
  lakeside: buildLakeside,
};

/** Stand-in where nobody is watching: cheering is a no-op. */
const NO_CROWD: Pick<Crowd, 'cheer'> = { cheer: () => {} };

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  private stars: THREE.Points;
  private nightDome: THREE.Mesh;
  private venues = new Map<VenueId, VenueScene>();
  private current: VenueScene | null = null;
  venue: VenueId | null = null;
  lighting: Lighting = lightingFor('afternoon');

  constructor(
    readonly scene: THREE.Scene,
    private readonly grass: MapSet,
    private readonly quality: Quality,
    private readonly crowdBody: BodyMesh,
  ) {
    scene.add(this.group);
    // Sky.
    this.sky = new Sky();
    this.sky.scale.setScalar(900);
    // Keep the sky's HDR radiance in a range the bloom pass leaves alone, so
    // only true specular glints glow.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( min( texColor, vec3( 2.2 ) ), 1.0 );',
    );
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
  }

  /** Show a venue (built on first use; shared sky and lights stay). */
  setVenue(id: VenueId) {
    if (id === this.venue) return;
    let v = this.venues.get(id);
    if (!v) {
      v = BUILDERS[id]({ q: this.quality, grass: this.grass, crowdBody: this.crowdBody, courts: courtSlots(id).map((c) => c * COURT_SPACING) });
      this.venues.set(id, v);
      this.group.add(v.group);
    }
    for (const other of this.venues.values()) other.group.visible = other === v;
    this.current = v;
    this.venue = id;
    v.setLighting(this.lighting);
  }

  /** The current venue's scoreboards (none at most venues). */
  get scoreboards(): Scoreboard[] {
    return this.current?.scoreboards ?? [];
  }

  /** The current venue's spectators (a silent stand-in where there are none). */
  get crowd(): Pick<Crowd, 'cheer'> {
    return this.current?.crowd ?? NO_CROWD;
  }

  apply(t: TimeOfDay, renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const L = (this.lighting = lightingFor(t));
    const u = this.sky.material.uniforms;
    u.turbidity.value = L.turbidity;
    u.rayleigh.value = L.rayleigh;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    if (u.cloudCoverage) {
      u.cloudCoverage.value = t === 'sunset' ? 0.5 : 0.42;
      u.cloudDensity.value = 0.45;
    }
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
    this.current?.setLighting(L);
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
    this.current?.update(dt, time);
    const u = this.sky.material.uniforms;
    if (u.time) u.time.value = time;
  }
}
