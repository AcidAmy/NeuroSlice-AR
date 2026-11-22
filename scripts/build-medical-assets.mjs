import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { previewDimensions } from '../src/core/volumePreview.js';

const compress = promisify(gzip);
const compressible = ['ct_volume.bin', 'mri_volume.bin', 'skull.glb', 'brain.glb'];

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

export async function prepareMedicalAssets(directory) {
  const files = new Map(await Promise.all(compressible.filter(name => existsSync(join(directory, name)))
    .map(async name => [name, await readFile(join(directory, name))])));
  const metaPath = join(directory, 'meta.json');
  if (existsSync(metaPath) && files.has('ct_volume.bin')) {
    const { version, dimensions, modalities } = JSON.parse(await readFile(metaPath, 'utf8'));
    const validDimensions = Array.isArray(dimensions) && dimensions.length === 3 &&
      dimensions.every(size => Number.isInteger(size) && size >= 2 && size <= 512);
    const count = validDimensions ? dimensions.reduce((voxels, size) => voxels * size, 1) : 0;
    const ct = files.get('ct_volume.bin');
    const mri = Array.isArray(modalities) && !modalities.includes('MRI') ? null : files.get('mri_volume.bin');
    if (version === 1 && validDimensions && ct.length === count * 2 && (mri === null || mri?.length === count)) {
      const preview = previewDimensions(dimensions);
      const parts = [sample(ct, dimensions, preview, 2)];
      if (mri) parts.push(sample(mri, dimensions, preview, 1));
      const bytes = Buffer.concat(parts);
      await writeFile(join(directory, 'volume-preview.bin'), bytes);
      files.set('volume-preview.bin', bytes);
    }
  }
  await Promise.all([...files].map(async ([name, bytes]) => {
    await writeFile(join(directory, name + '.gz'), await compress(bytes, { level: 9 }));
  }));
}
