import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { modelNames } from '../src/core/modelSource.js';
import { packModel } from './pack-model.mjs';
import { extraSequences, seriesFormats } from '../src/core/volumeSource.js';
import { previewDimensions } from '../src/core/volumePreview.js';

const compress = promisify(gzip);
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 24);

function sample(bytes, dimensions, preview, width) {
  const coordinates = preview.map((size, axis) => Array.from({ length: size },
    (_, index) => Math.round(index * (dimensions[axis] - 1) / (size - 1))));
  const [columns, rows, layers] = coordinates;
  const output = Buffer.alloc(preview.reduce((count, size) => count * size, width));
  let destination = 0;
  for (const z of layers) {
    for (const y of rows) {
      for (const x of columns) {
        const offset = ((z * dimensions[1] + y) * dimensions[0] + x) * width;
        bytes.copy(output, destination, offset, offset + width);
        destination += width;
      }
    }
  }
  return output;
}

export async function prepareMedicalAssets(publicDir) {
  const files = new Map();
  const input = join(publicDir, 'assets');
  const supported = [...modelNames, ...seriesFormats.flat(), ...Object.values(extraSequences)];
  const available = existsSync(input) ? (await readdir(input)).filter(name => supported.includes(name)) : [];
  const has = name => available.includes(name);

  function add(path, bytes, type, immutable = true) {
    files.set(path, { bytes, type, immutable });
    return { path, length: bytes.length };
  }

  async function variant(name, bytes, type, keepUncompressed = false) {
    const dir = 'medical/' + hash(bytes);
    const gzip = await compress(bytes, { level: 9 });
    const compressed = add('medical/' + hash(gzip) + '/' + name + '.gz', gzip, 'application/gzip');
    const raw = keepUncompressed ? add(dir + '/' + name, bytes, type) : undefined;
    return { compressed, raw, decodedLength: bytes.length };
  }

  const models = Object.fromEntries(await Promise.all(modelNames.filter(has).map(async name => {
    const packed = await packModel(await readFile(join(input, name)));
    return [name, await variant(name, packed, 'model/gltf-binary', true)];
  })));

  const manifests = new Map();
  let preload;
  for (const [metadataName, ct, mri] of seriesFormats) {
    if (!has(metadataName) || !has(ct)) continue;
    const metadata = JSON.parse(await readFile(join(input, metadataName), 'utf8'));
    const dims = metadata.dimensions;
    if (metadata.version !== 1 || !Array.isArray(dims) || dims.length !== 3 ||
        !dims.every(size => Number.isInteger(size) && size >= 2 && size <= 512)) continue;
    const preview = previewDimensions(dims);
    const count = dims[0] * dims[1] * dims[2];
    const hasMri = !Array.isArray(metadata.modalities) || metadata.modalities.includes('MRI');
    const names = [ct, ...(hasMri ? [mri, ...Object.values(extraSequences)] : [])];
    const variants = await Promise.all(names.filter(has).map(async name => {
      const bytes = await readFile(join(input, name));
      const width = name === ct ? 2 : 1;
      if (bytes.length !== count * width) return null;
      const levels = await Promise.all([
        variant(name, bytes, 'application/octet-stream'),
        variant(name + '.preview.bin', sample(bytes, dims, preview, width), 'application/octet-stream', true),
      ]);
      return [name, { full: levels[0], preview: levels[1] }];
    }));
    metadata.volumeAssets = Object.fromEntries(variants.filter(Boolean));
    metadata.modelAssets = models;
    metadata.previewDimensions = preview;
    // Cache generations cover every URL used by this deployment, including alternate protocols.
    manifests.set('assets/' + metadataName, metadata);
    preload ??= metadata.volumeAssets[ct]?.preview.compressed.path;
  }
  const release = hash(Buffer.from([...files.keys()].filter(path => path.startsWith('medical/')).sort().join('\n')));
  for (const [path, metadata] of manifests) {
    add(path, Buffer.from(JSON.stringify({ ...metadata, assetRelease: release })), 'application/json; charset=utf-8', false);
  }
  return { files, available, preload, models, release };
}

export async function prepareTrackingAssets(publicDir) {
  const types = { wasm: 'application/wasm', js: 'text/javascript; charset=utf-8', task: 'application/octet-stream' };
  const entries = [];
  for (const directory of ['wasm', 'models']) {
    const path = join(publicDir, directory);
    if (!existsSync(path)) continue;
    for (const name of (await readdir(path)).sort()) {
      const type = types[name.split('.').at(-1)];
      if (type) entries.push([directory + '/' + name, { bytes: await readFile(join(path, name)), type, immutable: true }]);
    }
  }
  const release = hash(Buffer.from(entries.map(([path, { bytes }]) => path + ':' + hash(bytes)).join('\n')));
  const base = 'tracking/' + release + '/';
  return { base, files: new Map(entries.map(([path, file]) => [base + path, file])) };
}
