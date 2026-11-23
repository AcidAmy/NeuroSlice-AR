import { readAssetVariant } from './staticAssets.js';

const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

export function signedVoxels(bytes) {
  const voxels = new Int16Array(bytes);
  if (!littleEndian) {
    const view = new DataView(bytes);
    for (let index = 0; index < voxels.length; index++) voxels[index] = view.getInt16(index * 2, true);
  }
  return voxels;
}

export async function decodeVolume(variant, signed, options) {
  const bytes = await readAssetVariant(variant, options);
  return signed ? signedVoxels(bytes) : new Uint8Array(bytes);
}
