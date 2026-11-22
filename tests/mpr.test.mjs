import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Group, Vector3 } from 'three';
import { headFrame, PLANES, planeAspect, pointToVoxel, projectVoxel } from '../src/core/mpr.js';
import { attachSlicePlanes } from '../src/ar/slicePlanes.js';
import { createPreviewOrbit } from '../src/ar/headPose.js';
import { buildHuLut, createMprPreview } from '../src/imaging/slicePreview.js';
import { createSpatialMapper } from '../src/core/spatialMapper.js';

const dimensions = [3, 4, 5];
const spacing = [0.7, 1.2, 2.4];
const cursor = [1, 2, 3];

test('the three MPR planes round-trip the same voxel and preserve physical image aspect', () => {
  for (const plane of Object.values(PLANES)) {
    assert.deepEqual(pointToVoxel(plane, projectVoxel(plane, cursor, dimensions), cursor, dimensions), cursor);
  }
  assert.deepEqual(PLANES.sagittal.tags, ['S', 'I', 'A', 'P']);
  assert.equal(planeAspect(PLANES.coronal, dimensions, spacing), 3 * 0.7 / (5 * 2.4));
  assert.equal(planeAspect(PLANES.sagittal, dimensions, spacing), 4 * 1.2 / (5 * 2.4));
  assert.deepEqual(pointToVoxel(PLANES.axial, [-0.5, 1.5], cursor, dimensions), [0, 3, 3]);
});

test('MPR renderers extract the correct signed CT and MRI voxels with superior at the top', () => {
  function fixture() {
    return {
      frames: [],
      getContext() {
        return {
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: image => this.frames.push([...image.data].filter((_, i) => i % 4 === 0)),
        };
      },
    };
  }
  const entries = ['ct', 'mri'].flatMap(modality =>
    Object.keys(PLANES).map(key => ({ key, modality, canvas: fixture() })));
  const ct = new Int16Array(60).map((_, index) => index - 35);
  const mri = new Uint8Array(60).map((_, index) => index + 25);
  const render = createMprPreview(entries, { dimensions, ct, mri, source: 'local' });
  const ctWindow = { width: 150, level: 0 };
  render(cursor, { ctWindow });
  const lut = buildHuLut(ctWindow.width, ctWindow.level);
  const expected = {
    axial: [36, 47],
    coronal: [54, 8],
    sagittal: [49, 10],
  };
  for (const { key, canvas, modality } of entries) {
    const [first, last] = expected[key];
    const frame = canvas.frames[0];
    assert.equal(frame[0], modality === 'ct' ? lut[ct[first] + 32768] : mri[first]);
    assert.equal(frame.at(-1), modality === 'ct' ? lut[ct[last] + 32768] : mri[last]);
  }
  render([1, 2, 4], { ctWindow }, 'axial');
  assert.deepEqual(entries.map(entry => entry.canvas.frames.length), [2, 1, 1, 2, 1, 1]);
  render([1, 2, 4], { ctWindow });
  assert.deepEqual(entries.map(entry => entry.canvas.frames.length), [2, 1, 1, 2, 1, 1]);
  render([1, 2, 4], { ctWindow: { ...ctWindow, level: 20 } });
  assert.deepEqual(entries.map(entry => entry.canvas.frames.length), [3, 2, 2, 2, 1, 1]);
});

test('Three.js plane intersections stay at the same head-local voxel after a mirrored pose change', () => {
  const parent = new Group();
  const anatomy = new Group();
  anatomy.scale.x = -1;
  parent.add(anatomy);
  const render = attachSlicePlanes(anatomy);
  render({ cursor, dimensions, spacing, activePlane: 'coronal', allPlanes: true, showPlanes: true });
  const orbit = createPreviewOrbit();
  orbit.drag(70, 30);
  orbit.apply(parent.rotation);
  parent.position.set(4, 9, -5);
  parent.scale.setScalar(2);
  parent.updateMatrixWorld(true);
  const anchor = anatomy.localToWorld(new Vector3(...headFrame(cursor, dimensions, spacing).point));
  for (const group of anatomy.children) {
    assert.equal(group.visible, true);
    const hit = group.worldToLocal(anchor.clone());
    assert.ok(Math.abs(hit.z) < 1e-9);
    assert.ok(Math.abs(hit.x - group.children[2].position.x) < 1e-9);
    assert.ok(Math.abs(hit.y - group.children[3].position.y) < 1e-9);
  }
  const preview = new Euler();
  orbit.apply(preview);
  assert.ok(preview.y > 0.9);
  render({ cursor, dimensions, spacing, activePlane: 'coronal', allPlanes: false, showPlanes: true });
  assert.deepEqual(anatomy.children.filter(child => child.visible).map(child => child.name), ['coronal-plane']);
});

test('gestures follow screen X for sagittal and vertical/reach motion for coronal', () => {
  const face = [];
  [10, 168, 1, 152].forEach((id, i) => { face[id] = { x: 0.5, y: [0.2, 0.35, 0.5, 0.8][i] }; });
  function mapper(plane) {
    const state = createSpatialMapper({ alpha: 1 });
    return (now, x, y, palmWidth) => {
      const hand = [];
      hand[8] = { x, y };
      hand[4] = { x: x - 0.13, y };
      if (palmWidth) {
        hand[5] = { x: 0.5 - palmWidth / 2, y };
        hand[17] = { x: 0.5 + palmWidth / 2, y };
      }
      return state.update({ now, faceLandmarks: face, handLandmarks: [hand], depth: 101, plane }).index;
    };
  }
  const sag = mapper('sagittal');
  assert.equal(sag(10, 0.5, 0.39), 50);
  assert.equal(sag(50, 0.5, 0.68), 50);
  assert.ok(sag(90, 0.72, 0.68) > 80);
  const cor = mapper('coronal');
  assert.ok(cor(10, 0.5, 0.4) < cor(50, 0.5, 0.6));
  const near = cor(90, 0.5, 0.6, 0.25);
  assert.ok(near < cor(130, 0.5, 0.6, 0.09));
});
