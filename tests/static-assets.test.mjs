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
  await assert.rejects(readBinary(path, { expected: 1 }), /预期尺寸/);
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

test('HTML rewrites are rejected and a stalled gzip download falls back to raw', async t => {
  const requests = [];
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requests.push(url);
    if (url === '/missing') return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    if (url === '/stall') return new Response(Uint8Array.of(7));
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(readBinary('/missing'), /资产不可用/);
  const bytes = await readCompressedOrRaw('/stall', { preferGzip: true, idle: 10 });
  assert.deepEqual(new Uint8Array(bytes), Uint8Array.of(7));
  assert.deepEqual(requests, ['/missing', '/stall.gz', '/stall']);
  assert.deepEqual(warnings.mock.calls[1].arguments.slice(1), ['/stall.gz', 'TimeoutError']);
});

test('nonempty chunks extend the idle deadline for the whole transfer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stream;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { stream = controller; },
  })));
  const received = [];
  const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const result = readBinary('/slow', { expected: 4, idle: 10, progress: bytes => received.push(bytes) });
  await microtasks();
  for (const byte of [1, 2, 3, 4]) {
    t.mock.timers.tick(8);
    stream.enqueue(Uint8Array.of(byte));
    await microtasks();
  }
  stream.close();
  assert.deepEqual(new Uint8Array(await result), Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(received, [0, 1, 2, 3, 4, 4]);
});

test('a stalled body expires even when its stream does not propagate the fetch abort', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.of(1)); },
  })));
  await assert.rejects(readBinary('/stalled-body', { idle: 10 }), { name: 'TimeoutError' });
});

test('a native decoder exception falls back to raw without TransformStream or tee', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(ReadableStream.prototype, 'tee', () => { throw new Error('tee unavailable'); });
  t.mock.method(globalThis, 'DecompressionStream', function () { throw new TypeError('decoder unavailable'); });
  t.mock.method(globalThis, 'fetch', async url =>
    new Response(url.endsWith('.gz') ? gzipSync(Uint8Array.of(1)) : Uint8Array.of(2)));
  const bytes = await readCompressedOrRaw('/asset', { preferGzip: true, expected: 1 });
  assert.deepEqual(new Uint8Array(bytes), Uint8Array.of(2));
});
