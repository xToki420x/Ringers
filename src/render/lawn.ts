import * as THREE from 'three';
import { GRASS_TIERS } from './grass';
import { GRASS_LOOKS, WILD } from './grassStyles';
import { LAWN_FIELDS_GLSL, lawnFieldUniforms } from './lawnFields';
import { GRASS_TILE } from './lawnTextures';
import type { MapSet, Quality } from './textures';

/**
 * The ground around the courts. Each venue picks a grass style: a striped,
 * manicured championship lawn, a homeowner's backyard, a public park, or a
 * natural lakeside meadow.
 */

export type GrassStyle = 'manicured' | 'backyard' | 'park' | 'meadow';

export interface LawnOptions {
  style: GrassStyle;
  /** Side length of the square ground, metres. */
  size: number;
  /** Centre x of each court (worn walking lanes run beside them). */
  courts: number[];
}

const lin = (hex: number) => new THREE.Color(hex);

/**
 * Turf shaded per pixel: the grass maps blended at two scales and angles
 * (so the tile never repeats visibly), tinted per style with large-scale
 * tonal and hue variation, clover and dry patches, worn soil where players
 * walk, long meadow grass, and view-dependent mowing stripes. Looking
 * steeply down shows the shaded gaps between blades; at grazing angles the
 * turf closes up and catches a soft sheen, as a real lawn does.
 */
export function buildLawn(grass: MapSet, q: Quality, opts: LawnOptions): THREE.Group {
  const group = new THREE.Group();
  const look = GRASS_LOOKS[opts.style];
  const normalMap = grass.normalMap.clone();
  normalMap.repeat.set(opts.size / GRASS_TILE, opts.size / GRASS_TILE);
  normalMap.needsUpdate = true;
  const mean = (grass.map.userData.mean as number[] | undefined) ?? [0.05, 0.1, 0.03];
  const uniforms = {
    ...lawnFieldUniforms(look, opts.courts),
    uDetail: { value: grass.map },
    uDetailInv: { value: new THREE.Vector3(1 / mean[0], 1 / mean[1], 1 / mean[2]) },
    uGround: { value: lin(look.ground) },
    uDry: { value: lin(look.dry) },
    uClover: { value: lin(look.clover) },
    uSoil: { value: lin(look.soil) },
    uWild: { value: lin(WILD.ground) },
    uSeed: { value: lin(WILD.seed) },
    uMeadowDepth: { value: new THREE.Vector2(GRASS_TIERS[q].wild.thin[0], GRASS_TIERS[q].wild.thin[1]) },
    uStripe: { value: new THREE.Vector2(look.stripes, look.stripeWidth) },
    uSoilShow: { value: look.soilShow },
  };
  const mat = new THREE.MeshStandardMaterial({ normalMap, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.92 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLawnPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLawnPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLawnPos;
        uniform sampler2D uDetail;
        uniform vec3 uDetailInv, uGround, uDry, uClover, uSoil, uWild, uSeed;
        uniform vec2 uStripe, uMeadowDepth;
        uniform float uSoilShow;
        ${LAWN_FIELDS_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 lp = vLawnPos.xz;
        vec3 toEye = cameraPosition - vLawnPos;
        float eyeDist = length(toEye);
        float grazing = 1.0 - clamp(toEye.y / max(eyeDist, 1e-3), 0.0, 1.0);
        vec4 fields = lawnFieldsAt(lp);
        float macro = lawnMacro(lp);
        float hue = lawnHue(lp);
        vec3 turf = uGround * (0.8 + 0.42 * macro);
        turf *= mix(vec3(0.9, 1.0, 1.08), vec3(1.12, 1.02, 0.8), hue);
        turf = mix(turf, uClover * (0.85 + 0.3 * macro), fields.x * 0.6);
        turf = mix(turf, uDry * (0.85 + 0.3 * macro), fields.y * 0.45);
        if (uFieldCover.w > 0.0) {
          // Long meadow grass: near the eye, the shade deep down between the
          // tussocks; further off, where the tussocks thin out, the canopy
          // itself: wind-combed swathes, drifts of ripening grass and the
          // seed heads' pale haze at grazing angles.
          float tussock = 0.6 * texture2D(uFieldNoise, lp / 1.9).a + 0.4 * texture2D(uFieldNoise, lawnRot(lp) / 0.73).a;
          float ripe = smoothstep(0.45, 0.95, texture2D(uFieldNoise, lawnRot(lp) / 13.0).b);
          float swathe = texture2D(uFieldNoise, vec2(lp.x / 23.0, lp.y / 7.0)).g;
          vec3 meadow = uWild * (0.7 + 0.6 * macro) * (0.55 + 0.75 * tussock) * (0.85 + 0.3 * swathe);
          meadow = mix(meadow, uSeed * (0.8 + 0.4 * tussock), 0.35 * ripe + 0.2 * pow(grazing, 4.0));
          meadow *= mix(1.0, 0.45, 1.0 - smoothstep(uMeadowDepth.x, uMeadowDepth.y, eyeDist));
          turf = mix(turf, meadow, fields.w);
        }
        // Mown stripes: grass laid away from the eye looks light, toward it dark.
        if (uStripe.x > 0.0) {
          float lane = floor(lp.x / uStripe.y + 0.5);
          float dir = mod(lane, 2.0) < 0.5 ? 1.0 : -1.0;
          float along = toEye.z / max(length(toEye.xz), 1e-3);
          turf *= 1.0 + uStripe.x * dir * (0.25 - along);
        }
        // Two scales of turf detail at different angles hide the tiling.
        vec3 dA = texture2D(uDetail, lp / ${GRASS_TILE.toFixed(3)}).rgb;
        vec3 dB = texture2D(uDetail, lawnRot(lp) / ${(GRASS_TILE * 0.37).toFixed(4)} + 0.31).rgb;
        vec3 detail = dA * uDetailInv * dB * uDetailInv;
        float steep = 1.0 - smoothstep(0.25, 0.92, grazing);
        turf *= mix(vec3(1.0), detail, 0.5 + 0.3 * steep) * mix(1.04, 0.8, steep);
        // Worn ground: flattened, paler grass first, then bare soil.
        float wear = fields.z;
        turf = mix(turf, turf * vec3(1.15, 1.08, 0.85), smoothstep(0.0, 0.5, wear));
        float bare = smoothstep(0.4, 0.85, wear + (dA.g * uDetailInv.g + dB.g * uDetailInv.g - 2.0) * 0.3) * uSoilShow;
        turf = mix(turf, uSoil * (0.75 + 0.5 * detail.r), bare);
        // Distant turf closes up into a soft, slightly paler sheen.
        turf = mix(turf, turf * vec3(1.16, 1.12, 0.92), pow(grazing, 6.0) * 0.55);
        diffuseColor.rgb *= turf;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // Turf scatters light between blades: far less glossy than a smooth dielectric.
        reflectedLight.directSpecular *= 0.2;
        reflectedLight.indirectSpecular *= 0.1;
        // The blades shade each other from the sky.
        reflectedLight.indirectDiffuse *= 0.55;`,
      );
  };
  const segs = q === 'low' ? 16 : 32;
  const geo = new THREE.PlaneGeometry(opts.size, opts.size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const lawn = new THREE.Mesh(geo, mat);
  lawn.position.y = -0.02;
  lawn.receiveShadow = true;
  group.add(lawn);
  return group;
}
