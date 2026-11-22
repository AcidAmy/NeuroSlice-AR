import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { cameraCrop, createHeadPose, fitLiveHead } from '../src/ar/headPose.js';

function upperFace() {
  const points = [];
  for (const [id, x, y] of [
    [33, 0.44, 0.44], [133, 0.55, 0.45], [362, 0.61, 0.45], [263, 0.72, 0.44],
    [168, 0.58, 0.42], [6, 0.58, 0.46], [2, 0.58, 0.57], [127, 0.37, 0.46], [356, 0.79, 0.46],
  ]) points[id] = { x, y };
  return points;
}

test('camera crop and projection share the same centered visible region', () => {
  const map = cameraCrop(400, 400, 1920, 1080);
  assert.deepEqual(map({ x: 0.5, y: 0.5 }), { x: 200, y: 200 });
  assert.ok(map({ x: 0, y: 0 }).x < 0);
});

test('live head pose mirrors yaw and roll while preserving pitch in both matrix layouts', () => {
  const faceLandmarks = upperFace();
  const map = cameraCrop(400, 400, 400, 400);
  for (const direction of [-1, 1]) {
    for (const angles of [[0.3, 0, 0], [0, 0.4, 0], [0, 0, 0.25], [0.12, 0.23, 0.34]]) {
      const raw = new Quaternion().setFromEuler(new Euler(...angles.map(value => value * direction)));
      const expected = new Quaternion(raw.x, -raw.y, -raw.z, raw.w);
      const matrix = new Matrix4().compose(new Vector3(1, 2, -36), raw, new Vector3(1, 1, 1));
      for (const values of [matrix.toArray(), matrix.clone().transpose().toArray()]) {
        const tracker = createHeadPose();
        const pose = tracker.update({ now: 1000, faceLandmarks, transformMatrix: values }, map, 400, 400);
        assert.ok(pose.rotation.angleTo(expected) < 1e-6);
        assert.equal(tracker.update({ now: 1016, faceLandmarks, transformMatrix: null }, map, 400, 400), null);
      }
    }
  }
});

test('jaw motion never enters the tracked skull scale or anchor', () => {
  const points = upperFace();
  const allowed = new Set(Object.keys(points));
  const faceLandmarks = new Proxy(points, {
    get(target, key) {
      assert.ok(allowed.has(key), `non-rigid landmark read: ${key}`);
      return target[key];
    },
  });
  const map = cameraCrop(400, 400, 400, 400);
  const frame = { now: 1000, faceLandmarks, transformMatrix: new Matrix4().toArray() };
  const tracker = createHeadPose();
  const closed = tracker.update(frame, map, 400, 400);
  const savedAnchor = closed.anchor.clone();
  points[152] = { x: 0.58, y: 0.90, z: 0.17 };
  points[13] = { x: 0.58, y: 0.69 };
  points[14] = { x: 0.58, y: 0.81 };
  const transformMatrix = new Matrix4().makeScale(1.2, 1.2, 1.2).setPosition(2, 4, -45).toArray();
  const open = tracker.update({ ...frame, now: 1033, transformMatrix }, map, 400, 400);
  assert.equal(open.scale, closed.scale);
  assert.ok(open.anchor.distanceTo(savedAnchor) < 1e-9);
  assert.ok(Math.abs(open.anchor.x - (1 - 2 * 0.58)) < 1e-9);
});

test('independent width and height calibration preserve the orbital anchor', () => {
  const head = new Group();
  const pose = {
    anchor: new Vector3(-0.2, 0.15, 0),
    rotation: new Quaternion().setFromEuler(new Euler(0.10, 0.33, -0.15)),
    scale: 0.65,
  };
  fitLiveHead(head, pose, { scale: 1, scaleX: 1, scaleY: 1 });
  const original = head.scale.clone();
  fitLiveHead(head, pose, { scale: 1.1, scaleX: 1.15, scaleY: 0.9 });
  const orbit = head.localToWorld(new Vector3(0, 0.07, 0.60));
  assert.ok(orbit.distanceTo(pose.anchor) < 1e-9);
  assert.ok(Math.abs(head.scale.x / original.x - 1.1 * 1.15) < 1e-9);
  assert.ok(Math.abs(head.scale.y / original.y - 1.1 * 0.9) < 1e-9);
  assert.ok(Math.abs(head.scale.z / original.z - 1.1) < 1e-9);
});
