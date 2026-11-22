export const AXIAL_ANCHORS = Object.freeze([
  { id: 10, ratio: 1 },     // 颅顶方向的额部代理点
  { id: 168, ratio: 0.69 }, // 眉间
  { id: 1, ratio: 0.39 },   // 鼻尖
  { id: 152, ratio: 0 },    // 下颌颏部
].map(Object.freeze));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const validPoint = point => point && [point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1);

function readReference(face) {
  const points = AXIAL_ANCHORS.map(({ id }) => face?.[id]);
  if (!points.every(validPoint)) return null;
  const ys = points.map(point => point.y);
  const span = ys[3] - ys[0];
  if (span < 0.075 || ys.slice(1).some((y, index) => y - ys[index] < 0.012)) return null;
  const x = (points[0].x + points[3].x) / 2;
  return { ys, span, x, y: (ys[0] + ys[3]) / 2 };
}

export function ratioForY(y, anchors) {
  if (y <= anchors[0]) return AXIAL_ANCHORS[0].ratio;
  for (let i = 1; i < anchors.length; i++) {
    if (y <= anchors[i]) {
      const portion = (y - anchors[i - 1]) / (anchors[i] - anchors[i - 1]);
      return AXIAL_ANCHORS[i - 1].ratio + portion * (AXIAL_ANCHORS[i].ratio - AXIAL_ANCHORS[i - 1].ratio);
    }
  }
  return AXIAL_ANCHORS.at(-1).ratio;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function consistent(a, b) {
  return distance(a, b) <= Math.max(0.014, a.span * 0.10) &&
    a.ys.every((y, index) => Math.abs(y - b.ys[index]) <= 0.034);
}

export function createSpatialMapper({
  alpha = 0.25, deadzone = 0.3, pinchClose = 0.042, pinchOpen = 0.065,
  pinchHoldMs = 200, manualHoldMs = 650,
} = {}) {
  let index = 0;
  let locked = false;
  let reference = null;
  let candidate = null;
  let filteredY = null;
  let filteredX = null;
  let filteredReach = null;
  let lastHandAt = -Infinity;
  let previousMapped = null;
  let pinchSince = null;
  let pinchLatched = false;
  let manualUntil = -Infinity;
  let manualActive = false;
  let pickup = false;

  function updateReference(face, hasHand) {
    const next = readReference(face);
    if (!next) {
      candidate = null;
      return;
    }
    const stable = candidate && consistent(candidate, next);
    candidate = next;
    if (!hasHand) {
      if (!reference || stable) reference = next;
      return;
    }
    if (!reference) {
      reference = next;
      return;
    }
    // 用前后连续两帧确认位移，同时排除局部五官被遮挡造成的锚点变形。
    const shapeDifference = Math.max(...next.ys.slice(1, -1).map((y, i) =>
      Math.abs((y - next.ys[0]) / next.span - (reference.ys[i + 1] - reference.ys[0]) / reference.span)));
    if (stable && distance(reference, next) > Math.max(0.078, reference.span * 0.24) &&
        next.span / reference.span > 0.68 && next.span / reference.span < 1.48 && shapeDifference < 0.15) {
      reference = next;
    }
  }

  function update({ now, faceLandmarks, handLandmarks, depth, plane = 'axial' }) {
    const hand = handLandmarks?.[0];
    const tip = hand?.[8];
    const thumb = hand?.[4];
    const hasHand = validPoint(tip) && validPoint(thumb);
    if (!hasHand || now - lastHandAt > 300) {
      filteredY = filteredX = filteredReach = null;
      previousMapped = null;
      pinchSince = null;
    }
    if (!hasHand && now - lastHandAt > 280) {
      pinchLatched = false;
      if (!manualActive && now >= manualUntil) pickup = false;
    }
    updateReference(faceLandmarks, hasHand);
    if (!hasHand) return { index, locked, pickup, confirmed: false, rawY: null, filteredY: null };

    lastHandAt = now;
    filteredY = filteredY === null ? tip.y : filteredY + alpha * (tip.y - filteredY);
    filteredX = filteredX === null ? tip.x : filteredX + alpha * (tip.x - filteredX);
    // 掌宽随手靠近摄像头而增大，作为冠状面前后移动的辅助量；缺点时使用上下滑动。
    if (reference && validPoint(hand[5]) && validPoint(hand[17])) {
      const reach = distance(hand[5], hand[17]) / reference.span;
      filteredReach = filteredReach === null ? reach : filteredReach + alpha * (reach - filteredReach);
    } else {
      filteredReach = null;
    }
    const depthDifference = Number.isFinite(tip.z) && Number.isFinite(thumb.z) ? tip.z - thumb.z : 0;
    const pinchDistance = Math.hypot(tip.x - thumb.x, tip.y - thumb.y, depthDifference);
    let confirmed = false;
    if (pinchDistance >= pinchOpen) {
      pinchLatched = false;
      pinchSince = null;
    } else if (!pinchLatched) {
      if (pinchDistance <= pinchClose) {
        pinchSince ??= now;
        if (now - pinchSince >= pinchHoldMs) {
          locked = !locked;
          if (!locked) pickup = true;
          confirmed = true;
          pinchLatched = true;
        }
      } else {
        pinchSince = null;
      }
    }

    if (reference && depth > 1) {
      let ratio = ratioForY(filteredY, reference.ys);
      if (plane === 'sagittal') {
        ratio = 0.5 + (filteredX - reference.x) / reference.span;
      } else if (plane === 'coronal') {
        const relativeReach = filteredReach === null ? 0 : clamp((0.27 - filteredReach) * 0.7, -0.24, 0.24);
        ratio = (filteredY - reference.ys[0]) / reference.span + relativeReach;
      }
      const mapped = clamp(ratio, 0, 1) * (depth - 1);
      const canNavigate = !locked && !confirmed && !pinchLatched && pinchSince === null &&
        !manualActive && now >= manualUntil;
      if (canNavigate && pickup) {
        const crossed = previousMapped !== null && (previousMapped - index) * (mapped - index) <= 0;
        if (Math.abs(mapped - index) <= 2 || crossed) {
          pickup = false;
          previousMapped = mapped;
          // 接管的第一帧保留当前层，避免鼠标和手势争抢导致跳层。
          return { index, locked, pickup, confirmed, rawY: tip.y, filteredY };
        }
      }
      if (canNavigate && !pickup && Math.abs(mapped - index) > 0.5 + deadzone) {
        index = clamp(Math.round(mapped), 0, depth - 1);
      }
      previousMapped = mapped;
    }
    return { index, locked, pickup, confirmed, rawY: tip.y, filteredY };
  }

  function setManual(value, now, active = false) {
    index = value;
    manualActive = active;
    manualUntil = now + manualHoldMs;
    pickup = now - lastHandAt <= 280;
    previousMapped = null;
    return index;
  }

  function reset(value) {
    index = value;
    locked = false;
    reference = candidate = null;
    lastHandAt = manualUntil = -Infinity;
    filteredY = filteredX = filteredReach = previousMapped = pinchSince = null;
    pinchLatched = manualActive = pickup = false;
  }

  return { update, setManual, reset, unlock() { locked = false; } };
}
