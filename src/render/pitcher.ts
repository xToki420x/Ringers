import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BODY_MATS, BONE, bonesFor, buildSkeleton, eyeCentres, probeSurface, type BodyMat, type BodyMesh, type BoneDef, type Build } from './humanBody';

/**
 * A pitcher: the generated seamless body as a skinned mesh, with eyes, and
 * dressed per character (cap, polo collar, buckle, braid, watch and the rest),
 * driven by a procedural underhand delivery — set, backswing, step with the
 * opposite foot, release beside the hip, follow-through reaching for the
 * stake — and a relaxed, side-on idle while waiting.
 */

/** Small kit a character wears or carries. */
export type Trim = 'buckle' | 'scorecard' | 'wristband' | 'patch' | 'braid' | 'pencil' | 'pin' | 'watch' | 'beltbag';

export interface PitcherLook {
  id: string;
  build: Build;
  /** Standing height in metres. */
  height: number;
  shirt: string;
  pants: string;
  skin: string;
  shoes: string;
  sole: string;
  hair: string;
  eyes: string;
  belt: string;
  /** Cap colour, or null for no cap. */
  cap: string | null;
  /** Short beard shading on the jaw and upper lip. */
  stubble: boolean;
  /** Fingerless glove on the left hand, or null. */
  glove: string | null;
  trims: Trim[];
}

/** Height of the sculpted bind-pose body (crown) for each build, before scaling. */
const SCULPT_HEIGHT: Record<Build, number> = { male: 1.78, female: 1.776 };

/** Surface response per garment: roughness, sheen. */
const SURF: Record<BodyMat, [number, number]> = {
  skin: [0.5, 0.18],
  shirt: [0.82, 0.35],
  pants: [0.88, 0.3],
  belt: [0.34, 0],
  shoe: [0.55, 0.05],
  sole: [0.85, 0],
  hair: [0.5, 0.7],
};

function albedo(m: BodyMat, look: PitcherLook): THREE.Color {
  switch (m) {
    case 'skin': return new THREE.Color(look.skin);
    case 'shirt': return new THREE.Color(look.shirt);
    case 'pants': return new THREE.Color(look.pants);
    case 'belt': return new THREE.Color(look.belt);
    case 'shoe': return new THREE.Color(look.shoes);
    case 'sole': return new THREE.Color(look.sole);
    case 'hair': return new THREE.Color(look.hair);
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One draw call for the whole body: per-vertex albedo, roughness and cloth
 * sheen, plus painted detail — lip colour, stubble along the jaw, and a
 * fingerless glove — placed from bind-pose positions and bones.
 */
function dressedBody(body: BodyMesh, look: PitcherLook): { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalMaterial } {
  const src = body.geometry;
  const geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) geo.setAttribute(name, src.getAttribute(name));
  geo.setIndex(src.getIndex());
  const ao = src.getAttribute('color');
  const P = src.getAttribute('position');
  const bone = src.getAttribute('skinIndex');
  const n = ao.count;
  const col = new Float32Array(n * 3);
  const surf = new Float32Array(n * 2);
  const alb = BODY_MATS.map((m) => albedo(m, look));
  const tmp = new THREE.Color();
  const lip = new THREE.Color(look.skin).lerp(new THREE.Color('#a8545a'), 0.4);
  const beard = new THREE.Color(look.hair).lerp(new THREE.Color(look.skin), 0.35).multiplyScalar(0.75);
  const glove = look.glove ? new THREE.Color(look.glove) : null;
  const F = look.build === 'female';
  const wristL = bonesFor(look.build)[BONE.handL].head;
  const skinIdx = BODY_MATS.indexOf('skin');
  for (let i = 0; i < n; i++) {
    const a = body.vmats[i * 2], b = body.vmats[i * 2 + 1], w = body.vmatW[i];
    tmp.copy(alb[b]).lerp(alb[a], w);
    let rough = SURF[BODY_MATS[b]][0] + (SURF[BODY_MATS[a]][0] - SURF[BODY_MATS[b]][0]) * w;
    let sheen = SURF[BODY_MATS[b]][1] + (SURF[BODY_MATS[a]][1] - SURF[BODY_MATS[b]][1]) * w;
    const skinW = (a === skinIdx ? w : 0) + (b === skinIdx ? 1 - w : 0);
    const bi = bone.getX(i);
    if (skinW > 0 && (bi === BONE.head || bi === BONE.neck)) {
      // Face paint, in the unscaled head's coordinates.
      const k = F ? 1 / 0.95 : 1;
      const x = P.getX(i) * k, y = 1.66 + (P.getY(i) - 1.66) * k, z = 0.01 + (P.getZ(i) - 0.01) * k;
      const lips = smooth(0.023, 0.016, Math.abs(x)) * smooth(1.578, 1.583, y) * smooth(1.608, 1.603, y) * smooth(0.078, 0.086, z);
      tmp.lerp(lip, lips * skinW * (F ? 0.7 : 0.35));
      rough -= lips * 0.15;
      if (look.stubble) {
        const jaw = smooth(1.535, 1.556, y) * smooth(1.64, 1.622, y) * smooth(-0.012, 0.02, z) * smooth(0.081, 0.07, Math.abs(x));
        // Upper cheeks stay clear above the jawline toward the ears.
        const cheek = 1 - smooth(1.6, 1.625, y) * smooth(0.03, 0.05, Math.abs(x)) * smooth(0.0, 0.05, z);
        tmp.lerp(beard, jaw * cheek * (1 - lips) * skinW * 0.55);
        rough += jaw * 0.2;
      }
    }
    if (glove && skinW > 0 && bi === BONE.handL && wristL[1] - P.getY(i) < 0.088) {
      tmp.lerp(glove, skinW);
      rough = 0.62;
      sheen = 0.1;
    }
    tmp.multiplyScalar(ao.getX(i));
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
    surf[i * 2] = rough;
    surf[i * 2 + 1] = sheen;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
  geo.boundingSphere = src.boundingSphere;
  const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.7, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(1, 1, 1), specularIntensity: 0.6 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vSurf.x;')
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor = sheenColor * vSurf.y * clamp(vColor.rgb * 2.2, 0.0, 1.0);\n#endif',
      );
  };
  return { geometry: geo, material };
}

type V3 = [number, number, number];

/** Attaches meshes built in world (bind-pose) coordinates to a bone. */
function onBone(bones: THREE.Bone[], defs: BoneDef[], bone: number, ...meshes: THREE.Object3D[]) {
  const h = defs[bone].head;
  for (const m of meshes) {
    m.position.x -= h[0];
    m.position.y -= h[1];
    m.position.z -= h[2];
    m.traverse((o) => (o.castShadow = true));
    bones[bone].add(m);
  }
}

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

/** Eyeball texture: iris and pupil around the front pole (the top of the sphere's UV). */
function eyeTexture(iris: string): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const img = ctx.createImageData(128, 128);
    const ic = new THREE.Color(iris);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const t = y / 128, u = (x / 128) * Math.PI * 2;
        let r: number, g: number, b: number;
        if (t < 0.07) [r, g, b] = [0.02, 0.02, 0.025];
        else if (t < 0.17) {
          const fibre = 0.8 + 0.25 * Math.sin(u * 37) * Math.sin(u * 13 + t * 40);
          const ring = 1 - 0.55 * smooth(0.13, 0.17, t) + 0.25 * (1 - smooth(0.07, 0.1, t));
          [r, g, b] = [ic.r * fibre * ring, ic.g * fibre * ring, ic.b * fibre * ring];
        } else {
          const vein = 0.04 * smooth(0.3, 0.6, t);
          [r, g, b] = [0.93 - vein * 0.2, 0.9 - vein, 0.86 - vein];
        }
        const o = (y * 128 + x) * 4;
        img.data[o] = r * 255;
        img.data[o + 1] = g * 255;
        img.data[o + 2] = b * 255;
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  });
}

/** Eyeballs set in the sculpted sockets, with a wet clear coat. */
function eyes(look: PitcherLook): THREE.Object3D[] {
  const tex = eyeTexture(look.eyes);
  tex.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03 });
  const r = look.build === 'female' ? 0.0112 : 0.0118;
  const geo = new THREE.SphereGeometry(r, 24, 16).rotateX(Math.PI / 2);
  return eyeCentres(look.build).map((c) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...c);
    // A touch of convergence toward the stake.
    m.rotation.y = -Math.sign(c[0]) * 0.03;
    return m;
  });
}

/** Six-panel cap: crown, a brim that follows the crown's front edge, seams, button and a front patch. */
function cap(color: string): THREE.Group {
  const frame = new THREE.Group();
  frame.position.set(0, 1.701, -0.012);
  frame.rotation.x = -0.16;
  const mat = cloth(color, 0.72);
  const R: V3 = [0.089, 0.089, 0.108];
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

/** Polo collar fitted to the shoulders, with an open placket: buttons, or a silver zip. */
function poloCollar(look: PitcherLook): THREE.Object3D[] {
  const F = look.build === 'female';
  const mat = cloth(new THREE.Color(look.shirt).multiplyScalar(0.82), 0.8);
  mat.side = THREE.DoubleSide;
  const gap = 0.42, A = 36;
  // Profile from the neckline: up the stand, fold over, down onto the shoulders.
  const k = F ? 0.9 : 1, y0 = F ? 1.432 : 1.448;
  const prof: [number, number][] = [[0.066, 0], [0.062, 0.022], [0.062, 0.038], [0.068, 0.044], [0.076, 0.036]].map(([r, y]) => [r * k, y0 + y * k]);
  const flare = [0.088 * k, 0.1 * k];
  const pos: number[] = [];
  const idx: number[] = [];
  const K = prof.length + flare.length;
  for (let a = 0; a <= A; a++) {
    const phi = gap + (a / A) * (Math.PI * 2 - 2 * gap);
    const sx = Math.sin(phi), cz = Math.cos(phi) * 0.95;
    for (const [r, y] of prof) pos.push(r * sx, y, r * cz - 0.004);
    for (const r of flare) {
      const hit = probeSurface([r * sx, 1.53, r * cz - 0.004], [0, -1, 0], look.build);
      pos.push(r * sx, (hit ? hit.y : 1.45) + 0.0035, r * cz - 0.004);
    }
    if (a > 0)
      for (let j = 0; j < K - 1; j++) {
        const i0 = (a - 1) * K + j, i1 = a * K + j;
        idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
      }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const parts: THREE.Object3D[] = [new THREE.Mesh(geo, mat)];
  // Placket strip laid on the chest.
  const strip: number[] = [];
  const sIdx: number[] = [];
  const ys = F ? [1.436, 1.415, 1.395, 1.375, 1.358] : [1.452, 1.43, 1.41, 1.39, 1.372];
  const surfZ = (x: number, y: number) => probeSurface([x, y, 0.4], [0, 0, -1], look.build)?.z ?? 0.09;
  ys.forEach((y, i) => {
    for (const x of [-0.013, 0.013]) strip.push(x, y, surfZ(x, y) + 0.0022);
    if (i > 0) sIdx.push(i * 2 - 2, i * 2, i * 2 - 1, i * 2, i * 2 + 1, i * 2 - 1);
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
  pg.setIndex(sIdx);
  pg.computeVertexNormals();
  parts.push(new THREE.Mesh(pg, mat));
  if (F) {
    // Silver zip down the placket, with its pull.
    const zip = metal('#cfd2d6', 0.3);
    const top = ys[0], bot = ys[ys.length - 1];
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.003, top - bot, 0.0015), zip);
    teeth.position.set(0, (top + bot) / 2, surfZ(0, (top + bot) / 2) + 0.0035);
    const pull = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.014, 0.002), zip);
    pull.position.set(0, top - 0.012, surfZ(0, top - 0.012) + 0.005);
    parts.push(teeth, pull);
  } else {
    const btnMat = new THREE.MeshPhysicalMaterial({ color: '#f3efe6', roughness: 0.25, clearcoat: 0.8 });
    for (const y of [1.432, 1.398]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.0048, 0.0048, 0.0025, 14), btnMat);
      b.rotation.x = Math.PI / 2;
      b.position.set(0, y, surfZ(0, y) + 0.0035);
      parts.push(b);
    }
  }
  return parts;
}

/** A band round a forearm near the wrist (watch strap or sweatband). */
function wristRing(defs: BoneDef[], bone: number, radius: number, tube: number, mat: THREE.Material): { group: THREE.Group; axis: THREE.Vector3 } {
  const fa = defs[bone];
  const at = new THREE.Vector3(...fa.head).lerp(new THREE.Vector3(...fa.tail), 0.86);
  const axis = new THREE.Vector3(...fa.tail).sub(new THREE.Vector3(...fa.head)).normalize();
  const group = new THREE.Group();
  const band = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 36), mat);
  band.scale.set(0.8, 1, 1);
  group.add(band);
  face(group, axis);
  group.position.copy(at);
  return { group, axis };
}

/** Braid from the nape down the upper back: interlocking lobes, a tie and a tuft. */
function braid(look: PitcherLook): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.64, -0.095),
    new THREE.Vector3(0, 1.58, -0.106),
    new THREE.Vector3(0, 1.5, -0.1),
    new THREE.Vector3(0, 1.42, -0.104),
    new THREE.Vector3(0, 1.34, -0.13),
    new THREE.Vector3(0, 1.27, -0.127),
  ]);
  const parts: THREE.BufferGeometry[] = [];
  const lobe = new THREE.SphereGeometry(1, 14, 10);
  const N = 18, END = 0.86;
  const m = new THREE.Matrix4();
  const basis = (t: number) => {
    const T = curve.getTangentAt(t);
    const X = new THREE.Vector3(1, 0, 0).sub(T.clone().multiplyScalar(T.x)).normalize();
    return { T, X, Y: new THREE.Vector3().crossVectors(T, X) };
  };
  for (let i = 0; i < N; i++) {
    const t = 0.03 + (i / (N - 1)) * (END - 0.05);
    const { T, X, Y } = basis(t);
    const r = 0.0165 - 0.0065 * t;
    const side = i % 2 ? 1 : -1;
    const c = curve.getPointAt(t).add(X.clone().multiplyScalar(side * r * 0.32));
    // Each lobe leans across the braid, alternating sides.
    const q = new THREE.Quaternion().setFromAxisAngle(Y, side * 0.55);
    const ax = X.clone().applyQuaternion(q), ay = T.clone().applyQuaternion(q);
    m.makeBasis(ax.multiplyScalar(r * 0.72), ay.multiplyScalar(r * 1.25), Y.clone().multiplyScalar(r * 0.75)).setPosition(c);
    parts.push(lobe.clone().applyMatrix4(m));
  }
  // Tie and tuft.
  const { T } = basis(END);
  const tieAt = curve.getPointAt(END);
  const tie = new THREE.CylinderGeometry(0.0078, 0.0078, 0.012, 16);
  tie.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), T)).translate(tieAt.x, tieAt.y, tieAt.z);
  // The loose end flares out below the tie.
  const tuftLen = 0.03;
  const tuft = new THREE.ConeGeometry(0.0135, tuftLen, 16, 1, true);
  tuft.translate(0, -tuftLen / 2, 0); // apex at the tie
  tuft.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), T)).translate(tieAt.x, tieAt.y, tieAt.z);
  parts.push(tuft);
  const hairMat = new THREE.MeshPhysicalMaterial({ color: look.hair, roughness: 0.48, sheen: 1, sheenRoughness: 0.35, sheenColor: new THREE.Color(look.hair).lerp(new THREE.Color(1, 0.9, 0.8), 0.35) });
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, hairMat);
  mesh.add(new THREE.Mesh(tie, new THREE.MeshPhysicalMaterial({ color: '#1a1a1c', roughness: 0.6 })));
  return mesh;
}

/** Everything a character wears beyond the body, attached to the right bones. */
function trims(look: PitcherLook, bones: THREE.Bone[]) {
  const defs = bonesFor(look.build);
  const F = look.build === 'female';
  const has = (t: Trim) => look.trims.includes(t);
  onBone(bones, defs, BONE.head, ...eyes(look));
  if (look.cap) onBone(bones, defs, BONE.head, cap(look.cap));
  onBone(bones, defs, BONE.chest, ...poloCollar(look));
  if (has('buckle')) {
    const hit = probeSurface([0, 0.965, 0.4], [0, 0, -1], look.build);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.032, 0.006), metal('#c9c3b4'));
    buckle.position.set(0, 0.965, (hit ? hit.z : 0.1) + 0.002);
    onBone(bones, defs, BONE.hips, buckle);
  }
  if (has('scorecard')) {
    // Score card clipped to the belt on the right hip.
    const hit = probeSurface([-0.4, 0.93, 0.02], [1, 0, 0], look.build);
    const x = (hit ? hit.x : -0.15) - 0.003;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.088), new THREE.MeshPhysicalMaterial({
      map: canvasTexture(64, 96, (ctx) => {
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(0, 0, 64, 96);
        ctx.strokeStyle = '#7d8794';
        ctx.lineWidth = 1;
        for (let y = 14; y < 96; y += 8) { ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(60, y); ctx.stroke(); }
        for (const xx of [22, 42]) { ctx.beginPath(); ctx.moveTo(xx, 14); ctx.lineTo(xx, 94); ctx.stroke(); }
        ctx.fillStyle = '#1b365d';
        ctx.fillRect(0, 0, 64, 10);
      }),
      roughness: 0.85, side: THREE.DoubleSide,
    }));
    card.rotation.y = -Math.PI / 2;
    card.rotation.x = 0.06;
    card.position.set(x, 0.915, 0.02);
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.022, 0.03), metal('#2a2c30', 0.4));
    clip.position.set(x + 0.002, 0.958, 0.02);
    onBone(bones, defs, BONE.hips, card, clip);
  }
  if (has('patch')) {
    // Patch on the left sleeve.
    const hit = probeSurface([0.5, 1.33, -0.004], [-1, 0, 0], look.build);
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.024, 32), new THREE.MeshPhysicalMaterial({ map: patchTexture('#c9b48a', '#1b365d'), roughness: 0.8 }));
    patch.position.set((hit ? hit.x : 0.26) + 0.002, 1.33, -0.004);
    face(patch, new THREE.Vector3(1, 0.05, 0));
    onBone(bones, defs, BONE.upperArmL, patch);
  }
  if (has('wristband')) onBone(bones, defs, BONE.forearmR, wristRing(defs, BONE.forearmR, 0.033, 0.0095, cloth('#e8e5de', 0.9)).group);
  if (has('watch')) {
    const { group } = wristRing(defs, BONE.forearmL, F ? 0.027 : 0.03, 0.005, new THREE.MeshPhysicalMaterial({ color: '#1c1d20', roughness: 0.6 }));
    const caseM = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.0135, 0.008, 24), metal('#9aa0a6', 0.35));
    caseM.rotation.z = Math.PI / 2;
    caseM.position.x = F ? 0.023 : 0.026;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.011, 24), new THREE.MeshPhysicalMaterial({ color: '#0d1116', roughness: 0.05, clearcoat: 1 }));
    glass.rotation.y = Math.PI / 2;
    glass.position.x = caseM.position.x + 0.0042;
    group.add(caseM, glass);
    onBone(bones, defs, BONE.forearmL, group);
  }
  if (has('braid')) onBone(bones, defs, BONE.chest, braid(look));
  if (has('pencil')) {
    // Tucked behind the right ear.
    const from = new THREE.Vector3(-0.081, 1.684, 0.004), to = new THREE.Vector3(-0.084, 1.664, -0.088);
    const len = from.distanceTo(to);
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, len * 0.86, 6), new THREE.MeshPhysicalMaterial({ color: '#e8b923', roughness: 0.5 }));
    body.position.y = -len * 0.07;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0034, len * 0.12, 6), new THREE.MeshPhysicalMaterial({ color: '#d9b98e', roughness: 0.7 }));
    tip.position.y = len * 0.43;
    const eraser = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, len * 0.06, 8), new THREE.MeshPhysicalMaterial({ color: '#e58b95', roughness: 0.8 }));
    eraser.position.y = -len * 0.53;
    g.add(body, tip, eraser);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
    g.position.copy(from).add(to).multiplyScalar(0.5);
    const s = 0.95;
    g.position.set(g.position.x * s, 1.66 + (g.position.y - 1.66) * s, 0.01 + (g.position.z - 0.01) * s);
    onBone(bones, defs, BONE.head, g);
  }
  if (has('pin')) {
    // Championship pin on the collar's left point.
    const phi = 0.62, r = 0.082;
    const hit = probeSurface([r * Math.sin(phi), 1.53, r * Math.cos(phi) * 0.95 - 0.004], [0, -1, 0], look.build);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.002, 20), metal('#d4af37', 0.22));
    pin.position.set(r * Math.sin(phi), (hit ? hit.y : 1.44) + 0.0065, r * Math.cos(phi) * 0.95 - 0.004);
    pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.sin(phi) * 0.5, 0.7, Math.cos(phi)).normalize());
    onBone(bones, defs, BONE.chest, pin);
  }
  if (has('beltbag')) {
    // Slim belt bag at the front of the hip on a waist strap, with a silver zip.
    const black = new THREE.MeshPhysicalMaterial({ color: '#1d1e21', roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0.3, 0.3, 0.32) });
    const strap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 8, 64), black);
    strap.rotation.x = Math.PI / 2;
    strap.scale.set(0.163, 0.118, 1);
    strap.position.set(0, 0.968, 0.003);
    const hit = probeSurface([-0.035, 0.935, 0.4], [0, 0, -1], look.build);
    const bag = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.07, 0.042, 3, 0.016), black);
    const z = (hit ? hit.z : 0.11) + 0.022;
    bag.position.set(-0.035, 0.94, z);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.003, 0.002), metal('#cfd2d6', 0.3));
    zip.position.set(-0.035, 0.958, z + 0.0205);
    onBone(bones, defs, BONE.hips, strap, bag, zip);
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

  constructor(body: BodyMesh, readonly look: PitcherLook) {
    const { bones, skeleton } = buildSkeleton(look.build);
    this.b = bones;
    this.bind = bones.map((x) => x.position.clone());
    const dressed = dressedBody(body, look);
    this.mesh = new THREE.SkinnedMesh(dressed.geometry, dressed.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.add(bones[0]);
    this.mesh.bind(skeleton);
    this.mesh.scale.setScalar(look.height / SCULPT_HEIGHT[look.build]);
    this.root.add(this.mesh);
    trims(look, bones);
    // Hand attachment points at the palm (index 0 = left hand, 1 = right hand).
    const mk = (bone: number, sx: number) => {
      const o = new THREE.Object3D();
      o.position.set(sx * 0.004, -0.05, 0.01);
      bones[bone].add(o);
      return o;
    };
    this.hands = [mk(BONE.handL, 1), mk(BONE.handR, -1)];
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
