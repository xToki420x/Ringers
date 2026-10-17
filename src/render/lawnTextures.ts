import { canvasTex, fbm, makeCanvas, mix, normalFromHeight, sizeFor, vnoise, type MapSet, type Quality } from './textures';

/** Mown lawn: fine blades with gentle tonal variation (macro variation is added per-vertex). */
export function grassMaps(q: Quality): MapSet {
  const S = sizeFor(q, 1024);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const h = new Float32Array(S * S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const broad = fbm(u * 4, v * 4, 4, 3, 21);
      const blades = vnoise(u * 256, v * 256, 256, 22) * 0.55 + vnoise(u * 512, v * 512, 512, 23) * 0.45;
      const clump = fbm(u * 24, v * 24, 24, 3, 25);
      const t = 0.35 + broad * 0.25 + (blades - 0.5) * 0.35 + (clump - 0.5) * 0.3;
      const col = mix([58, 92, 38], [96, 132, 56], Math.max(0, Math.min(1, t)));
      const dry = fbm(u * 10, v * 10, 10, 3, 24);
      const fin = dry > 0.7 ? mix(col, [128, 124, 78], (dry - 0.7) * 1.5) : col;
      const i = (y * S + x) * 4;
      img.data[i] = fin[0];
      img.data[i + 1] = fin[1];
      img.data[i + 2] = fin[2];
      img.data[i + 3] = 255;
      h[y * S + x] = blades * 0.7 + clump * 0.3;
    }
  ctx.putImageData(img, 0, 0);
  return { map: canvasTex(c, true), normalMap: canvasTex(normalFromHeight(h, S, 1.6), false) };
}
