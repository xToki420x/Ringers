import type { BufferGeometry } from 'three';

/** Non-indexed copy only when needed (avoids three's warning for already flat geometry). */
export function flat(g: BufferGeometry): BufferGeometry {
  return g.index ? g.toNonIndexed() : g;
}
