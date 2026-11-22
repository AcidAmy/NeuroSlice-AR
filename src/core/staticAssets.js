export async function fetchAsset(url, consume, {
  signal, priority, idle = 8000, timeout = 15000,
} = {}) {
  const controller = new AbortController();
  const expire = () => controller.abort(new DOMException('资产请求超时', 'TimeoutError'));
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let idleTimer;
  const activity = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, idle);
  };
  const deadline = setTimeout(expire, timeout);
  activity();
  try {
    const response = await fetch(url, { signal: controller.signal, priority });
    activity();
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('资产不可用：' + url);
    }
    return await consume(response, activity);
  } catch (error) {
    controller.abort();
    throw controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason : error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
  }
}

export const readAssetJson = (url, options) => fetchAsset(url, response => response.json(), options);

async function hasGzipHeader(probe) {
  const reader = probe.getReader();
  const prefix = [];
  try {
    while (prefix.length < 2) {
      const { value, done } = await reader.read();
      if (done) return false;
      prefix.push(...value.subarray(0, 2 - prefix.length));
    }
    return prefix[0] === 0x1f && prefix[1] === 0x8b;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function readBinary(url, { gzip, expected, progress, ...options } = {}) {
  return fetchAsset(url, async (response, activity) => {
    if (!response.body && !gzip && !expected) return response.arrayBuffer();
    const length = Number(response.headers.get('content-length')) || 0;
    const encoding = response.headers.get('content-encoding');
    const transportEncoded = encoding && encoding !== 'identity';
    const total = transportEncoded ? 0 : length;
    let received = 0;
    progress?.(0, total);
    let stream = response.body;
    if (!stream) throw new Error('资产内容为空');
    if (gzip && transportEncoded) {
      // Fetch may already have removed the gzip layer when the host supplies Content-Encoding.
      const [probe, body] = stream.tee();
      gzip = await hasGzipHeader(probe);
      stream = body;
    }
    stream = stream.pipeThrough(new TransformStream({
      transform(chunk, output) {
        activity();
        received += chunk.byteLength;
        if (!transportEncoded) progress?.(received, total);
        output.enqueue(chunk);
      },
    }));
    if (gzip) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    if (!expected) return new Response(stream).arrayBuffer();

    const bytes = new Uint8Array(expected);
    let offset = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > expected) throw new Error('资产长度超出体素尺寸');
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== expected) throw new Error('资产长度与体素尺寸不一致');
    if (!transportEncoded) progress?.(received, total || received);
    else if (length) progress?.(length, length);
    return bytes.buffer;
  }, options);
}

export async function readCompressedOrRaw(url, { preferGzip, progress, ...options }) {
  if (preferGzip && typeof DecompressionStream === 'function') {
    try {
      return await readBinary(url + '.gz', { ...options, gzip: true, progress });
    } catch (error) {
      if (options.signal?.aborted || error.name === 'TimeoutError') throw error;
    }
  }
  return readBinary(url, { ...options, progress });
}
