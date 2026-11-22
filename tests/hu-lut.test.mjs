import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHuLut, createSlicePreview, CT_PRESETS } from '../src/imaging/slicePreview.js';

test('brain VOI LUT spans every signed Int16 HU and clips at DICOM boundaries', () => {
  const lut = buildHuLut(80, 40);
  const gray = hu => lut[hu + 32768];
  assert.equal(lut.length, 65536);
  assert.equal(gray(-32768), 0);
  assert.equal(gray(0), 0);
  assert.equal(gray(40), 129);
  assert.equal(gray(79), 255);
  assert.equal(gray(32767), 255);
  assert.ok(gray(35) < gray(40) && gray(40) < gray(45));
});

test('width one becomes a threshold; bone and subdural defaults are exact', () => {
  const lut = buildHuLut(1, 40);
  assert.equal(lut[32768 + 39], 0);
  assert.equal(lut[32768 + 40], 255);
  assert.deepEqual(CT_PRESETS.bone, { width: 2000, level: 400 });
  assert.deepEqual(CT_PRESETS.subdural, { width: 300, level: 50 });
  assert.throws(() => buildHuLut(0, 40), RangeError);
  assert.throws(() => buildHuLut(80, NaN), RangeError);
});

function canvasFixture() {
  const calls = [];
  return {
    calls,
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: image => calls.push([...image.data]),
      };
    },
  };
}

test('changing window settings and MRI sequence preserves the shared slice index', () => {
  const ctCanvas = canvasFixture();
  const mriCanvas = canvasFixture();
  const series = {
    dimensions: [2, 2, 2], source: 'local',
    ct: Int16Array.of(40, 50, 70, 100, -1000, 400, 1000, 2000),
    mri: Uint8Array.of(100, 110, 120, 130, 0, 10, 20, 30),
    mriSequences: { t2: Uint8Array.of(0, 10, 20, 30, 200, 210, 220, 230) },
  };
  const paint = createSlicePreview(ctCanvas, mriCanvas, series);
  paint(1, { ctWindow: CT_PRESETS.brain });
  assert.equal(ctCanvas.calls.at(-1)[0], 0);
  assert.equal(mriCanvas.calls.at(-1)[0], 0);
  paint(1, { ctWindow: CT_PRESETS.bone, mriPreset: 't2' });
  assert.equal(ctCanvas.calls.at(-1)[4], 128);
  assert.equal(mriCanvas.calls.at(-1)[0], 200);
});
