export function bindMeasurementPanel(monitor) {
  const byId = id => document.getElementById(id);
  const panel = byId('measure-panel');
  const status = byId('copy-measure-status');
  let lastPaint = -Infinity;
  const format = (value, digits, suffix = '') => value === null ? '—' : value.toFixed(digits) + suffix;

  function render() {
    const data = monitor.snapshot();
    byId('measure-fps').textContent = format(data.avgRenderFps, 1);
    byId('measure-cost').textContent = format(data.avgTrackingAndRenderMs, 1, ' ms');
    byId('measure-jitter').textContent = format(data.fingertipRawYStd, 4) + ' / ' + format(data.fingertipEmaYStd, 4);
    byId('measure-suppression').textContent = format(data.jitterSuppressionPercent, 1, '%');
  }

  panel.addEventListener('toggle', () => { if (panel.open) render(); });
  byId('copy-measures').addEventListener('click', async () => {
    const json = JSON.stringify(monitor.snapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      status.textContent = '已复制';
    } catch {
      const text = document.createElement('textarea');
      text.value = json;
      text.readOnly = true;
      text.style.position = 'fixed';
      text.style.opacity = '0';
      panel.append(text);
      text.select();
      try {
        status.textContent = document.execCommand('copy') ? '已复制' : '浏览器未授予剪贴板权限';
      } catch {
        status.textContent = '浏览器未授予剪贴板权限';
      } finally {
        text.remove();
      }
    }
  });

  return now => {
    if (!panel.open || now - lastPaint < 250) return;
    lastPaint = now;
    render();
  };
}
