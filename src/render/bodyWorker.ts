import { buildBodyArrays, type Pose } from './humanBody';

self.onmessage = (e: MessageEvent<{ pose: Pose; cell: number }>) => {
  const a = buildBodyArrays(e.data.pose, e.data.cell);
  (self as unknown as Worker).postMessage(a, [a.position.buffer, a.normal.buffer, a.mats.buffer, a.matW.buffer, a.color.buffer, a.skinIndex.buffer, a.skinWeight.buffer, a.index.buffer]);
};
