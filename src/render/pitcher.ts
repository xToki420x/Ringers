import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Build } from './characterModels';

/**
 * A pitcher: a character model (see characterModels.ts) dressed in a look's
 * colours and kit (cap, score card, wristband, watch, belt bag...), driven by
 * a procedural underhand delivery — set, backswing, step with the opposite
 * foot, release beside the hip, follow-through reaching for the stake — and a
 * relaxed, side-on idle while waiting.
 */

/** Small kit a character wears or carries. */
export type Trim = 'scorecard' | 'wristband' | 'patch' | 'pencil' | 'watch' | 'beltbag';

export interface PitcherLook {
  id: string;
  /** Which body (model) to wear. */
  build: Build;
  shirt: string;
  pants: string;
  shoes: string;
  /** Cap colour, or null for no cap. */
  cap: string | null;
  trims: Trim[];
}

/** The rig's bones, in the order the model's skin lists them. */
const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'forearmL', 'handL', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];
const BONE = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])) as Record<string, number>;

type V3 = [number, number, number];

/** Fabric with sheen tinted by its own colour, matching the body's garments. */
function cloth(color: THREE.ColorRepresentation, roughness = 0.75) {
  const c = new THREE.Color(color);
  const tint = c.clone().multiplyScalar(2.2);
  tint.setRGB(Math.min(1, tint.r), Math.min(1, tint.g), Math.min(1, tint.b));
  return new THREE.MeshPhysicalMaterial({ color: c, roughness, sheen: 0.35, sheenRoughness: 0.5, sheenColor: tint });
}

const metal = (color: string, roughness = 0.28) => new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness });

/** Pointing `obj`'s +Z along `dir`. */
function face(obj: THREE.Object3D, dir: THREE.Vector3) {
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  return obj;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A round embroidered patch: stitched rim and a horseshoe. */
function patchTexture(bg: string, fg: string): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(64, 64, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(64, 70, 26, Math.PI * 0.85, Math.PI * 2.15, true);
    ctx.stroke();
  });
}

/** Six-panel cap: crown, a brim that follows the crown's front edge, seams, button and a front patch. */
function cap(color: string, centre: THREE.Vector3, R: V3): THREE.Group {
  const frame = new THREE.Group();
  frame.position.copy(centre);
  frame.rotation.x = -0.16;
  const mat = cloth(color, 0.72);
  const LOW = 0.58 * Math.PI;
  const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 28, 0, Math.PI * 2, 0, LOW), mat);
  crown.scale.set(...R);
  frame.add(crown);
  const seamMat = cloth(new THREE.Color(color).multiplyScalar(0.78), 0.8);
  const edgeY = Math.cos(LOW), edgeR = Math.sin(LOW);
  for (let k = 0; k < 6; k++) {
    const phi = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const th = (i / 16) * LOW;
      pts.push(new THREE.Vector3(Math.sin(th) * Math.sin(phi) * R[0] * 1.012, Math.cos(th) * R[1] * 1.012, Math.sin(th) * Math.cos(phi) * R[2] * 1.012));
    }
    frame.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0012, 4), seamMat));
  }
  // Brim: inner edge on the crown's rim, reaching forward, drooping at the sides.
  const shape = new THREE.Shape();
  const th0 = 0.17 * Math.PI, N = 40;
  const inner = (t: number) => new THREE.Vector2(Math.cos(t) * R[0] * edgeR, Math.sin(t) * R[2] * edgeR);
  for (let i = 0; i <= N; i++) {
    const p = inner(th0 + (i / N) * (Math.PI - 2 * th0));
    if (i === 0) shape.moveTo(p.x, p.y);
    else shape.lineTo(p.x, p.y);
  }
  for (let i = N; i >= 0; i--) {
    const t = th0 + (i / N) * (Math.PI - 2 * th0);
    const p = inner(t);
    shape.lineTo(p.x * 1.05, p.y + 0.072 * Math.pow(Math.sin(t), 1.6));
  }
  const brimGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0014, bevelSize: 0.0014, bevelSegments: 2, curveSegments: 4 });
  brimGeo.rotateX(Math.PI / 2);
  const bp = brimGeo.getAttribute('position');
  const z0 = R[2] * edgeR * 0.9;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), z = bp.getZ(i);
    bp.setY(i, bp.getY(i) + edgeY * R[1] + 0.003 - x * x * 2.4 - Math.max(0, z - z0) * 0.32);
  }
  brimGeo.computeVertexNormals();
  frame.add(new THREE.Mesh(brimGeo, mat));
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 16, 8), mat);
  button.scale.y = 0.55;
  button.position.y = R[1];
  frame.add(button);
  // Front patch, on the crown's surface above the brim.
  const th = 0.33 * Math.PI;
  const at = new THREE.Vector3(0, Math.cos(th) * R[1] * 1.01, Math.sin(th) * R[2] * 1.01);
  const patch = new THREE.Mesh(new THREE.CircleGeometry(0.02, 32), new THREE.MeshPhysicalMaterial({ map: patchTexture('#2b2f36', '#c9b48a'), roughness: 0.8, sheen: 0.4, sheenColor: new THREE.Color(0.5, 0.5, 0.5) }));
  patch.position.copy(at);
  face(patch, new THREE.Vector3(0, Math.cos(th) / R[1], Math.sin(th) / R[2]));
  frame.add(patch);
  return frame;
}

/** The model's meshes in their bind pose, for fitting kit to the body by ray casts. */
class BindSurface {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly ray = new THREE.Raycaster();

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.meshes.push(new THREE.Mesh((o as THREE.Mesh).geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    });
    for (const m of this.meshes) m.name = '';
  }

  /** First point where a ray meets the named meshes (or any). */
  probe(origin: V3, dir: V3, names?: string[]): THREE.Vector3 | null {
    this.ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...dir).normalize());
    const hits = this.ray.intersectObjects(names ? this.meshes.filter((m) => names.includes((m.geometry.userData.part as string) ?? '')) : this.meshes, false);
    return hits[0]?.point ?? null;
  }

  /** Bounding box of a named mesh in the bind pose. */
  box(name: string): THREE.Box3 {
    const m = this.meshes.find((x) => x.geometry.userData.part === name);
    if (!m) return new THREE.Box3();
    m.geometry.computeBoundingBox();
    return m.geometry.boundingBox!.clone();
  }
}

/** Attaches objects built in bind-pose world coordinates to a bone. */
function onBone(bone: THREE.Bone, at: THREE.Vector3, ...objs: THREE.Object3D[]) {
  for (const o of objs) {
    o.position.sub(at);
    o.traverse((c) => (c.castShadow = true));
    bone.add(o);
  }
}

/** A band round a forearm near the wrist (watch strap or sweatband). */
function wristRing(elbow: THREE.Vector3, wrist: THREE.Vector3, radius: number, tube: number, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const band = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 36), mat);
  band.scale.set(0.8, 1, 1);
  group.add(band);
  face(group, wrist.clone().sub(elbow));
  group.position.copy(elbow).lerp(wrist, 0.9);
  return group;
}

/** The look's kit, fitted to the model and attached to the right bones. */
function dress(look: PitcherLook, surf: BindSurface, bones: THREE.Bone[], at: THREE.Vector3[]) {
  const has = (t: Trim) => look.trims.includes(t);
  const attach = (name: string, ...objs: THREE.Object3D[]) => onBone(bones[BONE[name]], at[BONE[name]], ...objs);
  if (look.cap) {
    // Sized over the hair, the brim riding a few centimetres above the eyebrows.
    const hair = surf.box('hair');
    const brows = surf.box('eyebrows');
    const c = hair.getCenter(new THREE.Vector3());
    const size = hair.getSize(new THREE.Vector3());
    const y = brows.max.y + 0.035;
    const R: V3 = [size.x * 0.54, Math.max(0.088, hair.max.y - y + 0.014), size.z * 0.52];
    attach('head', cap(look.cap, new THREE.Vector3(0, y, c.z - 0.006), R));
  }
  const pants = surf.box('pants');
  if (has('scorecard')) {
    // Score card clipped at the right hip.
    const y = pants.max.y - 0.07;
    const hit = surf.probe([-0.6, y, 0.02], [1, 0, 0], ['pants', 'shirt']);
    const x = (hit ? hit.x : -0.17) - 0.003;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.088), new THREE.MeshPhysicalMaterial({
      map: canvasTexture(64, 96, (ctx) => {
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(0, 0, 64, 96);
        ctx.strokeStyle = '#7d8794';
        ctx.lineWidth = 1;
        for (let yy = 14; yy < 96; yy += 8) { ctx.beginPath(); ctx.moveTo(4, yy); ctx.lineTo(60, yy); ctx.stroke(); }
        for (const xx of [22, 42]) { ctx.beginPath(); ctx.moveTo(xx, 14); ctx.lineTo(xx, 94); ctx.stroke(); }
        ctx.fillStyle = '#1b365d';
        ctx.fillRect(0, 0, 64, 10);
      }),
      roughness: 0.85, side: THREE.DoubleSide,
    }));
    card.rotation.y = -Math.PI / 2;
    card.rotation.x = 0.06;
    card.position.set(x, y - 0.035, 0.02);
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.022, 0.03), metal('#2a2c30', 0.4));
    clip.position.set(x + 0.002, y + 0.008, 0.02);
    attach('hips', card, clip);
  }
  if (has('patch')) {
    // Patch on the left sleeve, below the shoulder.
    const sh = at[BONE.upperArmL];
    const y = sh.y - 0.09;
    const hit = surf.probe([0.6, y, sh.z], [-1, 0, 0], ['shirt']);
    if (hit) {
      const patch = new THREE.Mesh(new THREE.CircleGeometry(0.024, 32), new THREE.MeshPhysicalMaterial({ map: patchTexture('#c9b48a', '#1b365d'), roughness: 0.8 }));
      patch.position.copy(hit).add(new THREE.Vector3(0.002, 0, 0));
      face(patch, new THREE.Vector3(1, 0.05, 0));
      attach('upperArmL', patch);
    }
  }
  const r = look.build === 'female' ? 0.027 : 0.031;
  if (has('wristband')) attach('forearmR', wristRing(at[BONE.forearmR], at[BONE.handR], r + 0.004, 0.0095, cloth('#e8e5de', 0.9)));
  if (has('watch')) {
    const ring = wristRing(at[BONE.forearmL], at[BONE.handL], r, 0.005, new THREE.MeshPhysicalMaterial({ color: '#1c1d20', roughness: 0.6 }));
    const caseM = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.0135, 0.008, 24), metal('#9aa0a6', 0.35));
    caseM.rotation.z = Math.PI / 2;
    caseM.position.x = r * 0.8 + 0.004;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.011, 24), new THREE.MeshPhysicalMaterial({ color: '#0d1116', roughness: 0.05, clearcoat: 1 }));
    glass.rotation.y = Math.PI / 2;
    glass.position.x = caseM.position.x + 0.0042;
    ring.add(caseM, glass);
    attach('forearmL', ring);
  }
  if (has('pencil')) {
    // Tucked behind the right ear, in the hair.
    const head = at[BONE.head];
    const y = head.y + 0.09;
    const hit = surf.probe([-0.4, y, head.z + 0.0], [1, 0, 0], ['hair', 'body']);
    const x = (hit ? hit.x : -0.08) + 0.004;
    const from = new THREE.Vector3(x, y + 0.012, head.z + 0.05), to = new THREE.Vector3(x - 0.004, y - 0.008, head.z - 0.045);
    const len = from.distanceTo(to);
    const g = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, len * 0.86, 6), new THREE.MeshPhysicalMaterial({ color: '#e8b923', roughness: 0.5 }));
    stick.position.y = -len * 0.07;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0034, len * 0.12, 6), new THREE.MeshPhysicalMaterial({ color: '#d9b98e', roughness: 0.7 }));
    tip.position.y = len * 0.43;
    const eraser = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, len * 0.06, 8), new THREE.MeshPhysicalMaterial({ color: '#e58b95', roughness: 0.8 }));
    eraser.position.y = -len * 0.53;
    g.add(stick, tip, eraser);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
    g.position.copy(from).add(to).multiplyScalar(0.5);
    attach('head', g);
  }
  if (has('beltbag')) {
    // Slim belt bag at the front of the hip on a waist strap, with a silver zip.
    const black = new THREE.MeshPhysicalMaterial({ color: '#1d1e21', roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0.3, 0.3, 0.32) });
    const y = pants.max.y - 0.03;
    // Probe the clothes only: the hanging arms would get in the way.
    const side = surf.probe([0.6, y, 0], [-1, 0, 0], ['pants', 'shirt']);
    const front = surf.probe([0, y, 0.6], [0, 0, -1], ['pants', 'shirt']);
    const back = surf.probe([0, y, -0.6], [0, 0, 1], ['pants', 'shirt']);
    const rx = (side ? side.x : 0.16) + 0.004;
    const zf = front ? front.z : 0.1, zb = back ? back.z : -0.1;
    const strap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 8, 64), black);
    strap.rotation.x = Math.PI / 2;
    strap.scale.set(rx, (zf - zb) / 2 + 0.006, 1);
    strap.position.set(0, y, (zf + zb) / 2);
    const bagHit = surf.probe([-0.035, y - 0.03, 0.6], [0, 0, -1], ['pants', 'shirt']);
    const bz = (bagHit ? bagHit.z : zf) + 0.022;
    const bag = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.07, 0.042, 3, 0.016), black);
    bag.position.set(-0.035, y - 0.03, bz);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.003, 0.002), metal('#cfd2d6', 0.3));
    zip.position.set(-0.035, y - 0.012, bz + 0.0205);
    attach('hips', strap, bag, zip);
  }
}

/** Materials for one pitcher: the look's garment colours and richer surfaces. */
function material(src: THREE.MeshStandardMaterial, look: PitcherLook): THREE.Material {
  const part = src.name;
  const common = { map: src.map, normalMap: src.normalMap, alphaTest: src.alphaTest, transparent: false, side: src.side };
  switch (part) {
    case 'shirt':
    case 'pants':
    case 'shoes': {
      const c = new THREE.Color(look[part]);
      const tint = c.clone().multiplyScalar(2.2);
      tint.setRGB(Math.min(1, tint.r), Math.min(1, tint.g), Math.min(1, tint.b));
      return new THREE.MeshPhysicalMaterial({ ...common, color: c, roughness: part === 'shoes' ? 0.6 : 0.85, sheen: part === 'shoes' ? 0 : 0.45, sheenRoughness: 0.5, sheenColor: tint });
    }
    case 'skin':
      return new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.55, sheen: 0.25, sheenRoughness: 0.4, sheenColor: new THREE.Color(0.9, 0.55, 0.45), specularIntensity: 0.5 });
    case 'eyes':
      return new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 });
    case 'hair':
    case 'eyebrows':
    case 'eyelashes':
      return new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.5, sheen: 0.6, sheenRoughness: 0.35, sheenColor: new THREE.Color(0.55, 0.45, 0.38), side: THREE.DoubleSide });
    default:
      return src;
  }
}

export class Pitcher {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  private readonly b: THREE.Bone[];
  private readonly bind: THREE.Vector3[];
  /** Attachment point in the throwing hand. */
  hand: THREE.Object3D;
  private readonly hands: [THREE.Object3D, THREE.Object3D];
  private t = -1;
  private idleT = Math.random() * 10;
  private arm: 0 | 1 = 1;

  /** Seconds into the delivery at which the shoe leaves the hand. */
  static readonly RELEASE_AT = 0.62;
  static readonly DURATION = 1.6;

  constructor(model: THREE.Object3D, readonly look: PitcherLook) {
    const inst = cloneSkinned(model);
    const meshes: THREE.SkinnedMesh[] = [];
    inst.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.geometry.userData.part = m.name;
      m.material = material(m.material as THREE.MeshStandardMaterial, look);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      meshes.push(m);
    });
    this.mesh = meshes.find((m) => m.name === 'body') ?? meshes[0];
    const byName = new Map<string, THREE.Bone>();
    inst.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
    });
    this.b = BONE_NAMES.map((n) => byName.get(n)!);
    this.bind = this.b.map((x) => x.position.clone());
    inst.updateMatrixWorld(true);
    const at = this.b.map((x) => x.getWorldPosition(new THREE.Vector3()));
    dress(look, new BindSurface(inst), this.b, at);
    this.root.add(inst);
    // Hand attachment points at the palm (index 0 = left hand, 1 = right hand).
    const mk = (bone: number) => {
      const o = new THREE.Object3D();
      o.position.set(0, -0.075, 0.012);
      this.b[bone].add(o);
      return o;
    };
    this.hands = [mk(BONE.handL), mk(BONE.handR)];
    this.hand = this.hands[1];
  }

  setHand(hand: 1 | -1) {
    this.arm = hand === 1 ? 1 : 0;
    this.hand = this.hands[this.arm];
  }

  startDelivery(at = 0) {
    this.t = at;
  }

  get delivering() {
    return this.t >= 0;
  }

  get deliveryTime() {
    return this.t;
  }

  update(dt: number) {
    this.idleT += dt;
    if (this.t >= 0) {
      this.t += dt;
      if (this.t > Pitcher.DURATION) this.t = -1;
    }
    this.pose();
  }

  private bone(name: string) {
    return this.b[BONE[name]];
  }

  private pose() {
    const right = this.arm === 1;
    const A = right ? 'R' : 'L';
    const O = right ? 'L' : 'R';
    const side = right ? 1 : -1;
    const ease = (x: number) => x * x * (3 - 2 * x);
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    // Idle: standing a little side-on, lead foot forward, breathing and shifting weight.
    let armSwing = Math.sin(this.idleT * 1.1) * 0.025; // + = forward
    let lean = 0.03 + Math.sin(this.idleT * 0.7) * 0.01;
    let crouch = 0;
    let step = 0.22;
    let follow = 0;
    let twist = side * 0.14 + Math.sin(this.idleT * 0.45) * 0.03;
    let wrist = 0;
    if (this.t >= 0) {
      const t = this.t;
      // 0–0.12 set, 0.12–0.5 backswing, 0.5–0.62 forward swing, release, follow-through, relax.
      const back = ease(clamp((t - 0.12) / 0.38));
      const fwd = ease(clamp((t - 0.5) / 0.14));
      const thru = ease(clamp((t - 0.62) / 0.32));
      const relax = ease(clamp((t - 1.05) / 0.55));
      const set = 1 - ease(clamp(t / 0.12));
      // Follow-through: the arm reaches out level toward the stake, palm up.
      armSwing = (-1.2 * back * (1 - fwd) + 0.32 * fwd + 1.25 * thru) * (1 - relax);
      lean = 0.03 + 0.42 * back * (1 - relax * 0.9) + 0.08 * thru * (1 - relax);
      crouch = (0.14 * back + 0.05 * thru) * (1 - relax);
      step = Math.max(0.22 * set, ease(clamp((t - 0.36) / 0.24))) * (1 - relax * 0.7) + 0.22 * relax;
      follow = thru * (1 - relax);
      twist = side * (0.14 * set - 0.2 * back * (1 - fwd) + 0.1 * follow + 0.14 * relax);
      wrist = -0.5 * back * (1 - fwd) + 0.15 * thru * (1 - relax);
    }
    const hips = this.b[BONE.hips];
    hips.position.copy(this.bind[BONE.hips]);
    hips.position.y -= crouch * 0.5;
    hips.position.z += step * 0.12;
    hips.rotation.set(0, twist * 0.4, 0);
    this.bone('spine').rotation.set(lean * 0.45, twist * 0.3, 0);
    this.bone('chest').rotation.set(lean * 0.5, twist * 0.5, 0);
    this.bone('neck').rotation.set(-lean * 0.4, -twist * 0.4, 0);
    this.bone('head').rotation.set(-lean * 0.5, -twist * 0.3, 0);
    // Pitching arm swings in the sagittal plane (rotation about X; positive = back).
    this.bone(`upperArm${A}`).rotation.set(-armSwing, 0, side * 0.04 * (1 - Math.abs(armSwing)));
    this.bone(`forearm${A}`).rotation.set(-0.12 - Math.max(0, armSwing) * 0.3, 0, 0);
    this.bone(`hand${A}`).rotation.set(wrist, 0, 0);
    // Pitching hand turns palm-up as it reaches for the stake.
    this.bone(`hand${A}`).rotation.y = side * 0.9 * follow;
    // The other hand carries the second shoe low by the hip, elbow soft, drifting out for balance.
    const bal = crouch * 5;
    this.bone(`upperArm${O}`).rotation.set(0.12 * bal - 0.06, 0, -side * (0.1 + 0.12 * bal));
    this.bone(`forearm${O}`).rotation.set(-0.35 - 0.2 * bal, 0, 0);
    this.bone(`hand${O}`).rotation.set(-0.1, 0, 0);
    // Step with the opposite foot; trailing knee bends; feet stay flat.
    const hipO = -0.42 * step - crouch * 1.25;
    const kneeO = 0.22 * step + crouch * 2.3;
    const hipA = 0.18 * step - crouch * 1.15;
    const kneeA = crouch * 2.2 + 0.16 * step;
    this.bone(`thigh${O}`).rotation.set(hipO, 0, 0);
    this.bone(`shin${O}`).rotation.set(kneeO, 0, 0);
    this.bone(`foot${O}`).rotation.set(-(hipO + kneeO) - lean * 0.0, 0, 0);
    this.bone(`thigh${A}`).rotation.set(hipA, 0, 0);
    this.bone(`shin${A}`).rotation.set(kneeA, 0, 0);
    this.bone(`foot${A}`).rotation.set(-(hipA + kneeA) + follow * 0.35, 0, 0);
  }
}
