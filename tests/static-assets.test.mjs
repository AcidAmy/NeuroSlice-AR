import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readBinary, readCompressedOrRaw } from '../src/core/staticAssets.js';

test('gzip download reports compressed bytes and recovers exact signed voxel bytes', async t => {
  const bytes = Uint8Array.of(0x00, 0xfc, 0x32, 0x00);
  const gzip = gzipSync(bytes);
  const progress = [];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return new Response(gzip, { headers: { 'Content-Length': String(gzip.length) } });
  });
  const result = await readCompressedOrRaw('/assets/ct_volume.bin', {
    preferGzip: true, expected: bytes.length, progress: (...args) => progress.push(args),
  });
  assert.deepEqual(requests, ['/assets/ct_volume.bin.gz']);
  assert.deepEqual(new Uint8Array(result), bytes);
  assert.deepEqual(progress[0], [0, gzip.length]);
  assert.deepEqual(progress.at(-1), [gzip.length, gzip.length]);
});

test('an invalid gzip response retries the raw file and rejects an incorrect voxel count', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    if (url.endsWith('.gz')) return new Response(gzipSync(Uint8Array.of(1)));
    return new Response(Uint8Array.of(2, 3));
  });
  const path = '/assets/mri_volume.bin';
  const result = await readCompressedOrRaw(path, { preferGzip: true, expected: 2 });
  assert.deepEqual(new Uint8Array(result), Uint8Array.of(2, 3));
  assert.deepEqual(requests, [path + '.gz', path]);
  await assert.rejects(readBinary(path, { expected: 1 }), /体素尺寸/);
});

test('an HTTP-decoded gzip asset is read without decompressing the same bytes twice', async t => {
  const bytes = Uint8Array.of(0x00, 0xfc, 0x32, 0x00);
  const encodedLength = gzipSync(bytes).length;
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, {
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(encodedLength) },
  }));
  const progress = [];
  const result = await readBinary('/assets/ct_volume.bin.gz', {
    gzip: true, expected: bytes.length, progress: (...args) => progress.push(args),
  });
  assert.deepEqual(new Uint8Array(result), bytes);
  assert.deepEqual(progress, [[0, 0], [encodedLength, encodedLength]]);
});

test('HTML rewrites are rejected and a stalled request is aborted without a second large download', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requests.push(url);
    if (url === '/missing') return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(readBinary('/missing'), /资产不可用/);
  await assert.rejects(readCompressedOrRaw('/stall', { preferGzip: true, idle: 10 }),
    { name: 'TimeoutError' });
  assert.deepEqual(requests, ['/missing', '/stall.gz']);
});
