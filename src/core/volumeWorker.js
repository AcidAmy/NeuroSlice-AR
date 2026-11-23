import { decodeVolume } from './volumeDecode.js';

let worker;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./volume.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.progress) request.progress?.(...data.progress);
    else request.finish(data.error ? new Error(data.error) : null, data.voxels);
  };
  worker.onerror = () => {
    worker.terminate();
    worker = null;
    for (const request of pending.values()) request.fallback();
  };
  return worker;
}

export function readVolume(variant, signed, { signal, progress, ...options }) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let decoder;
  try {
    decoder = getWorker();
  } catch {
    return decodeVolume(variant, signed, { ...options, signal, progress });
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    function cleanup() {
      signal?.removeEventListener('abort', abort);
      pending.delete(id);
    }
    function abort() {
      decoder.postMessage({ id, cancel: true });
      finish(signal.reason);
    }
    function finish(error, voxels) {
      cleanup();
      if (error) reject(error);
      else resolve(voxels);
    }
    function fallback() {
      cleanup();
      // The preload buffer may have been transferred to a worker that failed to start.
      resolve(decodeVolume(variant, signed, { ...options, payload: undefined, signal, progress }));
    }
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { progress, finish, fallback });
    try {
      decoder.postMessage({ id, variant, signed, options }, options.payload ? [options.payload] : []);
    } catch {
      fallback();
    }
  });
}
