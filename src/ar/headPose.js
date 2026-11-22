import { Matrix4, Quaternion, Vector3 } from 'three';
import { OneEuro, OneEuroQuat, OneEuroVec3, stepSeconds } from '../filters.js';

// 和视频画布的 object-fit: cover 使用相同的居中裁切。
export function cameraCrop(viewWidth, viewHeight, frameWidth, frameHeight) {
  const scale = Math.max(viewWidth / frameWidth, viewHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return point => ({
    x: (viewWidth - width) / 2 + point.x * width,
    y: (viewHeight - height) / 2 + point.y * height,
    ...(Number.isFinite(point.z) ? { z: point.z * width } : {}),
  });
}

const mirrorX = new Matrix4().makeScale(-1, 1, 1);
const orbitAnchor = new Vector3(0, 0.07, 0.60);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function fitLiveHead(head, pose, { scale, scaleX, scaleY }) {
  const size = pose.scale * scale;
  head.quaternion.copy(pose.rotation);
  // 调整任一缩放轴时，眶部仍固定在追踪锚点。
  head.scale.set(size * 1.04 * scaleX, size * 1.025 * scaleY, size);
  head.position.copy(orbitAnchor).multiply(head.scale).applyQuaternion(head.quaternion).negate().add(pose.anchor);
}

export function createHeadPose() {
  const rotation = new Quaternion();
  const anchor = new Vector3();
  const target = new Vector3();
  const brow = new Vector3();
  const bridge = new Vector3();
  const noseBase = new Vector3();
  const outerLeft = new Vector3();
  const outerRight = new Vector3();
  const innerLeft = new Vector3();
  const innerRight = new Vector3();
  const orbitLeft = new Vector3();
  const orbitRight = new Vector3();
  const templeLeft = new Vector3();
  const templeRight = new Vector3();
  const matrix = new Matrix4();
  const matrixPosition = new Vector3();
  const matrixRotation = new Quaternion();
  const matrixScale = new Vector3();
  const filterPosition = new OneEuroVec3({ minCutoff: 2.1, beta: 1.6 });
  const filterRotation = new OneEuroQuat({ minCutoff: 2.6, beta: 12 });
  const filterScale = new OneEuro({ minCutoff: 2.3, beta: 1.1 });
  let lastTime = 0;

  function reset() {
    lastTime = 0;
    filterPosition.reset();
    filterRotation.reset();
    filterScale.reset();
  }

  function update(frame, map, width, height) {
    const matrixData = frame.transformMatrix;
    const points = frame.faceLandmarks;
    if (!points || matrixData?.length !== 16 || !matrixData.every(Number.isFinite)) return null;

    matrix.fromArray(matrixData);
    // 标准列优先矩阵的最后一行是 [0, 0, 0, 1]，也兼容行优先的仿射数据。
    if (Math.hypot(matrixData[3], matrixData[7], matrixData[11]) > 1e-5) matrix.transpose();
    // 镜像是一次坐标基变换。两侧乘 M 保留正向旋转，所有部位共用该姿态。
    matrix.premultiply(mirrorX).multiply(mirrorX);
    matrix.decompose(matrixPosition, matrixRotation, matrixScale);
    if (matrixScale.x < 0.01 || matrixScale.y < 0.01 || matrixScale.z < 0.01 ||
        ![matrixRotation.x, matrixRotation.y, matrixRotation.z, matrixRotation.w].every(Number.isFinite)) return null;
    matrixRotation.normalize();

    function landmark(index, point) {
      const sample = points[index];
      if (!Number.isFinite(sample?.x) || !Number.isFinite(sample.y)) return false;
      const mapped = map(sample);
      point.set((width - 2 * mapped.x) / height, 1 - 2 * mapped.y / height, -2 * (mapped.z ?? 0) / height);
      return true;
    }
    if (!landmark(33, outerLeft) || !landmark(263, outerRight) ||
        !landmark(133, innerLeft) || !landmark(362, innerRight) ||
        !landmark(168, brow) || !landmark(6, bridge)) return null;
    orbitLeft.copy(outerLeft).lerp(innerLeft, 0.5);
    orbitRight.copy(outerRight).lerp(innerRight, 0.5);
    const eyeScale = 0.65 * orbitLeft.distanceTo(orbitRight) / 0.56 +
      0.35 * outerLeft.distanceTo(outerRight) / 0.85;
    if (eyeScale < 1e-4) return null;
    const templeScale = landmark(127, templeLeft) && landmark(356, templeRight)
      ? templeLeft.distanceTo(templeRight) / 1.08 : eyeScale;
    const noseScale = landmark(2, noseBase) ? brow.distanceTo(noseBase) / 0.42 : eyeScale;
    // 按裁切后的三维距离估算尺寸，限制不稳定深度测量的影响。
    const size = clamp(0.53 * eyeScale + 0.35 * clamp(templeScale, eyeScale * 0.75, eyeScale * 1.30) +
      0.12 * clamp(noseScale, eyeScale * 0.75, eyeScale * 1.30), 0.08, 2.5);
    bridge.lerp(brow, 0.5);
    target.copy(orbitLeft).lerp(orbitRight, 0.5).lerp(bridge, 0.22);
    target.z = 0;
    if (!lastTime || frame.now - lastTime > 350) {
      reset();
      anchor.copy(target);
      rotation.copy(matrixRotation);
    } else {
      const dt = stepSeconds(frame.now, lastTime);
      filterPosition.step(anchor, target, dt);
      filterRotation.step(rotation, matrixRotation, dt);
    }
    const scale = filterScale.filter(size, stepSeconds(frame.now, lastTime || frame.now));
    lastTime = frame.now;
    return { anchor, rotation, scale };
  }

  return { update, reset };
}

// 预览和真人追踪共用模型父节点；拖拽仅改变无摄像头时的头姿。
export function createPreviewOrbit() {
  let pitch = -0.11;
  let yaw = 0.31;
  return {
    drag(dx, dy) {
      yaw += dx * 0.012;
      pitch = Math.max(-1.35, Math.min(1.35, pitch + dy * 0.012));
    },
    apply(target) { target.set(pitch, yaw, -0.035); },
  };
}
