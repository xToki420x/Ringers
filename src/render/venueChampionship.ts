import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_COURT } from '../core/constants';
import { COURT_SPACING } from './court';
import { bannerTexture } from './textures';
import { Forest, type TreePlacement } from './trees';
import { buildGround, rng, type VenueContext, type VenueScene } from './venueKit';
import { Crowd, Scoreboard, type Seat } from './venueStands';
import { glowTexture } from './venueTextures';

/**
 * The World Championship grounds: five courts on a striped, manicured
 * lawn, aluminium bleachers full of spectators, sponsor banners, flags,
 * four light towers, scoreboards at both ends and a ring of shade trees.
 */
export function buildChampionship(ctx: VenueContext): VenueScene {
  const { q } = ctx;
  const group = new THREE.Group();
  const grass = buildGround(ctx, 'manicured', group);

  const r = rng(7);
  const placements: TreePlacement[] = [];
  const count = q === 'low' ? 50 : 110;
  while (placements.length < count) {
    const a = r() * Math.PI * 2;
    const d = 30 + r() * 60;
    const x = Math.cos(a) * d * 0.75, z = Math.sin(a) * d * 1.15;
    if (Math.abs(x) < 26 && Math.abs(z) < 24) continue;
    placements.push({ x, z, scale: 1.0 + r() * 1.4, rot: r() * Math.PI * 2, species: r() < 0.8 ? 'oak' : 'maple', seed: placements.length });
  }
  const forest = new Forest(placements, q);
  group.add(forest.object);

  const crowd = new Crowd(group, bleachers(group, q), ctx.crowdBody);
  banners(group);
  const lamps = lightTowers(group);
  const flags = flagPoles(group);
  const scoreboards = ([0, 1] as const).map((end) => {
    const sb = new Scoreboard(end);
    group.add(sb.mesh);
    return sb;
  });

  return {
    group,
    scoreboards,
    crowd,
    setLighting({ night }) {
      for (const g of lamps.glows) g.visible = night;
      lamps.heads.emissive.set(night ? 0xfff1d0 : 0x000000);
      lamps.heads.emissiveIntensity = night ? 3 : 0;
    },
    update(dt, time) {
      for (const f of flags) {
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
      crowd.update(dt, time);
      grass.update(time);
      forest.update(time);
    },
  };
}

/** Five-row aluminium bleachers beside the outer courts; returns their seats. */
function bleachers(group: THREE.Group, q: VenueContext['q']): Seat[] {
  const benchMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.8, roughness: 0.35 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x5d6369, metalness: 0.6, roughness: 0.5 });
  const rows = 5;
  const benches: THREE.BufferGeometry[] = [];
  const frames: THREE.BufferGeometry[] = [];
  const seats: Seat[] = [];
  const sideX = 3 * COURT_SPACING + 2.6;
  const perRow = q === 'low' ? 10 : 16;
  for (const sx of [-1, 1]) {
    for (const seg of [-1, 1]) {
      const zc = seg * 3.4;
      for (let r = 0; r < rows; r++) {
        const x = sx * (sideX + r * 0.75);
        const y = 0.45 + r * 0.42;
        benches.push(new THREE.BoxGeometry(0.32, 0.05, 5.6).translate(x, y, zc));
        benches.push(new THREE.BoxGeometry(0.28, 0.03, 5.6).translate(x + sx * 0.32, y - 0.22, zc));
        for (let k = 0; k < perRow; k++) {
          if (Math.random() < 0.18) continue;
          seats.push({ x, y, z: zc - 2.6 + (5.2 * (k + 0.5)) / perRow + (Math.random() - 0.5) * 0.08, facing: sx > 0 ? -Math.PI / 2 : Math.PI / 2, stand: sx });
        }
      }
      for (let k = 0; k < 4; k++)
        frames.push(new THREE.BoxGeometry(0.06, 0.45 + rows * 0.42, 0.06).translate(sx * (sideX + (rows - 1) * 0.75 + 0.2), (0.45 + rows * 0.42) / 2, zc - 2.7 + k * 1.8));
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(benches)!, benchMat), new THREE.Mesh(mergeGeometries(frames)!, frameMat));
  return seats;
}

/** Sponsor banners on a low rail fence behind both ends. */
function banners(group: THREE.Group) {
  const sponsors: [string[], string, string, string?][] = [
    [['RINGERS', 'WORLD HORSESHOE CHAMPIONSHIP'], '#13294b', '#f2c14e', '#c8102e'],
    [['BULLDOG', 'PITCHING SHOES'], '#1c1c1c', '#e8833a'],
    [['LEGEND', 'PITCHING SHOES'], '#8e1b1b', '#fff3d6'],
    [['CADET', 'HOOKS THAT BITE'], '#0f4a24', '#ffffff'],
    [['ANY COLOR', 'YOU CAN DREAM UP'], '#0f2f5c', '#ffffff'],
    [['COMPETITION', 'DROP FORGED'], '#d8dde3', '#20262c'],
  ];
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8b9096, metalness: 0.7, roughness: 0.5 });
  const posts: THREE.BufferGeometry[] = [];
  let k = 0;
  for (const end of [-1, 1]) {
    const z = end * (HALF_COURT + 5.5);
    for (let i = -5; i <= 5; i++) {
      const x = i * 4.2;
      posts.push(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 6).translate(x, 0.65, z));
      if (i < 5) {
        const [lines, bg, fg, accent] = sponsors[k++ % sponsors.length];
        const tex = bannerTexture(lines, bg, fg, 1024, 256, accent);
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 1.0), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
        banner.position.set(x + 2.1, 0.62, z);
        banner.rotation.y = end > 0 ? Math.PI : 0;
        banner.receiveShadow = true;
        group.add(banner);
      }
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(posts)!, fenceMat));
}

/** Four floodlight towers; their lamp heads and glows light up at night. */
function lightTowers(group: THREE.Group): { heads: THREE.MeshStandardMaterial; glows: THREE.Sprite[] } {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x7c8288, metalness: 0.6, roughness: 0.5 });
  const headGeos: THREE.BufferGeometry[] = [];
  const poles: THREE.BufferGeometry[] = [];
  const glows: THREE.Sprite[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * 16, z = sz * (HALF_COURT + 2);
      poles.push(new THREE.CylinderGeometry(0.12, 0.2, 14, 8).translate(x, 7, z));
      for (let i = 0; i < 4; i++) {
        const ox = (i - 1.5) * 0.62;
        headGeos.push(new THREE.BoxGeometry(0.55, 0.45, 0.25).translate(x + ox * Math.abs(sz), 14.2, z));
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff2d8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        s.position.set(x + ox, 14.2, z - sz * 0.2);
        s.scale.setScalar(3.2);
        s.visible = false;
        glows.push(s);
        group.add(s);
      }
    }
  group.add(new THREE.Mesh(mergeGeometries(poles)!, poleMat));
  const heads = new THREE.MeshStandardMaterial({ color: 0x30343a, emissive: 0x000000, roughness: 0.4 });
  group.add(new THREE.Mesh(mergeGeometries(headGeos)!, heads));
  return { heads, glows };
}

/** Three flags behind the far end that ripple in the wind. */
function flagPoles(group: THREE.Group): { mesh: THREE.Mesh; base: Float32Array; phase: number }[] {
  const cols = [['#b22234', '#ffffff', '#3c3b6e'], ['#13294b', '#f2c14e', '#13294b'], ['#c8102e', '#ffffff', '#c8102e']];
  return cols.map((c, i) => {
    const x = (i - 1) * 6;
    const z = -(HALF_COURT + 8);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 8, 8), new THREE.MeshStandardMaterial({ color: 0xd0d4d8, metalness: 0.8, roughness: 0.3 }));
    pole.position.set(x, 4, z);
    group.add(pole);
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
    group.add(mesh);
    return { mesh, base: Float32Array.from(geo.getAttribute('position').array as Float32Array), phase: i * 1.3 };
  });
}
