import { openAssetCache } from './assetCache.js';

export function warnAsset(url, error) {
  console.warn('[NeuroSlice AR]', url, error?.name ?? 'Error');
}

async function fetchAsset(url, consume, { signal, priority, idle = 15000, reload = false, cacheName, payload, initialResponse } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let idleTimer;
  const activity = () => {
    if (controller.signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new DOMException('资产传输停滞', 'TimeoutError')), idle);
  };
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  if (signal?.aborted) abort();

  async function download() {
    if (controller.signal.aborted) throw controller.signal.reason;
    activity();
    if (payload) {
      return consume(new Response(payload, { headers: { 'Content-Length': String(payload.byteLength) } }), activity);
    }
    const cache = await openAssetCache(cacheName);
    const request = cache && new Request(url);
    if (request && !reload) {
      const cached = await cache.match(request).catch(() => null);
      if (cached) {
        try {
          activity();
          return await consume(cached, activity);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          await cache.delete(request).catch(() => {});
        }
      }
    }
    const response = initialResponse ? await initialResponse : await fetch(url, {
      signal: controller.signal, priority, cache: reload ? 'reload' : 'default',
    });
    activity();
    if (!response?.ok || response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('资产不可用：' + url);
    }
    let copy;
    if (cache) {
      try { copy = response.clone(); } catch { /* HTTP cache still works. */ }
    }
    try {
      const result = await consume(response, activity);
      if (copy) cache.put(request, copy).catch(() => {});
      return result;
    } catch (error) {
      copy?.body?.cancel().catch(() => {});
      throw error;
    }
  }

  try {
    return await Promise.race([stopped, download()]);
  } catch (error) {
    controller.abort();
    if (!signal?.aborted) warnAsset(url, error);
    throw error;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', abort);
  }
}

async function gzipReader(read, reader, transportEncoded) {
  const queued = [];
  if (transportEncoded) {
    // The browser may already have decoded the HTTP representation. Inspect its first two bytes.
    const prefix = [];
    while (prefix.length < 2) {
      const { value, done } = await read();
      if (done) break;
      if (!value.byteLength) continue;
      queued.push(value);
      prefix.push(...value.subarray(0, 2 - prefix.length));
    }
    if (prefix[0] !== 0x1f || prefix[1] !== 0x8b) {
      return {
        read: () => queued.length ? { value: queued.shift(), done: false } : read(),
        releaseLock: () => reader.releaseLock(),
      };
    }
  }

  const decoder = new DecompressionStream('gzip');
  const source = new ReadableStream({
    async pull(output) {
      const { value, done } = queued.length ? { value: queued.shift(), done: false } : await read();
      if (done) {
        reader.releaseLock();
        output.close();
      }
      else output.enqueue(value);
    },
    cancel: reason => reader.cancel(reason),
  });
  return source.pipeThrough(decoder).getReader();
}

export async function readBinary(url, { gzip, expected, limit, progress, parse, ...options } = {}) {
  return fetchAsset(url, async (response, activity) => {
    const length = Number(response.headers.get('content-length')) || 0;
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const transportEncoded = Boolean(encoding && encoding !== 'identity');
    const total = transportEncoded ? 0 : length;
    let received = 0;
    progress?.(0, total);
    let bytes;

    if (typeof response.body?.getReader !== 'function') {
      if (gzip) throw new TypeError('浏览器无法流式解压 Gzip');
      bytes = new Uint8Array(await response.arrayBuffer());
      received = bytes.byteLength;
    } else {
      const reader = response.body.getReader();
      const read = async () => {
        const chunk = await reader.read();
        if (!chunk.done && chunk.value.byteLength) {
          activity();
          received += chunk.value.byteLength;
          if (!transportEncoded) progress?.(received, total);
        }
        return chunk;
      };
      const output = gzip ? await gzipReader(read, reader, transportEncoded)
        : { read, releaseLock: () => reader.releaseLock() };
      try {
        const chunks = [];
        if (expected !== undefined) bytes = new Uint8Array(expected);
        let offset = 0;
        for (;;) {
          const { done, value } = await output.read();
          if (done) break;
          if (offset + value.byteLength > (expected ?? limit ?? Infinity)) {
            throw new Error('资产长度超出预期尺寸');
          }
          if (bytes) bytes.set(value, offset);
          else chunks.push(value);
          offset += value.byteLength;
        }
        if (expected !== undefined && offset !== expected) throw new Error('资产长度与体素尺寸不一致');
        if (!bytes) {
          bytes = new Uint8Array(offset);
          let position = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, position);
            position += chunk.byteLength;
          }
        }
      } finally {
        output.releaseLock?.();
      }
    }

    if (expected !== undefined && bytes.byteLength !== expected) throw new Error('资产长度与体素尺寸不一致');
    if (limit !== undefined && bytes.byteLength > limit) throw new Error('资产长度超出预期尺寸');
    if (!transportEncoded) progress?.(received, total || received);
    else if (length) progress?.(length, length);
    return parse ? parse(bytes.buffer) : bytes.buffer;
  }, options);
}

export const readAssetJson = (url, options) => readBinary(url, {
  ...options,
  parse: bytes => JSON.parse(new TextDecoder().decode(bytes)),
});

export async function readCompressedOrRaw(url, { preferGzip, ...options }) {
  if (preferGzip && typeof DecompressionStream === 'function') {
    try {
      return await readBinary(url + '.gz', { ...options, gzip: true });
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  return readBinary(url, options);
}


export async function readAssetVariant({ compressed, raw, decodedLength }, options) {
  if (compressed && typeof DecompressionStream === 'function') {
    try {
      return await readBinary(compressed, { ...options, expected: decodedLength, gzip: true });
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  return readBinary(raw, { ...options, payload: compressed ? undefined : options.payload, expected: decodedLength });
}
