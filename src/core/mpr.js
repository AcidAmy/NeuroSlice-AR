// 体素顺序为 LPS 的 [列、行、层]。屏幕始终按放射学方向显示。
export const PLANES = Object.freeze({
  axial: { axis: 2, axes: [0, 1], signs: [1, 1], tags: ['A', 'P', 'R', 'L'], short: 'AX', label: '横断面', color: '#38BDF8' },
  coronal: { axis: 1, axes: [0, 2], signs: [1, -1], tags: ['S', 'I', 'R', 'L'], short: 'COR', label: '冠状面', color: '#10B981' },
  sagittal: { axis: 0, axes: [1, 2], signs: [1, -1], tags: ['S', 'I', 'A', 'P'], short: 'SAG', label: '矢状面', color: '#F59E0B' },
});

export const AXIS_PLANES = ['sagittal', 'coronal', 'axial'];
export const clampVoxel = (value, size) => Math.max(0, Math.min(size - 1, Math.round(value)));

export function planeAspect(plane, dimensions, spacing) {
  const [u, v] = plane.axes;
  return dimensions[u] * spacing[u] / (dimensions[v] * spacing[v]);
}

export function projectVoxel(plane, voxel, dimensions) {
  return plane.axes.map((axis, i) => {
    const ratio = (voxel[axis] + 0.5) / dimensions[axis];
    return plane.signs[i] > 0 ? ratio : 1 - ratio;
  });
}

export function pointToVoxel(plane, point, cursor, dimensions) {
  const result = cursor.slice();
  plane.axes.forEach((axis, i) => {
    const ratio = plane.signs[i] > 0 ? point[i] : 1 - point[i];
    result[axis] = clampVoxel(Math.floor(ratio * dimensions[axis]), dimensions[axis]);
  });
  return result;
}

export function rescaleVoxel(value, fromSize, toSize) {
  return clampVoxel(value * (toSize - 1) / (fromSize - 1), toSize);
}

export function sliceAddress(plane, index, dimensions) {
  const [nx, ny] = dimensions;
  const strides = [1, nx, nx * ny];
  const offset = plane.axes.reduce((start, axis, i) =>
    start + (plane.signs[i] < 0 ? (dimensions[axis] - 1) * strides[axis] : 0), index * strides[plane.axis]);
  const [u, v] = plane.axes.map((axis, i) => strides[axis] * plane.signs[i]);
  return { offset, u, v };
}

// 模型沿用 +X 左、+Y 上、+Z 前；体素索引的向上轴是第三个分量。
export function headFrame(cursor, dimensions, spacing) {
  const lengths = dimensions.map((size, axis) => (size - 1) * spacing[axis]);
  const halfX = lengths[0] / lengths[2];
  const halfZ = lengths[1] / lengths[2];
  const [x, y, z] = cursor.map((value, axis) => 2 * value / (dimensions[axis] - 1) - 1);
  return { point: [x * halfX, z, -y * halfZ], halfX, halfZ };
}
