import { generatePhantomVolume } from './phantomDataGenerator.js';

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

// 两代文件名共用同一个小端协议和列、行、轴位层的排列。
export function decodeVolumePair(dimensions, ctBytes, mriBytes, metadata = {}) {
  if (!Array.isArray(dimensions) || dimensions.length !== 3 ||
      !dimensions.every(size => Number.isSafeInteger(size) && size >= 2 && size <= 512)) {
    throw new Error('体数据尺寸无效');
  }
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  if (ctBytes.byteLength !== count * 2 || (mriBytes !== null && mriBytes.byteLength !== count)) {
    throw new Error('CT/MRI 体素数与尺寸不一致');
  }
  if (metadata.spacing !== undefined && !validSpacing(metadata.spacing)) throw new Error('体素间距无效');
  const view = new DataView(ctBytes);
  const ct = new Int16Array(count);
  for (let index = 0; index < count; index++) ct[index] = view.getInt16(index * 2, true);
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

async function readAsset(base, name) {
  const response = await fetch(base + 'assets/' + name, { cache: 'no-cache' });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('缺少体数据：' + name);
  }
  return response;
}

async function loadExtraSequences(base, available, series) {
  const names = { t1: 'mri_t1.u8', t2: 'mri_t2.u8' };
  await Promise.all(Object.entries(names).map(async ([key, filename]) => {
    if (!available.includes(filename)) return;
    try {
      const bytes = await readAsset(base, filename).then(response => response.arrayBuffer());
      if (bytes.byteLength === series.mri.byteLength) series.mriSequences[key] = new Uint8Array(bytes);
    } catch {
      // 单个附加序列缺失时仍可以使用主序列。
    }
  }));
}

export async function loadVolumePair(base, available) {
  let failed = false;
  for (const [metadataName, ctName, mriName] of seriesFormats) {
    if (![metadataName, ctName].every(name => available.includes(name))) continue;
    try {
      const metadata = await readAsset(base, metadataName).then(response => response.json());
      if (metadata.version !== 1) throw new Error('体数据版本无效');
      const ctOnly = Array.isArray(metadata.modalities) && !metadata.modalities.includes('MRI');
      const [ct, mri] = await Promise.all([
        readAsset(base, ctName).then(response => response.arrayBuffer()),
        ctOnly ? null : readAsset(base, mriName).then(response => response.arrayBuffer()),
      ]);
      const series = decodeVolumePair(metadata.dimensions, ct, mri, metadata);
      if (mri) await loadExtraSequences(base, available, series);
      return series;
    } catch {
      failed = true;
    }
  }
  const phantom = generatePhantomVolume();
  return {
    ...phantom, source: failed ? 'fallback' : phantom.source,
    spacing: nominalSpacing(phantom.dimensions), spacingSource: 'phantom',
  };
}
