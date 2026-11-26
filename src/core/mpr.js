// 体素顺序为 LPS 的 [列、行、层]。屏幕始终按放射学方向显示。
export const PLANES = Object.freeze({
  axial: { axis: 2, axes: [0, 1], signs: [1, 1], tags: ['A', 'P', 'R', 'L'], short: 'AX', label: '横断面', color: '#38BDF8' },
  coronal: { axis: 1, axes: [0, 2], signs: [1, -1], tags: ['S', 'I', 'R', 'L'], short: 'COR', label: '冠状面', color: '#10B981' },
  sagittal: { axis: 0, axes: [1, 2], signs: [1, -1], tags: ['S', 'I', 'A', 'P'], short: 'SAG', label: '矢状面', color: '#F59E0B' },
});

export const AXIS_PLANES = ['sagittal', 'coronal', 'axial'];
export const OBLIQUE_ENTER_RAD = 1.5 * Math.PI / 180;
export const OBLIQUE_EXIT_RAD = 1.0 * Math.PI / 180;
export const OBLIQUE_STEP_RAD = 0.35 * Math.PI / 180;

const OBLIQUE_BASES = Object.freeze({
  axial: Object.freeze({ u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] }),
  coronal: Object.freeze({ u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, -1] }),
  sagittal: Object.freeze({ u: [0, 0, -1], v: [0, -1, 0], n: [1, 0, 0] }),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
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

export function volumeExtents(dimensions, spacing) {
  const lengths = dimensions.map((size, axis) => (size - 1) * spacing[axis]);
  return { halfX: lengths[0] / lengths[2], halfZ: lengths[1] / lengths[2] };
}

// 模型沿用 +X 左、+Y 上、+Z 前；体素索引的向上轴是第三个分量。
export function headFrame(cursor, dimensions, spacing) {
  const { halfX, halfZ } = volumeExtents(dimensions, spacing);
  const [x, y, z] = cursor.map((value, axis) => 2 * value / (dimensions[axis] - 1) - 1);
  return { point: [x * halfX, z, -y * halfZ], halfX, halfZ };
}

export function headToVoxel(point, dimensions, spacing) {
  const { halfX, halfZ } = volumeExtents(dimensions, spacing);
  return [
    (point[0] / halfX + 1) * (dimensions[0] - 1) * 0.5,
    (1 - point[2] / halfZ) * (dimensions[1] - 1) * 0.5,
    (point[1] + 1) * (dimensions[2] - 1) * 0.5,
  ];
}

export function clampHeadPoint(point, dimensions, spacing) {
  const { halfX, halfZ } = volumeExtents(dimensions, spacing);
  return [
    clamp(point[0], -halfX, halfX),
    clamp(point[1], -1, 1),
    clamp(point[2], -halfZ, halfZ),
  ];
}

export function normalizeQuaternion(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(length) || length < 1e-8) return [0, 0, 0, 1];
  const sign = q[3] < 0 ? -1 : 1;
  return [sign * q[0] / length, sign * q[1] / length, sign * q[2] / length, sign * q[3] / length];
}

// 自拍镜像是沿 X 轴的基变换；再次共轭即可恢复未镜像的解剖真实头姿。
export function unmirrorQuaternion(q) {
  return normalizeQuaternion([q[0], -q[1], -q[2], q[3]]);
}

export function invertQuaternion(q) {
  const [x, y, z, w] = normalizeQuaternion(q);
  return [-x, -y, -z, w];
}

export function quatAngle(q) {
  const [, , , w] = normalizeQuaternion(q);
  return 2 * Math.acos(clamp(w, -1, 1));
}

export function quatDeltaAngle(a, b) {
  if (!a && !b) return 0;
  const qa = a ? normalizeQuaternion(a) : [0, 0, 0, 1];
  const qb = b ? normalizeQuaternion(b) : [0, 0, 0, 1];
  const dot = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
  return 2 * Math.acos(clamp(dot, -1, 1));
}

export function rotateVec3(v, q) {
  const [vx, vy, vz] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 按放射学 PACS 规范生成斜切边缘方位标签（+X=L/-X=R，+Y=S/-Y=I，+Z=A/-Z=P）。
export function directionLabel(vec) {
  const components = [
    [Math.abs(vec[0]), vec[0] >= 0 ? 'L' : 'R'],
    [Math.abs(vec[1]), vec[1] >= 0 ? 'S' : 'I'],
    [Math.abs(vec[2]), vec[2] >= 0 ? 'A' : 'P'],
  ].sort((a, b) => b[0] - a[0]);
  return components[1][0] >= 0.2588 ? components[0][1] + components[1][1] : components[0][1];
}

export function obliquePlaneTags(u, v) {
  return [
    directionLabel([-v[0], -v[1], -v[2]]),
    directionLabel(v),
    directionLabel([-u[0], -u[1], -u[2]]),
    directionLabel(u),
  ];
}

export function obliquePlaneFrame(key, pivot, dimensions, spacing, obliqueQuat) {
  const q = obliqueQuat ? normalizeQuaternion(obliqueQuat) : [0, 0, 0, 1];
  const { halfX, halfZ } = volumeExtents(dimensions, spacing);
  const halfSizes = key === 'axial' ? [halfX, halfZ, 1]
    : key === 'coronal' ? [halfX, 1, halfZ] : [halfZ, 1, halfX];
  const [halfU, halfV, halfN] = halfSizes;
  const basis = OBLIQUE_BASES[key];
  const u = rotateVec3(basis.u, q);
  const v = rotateVec3(basis.v, q);
  const n = rotateVec3(basis.n, q);
  const offset = dot3(pivot, n);
  const center = [n[0] * offset, n[1] * offset, n[2] * offset];
  const cross = [
    clamp(0.5 + dot3(pivot, u) / (2 * halfU), 0, 1),
    clamp(0.5 + dot3(pivot, v) / (2 * halfV), 0, 1),
  ];
  return {
    key, quat: q, center, u, v, n, halfU, halfV, halfN, halfX, halfZ, offset, cross,
    tags: obliquePlaneTags(u, v),
    angleDeg: Math.round(quatAngle(q) * 180 / Math.PI),
  };
}

export function buildObliqueFrames(pivot, dimensions, spacing, obliqueQuat) {
  return {
    axial: obliquePlaneFrame('axial', pivot, dimensions, spacing, obliqueQuat),
    coronal: obliquePlaneFrame('coronal', pivot, dimensions, spacing, obliqueQuat),
    sagittal: obliquePlaneFrame('sagittal', pivot, dimensions, spacing, obliqueQuat),
  };
}

export function obliquePointToHead(frame, point2d, dimensions, spacing) {
  const su = (clamp(point2d[0], 0, 1) * 2 - 1) * frame.halfU;
  const sv = (clamp(point2d[1], 0, 1) * 2 - 1) * frame.halfV;
  return clampHeadPoint([
    frame.center[0] + frame.u[0] * su + frame.v[0] * sv,
    frame.center[1] + frame.u[1] * su + frame.v[1] * sv,
    frame.center[2] + frame.u[2] * su + frame.v[2] * sv,
  ], dimensions, spacing);
}

export function obliqueSliceIndex(frame, pivot, depth) {
  const ratio = (dot3(pivot, frame.n) / frame.halfN + 1) * 0.5;
  return clampVoxel(ratio * (depth - 1), depth);
}

export function stepObliquePivot(frame, pivot, index, depth, dimensions, spacing) {
  const clamped = clampVoxel(index, depth);
  const targetOffset = (2 * clamped / (depth - 1) - 1) * frame.halfN;
  const delta = targetOffset - dot3(pivot, frame.n);
  return clampHeadPoint([
    pivot[0] + frame.n[0] * delta,
    pivot[1] + frame.n[1] * delta,
    pivot[2] + frame.n[2] * delta,
  ], dimensions, spacing);
}

export function projectPointToOblique(frame, point3d, depth) {
  const dx = point3d[0] - frame.center[0];
  const dy = point3d[1] - frame.center[1];
  const dz = point3d[2] - frame.center[2];
  const distNormal = Math.abs(dx * frame.n[0] + dy * frame.n[1] + dz * frame.n[2]);
  const distSlices = distNormal / (2 * frame.halfN) * (depth - 1);
  const u = 0.5 + (dx * frame.u[0] + dy * frame.u[1] + dz * frame.u[2]) / (2 * frame.halfU);
  const v = 0.5 + (dx * frame.v[0] + dy * frame.v[1] + dz * frame.v[2]) / (2 * frame.halfV);
  return { u, v, distSlices };
}

function planeVoxelGrid(frame, width, height, dims) {
  const sx = (dims[0] - 1) * 0.5 / frame.halfX;
  const sy = -(dims[1] - 1) * 0.5 / frame.halfZ;
  const sz = (dims[2] - 1) * 0.5;
  const spanU = width > 1 ? 2 * frame.halfU / (width - 1) : 0;
  const spanV = height > 1 ? 2 * frame.halfV / (height - 1) : 0;
  const dux = frame.u[0] * spanU * sx;
  const duy = frame.u[2] * spanU * sy;
  const duz = frame.u[1] * spanU * sz;
  const dvx = frame.v[0] * spanV * sx;
  const dvy = frame.v[2] * spanV * sy;
  const dvz = frame.v[1] * spanV * sz;
  const cx = (frame.center[0] / frame.halfX + 1) * (dims[0] - 1) * 0.5;
  const cy = (1 - frame.center[2] / frame.halfZ) * (dims[1] - 1) * 0.5;
  const cz = (frame.center[1] + 1) * (dims[2] - 1) * 0.5;
  const halfW = (width - 1) * 0.5;
  const halfH = (height - 1) * 0.5;
  return {
    ox: cx - halfW * dux - halfH * dvx,
    oy: cy - halfW * duy - halfH * dvy,
    oz: cz - halfW * duz - halfH * dvz,
    dux, duy, duz, dvx, dvy, dvz,
  };
}

function sampleTrilinear(volume, vx, vy, vz, nx, strideZ, maxX, maxY, maxZ) {
  const x0 = vx | 0;
  const y0 = vy | 0;
  const z0 = vz | 0;
  const x1 = x0 < maxX ? x0 + 1 : maxX;
  const y1 = y0 < maxY ? y0 + 1 : maxY;
  const z1 = z0 < maxZ ? z0 + 1 : maxZ;
  const fx = vx - x0;
  const fy = vy - y0;
  const fz = vz - z0;
  const z0Off = z0 * strideZ;
  const z1Off = z1 * strideZ;
  const y0Off = y0 * nx;
  const y1Off = y1 * nx;
  const c000 = volume[z0Off + y0Off + x0];
  const c100 = volume[z0Off + y0Off + x1];
  const c010 = volume[z0Off + y1Off + x0];
  const c110 = volume[z0Off + y1Off + x1];
  const c001 = volume[z1Off + y0Off + x0];
  const c101 = volume[z1Off + y0Off + x1];
  const c011 = volume[z1Off + y1Off + x0];
  const c111 = volume[z1Off + y1Off + x1];
  const c00 = c000 + (c100 - c000) * fx;
  const c10 = c010 + (c110 - c010) * fx;
  const c01 = c001 + (c101 - c001) * fx;
  const c11 = c011 + (c111 - c011) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

function smoothAlpha(value, start, end) {
  if (value <= start) return 0;
  if (value >= end) return 255;
  const t = (value - start) / (end - start);
  return Math.max(1, Math.round(255 * t * t * (3 - 2 * t)));
}

// 统一供 2D 右侧预览和 3D 切面显影复用的斜断层体素采样器。
export function sampleObliqueSlice(output, width, height, frame, dims, volume, lut, bias, {
  trilinear = true,
  airValue = bias ? -1024 : 0,
  alphaMask = null,
} = {}) {
  const [nx, ny, nz] = dims;
  const maxX = nx - 1;
  const maxY = ny - 1;
  const maxZ = nz - 1;
  const strideZ = nx * ny;
  const grid = planeVoxelGrid(frame, width, height, dims);
  const bgGray = lut[airValue + bias];

  let maskGrid, maskDims, maskStrideZ, maskMaxX, maskMaxY, maskMaxZ;
  const hasMask = Boolean(alphaMask);
  const maskCt = alphaMask?.ct ?? null;
  const maskRealCt = Boolean(alphaMask?.realCt);
  const sameMaskGrid = hasMask && maskCt && alphaMask.ctDims.every((size, axis) => size === dims[axis]);
  if (hasMask && maskCt && !sameMaskGrid) {
    maskDims = alphaMask.ctDims;
    maskGrid = planeVoxelGrid(frame, width, height, maskDims);
    maskStrideZ = maskDims[0] * maskDims[1];
    maskMaxX = maskDims[0] - 1;
    maskMaxY = maskDims[1] - 1;
    maskMaxZ = maskDims[2] - 1;
  }

  const eps = 1e-5;
  for (let row = 0, i = 0; row < height; row++) {
    let vx = grid.ox + row * grid.dvx;
    let vy = grid.oy + row * grid.dvy;
    let vz = grid.oz + row * grid.dvz;
    let mx = maskGrid ? maskGrid.ox + row * maskGrid.dvx : 0;
    let my = maskGrid ? maskGrid.oy + row * maskGrid.dvy : 0;
    let mz = maskGrid ? maskGrid.oz + row * maskGrid.dvz : 0;
    for (let col = 0; col < width; col++, i += 4) {
      const inside = vx >= -eps && vx <= maxX + eps && vy >= -eps && vy <= maxY + eps && vz >= -eps && vz <= maxZ + eps;
      if (!inside) {
        if (hasMask) {
          output[i] = output[i + 1] = output[i + 2] = output[i + 3] = 0;
        } else {
          output[i] = output[i + 1] = output[i + 2] = bgGray;
          output[i + 3] = 255;
        }
      } else {
        const cvx = vx < 0 ? 0 : vx > maxX ? maxX : vx;
        const cvy = vy < 0 ? 0 : vy > maxY ? maxY : vy;
        const cvz = vz < 0 ? 0 : vz > maxZ ? maxZ : vz;
        let value;
        if (trilinear) {
          value = Math.round(sampleTrilinear(volume, cvx, cvy, cvz, nx, strideZ, maxX, maxY, maxZ));
        } else {
          value = volume[((cvz + 0.5) | 0) * strideZ + ((cvy + 0.5) | 0) * nx + ((cvx + 0.5) | 0)];
        }
        const gray = lut[value + bias];
        if (!hasMask) {
          output[i] = output[i + 1] = output[i + 2] = gray;
          output[i + 3] = 255;
        } else {
          let alpha;
          if (!maskCt) {
            alpha = smoothAlpha(value, 2, 14);
          } else {
            let hu;
            if (sameMaskGrid) {
              hu = trilinear
                ? sampleTrilinear(maskCt, cvx, cvy, cvz, nx, strideZ, maxX, maxY, maxZ)
                : maskCt[((cvz + 0.5) | 0) * strideZ + ((cvy + 0.5) | 0) * nx + ((cvx + 0.5) | 0)];
            } else if (mx >= -eps && mx <= maskMaxX + eps && my >= -eps && my <= maskMaxY + eps && mz >= -eps && mz <= maskMaxZ + eps) {
              const cmx = mx < 0 ? 0 : mx > maskMaxX ? maskMaxX : mx;
              const cmy = my < 0 ? 0 : my > maskMaxY ? maskMaxY : my;
              const cmz = mz < 0 ? 0 : mz > maskMaxZ ? maskMaxZ : mz;
              hu = trilinear
                ? sampleTrilinear(maskCt, cmx, cmy, cmz, maskDims[0], maskStrideZ, maskMaxX, maskMaxY, maskMaxZ)
                : maskCt[((cmz + 0.5) | 0) * maskStrideZ + ((cmy + 0.5) | 0) * maskDims[0] + ((cmx + 0.5) | 0)];
            } else {
              hu = -1024;
            }
            alpha = maskRealCt ? smoothAlpha(hu, -450, -350) : smoothAlpha(hu, -900, -750);
          }
          output[i] = output[i + 1] = output[i + 2] = Math.round(gray * alpha / 255);
          output[i + 3] = alpha;
        }
      }
      vx += grid.dux;
      vy += grid.duy;
      vz += grid.duz;
      if (maskGrid) {
        mx += maskGrid.dux;
        my += maskGrid.duy;
        mz += maskGrid.duz;
      }
    }
  }
}
