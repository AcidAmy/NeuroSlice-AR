import { PLANES, rescaleVoxel, sliceAddress } from '../core/mpr.js';

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
    const context = canvas.getContext('2d', { alpha: false });
    return { canvas, key, modality, plane: PLANES[key], context };
  });
  return (cursor, options, selected, currentSeries = series) => {
    const ctTone = resolveTone(currentSeries, 'ct', options);
    const mriTone = resolveTone(currentSeries, 'mri', options);
    for (const view of views) {
      if (selected && view.key !== selected) continue;
      const tone = view.modality === 'ct' ? ctTone : mriTone;
      if (!tone) {
        view.lastTone = undefined;
        continue;
      }
      const { plane, canvas, context } = view;
      const dims = tone.dimensions;
      const index = rescaleVoxel(cursor[plane.axis], currentSeries.dimensions[plane.axis], dims[plane.axis]);
      if (view.lastIndex === index && view.lastTone?.deref() === tone) continue;
      const [width, height] = plane.axes.map(axis => dims[axis]);
      if (!view.pixels || canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        const dataImage = context.createImageData(width, height);
        view.pixels = { width, height, dataImage, data: dataImage.data };
      }
      paint(context, view.pixels, tone.volume, sliceAddress(plane, index, dims), tone.lut, tone.bias);
      view.lastIndex = index;
      view.lastTone = new WeakRef(tone);
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
