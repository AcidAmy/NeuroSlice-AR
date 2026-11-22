import { readAssetJson, readBinary, readCompressedOrRaw } from './staticAssets.js';
import { previewDimensions } from './volumePreview.js';

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

export async function loadVolumeMetadata(base, [name]) {
  const metadata = await readAssetJson(base + 'assets/' + name, { priority: 'high' });
  if (metadata.version !== 1) throw new Error('体数据版本无效');
  voxelCount(metadata.dimensions);
  if (metadata.spacing !== undefined && !validSpacing(metadata.spacing)) throw new Error('体素间距无效');
  return metadata;
}

export async function loadVolumePreview(base, metadata) {
  const dimensions = previewDimensions(metadata.dimensions);
  const ctLength = voxelCount(dimensions) * 2;
  const hasMri = !ctOnly(metadata);
  const bytes = await readBinary(base + 'assets/volume-preview.bin.gz', {
    gzip: true, expected: hasMri ? ctLength * 1.5 : ctLength, priority: 'high', idle: 4000, timeout: 6000,
  });
  const spacing = metadata.spacing?.map((value, axis) =>
    value * (metadata.dimensions[axis] - 1) / (dimensions[axis] - 1));
  const series = decodeVolumePair(dimensions, bytes.slice(0, ctLength), hasMri ? bytes.slice(ctLength) : null,
    { ...metadata, spacing });
  return { ...series, preview: true };
}

async function loadExtraSequences(base, available, series, signal) {
  const names = { t1: 'mri_t1.u8', t2: 'mri_t2.u8' };
  await Promise.all(Object.entries(names).map(async ([key, filename]) => {
    if (!available.includes(filename)) return;
    try {
      const bytes = await readBinary(base + 'assets/' + filename, { expected: series.mri.byteLength, signal });
      series.mriSequences[key] = new Uint8Array(bytes);
    } catch {
      // 单个附加序列缺失时仍可以使用主序列。
    }
  }));
}

async function loadVolumeSeries(base, available, [metadataName, ctName, mriName], metadata, onProgress) {
  const controller = new AbortController();
  const count = voxelCount(metadata.dimensions);
  const hasMri = !ctOnly(metadata);
  const transfers = Array.from({ length: hasMri ? 2 : 1 }, () => ({ received: 0, total: 0 }));
  const load = (name, index, expected) => readCompressedOrRaw(base + 'assets/' + name, {
    preferGzip: metadataName === 'meta.json' && import.meta.env?.PROD,
    priority: 'low', signal: controller.signal, timeout: 90000, expected,
    progress(received, total) {
      transfers[index] = { received, total };
      onProgress(
        transfers.reduce((sum, entry) => sum + entry.received, 0),
        transfers.every(entry => entry.total) ? transfers.reduce((sum, entry) => sum + entry.total, 0) : 0,
      );
    },
  });
  onProgress(0, 0);
  try {
    const [ct, mri] = await Promise.all([load(ctName, 0, count * 2), hasMri ? load(mriName, 1, count) : null]);
    const series = decodeVolumePair(metadata.dimensions, ct, mri, metadata);
    if (mri) await loadExtraSequences(base, available, series, controller.signal);
    return series;
  } finally {
    controller.abort();
  }
}

export async function loadVolumePair(base, available, {
  firstMetadata, onMetadata = () => {}, onProgress = () => {}, hasPreview = () => false,
} = {}) {
  const formats = volumeFormats(available);
  for (const [index, format] of formats.entries()) {
    try {
      const metadata = index === 0 && firstMetadata
        ? await firstMetadata : await loadVolumeMetadata(base, format);
      if (!metadata) continue;
      await onMetadata(metadata, format);
      return await loadVolumeSeries(base, available, format, metadata, onProgress);
    } catch {
      // 另一代资产协议仍可能可用。
    }
  }
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
