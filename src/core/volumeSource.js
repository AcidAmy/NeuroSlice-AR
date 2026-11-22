import { readAssetJson, readBinary, readCompressedOrRaw } from './staticAssets.js';
import { MAX_PREVIEW_DIMENSION, previewDimensions } from './volumePreview.js';

const seriesFormats = [
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

const nativeLittleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

// 两代文件名共用同一个小端协议和列、行、轴位层的排列。
export function decodeVolumePair(dimensions, ctBytes, mriBytes, metadata = {}) {
  const count = voxelCount(dimensions);
  if (ctBytes.byteLength !== count * 2 || (mriBytes !== null && mriBytes.byteLength !== count)) {
    throw new Error('CT/MRI 体素数与尺寸不一致');
  }
  if (metadata.spacing !== undefined && !validSpacing(metadata.spacing)) throw new Error('体素间距无效');
  const ct = new Int16Array(ctBytes);
  if (!nativeLittleEndian) {
    const view = new DataView(ctBytes);
    for (let index = 0; index < count; index++) ct[index] = view.getInt16(index * 2, true);
  }
  const mri = mriBytes === null ? null : new Uint8Array(mriBytes);
  const sequence = metadata.mriSequence;
  return {
    dimensions, ct, mri, source: 'local',
    spacing: metadata.spacing ?? nominalSpacing(dimensions),
    spacingSource: metadata.spacing ? 'metadata' : 'estimated',
    ctWindow: metadata.ctWindow,
    mriRelation: metadata.mriRelation,
    meshFiles: Array.isArray(metadata.meshFiles) ? metadata.meshFiles : undefined,
    mriSequences: mri && (sequence === 't1' || sequence === 't2') ? { [sequence]: mri } : {},
  };
}

function ctOnly(metadata) {
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

export async function loadVolumePreview(base, metadataPromise, options) {
  const download = readCompressedOrRaw(base + 'assets/volume-preview.bin', {
    ...options, preferGzip: true, limit: MAX_PREVIEW_DIMENSION ** 3 * 3, priority: 'high', idle: 20000,
  });
  const [bytes, metadata] = await Promise.all([download, metadataPromise]);
  if (!metadata) return null;
  const dimensions = previewDimensions(metadata.dimensions);
  const ctLength = voxelCount(dimensions) * 2;
  const hasMri = !ctOnly(metadata);
  if (bytes.byteLength !== (hasMri ? ctLength * 1.5 : ctLength)) throw new Error('预览体素数与尺寸不一致');
  const spacing = metadata.spacing?.map((value, axis) =>
    value * (metadata.dimensions[axis] - 1) / (dimensions[axis] - 1));
  const series = decodeVolumePair(dimensions, bytes.slice(0, ctLength), hasMri ? bytes.slice(ctLength) : null,
    { ...metadata, spacing });
  return { ...series, preview: true };
}

async function loadExtraSequences(base, available, series, options) {
  const names = { t1: 'mri_t1.u8', t2: 'mri_t2.u8' };
  for (const [key, filename] of Object.entries(names)) {
    if (!available.includes(filename)) continue;
    try {
      const bytes = await readBinary(base + 'assets/' + filename, { ...options, expected: series.mri.byteLength, idle: 30000 });
      series.mriSequences[key] = new Uint8Array(bytes);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 单个附加序列缺失时仍可以使用主序列。
    }
  }
}

async function loadVolumeSeries(base, available, [metadataName, ctName, mriName], metadata, onProgress, options) {
  const count = voxelCount(metadata.dimensions);
  const load = (name, modality, expected) => readCompressedOrRaw(base + 'assets/' + name, {
    ...options,
    preferGzip: metadataName === 'meta.json' && import.meta.env?.PROD,
    priority: 'low', idle: 30000, expected,
    progress: (received, total) => onProgress(received, total, modality),
  });
  onProgress(0, 0, 'CT');
  const ct = await load(ctName, 'CT', count * 2);
  if (!ctOnly(metadata)) onProgress(0, 0, 'MRI');
  const mri = ctOnly(metadata) ? null : await load(mriName, 'MRI', count);
  const series = decodeVolumePair(metadata.dimensions, ct, mri, metadata);
  if (mri) await loadExtraSequences(base, available, series, options);
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

async function loadPhantom(failed) {
  const { generatePhantomVolume } = await import('./phantomDataGenerator.js');
  const phantom = generatePhantomVolume();
  return {
    ...phantom, source: failed ? 'fallback' : phantom.source,
    spacing: nominalSpacing(phantom.dimensions), spacingSource: 'phantom',
  };
}
