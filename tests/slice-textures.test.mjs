import assert from 'node:assert/strict';
import test from 'node:test';
import { ClampToEdgeWrapping, DoubleSide, Group, LinearFilter, RGBAFormat, Vector2, Vector3 } from 'three';
import { attachSlicePlanes } from '../src/ar/slicePlanes.js';
import { bindSliceDisplayControls } from '../src/app/sliceDisplayControls.js';
import { headFrame, PLANES } from '../src/core/mpr.js';
import { createSliceTone } from '../src/core/sliceTone.js';

const dimensions = [3, 4, 5];
const spacing = [0.6, 1.2, 2.4];
const cursor = [1, 2, 3];
const ctWindow = { width: 80, level: 40 };
const options = { dimensions, spacing, cursor, activePlane: 'axial', showPlanes: true, allPlanes: true };
const ct = new Int16Array(60).map((_, i) => i);
const mri = new Uint8Array(60).map((_, i) => 30 + i);
const series = { ct, mri, dimensions, source: 'local' };
const textureOf = surface => surface.material.uniforms.sliceImage.value;

test('3D plane corners sample the same LPS voxel centers in preview and mirrored camera coordinates', () => {
  const parent = new Group();
  parent.rotation.set(0.31, -0.42, 0.12);
  parent.position.set(0.3, -0.6, 1.1);
  const anatomy = new Group();
  parent.add(anatomy);
  const update = attachSlicePlanes(anatomy);
  const tone = createSliceTone()(series, 'mri', {});
  update(options, series, tone);
  // PlaneGeometry vertex order: top left, top right, bottom left, bottom right.
  const expected = {
    axial: [[0, 0, 3], [2, 0, 3], [0, 3, 3], [2, 3, 3]],
    coronal: [[0, 2, 4], [2, 2, 4], [0, 2, 0], [2, 2, 0]],
    sagittal: [[1, 0, 4], [1, 3, 4], [1, 0, 0], [1, 3, 0]],
  };
  for (const mirror of [1, -1]) {
    anatomy.scale.x = mirror;
    parent.updateMatrixWorld(true);
    for (const [key, voxels] of Object.entries(expected)) {
      const [surface] = anatomy.getObjectByName(key + '-plane').children;
      const { position, uv } = surface.geometry.attributes;
      const { uvScale, uvOffset } = surface.material.uniforms;
      const { image, flipY } = textureOf(surface);
      assert.equal(flipY, false);
      voxels.forEach((voxel, corner) => {
        const actual = surface.localToWorld(new Vector3().fromBufferAttribute(position, corner));
        const anchor = anatomy.localToWorld(new Vector3(...headFrame(voxel, dimensions, spacing).point));
        assert.ok(actual.distanceTo(anchor) < 1e-9);
        const sample = new Vector2().fromBufferAttribute(uv, corner).multiply(uvScale.value).add(uvOffset.value);
        const x = sample.x * image.width - 0.5;
        const y = sample.y * image.height - 0.5;
        assert.ok(Math.abs(x - (corner % 2 ? image.width - 1 : 0)) < 1e-9);
        assert.ok(Math.abs(y - (corner >= 2 ? image.height - 1 : 0)) < 1e-9);
        const [col, row, layer] = voxel;
        const voxelIndex = col + dimensions[0] * (row + dimensions[1] * layer);
        assert.equal(image.data[(Math.round(y) * image.width + Math.round(x)) * 4], mri[voxelIndex]);
      });
    }
  }
});

test('CT air is transparent, and dark CT and MRI tissue keeps alpha from the aligned CT', () => {
  const anatomy = new Group();
  const update = attachSlicePlanes(anatomy);
  const resolve = createSliceTone();
  const ct = Int16Array.of(-1000, -450, -400, 0, 20, 40, -1000, -1000);
  const mri = Uint8Array.of(255, 255, 96, 0, 0, 0, 0, 0);
  const series = { dimensions: [2, 2, 2], ct, mri, source: 'local' };
  const state = { ...options, dimensions: series.dimensions, cursor: [0, 0, 0], allPlanes: false };
  const [surface] = anatomy.getObjectByName('axial-plane').children;
  const alpha = () => [...textureOf(surface).image.data].filter((_, i) => i % 4 === 3);
  update(state, series, resolve(series, 'ct', { ctWindow }));
  assert.deepEqual(alpha(), [0, 0, 128, 255]);
  const texture = textureOf(surface);
  assert.equal(texture.format, RGBAFormat);
  assert.equal(texture.minFilter, LinearFilter);
  assert.equal(texture.magFilter, LinearFilter);
  assert.equal(texture.wrapS, ClampToEdgeWrapping);
  assert.equal(texture.wrapT, ClampToEdgeWrapping);
  assert.equal(surface.material.side, DoubleSide);
  assert.equal(surface.material.depthTest, true);
  assert.equal(surface.material.depthWrite, true);
  assert.deepEqual([...texture.image.data.slice(12, 16)], [0, 0, 0, 255]);
  update({ ...state, cursor: [0, 0, 1] }, series, resolve(series, 'ct', { ctWindow }));
  assert.deepEqual(alpha(), [255, 255, 0, 0]);
  update(state, series, resolve(series, 'mri', { brightness: 58 }));
  assert.equal(textureOf(surface), texture);
  assert.deepEqual(alpha(), [0, 0, 128, 255]);

  const mriOnly = { ...series, ct: null, mri: Uint8Array.of(0, 8, 14, 30, 0, 0, 0, 0) };
  update(state, mriOnly, resolve(mriOnly, 'mri', { brightness: 80 }));
  assert.deepEqual(alpha(), [0, 128, 255, 255]);
  const phantom = { ...series, source: 'phantom', ct: Int16Array.of(-1000, -825, -65, 8, 0, 0, 0, 0) };
  update(state, phantom, resolve(phantom, 'mri', { brightness: 80 }));
  assert.deepEqual(alpha(), [0, 128, 255, 255]);
});

test('3D texture uploads are limited to visible planes with changed slices, tone or series', () => {
  const anatomy = new Group();
  const update = attachSlicePlanes(anatomy);
  const resolve = createSliceTone();
  const surfaces = Object.keys(PLANES).map(key => anatomy.getObjectByName(key + '-plane').children[0]);
  const versions = () => surfaces.map(surface => textureOf(surface).version);
  let tone = resolve(series, 'ct', { ctWindow });
  update(options, series, tone);
  const pixels = surfaces.map(surface => textureOf(surface).image.data);
  assert.deepEqual(versions(), [1, 1, 1]);
  update(options, series, resolve(series, 'ct', { ctWindow: { ...ctWindow }, contrast: 2 }));
  assert.deepEqual(versions(), [1, 1, 1]);
  const next = { ...options, cursor: [0, 1, 4] };
  update({ ...next, showPlanes: false }, series, tone);
  assert.deepEqual(versions(), [1, 1, 1]);
  update({ ...next, allPlanes: false }, series, tone);
  assert.deepEqual(versions(), [2, 1, 1]);
  update(next, series, tone);
  assert.deepEqual(versions(), [2, 2, 2]);
  tone = resolve(series, 'ct', { ctWindow: { ...ctWindow, level: 0 } });
  update(next, series, tone);
  assert.deepEqual(versions(), [3, 3, 3]);
  tone = resolve(series, 'mri', {});
  update(next, series, tone);
  assert.deepEqual(versions(), [4, 4, 4]);
  tone = resolve(series, 'mri', { mriPreset: 't2', contrast: 1.2 });
  update(next, series, tone);
  update(next, { ...series }, tone);
  assert.deepEqual(versions(), [6, 6, 6]);
  surfaces.forEach((surface, i) => assert.equal(textureOf(surface).image.data, pixels[i]));
});

test('slice display enables 3D guides and falls back to CT when a series has no MRI', () => {
  class Control extends EventTarget {
    attributes = {};
    dataset = {};
    setAttribute(key, value) { this.attributes[key] = value; }
    click() { this.dispatchEvent(new Event('click')); }
  }
  const scanToggle = new Control();
  const allPlanesToggle = new Control();
  const textureToggle = new Control();
  const modalityGroup = new Control();
  const [ctButton, mriButton] = ['ct', 'mri'].map(sliceModality => Object.assign(new Control(), {
    dataset: { sliceModality },
  }));
  modalityGroup.querySelectorAll = () => [ctButton, mriButton];
  const display = { showPlanes: true, allPlanes: false, showSliceTexture: false, sliceModality: 'ct' };
  let redraws = 0;
  const controls = bindSliceDisplayControls(
    { scanToggle, allPlanesToggle, textureToggle, modalityGroup }, display, () => redraws++,
  );
  assert.equal(modalityGroup.hidden, true);
  scanToggle.click();
  textureToggle.click();
  assert.equal(scanToggle.attributes['aria-pressed'], 'true');
  assert.equal(textureToggle.attributes['aria-pressed'], 'true');
  assert.equal(modalityGroup.hidden, false);
  assert.equal(ctButton.attributes['aria-pressed'], 'true');
  assert.equal(mriButton.disabled, true);
  mriButton.click();
  assert.equal(redraws, 2);
  controls.setSeries(series);
  assert.equal(mriButton.disabled, false);
  mriButton.click();
  assert.equal(display.sliceModality, 'mri');
  assert.equal(mriButton.attributes['aria-pressed'], 'true');
  ctButton.click();
  assert.equal(display.sliceModality, 'ct');
  mriButton.click();
  controls.setSeries({ ...series, mri: null });
  assert.equal(display.sliceModality, 'ct');
  assert.equal(mriButton.disabled, true);
  scanToggle.click();
  assert.equal(display.showPlanes, false);
  allPlanesToggle.click();
  assert.equal(display.showPlanes, true);
  textureToggle.click();
  assert.equal(display.showPlanes, true);
  assert.equal(display.showSliceTexture, false);
  assert.equal(modalityGroup.hidden, true);
});
