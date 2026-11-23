import { PLANES, sliceAddress } from '../core/mpr.js';

import { createSliceTone } from '../core/sliceTone.js';

export { buildHuLut, CT_PRESETS } from '../core/sliceTone.js';

function paint(context, pixels, volume, address, lut, bias) {
  const output = pixels.data;
  const { offset, u, v } = address;
  for (let y = 0, i = 0; y < pixels.height; y++) {
    let sample = offset + y * v;
    for (let x = 0; x < pixels.width; x++, i += 4, sample += u) {
      const gray = lut[volume[sample] + bias];
      output[i] = output[i + 1] = output[i + 2] = gray;
      output[i + 3] = 255;
    }
  }
  context.putImageData(pixels.dataImage, 0, 0);
}

export function createMprPreview(entries, series, resolveTone = createSliceTone()) {
  const views = entries.map(({ canvas, key, modality }) => {
    const plane = PLANES[key];
    const [width, height] = plane.axes.map(axis => series.dimensions[axis]);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const dataImage = context.createImageData(width, height);
    return { key, modality, plane, context, pixels: { width, height, dataImage, data: dataImage.data } };
  });
  return (cursor, options, selected) => {
    const ctTone = resolveTone(series, 'ct', options);
    const mriTone = resolveTone(series, 'mri', options);
    for (const view of views) {
      if (selected && view.key !== selected) continue;
      const tone = view.modality === 'ct' ? ctTone : mriTone;
      const index = cursor[view.plane.axis];
      // 十字线和标注在 DOM 层。只有体数据、正交层面或灰阶变化才提交 Canvas。
      if (!tone || (view.lastIndex === index && view.lastTone === tone)) continue;
      paint(view.context, view.pixels, tone.volume, sliceAddress(view.plane, index, series.dimensions), tone.lut, tone.bias);
      view.lastIndex = index;
      view.lastTone = tone;
    }
  };
}

export function createSlicePreview(ctCanvas, mriCanvas, series) {
  const paint = createMprPreview([
    { canvas: ctCanvas, key: 'axial', modality: 'ct' },
    { canvas: mriCanvas, key: 'axial', modality: 'mri' },
  ], series);
  return (index, options) => paint([0, 0, index], options);
}
