export function bindSliceDisplayControls({ scanToggle, allPlanesToggle, textureToggle, modalityGroup }, display, onChange) {
  const modalityButtons = [...modalityGroup.querySelectorAll('[data-slice-modality]')];
  let hasMri = false;

  function sync() {
    scanToggle.setAttribute('aria-pressed', String(display.showPlanes));
    allPlanesToggle.setAttribute('aria-pressed', String(display.allPlanes));
    textureToggle.setAttribute('aria-pressed', String(display.showSliceTexture));
    modalityGroup.hidden = !display.showSliceTexture;
    for (const button of modalityButtons) {
      const modality = button.dataset.sliceModality;
      button.disabled = !display.showSliceTexture || (modality === 'mri' && !hasMri);
      button.setAttribute('aria-pressed', String(display.sliceModality === modality));
    }
  }

  function bindToggle(button, key, opensPlanes = false) {
    button.addEventListener('click', () => {
      display[key] = !display[key];
      if (opensPlanes && display[key]) display.showPlanes = true;
      sync();
      onChange();
    });
  }

  bindToggle(scanToggle, 'showPlanes');
  bindToggle(allPlanesToggle, 'allPlanes', true);
  bindToggle(textureToggle, 'showSliceTexture', true);
  for (const button of modalityButtons) {
    button.addEventListener('click', () => {
      if (button.disabled || display.sliceModality === button.dataset.sliceModality) return;
      display.sliceModality = button.dataset.sliceModality;
      sync();
      onChange();
    });
  }
  sync();
  return {
    setSeries(series) {
      hasMri = Boolean(series.mri);
      if (!hasMri) display.sliceModality = 'ct';
      sync();
    },
  };
}
