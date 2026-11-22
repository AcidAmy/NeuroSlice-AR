import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceMonitor } from '../src/core/performanceMonitor.js';

test('the report uses matched jitter samples and drops frames outside its window', () => {
  const monitor = createPerformanceMonitor(5000);
  monitor.add(0, 100, { rawY: 9, filteredY: 9 });
  monitor.add(5000, 12, { rawY: 0.4, filteredY: 0.48 });
  monitor.add(5050, 16, { rawY: 0.6, filteredY: 0.52 });
  monitor.add(5100, 14, { rawY: null, filteredY: null });
  const data = monitor.snapshot();
  assert.equal(data.frameSamples, 3);
  assert.equal(data.fingertipSamples, 2);
  assert.equal(data.avgRenderFps, 20);
  assert.equal(data.avgTrackingAndRenderMs, 14);
  assert.equal(data.fingertipRawYStd, 0.1);
  assert.equal(data.fingertipEmaYStd, 0.02);
  assert.equal(data.jitterSuppressionPercent, 80);
  monitor.reset();
  assert.equal(monitor.snapshot().avgRenderFps, null);
});
