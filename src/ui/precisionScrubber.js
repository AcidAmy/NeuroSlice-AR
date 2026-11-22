// 保留原生 range 的键盘和触屏语义，绘制统一的刻度、进度带与握持滑块。
export function installPrecisionScrubber(input, { label, output, minus, plus, unit = '' }) {
  const node = document.createElement('div');
  node.className = 'precision-scrubber';
  const heading = document.createElement('div');
  heading.className = 'scrubber-heading';
  const name = document.createElement('label');
  name.htmlFor = input.id;
  name.textContent = label;
  heading.append(name, output);
  const controls = document.createElement('div');
  controls.className = 'scrubber-controls';
  const track = document.createElement('div');
  track.className = 'scrubber-track';
  const action = (existing, direction) => {
    if (existing) return existing;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-button numeric';
    button.textContent = direction < 0 ? '−' : '+';
    button.setAttribute('aria-label', label + (direction < 0 ? '减小' : '增大'));
    button.addEventListener('click', () => { input[direction < 0 ? 'stepDown' : 'stepUp'](); dispatch(); });
    return button;
  };
  function dispatch() { input.dispatchEvent(new Event('input', { bubbles: true })); }
  function sync({ valueText, defaultValue } = {}) {
    if (defaultValue !== undefined) input.defaultValue = defaultValue;
    const value = input.valueAsNumber;
    const min = Number(input.min);
    const max = Number(input.max);
    track.style.setProperty('--level', (max > min ? (value - min) * 100 / (max - min) : 0) + '%');
    output.value = valueText ?? value + unit;
    back.disabled = input.disabled || value <= min;
    forward.disabled = input.disabled || value >= max;
  }
  const back = action(minus, -1);
  const forward = action(plus, 1);
  const marks = document.createElement('span');
  marks.className = 'scrubber-marks';
  const thumb = document.createElement('span');
  thumb.className = 'scrubber-thumb';
  marks.setAttribute('aria-hidden', 'true');
  thumb.setAttribute('aria-hidden', 'true');
  input.before(node);
  node.append(heading, controls);
  track.append(marks, thumb, input);
  controls.append(back, track, forward);
  input.addEventListener('dblclick', () => { input.value = input.defaultValue; dispatch(); });
  sync();
  return { node, sync };
}
