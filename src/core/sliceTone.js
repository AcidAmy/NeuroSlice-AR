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

// 同一工作站的 2D 预览与 3D 显影共用调窗 LUT。
export function createSliceTone() {
  const cache = {};
  return (series, modality, { ctWindow, mriPreset = 't1', brightness = 0, contrast = 1 }) => {
    const ct = modality === 'ct';
    const sequence = ct ? null : series.mriSequences?.[mriPreset];
    const volume = ct ? series.ct : sequence ?? series.mri;
    if (!volume) return null;
    const width = ct ? ctWindow.width : contrast;
    const level = ct ? ctWindow.level : brightness;
    const preset = ct ? null : sequence ? 'native' : mriPreset;
    const phantom = !ct && series.source !== 'local';
    const previous = cache[modality];
    if (previous?.volume === volume && previous.width === width && previous.level === level &&
        previous.preset === preset && previous.phantom === phantom) return previous;

    const sameLut = previous?.width === width && previous.level === level &&
      previous.preset === preset && previous.phantom === phantom;
    const lut = sameLut ? previous.lut : ct ? buildHuLut(width, level) : buildMriLut(preset, level, width, phantom);
    return cache[modality] = { volume, lut, bias: ct ? 32768 : 0, width, level, preset, phantom };
  };
}
