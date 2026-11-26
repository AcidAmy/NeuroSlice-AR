import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Group, Quaternion, Vector3 } from 'three';
import {
  PLANES, buildObliqueFrames, headFrame, invertQuaternion, obliquePlaneFrame,
  obliquePointToHead, obliqueSliceIndex, projectPointToOblique, sampleObliqueSlice,
  stepObliquePivot, unmirrorQuaternion,
} from '../src/core/mpr.js';
import { attachSlicePlanes } from '../src/ar/slicePlanes.js';
import { createSliceTone } from '../src/core/sliceTone.js';
import { buildHuLut, createMprPreview } from '../src/imaging/slicePreview.js';

function canvasFixture() {
  return {
    width: 0,
    height: 0,
    frames: [],
    getContext() {
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: image => this.frames.push({
          width: image.width,
          height: image.height,
          gray: [...image.data].filter((_, i) => i % 4 === 0),
        }),
      };
    },
  };
}

test('identity oblique frames match canonical orthogonal slices and PACS edge tags exactly', () => {
  const dimensions = [5, 6, 7];
  const spacing = [1, 1.2, 1.5];
  const cursor = [2, 3, 4];
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  const ct = new Int16Array(count).map((_, i) => -500 + i * 5);
  const mri = new Uint8Array(count).map((_, i) => (i * 3) % 256);
  const series = { dimensions, spacing, ct, mri, source: 'local' };
  const ctWindow = { width: 800, level: 50 };

  const canonicalEntries = ['ct', 'mri'].flatMap(modality =>
    Object.keys(PLANES).map(key => ({ key, modality, canvas: canvasFixture() })));
  const obliqueEntries = ['ct', 'mri'].flatMap(modality =>
    Object.keys(PLANES).map(key => ({ key, modality, canvas: canvasFixture() })));

  const renderCanonical = createMprPreview(canonicalEntries, series);
  const renderOblique = createMprPreview(obliqueEntries, series);
  const pivot = headFrame(cursor, dimensions, spacing).point;
  const frames = buildObliqueFrames(pivot, dimensions, spacing, [0, 0, 0, 1]);

  renderCanonical(cursor, { ctWindow });
  renderOblique(cursor, { ctWindow }, undefined, series, { frames, draft: false, key: 1 });

  for (const [i, entry] of obliqueEntries.entries()) {
    assert.deepEqual(frames[entry.key].tags, PLANES[entry.key].tags);
    assert.equal(frames[entry.key].angleDeg, 0);
    assert.deepEqual(entry.canvas.frames[0].gray, canonicalEntries[i].canvas.frames[0].gray);
  }
});

test('radiological yaw turns anterior landmarks toward patient left (screen right) and keeps 3D planes screen-aligned', () => {
  const dimensions = [11, 11, 11];
  const spacing = [1, 1, 1];
  const cursor = [5, 5, 5];
  const pivot = headFrame(cursor, dimensions, spacing).point;

  // Patient turns 30 deg toward their own left (+Y yaw in anatomical camera space).
  const yaw = Math.PI / 6;
  const rawQuat = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
  const mirroredPose = new Quaternion(rawQuat.x, -rawQuat.y, -rawQuat.z, rawQuat.w);
  const recovered = unmirrorQuaternion([mirroredPose.x, mirroredPose.y, mirroredPose.z, mirroredPose.w]);
  const obliqueQuat = invertQuaternion(recovered);

  const frames = buildObliqueFrames(pivot, dimensions, spacing, obliqueQuat);
  assert.equal(frames.axial.angleDeg, 30);
  assert.deepEqual(frames.axial.tags, ['AR', 'PL', 'RP', 'LA']);

  // An anterior nose landmark at voxel (5, 1, 5) projects into the upper-right (L side) of radiological axial.
  const noseHead = headFrame([5, 1, 5], dimensions, spacing).point;
  const projected = projectPointToOblique(frames.axial, noseHead, dimensions[2]);
  assert.ok(projected.distSlices < 1e-6);
  assert.ok(projected.u > 0.65 && projected.u < 0.8);
  assert.ok(projected.v > 0.1 && projected.v < 0.25);

  // In the mirrored 3D AR scene, the 3D slice planes stay strictly aligned with screen axes
  // and still intersect at the exact same 3D head-local pivot.
  const head = new Group();
  const anatomy = new Group();
  head.quaternion.copy(mirroredPose);
  anatomy.scale.x = -1;
  head.add(anatomy);
  const updatePlanes = attachSlicePlanes(anatomy);
  updatePlanes({
    cursor, dimensions, spacing, activePlane: 'axial', allPlanes: true, showPlanes: true,
    oblique: { frames, draft: false, key: 1 },
  });
  head.updateMatrixWorld(true);

  const worldPivot = anatomy.localToWorld(new Vector3(...pivot));
  const expectedNormals = {
    axial: [0, 1, 0],
    coronal: [0, 0, 1],
    sagittal: [1, 0, 0],
  };
  for (const [key, axis] of Object.entries(expectedNormals)) {
    const planeGroup = anatomy.getObjectByName(key + '-plane');
    const localHit = planeGroup.worldToLocal(worldPivot.clone());
    assert.ok(Math.abs(localHit.z) < 1e-6, `${key} plane must pass through 3D pivot`);
    const worldNormal = new Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld);
    const alignment = Math.abs(worldNormal.dot(new Vector3(...axis)));
    assert.ok(Math.abs(alignment - 1) < 1e-6, `${key} world normal should stay screen-aligned`);
  }

  // Returning to canonical restores base orientation.
  updatePlanes({ cursor, dimensions, spacing, activePlane: 'axial', allPlanes: true, showPlanes: true, oblique: null });
  const coronal = anatomy.getObjectByName('coronal-plane');
  assert.ok(coronal.quaternion.angleTo(new Quaternion()) < 1e-6);
});

test('oblique click positioning stays in-plane and normal stepping moves monotonically along the oblique normal', () => {
  const dimensions = [21, 21, 21];
  const spacing = [1, 1, 1];
  const start = headFrame([10, 10, 10], dimensions, spacing).point;
  const q = new Quaternion().setFromEuler(new Euler(0.28, -0.35, 0.18));
  const obliqueQuat = invertQuaternion([q.x, q.y, q.z, q.w]);

  const initialFrame = obliquePlaneFrame('axial', start, dimensions, spacing, obliqueQuat);
  const clicked = obliquePointToHead(initialFrame, [0.7, 0.3], dimensions, spacing);
  const afterClick = obliquePlaneFrame('axial', clicked, dimensions, spacing, obliqueQuat);
  assert.ok(Math.abs(afterClick.offset - initialFrame.offset) < 1e-6);
  assert.ok(Math.abs(afterClick.cross[0] - 0.7) < 1e-6);
  assert.ok(Math.abs(afterClick.cross[1] - 0.3) < 1e-6);

  const steppedUp = stepObliquePivot(afterClick, clicked, 15, dimensions[2], dimensions, spacing);
  assert.equal(obliqueSliceIndex(afterClick, steppedUp, dimensions[2]), 15);
  const steppedDown = stepObliquePivot(afterClick, steppedUp, 4, dimensions[2], dimensions, spacing);
  assert.equal(obliqueSliceIndex(afterClick, steppedDown, dimensions[2]), 4);
});

test('oblique 2D preview and 3D slice texture support draft/refine upgrades, caching, and air alpha masking', () => {
  const dimensions = [16, 16, 16];
  const spacing = [1, 1, 1];
  const count = 16 * 16 * 16;
  const ct = new Int16Array(count).fill(-1000);
  const mri = new Uint8Array(count).fill(0);
  for (let z = 4; z <= 12; z++) {
    for (let y = 4; y <= 12; y++) {
      for (let x = 4; x <= 12; x++) {
        const idx = x + 16 * (y + 16 * z);
        ct[idx] = 40;
        mri[idx] = 180;
      }
    }
  }
  const series = { dimensions, spacing, ct, mri, source: 'local' };
  const pivot = headFrame([8, 8, 8], dimensions, spacing).point;
  const q = new Quaternion().setFromEuler(new Euler(0.25, 0.3, 0));
  const frames = buildObliqueFrames(pivot, dimensions, spacing, invertQuaternion([q.x, q.y, q.z, q.w]));
  const ctWindow = { width: 80, level: 40 };

  const entries = [
    { key: 'axial', modality: 'ct', canvas: canvasFixture() },
    { key: 'axial', modality: 'mri', canvas: canvasFixture() },
  ];
  const render = createMprPreview(entries, series);
  render([8, 8, 8], { ctWindow }, 'axial', series, { frames, draft: true, draftScale: 0.5, key: 1 });
  assert.equal(entries[0].canvas.frames.length, 1);
  // Same oblique key + draft skips redundant redraw.
  render([8, 8, 8], { ctWindow }, 'axial', series, { frames, draft: true, draftScale: 0.5, key: 1 });
  assert.equal(entries[0].canvas.frames.length, 1);
  // Refine pass upgrades to full-res trilinear.
  render([8, 8, 8], { ctWindow }, 'axial', series, { frames, draft: false, key: 1 });
  assert.equal(entries[0].canvas.frames.length, 2);
  assert.equal(entries[0].canvas.frames[1].width, 16);
  assert.ok(entries[0].canvas.frames[1].gray.some(v => v > 100));
  assert.ok(entries[1].canvas.frames[1].gray.some(v => v > 150));

  // Verify 3D slice texture masking in oblique mode: outside volume is transparent, tissue center is opaque.
  const anatomy = new Group();
  const updatePlanes = attachSlicePlanes(anatomy);
  const resolveTone = createSliceTone();
  const ctTone = resolveTone(series, 'ct', { ctWindow });
  updatePlanes(
    { cursor: [8, 8, 8], dimensions, spacing, activePlane: 'axial', allPlanes: false, showPlanes: true,
      oblique: { frames, draft: false, key: 1 } },
    series, ctTone,
  );
  const surface = anatomy.getObjectByName('axial-plane').children[0];
  const texture = surface.material.uniforms.sliceImage.value;
  assert.equal(texture.image.width, 16);
  // Corner is outside tissue -> alpha 0; center (8, 8) is tissue -> alpha 255.
  assert.equal(texture.image.data[3], 0);
  assert.equal(texture.image.data[(8 * 16 + 8) * 4 + 3], 255);

  // Direct sampleObliqueSlice check with non-square output size.
  const out = new Uint8ClampedArray(8 * 8 * 4);
  sampleObliqueSlice(out, 8, 8, frames.axial, dimensions, ct, buildHuLut(80, 40), 32768, { trilinear: true });
  assert.equal(out[3], 255);
  assert.ok(out[(4 * 8 + 4) * 4] > 100);
});
