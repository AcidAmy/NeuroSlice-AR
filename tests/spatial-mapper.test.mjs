import assert from 'node:assert/strict';
import test from 'node:test';
import { AXIAL_ANCHORS, createSpatialMapper, ratioForY } from '../src/core/spatialMapper.js';

const ys = [0.2, 0.35, 0.5, 0.78];
function face(dy = 0, positions = ys) {
  const result = [];
  AXIAL_ANCHORS.forEach(({ id }, i) => { result[id] = { x: 0.48, y: positions[i] + dy }; });
  return result;
}

function hand(y, pinchDistance = 0.12) {
  const points = [];
  points[8] = { x: 0.48, y };
  points[4] = { x: 0.48 + pinchDistance, y };
  return [points];
}

function update(mapper, now, y, { depth = 101, distance, landmarks = face() } = {}) {
  return mapper.update({ now, faceLandmarks: landmarks, handLandmarks: y === null ? [] : hand(y, distance), depth });
}

test('the four endpoints and interpolated segments map consistently at different depths', () => {
  for (const [i, { ratio }] of AXIAL_ANCHORS.entries()) assert.equal(ratioForY(ys[i], ys), ratio);
  assert.equal(ratioForY(0.12, ys), 1);
  assert.equal(ratioForY(0.93, ys), 0);
  assert.ok(Math.abs(ratioForY(0.425, ys) - 0.54) < 1e-9);
  const mapper = createSpatialMapper();
  mapper.reset(0);
  assert.equal(update(mapper, 10, 0.425, { depth: 160 }).index, 86);
});

test('EMA filters the same raw samples and hysteresis blocks sub-layer flicker', () => {
  const mapper = createSpatialMapper();
  assert.equal(update(mapper, 10, 0.35).index, 69);
  const result = update(mapper, 43, 0.36);
  assert.equal(result.rawY, 0.36);
  assert.ok(Math.abs(result.filteredY - 0.3525) < 1e-9);
  assert.equal(result.index, 69);
  assert.ok(update(mapper, 76, 0.45).index < 69);
});

test('the face baseline survives occlusion and shifts only after a consistent large displacement', () => {
  const mapper = createSpatialMapper({ alpha: 1 });
  update(mapper, 0, null);
  update(mapper, 33, null);
  assert.equal(update(mapper, 66, 0.35, { landmarks: face(0.028) }).index, 69);
  assert.equal(update(mapper, 99, 0.35, { landmarks: [] }).index, 69);
  assert.equal(update(mapper, 132, 0.35, { landmarks: face(0.14) }).index, 69);
  assert.ok(update(mapper, 165, 0.35, { landmarks: face(0.14) }).index > 95);
});

test('pinch requires a 200 ms dwell, fires once per hold, and rearms only after release', () => {
  const mapper = createSpatialMapper();
  assert.equal(update(mapper, 0, 0.35).index, 69);
  update(mapper, 20, 0.38, { distance: 0.02 });
  assert.equal(update(mapper, 110, 0.38, { distance: 0.02 }).confirmed, false);
  assert.equal(update(mapper, 219, 0.38, { distance: 0.02 }).locked, false);
  const locked = update(mapper, 220, 0.38, { distance: 0.02 });
  assert.ok(locked.locked && locked.confirmed);
  assert.equal(locked.index, 69);
  assert.equal(update(mapper, 335, 0.5, { distance: 0.055 }).confirmed, false);
  assert.equal(update(mapper, 430, 0.5, { distance: 0.02 }).confirmed, false);
  update(mapper, 460, 0.35);
  update(mapper, 490, 0.35, { distance: 0.02 });
  update(mapper, 590, 0.35, { distance: 0.02 });
  const unlocked = update(mapper, 690, 0.35, { distance: 0.02 });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.confirmed, true);
});

test('brief occlusion restarts an incomplete pinch instead of counting invisible time', () => {
  const mapper = createSpatialMapper();
  update(mapper, 0, 0.35, { distance: 0.02 });
  update(mapper, 100, 0.35, { distance: 0.02 });
  update(mapper, 150, null);
  assert.equal(update(mapper, 260, 0.35, { distance: 0.02 }).confirmed, false);
  assert.equal(update(mapper, 360, 0.35, { distance: 0.02 }).confirmed, false);
  assert.equal(update(mapper, 461, 0.35, { distance: 0.02 }).confirmed, true);
});

test('manual control takes over immediately and gestures pick up without a jump', () => {
  const mapper = createSpatialMapper({ alpha: 1, manualHoldMs: 100 });
  update(mapper, 10, 0.35);
  mapper.setManual(39, 30, true);
  assert.equal(update(mapper, 90, 0.36).index, 39);
  mapper.setManual(39, 100);
  assert.equal(update(mapper, 160, 0.36).index, 39);
  const waiting = update(mapper, 230, 0.45);
  assert.equal(waiting.index, 39);
  assert.equal(waiting.pickup, true);
  const picked = update(mapper, 260, 0.52);
  assert.equal(picked.index, 39);
  assert.equal(picked.pickup, false);
  assert.ok(update(mapper, 290, 0.56).index < 39);
});

test('a long frame gap does not rearm a completed pinch without a release', () => {
  const mapper = createSpatialMapper();
  for (const now of [0, 100, 200]) update(mapper, now, 0.35, { distance: 0.02 });
  const afterGap = update(mapper, 650, 0.35, { distance: 0.02 });
  assert.equal(afterGap.locked, true);
  assert.equal(afterGap.confirmed, false);
  assert.equal(update(mapper, 850, 0.35, { distance: 0.02 }).locked, true);
});
