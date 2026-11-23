import { readAssetJson, readBinary } from './staticAssets.js';
import { previewDimensions } from './volumePreview.js';
import { signedVoxels } from './volumeDecode.js';
import { readVolume } from './volumeWorker.js';

export const seriesFormats = [
  ['meta.json', 'ct_volume.bin', 'mri_volume.bin'],
  ['volume.json', 'ct.i16le', 'mri.u8'],
];

function validSpacing(spacing) {
  return Array.isArray(spacing) && spacing.length === 3 &&
    spacing.every(value => Number.isFinite(value) && value > 0);
}

function nominalSpacing(dimensions) {
  return dimensions.map(size => 200 / (size - 1));
}

function voxelCount(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length !== 3 ||
      !dimensions.every(size => Number.isSafeInteger(size) && size >= 2 && size <= 512)) {
    throw new Error('体数据尺寸无效');
  }
  return dimensions[0] * dimensions[1] * dimensions[2];
}

export const extraSequences = { t1: 'mri_t1.u8', t2: 'mri_t2.u8' };

// 两代文件名共用同一个小端协议和列、行、轴位层的排列。
export function decodeVolumePair(dimensions, ctBytes, mriBytes, metadata = {}) {
  const count = voxelCount(dimensions);
  if (ctBytes.byteLength !== count * 2 || (mriBytes !== null && mriBytes.byteLength !== count)) {
    throw new Error('CT/MRI 体素数与尺寸不一致');
  }
  if (metadata.spacing !== undefined && !validSpacing(metadata.spacing)) throw new Error('体素间距无效');
  const mri = mriBytes === null ? null : new Uint8Array(mriBytes);
  return combinePair(metadata, dimensions, signedVoxels(ctBytes), mri);
}

function combinePair(metadata, dimensions, ct, mri) {
  const sequence = metadata.mriSequence;
  return {
    ...seriesGeometry(metadata, dimensions), ct, mri,
    mriSequences: mri && (sequence === 't1' || sequence === 't2') ? { [sequence]: mri } : {},
  };
}

export function seriesGeometry(metadata, dimensions = metadata.dimensions) {
  return {
    dimensions, source: 'local',
    spacing: metadata.spacing ?? nominalSpacing(dimensions),
    spacingSource: metadata.spacing ? 'metadata' : 'estimated',
    ctWindow: metadata.ctWindow,
    mriRelation: metadata.mriRelation,
    meshFiles: Array.isArray(metadata.meshFiles) ? metadata.meshFiles : undefined,
  };
}

export function ctOnly(metadata) {
  return Array.isArray(metadata.modalities) && !metadata.modalities.includes('MRI');
}

export function volumeFormats(available) {
  return seriesFormats.filter(([metadata, ct]) => available.includes(metadata) && available.includes(ct));
}

export async function loadVolumeMetadata(base, [name], options) {
  const metadata = await readAssetJson(base + 'assets/' + name, { ...options, priority: 'high' });
  if (metadata.version !== 1) throw new Error('体数据版本无效');
  voxelCount(metadata.dimensions);
  if (metadata.spacing !== undefined && !validSpacing(metadata.spacing)) throw new Error('体素间距无效');
  return metadata;
}

export async function loadModality(base, metadata, name, { preview = false, signed = false, ...options }) {
  const level = metadata.volumeAssets?.[name]?.[preview ? 'preview' : 'full'];
  if (preview && !level) return null;
  const dimensions = preview ? metadata.previewDimensions ?? previewDimensions(metadata.dimensions) : metadata.dimensions;
  const url = path => typeof document === 'undefined' ? base + path : new URL(base + path, document.baseURI).href;
  let compressed = level?.compressed && url(level.compressed.path);
  const raw = url(level?.raw?.path ?? 'assets/' + name);
  const decodedLength = voxelCount(dimensions) * (signed ? 2 : 1);
  let payload;
  const early = globalThis.__neurosliceCtPreview;
  if (early && compressed === early.url && !options.reload) {
    // Reuse the exact early response. WebKit can fetch a link preload and a window fetch twice.
    delete globalThis.__neurosliceCtPreview;
    payload = await readBinary(compressed, {
      signal: options.signal, idle: options.idle, limit: decodedLength + 1024, initialResponse: early.response,
    }).catch(() => undefined).finally(() => early.controller.abort());
    if (!payload?.byteLength) {
      compressed = undefined;
      payload = undefined;
    } else if (payload.byteLength >= 2 && new DataView(payload).getUint16(0) !== 0x1f8b) {
      // An intermediary may have already decoded the HTTP representation.
      if (payload.byteLength === decodedLength) {
        const voxels = await readVolume({ raw, decodedLength }, signed, { ...options, payload });
        return { dimensions, voxels, preview };
      }
      compressed = undefined;
      payload = undefined;
    }
  }
  const voxels = await readVolume({ compressed, raw, decodedLength }, signed, { ...options, payload });
  return { dimensions, voxels, preview };
}

async function loadExtraSequences(load, available, series, options) {
  for (const [key, filename] of Object.entries(extraSequences)) {
    if (!available.includes(filename)) continue;
    try {
      series.mriSequences[key] = await load(filename, 'MRI');
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 单个附加序列缺失时仍可以使用主序列。
    }
  }
}

async function loadVolumeSeries(base, available, [, ctName, mriName], metadata, onProgress, options) {
  const load = async (name, modality, signed = false) => {
    const { voxels } = await loadModality(base, metadata, name, {
      ...options, signed, priority: 'low', idle: 30000,
      progress: (received, total) => onProgress(received, total, modality),
    });
    return voxels;
  };
  const ct = await load(ctName, 'CT', true);
  const mri = ctOnly(metadata) ? null : await load(mriName, 'MRI');
  const series = combinePair(metadata, metadata.dimensions, ct, mri);
  if (mri) await loadExtraSequences(load, available, series, options);
  return series;
}

export async function loadVolumePair(base, available, {
  firstMetadata, onProgress = () => {}, hasPreview = () => false, ...options
} = {}) {
  const formats = volumeFormats(available);
  for (const [index, format] of formats.entries()) {
    try {
      const metadata = index === 0 && firstMetadata
        ? await firstMetadata : await loadVolumeMetadata(base, format, options);
      if (!metadata) continue;
      return await loadVolumeSeries(base, available, format, metadata, onProgress, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 另一代资产协议仍可能可用。
    }
  }
  if (options.signal?.aborted) throw options.signal.reason;
  return hasPreview() ? null : loadPhantom(formats.length > 0);
}

export async function loadPhantom(failed) {
  const { generatePhantomVolume } = await import('./phantomDataGenerator.js');
  const phantom = generatePhantomVolume();
  return {
    ...phantom, source: failed ? 'fallback' : phantom.source,
    spacing: nominalSpacing(phantom.dimensions), spacingSource: 'phantom',
  };
}
