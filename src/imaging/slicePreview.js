import { PLANES, sliceAddress } from '../core/mpr.js';

// DICOM VOI LINEAR 包含半级偏移，宽度 1 是阈值调窗。
export const CT_PRESETS = Object.freeze({
  brain: Object.freeze({ width: 80, level: 40 }),
  bone: Object.freeze({ width: 2000, level: 400 }),
  subdural: Object.freeze({ width: 300, level: 50 }),
});

export function buildHuLut(width, level) {
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(level)) throw new RangeError('窗宽窗位无效');
  const lut = new Uint8ClampedArray(65536);
  const center = level - 0.5;
  if (width === 1) {
    lut.fill(255, Math.max(0, Math.min(65536, Math.floor(center) + 32769)));
    return lut;
  }
  for (let i = 0; i < lut.length; i++) {
    lut[i] = ((i - 32768 - center) / (width - 1) + 0.5) * 255;
  }
  return lut;
}

function buildMriLut(preset, brightness, contrast, phantom) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < lut.length; i++) {
    let signal = i;
    if (phantom && preset === 't2' && i > 0) {
      // 将合成的低信号脑脊液映为亮信号，同时保留背景和颅骨的低信号。
      if (i >= 22 && i <= 96) signal = 238 - Math.abs(i - 33) * 1.9;
      else if (i > 96) signal = 224 - (i - 96) * 0.92;
    } else if (preset === 't2' && i > 0) {
      signal = Math.pow(i / 255, 0.72) * 255;
    }
    lut[i] = (signal - 128) * contrast + 128 + brightness;
  }
  return lut;
}

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

export function createMprPreview(entries, series) {
  const views = entries.map(({ canvas, key, modality }) => {
    const plane = PLANES[key];
    const [width, height] = plane.axes.map(axis => series.dimensions[axis]);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const dataImage = context.createImageData(width, height);
    return { key, modality, plane, context, pixels: { width, height, dataImage, data: dataImage.data } };
  });
  let ctLut, mriLut, ctKey, mriKey;
  return (cursor, { ctWindow, mriPreset = 't1', brightness = 0, contrast = 1 }, selected) => {
    const nextCtKey = ctWindow.width + '/' + ctWindow.level;
    const nextMriKey = [mriPreset, brightness, contrast].join('/');
    const realSequence = series.mriSequences?.[mriPreset];
    if (ctKey !== nextCtKey) {
      ctLut = buildHuLut(ctWindow.width, ctWindow.level);
      ctKey = nextCtKey;
    }
    if (mriKey !== nextMriKey) {
      mriLut = buildMriLut(realSequence ? 'native' : mriPreset, brightness, contrast, series.source !== 'local');
      mriKey = nextMriKey;
    }
    for (const view of views) {
      if (selected && view.key !== selected) continue;
      const ct = view.modality === 'ct';
      const volume = ct ? series.ct : realSequence ?? series.mri;
      const index = cursor[view.plane.axis];
      const tone = ct ? ctKey : mriKey;
      // 十字线和标注在 DOM 层。只有体数据、正交层面或灰阶变化才提交 Canvas。
      if (!volume || (view.lastIndex === index && view.lastTone === tone && view.lastVolume === volume)) continue;
      paint(view.context, view.pixels, volume, sliceAddress(view.plane, index, series.dimensions),
        ct ? ctLut : mriLut, ct ? 32768 : 0);
      view.lastIndex = index;
      view.lastTone = tone;
      view.lastVolume = volume;
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
