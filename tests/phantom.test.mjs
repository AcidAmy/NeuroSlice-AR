import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, MeshBasicMaterial } from 'three';
import {
  generatePhantomBrain, generatePhantomSkull, PHANTOM_DIMENSIONS, sliceHeight,
} from '../src/core/phantomDataGenerator.js';
import { decodeVolumePair, loadVolumePair } from '../src/core/volumeSource.js';

test('missing local assets produce a spatially consistent synthetic CT/MRI pair', async () => {
  const series = await loadVolumePair('./', []);
  assert.equal(series.source, 'phantom');
  assert.deepEqual(series.dimensions, [128, 128, 120]);
  assert.ok(series.ct instanceof Int16Array);
  assert.ok(series.mri instanceof Uint8Array);
  const [width, height, layers] = PHANTOM_DIMENSIONS;
  assert.equal(series.ct.length, width * height * layers);
  assert.equal(series.mri.length, series.ct.length);
  assert.equal(sliceHeight(0, layers), -1);
  assert.equal(sliceHeight(layers - 1, layers), 1);

  const pixel = (x, y, z) => (
    Math.round((x + 1) * (width - 1) / 2) +
    Math.round((1 - z) * (height - 1) / 2) * width +
    Math.round((y + 1) * (layers - 1) / 2) * width * height
  );
  const fluid = pixel(0.145, 0.23, -0.02);
  const tissue = pixel(0.38, 0.23, -0.02);
  assert.ok(series.ct[0] < -950 && series.mri[0] === 0);
  assert.ok(series.ct[fluid] < series.ct[tissue]);
  assert.ok(series.mri[fluid] < series.mri[tissue]);
  const bone = pixel(0.68, 0.23, -0.08);
  assert.ok(series.ct[bone] > 700 && series.mri[bone] < 30);
});

test('optional local series preserve signed little-endian HU and validate dimensions', () => {
  const ct = new ArrayBuffer(16);
  const mri = new Uint8Array([2, 8, 13, 28, 62, 102, 180, 210]);
  new DataView(ct).setInt16(0, -1024, true);
  new DataView(ct).setInt16(14, 1432, true);
  const volume = decodeVolumePair([2, 2, 2], ct, mri.buffer);
  assert.equal(volume.ct[0], -1024);
  assert.equal(volume.ct[7], 1432);
  assert.deepEqual(volume.mri, mri);
  assert.throws(() => decodeVolumePair([2, 2, 2], ct, new ArrayBuffer(4)), /体素数/);
});

test('fallback meshes contain skull, bilateral brain and ventricle surfaces on the slice height grid', () => {
  const shell = new MeshBasicMaterial();
  const fluid = new MeshBasicMaterial();
  const skull = generatePhantomSkull(shell);
  const brain = generatePhantomBrain(shell, fluid);
  assert.ok(skull.children.length >= 5);
  const ventricles = brain.children.filter(mesh => mesh.material === fluid);
  assert.equal(ventricles.length, 2);
  assert.ok(new Box3().setFromObject(ventricles[0]).max.x < 0);
  assert.ok(new Box3().setFromObject(ventricles[1]).min.x > 0);
  for (const model of [skull, brain]) {
    const limits = new Box3().setFromObject(model);
    assert.ok(limits.min.y >= -1 && limits.max.y <= 1);
    assert.ok(limits.min.x < 0 && limits.max.x > 0);
  }
});

test('loader accepts the prepared metadata protocol and registers both true MRI sequences', async t => {
  const ct = new ArrayBuffer(16);
  new DataView(ct).setInt16(0, -350, true);
  const bytes = {
    'meta.json': JSON.stringify({
      version: 1, dimensions: [2, 2, 2], spacing: [0.8, 0.9, 1.5],
      ctWindow: { width: 2000, level: 400 }, mriSequence: 't1',
    }),
    'ct_volume.bin': ct,
    'mri_volume.bin': Uint8Array.of(4, 8, 12, 16, 20, 24, 28, 32),
    'mri_t2.u8': Uint8Array.of(7, 8, 9, 9, 7, 6, 5, 4),
  };
  const available = Object.keys(bytes);
  t.mock.method(globalThis, 'fetch', async url => new Response(bytes[url.split('/').at(-1)], {
    status: 200, headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const series = await loadVolumePair('./', available);
  assert.equal(series.source, 'local');
  assert.equal(series.spacingSource, 'metadata');
  assert.deepEqual(series.spacing, [0.8, 0.9, 1.5]);
  assert.equal(series.ct[0], -350);
  assert.equal(series.ctWindow.width, 2000);
  assert.equal(series.mriSequences.t1[0], 4);
  assert.equal(series.mriSequences.t2[0], 7);
});

test('CT-only metadata ignores previous MRI files and retains its own spacing', async t => {
  const assets = ['meta.json', 'ct_volume.bin', 'mri_volume.bin', 'mri_t2.u8'];
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const name = url.split('/').at(-1);
    fetched.push(name);
    return new Response(name === 'meta.json'
      ? JSON.stringify({ version: 1, modalities: ['CT'], dimensions: [2, 2, 2], spacing: [1, 1, 1], meshFiles: [] })
      : new ArrayBuffer(16));
  });
  const series = await loadVolumePair('./', assets);
  assert.equal(series.source, 'local');
  assert.equal(series.mri, null);
  assert.deepEqual(series.meshFiles, []);
  assert.deepEqual(fetched, ['meta.json', 'ct_volume.bin']);
});
