import { readAssetVariant, readBinary } from './staticAssets.js';

export const modelNames = ['skull.glb', 'brain.glb'];

function checkGlb(bytes) {
  if (bytes.byteLength < 12 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) {
    throw new Error('GLB 文件头无效');
  }
  return bytes;
}

export function readOriginalModel(directory, name, options) {
  return readBinary(new URL(name, directory).href, {
    ...options, cacheName: undefined, priority: 'low', idle: 30000, parse: checkGlb,
  });
}

async function readModel(directory, name, variant, options) {
  if (variant && typeof WebAssembly === 'object') {
    const url = file => new URL('../' + file.path, directory).href;
    try {
      const bytes = await readAssetVariant({
        compressed: url(variant.compressed), raw: url(variant.raw), decodedLength: variant.decodedLength,
      }, { ...options, priority: 'low', idle: 30000, parse: checkGlb });
      return { bytes, packed: true };
    } catch (error) {
      if (options.signal.aborted) throw error;
    }
  }
  return { bytes: await readOriginalModel(directory, name, options), packed: false };
}

export function startModelDownloads(base, names, variants, { onProgress, ...options }) {
  const directory = new URL(base + 'assets/', document.baseURI);
  const transfers = new Map(names.map(name => [name, { received: 0, total: 0 }]));
  return new Map(names.map(name => [name, readModel(directory, name, variants?.[name], {
    ...options,
    progress(received, total) {
      transfers.set(name, { received, total });
      const files = [...transfers.values()];
      onProgress(files.reduce((sum, item) => sum + item.received, 0),
        files.every(item => item.total) ? files.reduce((sum, item) => sum + item.total, 0) : 0);
    },
  }).catch(() => null)]));
}
