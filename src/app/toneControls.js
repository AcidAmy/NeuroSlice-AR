import { CT_PRESETS } from '../imaging/slicePreview.js';

export function bindToneControls(onChange) {
  const byId = id => document.getElementById(id);
  const width = byId('ct-width');
  const level = byId('ct-level');
  const brightness = byId('mri-brightness');
  const contrast = byId('mri-contrast');
  const ctButtons = [...document.querySelectorAll('[data-ct-window]')];
  const mriButtons = [...document.querySelectorAll('[data-mri-preset]')];
  let mriPreset = 't1';
  let series;

  function options() {
    return {
      ctWindow: { width: width.valueAsNumber, level: level.valueAsNumber },
      mriPreset, brightness: brightness.valueAsNumber, contrast: contrast.valueAsNumber / 100,
    };
  }

  function update() {
    byId('ct-width-value').value = width.value;
    byId('ct-level-value').value = level.value;
    byId('mri-brightness-value').value = brightness.value;
    byId('mri-contrast-value').value = contrast.value + '%';
    const current = options().ctWindow;
    const bone = current.width === CT_PRESETS.bone.width && current.level === CT_PRESETS.bone.level;
    width.closest('.tone-control').dataset.semantic = bone ? 'sagittal' : 'axial';
    byId('ct-overlay').dataset.semantic = bone ? 'sagittal' : 'axial';
    byId('ct-overlay').value = `W ${current.width} / L ${current.level}`;
    for (const button of ctButtons) {
      const preset = CT_PRESETS[button.dataset.ctWindow];
      button.setAttribute('aria-pressed', String(current.width === preset.width && current.level === preset.level));
    }
    for (const button of mriButtons) button.setAttribute('aria-pressed', String(button.dataset.mriPreset === mriPreset));
    const realSequence = Boolean(series?.mriSequences?.[mriPreset]);
    byId('mri-overlay').value = series && !series.mri ? 'MRI —' : mriPreset.toUpperCase() + 'WI' + (realSequence ? '' : ' · SIM');
    onChange();
  }

  for (const button of ctButtons) {
    button.addEventListener('click', () => {
      const preset = CT_PRESETS[button.dataset.ctWindow];
      width.value = preset.width;
      level.value = preset.level;
      update();
    });
  }
  for (const button of mriButtons) {
    button.addEventListener('click', () => {
      mriPreset = button.dataset.mriPreset;
      update();
    });
  }
  for (const input of [width, level, contrast, brightness]) input.addEventListener('input', update);

  function setSeries(value) {
    series = value;
    for (const control of [brightness, contrast, ...mriButtons]) control.disabled = !value.mri;
    const defaults = value.ctWindow;
    if (Number.isInteger(defaults?.width) && defaults.width >= Number(width.min) && defaults.width <= Number(width.max) &&
        Number.isInteger(defaults.level) && defaults.level >= Number(level.min) && defaults.level <= Number(level.max)) {
      width.value = defaults.width;
      level.value = defaults.level;
    }
    if (!value.mriSequences?.t1 && value.mriSequences?.t2) mriPreset = 't2';
    update();
  }

  return { options, setSeries };
}
