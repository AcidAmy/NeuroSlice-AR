import { decodeVolume } from './volumeDecode.js';

const active = new Map();
self.onmessage = async ({ data }) => {
  const { id, variant, signed, options } = data;
  if (data.cancel) {
    active.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  let lastUpdate = -Infinity;
  try {
    const voxels = await decodeVolume(variant, signed, {
      ...options, signal: controller.signal,
      progress(received, total) {
        const now = performance.now();
        if (received === 0 || received === total || now - lastUpdate >= 60) {
          lastUpdate = now;
          self.postMessage({ id, progress: [received, total] });
        }
      },
    });
    self.postMessage({ id, voxels }, [voxels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  } finally {
    active.delete(id);
  }
};
