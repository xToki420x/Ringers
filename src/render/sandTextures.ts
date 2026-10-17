import { canvasTex, fbm, hash, makeCanvas, mix, normalFromHeight, sizeFor, vnoise, type MapSet, type Quality } from './textures';

/** Pitching sand: individual grains, pebbles and shell fragments. */
export function sandMaps(q: Quality, kind: 'sand' | 'clay'): MapSet {
  const S = sizeFor(q, 1024);
  const h = new Float32Array(S * S);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const rough = makeCanvas(S);
  const rctx = rough.getContext('2d')!;
  const rimg = rctx.createImageData(S, S);
  const base = kind === 'sand' ? [196, 164, 118] : [118, 128, 134];
  const dark = kind === 'sand' ? [150, 118, 80] : [86, 96, 104];
  const light = kind === 'sand' ? [226, 204, 160] : [146, 156, 160];
  const grainCells = kind === 'sand' ? 256 : 96;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const broad = fbm(u * 6, v * 6, 6, 4, 3);
      const grain = vnoise(u * grainCells, v * grainCells, grainCells, 9);
      const grain2 = vnoise(u * grainCells * 2, v * grainCells * 2, grainCells * 2, 10);
      const speck = hash(x, y, 77);
      let col = mix(dark, base, broad * 1.2 - 0.1);
      col = mix(col, light, Math.max(0, grain - 0.55) * 1.4);
      if (speck > 0.985) col = mix(col, kind === 'sand' ? [70, 60, 50] : [60, 66, 70], 0.7); // dark mineral grains
      else if (speck < 0.01) col = mix(col, [245, 238, 225], 0.6); // quartz glints
      const hv = grain * 0.6 + grain2 * 0.3 + broad * 0.6 + (kind === 'clay' ? fbm(u * 24, v * 24, 24, 3, 12) * 0.5 : 0);
      h[y * S + x] = hv;
      const i = (y * S + x) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
      const rv = (kind === 'sand' ? 235 : 200) - grain * 30 - (speck < 0.01 ? 120 : 0);
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = rv;
      rimg.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return {
    map: canvasTex(c, true),
    normalMap: canvasTex(normalFromHeight(h, S, kind === 'sand' ? 6 : 4), false),
    roughnessMap: canvasTex(rough, false),
  };
}
