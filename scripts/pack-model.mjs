import { MeshoptEncoder } from 'meshoptimizer';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const extension = 'EXT_meshopt_compression';
const aligned = length => Math.ceil(length / 4) * 4;

export async function packModel(glb) {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  const binary = glb.subarray(28 + jsonLength);
  if (glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2 ||
      json.buffers.length !== 1 || json.buffers[0].uri || json.extensionsUsed?.includes(extension)) return glb;

  // Pack only tight geometry views. Keep accessors, scene graph, transforms and triangle order intact.
  const usages = new Map();
  const mark = (index, mode) => {
    const accessor = json.accessors[index];
    const key = accessor.bufferView;
    const previous = usages.get(key);
    usages.set(key, previous && (previous.accessor !== accessor || previous.mode !== mode)
      ? { mode: null } : { accessor, mode });
  };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const index of Object.values(primitive.attributes)) mark(index, 'ATTRIBUTES');
      if (primitive.indices !== undefined) mark(primitive.indices, 'INDICES');
    }
  }

  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const chunks = [];
  let length = 0, fallbackLength = 0;
  for (const [index, view] of json.bufferViews.entries()) {
    const source = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const { accessor, mode } = usages.get(index) ?? {};
    const stride = accessor && view.byteLength / accessor.count;
    const validStride = Number.isInteger(stride) && (mode === 'INDICES'
      ? (stride === 2 && accessor.componentType === 5123) || (stride === 4 && accessor.componentType === 5125)
      : stride % 4 === 0 && stride > 0 && stride <= 256 && (!view.byteStride || view.byteStride === stride));
    let payload = source;
    if (mode && validStride && !accessor.byteOffset && !accessor.sparse && !view.extensions) {
      const encoded = MeshoptEncoder.encodeGltfBuffer(source, accessor.count, stride, mode);
      const decoded = Buffer.alloc(source.length);
      MeshoptDecoder.decodeGltfBuffer(decoded, accessor.count, stride, encoded, mode, 'NONE');
      if (!decoded.equals(source)) throw new Error('Meshopt round trip changed geometry bytes');
      if (encoded.byteLength < source.length) {
        payload = encoded;
        view.extensions = { [extension]: {
          buffer: 0, byteOffset: length, byteLength: encoded.byteLength, byteStride: stride, count: accessor.count, mode,
        } };
        view.buffer = 1;
        view.byteOffset = fallbackLength;
        fallbackLength += aligned(view.byteLength);
      }
    }
    if (view.buffer === 0) view.byteOffset = length;
    chunks.push(payload, Buffer.alloc(aligned(payload.byteLength) - payload.byteLength));
    length += aligned(payload.byteLength);
  }
  if (!fallbackLength) return glb;
  json.extensionsUsed = [...(json.extensionsUsed ?? []), extension];
  json.extensionsRequired = [...(json.extensionsRequired ?? []), extension];
  json.buffers[0].byteLength = length;
  json.buffers.push({ byteLength: fallbackLength, extensions: { [extension]: { fallback: true } } });

  const description = Buffer.from(JSON.stringify(json));
  const header = Buffer.alloc(20);
  const body = Buffer.alloc(8);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + aligned(description.length) + body.length + length, 8);
  header.writeUInt32LE(aligned(description.length), 12);
  header.write('JSON', 16);
  body.writeUInt32LE(length, 0);
  body.write('BIN\0', 4);
  return Buffer.concat([header, description, Buffer.alloc(aligned(description.length) - description.length, 0x20), body, ...chunks]);
}
