function standardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

const rounded = value => value === null ? null : Number(value.toFixed(5));

export function createPerformanceMonitor(windowMs = 5000) {
  const frames = [];

  function add(now, costMs, hand) {
    frames.push({ now, costMs, ...hand });
    while (frames[0].now < now - windowMs) frames.shift();
  }

  function snapshot() {
    const paired = frames.filter(({ rawY, filteredY }) => Number.isFinite(rawY) && Number.isFinite(filteredY));
    const rawStd = standardDeviation(paired.map(frame => frame.rawY));
    const filteredStd = standardDeviation(paired.map(frame => frame.filteredY));
    const duration = frames.length > 1 ? frames.at(-1).now - frames[0].now : 0;
    return {
      windowMs,
      measuredDurationMs: rounded(duration),
      frameSamples: frames.length,
      fingertipSamples: paired.length,
      avgRenderFps: rounded(duration > 0 ? (frames.length - 1) * 1000 / duration : null),
      avgTrackingAndRenderMs: rounded(frames.length ? frames.reduce((sum, frame) => sum + frame.costMs, 0) / frames.length : null),
      fingertipRawYStd: rounded(rawStd),
      fingertipEmaYStd: rounded(filteredStd),
      jitterSuppressionPercent: rounded(rawStd > 1e-7 ? 100 * (1 - filteredStd / rawStd) : null),
    };
  }

  return { add, snapshot, reset() { frames.length = 0; } };
}
