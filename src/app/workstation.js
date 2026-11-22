import { cameraActive, describeStartError, startCamera, stopCamera } from '../camera.js';
import { setProgress } from '../net.js';
import { evaluate, initQuality, quality } from '../quality.js';
import { loadVolumeMetadata, loadVolumePair, loadVolumePreview, volumeFormats } from '../core/volumeSource.js';
import { createMprPreview } from '../imaging/slicePreview.js';
import { t } from './messages.js';
import { createSpatialMapper } from '../core/spatialMapper.js';
import { createPerformanceMonitor } from '../core/performanceMonitor.js';
import { createLearningTools } from './learningTools.js';
import { bindMeasurementPanel } from './measurementPanel.js';
import { PLANES, clampVoxel } from '../core/mpr.js';
import { createMprViews } from '../ui/mprViews.js';
import { installPrecisionScrubber } from '../ui/precisionScrubber.js';
import { bindToneControls } from './toneControls.js';

const byId = id => document.getElementById(id);
const viewport = byId('ar-viewport');
const video = byId('camera-input');
const frame = byId('camera-image');
const cameraButton = byId('camera-action');
const status = byId('tracking-status');
const fps = byId('fps-value');
const sliceInput = byId('slice-index');
const sliceBack = byId('slice-back');
const sliceForward = byId('slice-forward');
const calibration = byId('calibration-panel');
const base = import.meta.env.BASE_URL;
const available = JSON.parse(byId('medical-assets')?.textContent ?? '[]');

const controls = {
  opacity: byId('projection-opacity'),
  xOffset: byId('align-x'), yOffset: byId('align-y'), zOffset: byId('align-z'), scale: byId('align-scale'),
  scaleX: byId('align-scale-x'), scaleY: byId('align-scale-y'),
};
const display = {
  layer: 'combined', renderMode: 'specimen', half: false, lens: false,
  showPlanes: true, allPlanes: false, showLabels: false,
};
let dimensions = [128, 128, 120];
let spacing = dimensions.map(size => 200 / (size - 1));
let cursor = [64, 64, 77];
let activePlane = 'axial';
let layout = 'mpr';
let projection, paintSlices, stopLoop;
let trackers;
let renderedSliceView;
let modelSource, volumeSource;
let depth = 120;
let index = Number(sliceInput.value);
let session = 0;
let fpsStart = 0;
let fpsSamples = 0;
let manualPointer = null;
let wheelDelta = 0;

const mpr = createMprViews(byId('scan-pair'), {
  onPoint: (key, next) => {
    learning.checkDeadline();
    activatePlane(key);
    cursor = next;
    manualSlice(next[PLANES[key].axis]);
  },
  onWheel: (key, direction) => {
    activatePlane(key);
    manualSlice(index + direction);
  },
  onDetail: selectLayout,
});

function instrumentSlider(id, label, outputId, unit = '') {
  const input = byId(id);
  const wrapper = input.parentElement;
  wrapper.before(input);
  const scrubber = installPrecisionScrubber(input, { label, output: byId(outputId), unit });
  wrapper.remove();
  input.addEventListener('input', () => scrubber.sync());
  return scrubber;
}

const sliceTrack = installPrecisionScrubber(sliceInput, {
  label: '切层轨道', output: byId('slice-number'), minus: sliceBack, plus: sliceForward,
});
sliceTrack.sync({ valueText: '—' });
instrumentSlider('projection-opacity', '透视强度', 'opacity-value', '%');
const toneTracks = [
  instrumentSlider('ct-width', '窗宽 W', 'ct-width-value'),
  instrumentSlider('ct-level', '窗位 L', 'ct-level-value'),
  instrumentSlider('mri-contrast', '对比度', 'mri-contrast-value', '%'),
  instrumentSlider('mri-brightness', '亮度', 'mri-brightness-value'),
];
const mapper = createSpatialMapper();
mapper.reset(index);
const monitor = createPerformanceMonitor();
const paintMeasurements = bindMeasurementPanel(monitor);
const learning = createLearningTools({
  base, getCursor: () => cursor, getPlane: () => activePlane, views: mpr.entries,
  onPreset: value => {
    if (layout !== 'mpr') selectLayout('axial');
    else activatePlane('axial');
    manualSlice(value);
  },
  onRoundStart: () => {
    mapper.unlock();
    byId('slice-lock').hidden = true;
  },
});
const tones = bindToneControls(() => {
  for (const track of toneTracks) track.sync();
  paintCurrentSlices();
});

function paintCurrentSlices() {
  paintSlices?.(cursor, tones.options(), layout === 'mpr' ? undefined : layout);
}

function activatePlane(key) {
  if (activePlane !== key) {
    activePlane = key;
    configureSliceAxis();
    mapper.setManual(index, performance.now(), manualPointer !== null);
  }
  mpr.setLayout(layout, activePlane);
}

function configureSliceAxis() {
  const plane = PLANES[activePlane];
  depth = dimensions[plane.axis];
  index = cursor[plane.axis];
  sliceInput.max = depth - 1;
  sliceInput.value = index;
  sliceTrack.sync({ defaultValue: Math.round((depth - 1) * (activePlane === 'axial' ? 0.65 : 0.5)) });
  byId('slice-controls').dataset.semantic = activePlane;
  byId('toggle-scan-line').dataset.semantic = activePlane;
  byId('active-plane').textContent = plane.label;
  const endpoints = { axial: ['足侧', '头顶'], coronal: ['前方', '后方'], sagittal: ['右侧', '左侧'] };
  const [start, end] = endpoints[activePlane];
  byId('slice-start').textContent = start;
  byId('slice-end').textContent = end;
}

function selectLayout(value) {
  layout = value;
  if (layout !== 'mpr') activatePlane(layout);
  mpr.setLayout(layout, activePlane);
  byId('toggle-all-planes').disabled = layout !== 'mpr';
  for (const button of document.querySelectorAll('[data-mpr-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mprLayout === value));
  }
  learning.setLayout(layout);
  chooseSlice(index);
}

function drawAR() {
  projection?.draw({
    live: Boolean(stopLoop),
    layer: display.layer,
    renderMode: display.renderMode,
    half: display.half,
    lens: display.lens,
    showPlanes: display.showPlanes,
    showLabels: display.showLabels,
    allPlanes: display.allPlanes && layout === 'mpr',
    activePlane,
    cursor, dimensions, spacing,
    opacity: controls.opacity.valueAsNumber / 100,
    xOffset: controls.xOffset.valueAsNumber / 100,
    yOffset: controls.yOffset.valueAsNumber / 100,
    zOffset: controls.zOffset.valueAsNumber / 100,
    scale: controls.scale.valueAsNumber / 100,
    scaleX: controls.scaleX.valueAsNumber / 100,
    scaleY: controls.scaleY.valueAsNumber / 100,
    ratio: quality.ratio,
  });
}

function updateSourceBadge() {
  byId('workstation-source').hidden = ![...modelSource ?? [], volumeSource]
    .some(source => source === 'fallback' || source === 'phantom');
}

function chooseSlice(value, redraw = true) {
  index = clampVoxel(value, depth);
  cursor[PLANES[activePlane].axis] = index;
  sliceInput.value = index;
  sliceTrack.sync({ valueText: `${String(index + 1).padStart(String(depth).length, '0')} / ${depth}` });
  // 像素、十字线和标注独立更新。头姿帧和同层事件不进入断层绘制。
  const nextView = [...cursor, layout, activePlane];
  if (!renderedSliceView || nextView.some((value, i) => value !== renderedSliceView[i])) {
    renderedSliceView = nextView;
    paintCurrentSlices();
    mpr.render(cursor);
    learning.drawAnnotations();
  }
  if (redraw) drawAR();
}

function manualSlice(value) {
  learning.checkDeadline();
  chooseSlice(value);
  mapper.setManual(index, performance.now(), manualPointer !== null);
}

function setStatus(message) {
  if (status.textContent !== message) status.textContent = message;
}

function endCamera(message = '启动摄像头后，透视模型会跟随头部。') {
  session++;
  stopLoop?.();
  stopLoop = null;
  stopCamera(video);
  projection?.setFrame(null);
  frame.hidden = true;
  viewport.classList.remove('is-live');
  fps.parentElement.classList.remove('is-active');
  fps.value = '—';
  fpsStart = fpsSamples = 0;
  manualPointer = null;
  mapper.reset(index);
  byId('slice-lock').hidden = true;
  byId('slice-gesture-status').textContent = '指尖上下移动可切层，捏合 0.2 秒锁定。也可使用滚轮或滑块。';
  setProgress(null);
  cameraButton.disabled = false;
  delete cameraButton.dataset.live;
  cameraButton.textContent = '启动摄像头';
  setStatus(message);
  drawAR();
}

function handleFrame(data) {
  projection?.setFrame(data);
  learning.checkDeadline();
  const gesture = mapper.update({ ...data, depth: paintSlices ? depth : 0, plane: activePlane });
  byId('slice-lock').hidden = !gesture.locked;
  const hint = gesture.pickup
    ? '手动控制中。将指尖移动到当前层附近以平滑接管。'
    : ({ axial: '指尖上下移动', coronal: '指尖前后或上下移动', sagittal: '指尖左右移动' })[activePlane]
      + '可切层，捏合 0.2 秒锁定。';
  const gestureStatus = byId('slice-gesture-status');
  if (gestureStatus.textContent !== hint) gestureStatus.textContent = hint;
  if (gesture.index !== index) chooseSlice(gesture.index, false);
  if (gesture.confirmed) learning.confirmGesture();
  if (!fpsStart) fpsStart = data.now;
  fpsSamples++;
  const elapsed = data.now - fpsStart;
  if (elapsed >= 1000) {
    const rate = Math.round(fpsSamples * 1000 / elapsed);
    fps.value = String(rate);
    evaluate(rate);
    fpsStart = data.now;
    fpsSamples = 0;
  }
  if (!data.faceLandmarks || !data.transformMatrix) {
    setStatus('请面向摄像头，将双眼和鼻梁移入画面。');
  } else if (!trackers.hand) {
    setStatus('正在追踪头部。指尖追踪暂不可用。');
  } else {
    setStatus('正在追踪头部与手部。');
  }
  drawAR();
  return { rawY: gesture.rawY, filteredY: gesture.filteredY };
}

async function toggleCamera() {
  if (stopLoop || cameraActive()) {
    endCamera();
    return;
  }
  const current = ++session;
  let stage = 'camera';
  cameraButton.disabled = true;
  setStatus('正在请求摄像头权限…');
  try {
    await startCamera(video, () => {
      if (session === current) endCamera('摄像头已断开，可以重新启动。');
    });
    if (session !== current) return;
    stage = 'trackers';
    setStatus('正在加载 MediaPipe 追踪模型…');
    setProgress(0);
    const [{ loadTrackers }, { startLive }] = await Promise.all([
      import('../tracking/trackers.js'), import('../loops/live.js'),
    ]);
    if (session !== current) return;
    trackers = await loadTrackers(value => {
      if (session === current) setProgress(value);
    });
    if (session !== current) return;
    setProgress(null);
    cameraButton.disabled = false;
    cameraButton.dataset.live = 'true';
    cameraButton.textContent = '关闭摄像头';
    frame.hidden = false;
    viewport.classList.add('is-live');
    fps.parentElement.classList.add('is-active');
    monitor.reset();
    stopLoop = startLive({
      video, frame, onFrame: handleFrame,
      onFrameMeasured: (now, costMs, hand) => {
        monitor.add(now, costMs, hand);
        paintMeasurements(now);
      },
      onError: () => {
        projection?.setFrame(null);
        drawAR();
        setStatus('追踪暂时中断，正在等待下一帧。');
      },
    });
  } catch (error) {
    if (session === current) endCamera(t(...describeStartError(error, stage)));
  }
}

initQuality();
cameraButton.addEventListener('click', toggleCamera);
window.addEventListener('pagehide', () => { if (cameraActive()) endCamera(); });
sliceInput.addEventListener('pointerdown', event => {
  manualPointer = event.pointerId;
  mapper.setManual(index, performance.now(), true);
});
function releaseSlider(event) {
  if (event.pointerId !== manualPointer) return;
  manualPointer = null;
  mapper.setManual(index, performance.now());
}
window.addEventListener('pointerup', releaseSlider);
window.addEventListener('pointercancel', releaseSlider);
sliceInput.addEventListener('input', () => manualSlice(sliceInput.valueAsNumber));
sliceBack.addEventListener('click', () => manualSlice(index - 1));
sliceForward.addEventListener('click', () => manualSlice(index + 1));
function wheelSlice(event) {
  if (!paintSlices || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  if (event.target.closest('input[type="range"]') && event.target !== sliceInput) return;
  event.preventDefault();
  if (event.deltaMode) {
    manualSlice(index + Math.sign(event.deltaY));
    return;
  }
  if (Math.sign(event.deltaY) !== Math.sign(wheelDelta)) wheelDelta = 0;
  wheelDelta += event.deltaY;
  const steps = Math.trunc(wheelDelta / 40);
  if (steps) {
    wheelDelta %= 40;
    manualSlice(index + Math.max(-5, Math.min(5, steps)));
  }
}
sliceInput.addEventListener('wheel', wheelSlice, { passive: false });
for (const control of Object.values(controls)) control.addEventListener('input', drawAR);
const layerButtons = [...document.querySelectorAll('[data-ar-layer]')];
for (const button of layerButtons) {
  button.addEventListener('click', () => {
    display.layer = button.dataset.arLayer;
    for (const item of layerButtons) item.setAttribute('aria-pressed', String(item.dataset.arLayer === display.layer));
    drawAR();
  });
}
const viewButtons = [...document.querySelectorAll('[data-ar-view]')];
for (const button of viewButtons) {
  button.addEventListener('click', () => {
    const view = button.dataset.arView;
    // 半剖与镜窗仍可叠加。全头恢复两项默认显示。
    if (view === 'full') display.half = display.lens = false;
    else display[view] = !display[view];
    for (const item of viewButtons) {
      const key = item.dataset.arView;
      item.setAttribute('aria-pressed', String(key === 'full' ? !display.half && !display.lens : display[key]));
    }
    drawAR();
  });
}
const renderButtons = [...document.querySelectorAll('[data-ar-render]')];
for (const button of renderButtons) {
  button.addEventListener('click', () => {
    display.renderMode = button.dataset.arRender;
    viewport.dataset.renderMode = display.renderMode;
    for (const item of renderButtons) item.setAttribute('aria-pressed', String(item === button));
    drawAR();
  });
}
const scanToggle = byId('toggle-scan-line');
scanToggle.addEventListener('click', () => {
  display.showPlanes = !display.showPlanes;
  scanToggle.setAttribute('aria-pressed', String(display.showPlanes));
  drawAR();
});
const labelToggle = byId('toggle-model-labels');
labelToggle.addEventListener('click', () => {
  display.showLabels = !display.showLabels;
  labelToggle.setAttribute('aria-pressed', String(display.showLabels));
  if (!display.showLabels) projection?.clearSelection(false, false);
  drawAR();
});
const allPlanesToggle = byId('toggle-all-planes');
allPlanesToggle.addEventListener('click', () => {
  display.allPlanes = !display.allPlanes;
  allPlanesToggle.setAttribute('aria-pressed', String(display.allPlanes));
  if (display.allPlanes && !display.showPlanes) {
    display.showPlanes = true;
    scanToggle.setAttribute('aria-pressed', 'true');
  }
  drawAR();
});
for (const button of document.querySelectorAll('[data-mpr-layout]')) {
  button.addEventListener('click', () => selectLayout(button.dataset.mprLayout));
}
const calibrationValues = [
  [controls.scale, '整体缩放', 'value-scale'],
  [controls.scaleX, '水平宽窄 (X)', 'value-scale-x'],
  [controls.scaleY, '垂直高矮 (Y)', 'value-scale-y'],
  [controls.yOffset, '上下偏移', 'value-y'],
  [controls.zOffset, '深度偏移', 'value-z'],
  [controls.xOffset, '水平偏移', 'value-x'],
].map(([input, label, output]) => [input, instrumentSlider(input.id, label, output, '%')]);
byId('open-calibration').addEventListener('click', () => calibration.showModal());
byId('open-credits').addEventListener('click', () => byId('credits-panel').showModal());
byId('reset-calibration').addEventListener('click', () => {
  for (const [input, track] of calibrationValues) {
    input.value = input.defaultValue;
    track.sync();
  }
  drawAR();
});
const modeButtons = [...document.querySelectorAll('[data-mode]')];
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    for (const item of modeButtons) item.setAttribute('aria-pressed', String(item === button));
    learning.setMode(button.dataset.mode);
  });
}
let modelPointer;
viewport.addEventListener('pointerdown', event => {
  if (!projection || modelPointer || event.button !== 0 || event.target.closest('button, .model-label-card')) return;
  modelPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  viewport.setPointerCapture(event.pointerId);
});
viewport.addEventListener('lostpointercapture', event => {
  if (modelPointer?.id === event.pointerId) modelPointer = undefined;
});
function viewportPoint(event) {
  const bounds = viewport.getBoundingClientRect();
  return { x: event.clientX - bounds.left - viewport.clientLeft, y: event.clientY - bounds.top - viewport.clientTop };
}
viewport.addEventListener('pointermove', event => {
  if (!projection) return;
  const held = modelPointer?.id === event.pointerId && modelPointer;
  let dragging = false;
  if (held) {
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (held.moved || Math.hypot(dx, dy) >= 4) {
      held.moved = true;
      held.x = event.clientX;
      held.y = event.clientY;
      dragging = !stopLoop;
      if (dragging) projection.dragPreview(dx, dy);
    }
  }
  if (!dragging && !display.lens) return;
  projection.setPointer(viewportPoint(event));
  drawAR();
});
viewport.addEventListener('pointerup', event => {
  if (modelPointer?.id !== event.pointerId) return;
  const { x, y, moved } = modelPointer;
  modelPointer = undefined;
  if (moved || Math.hypot(event.clientX - x, event.clientY - y) >= 4) return;
  const target = viewportPoint(event);
  if (display.lens) {
    projection.setPointer(target);
    drawAR();
  }
  projection.pick(target.x, target.y);
});
viewport.addEventListener('pointerleave', () => {
  projection?.setPointer(null);
  if (display.lens) drawAR();
});
new ResizeObserver(drawAR).observe(viewport);

viewport.classList.add('is-orbitable');
const formats = volumeFormats(available);
const firstMetadata = formats.length ? loadVolumeMetadata(base, formats[0]).catch(() => null) : Promise.resolve(null);
import('../ar/projection.js').then(({ createProjection }) => createProjection({
  canvas: byId('projection-image'), ring: byId('lens-guide'), base,
  labels: byId('model-labels'), labelCard: byId('model-label-card'),
  onSelection: drawAR,
  available, metadata: firstMetadata,
})).then(result => {
  projection = result;
  modelSource = result.modelSources;
  updateSourceBadge();
  drawAR();
}).catch(() => {
  modelSource = ['unavailable', 'unavailable'];
  updateSourceBadge();
  byId('projection-error').hidden = false;
}).finally(() => {
  byId('projection-loading').hidden = true;
});

function showSeries(series) {
  const previousDimensions = dimensions;
  const previousCursor = cursor;
  volumeSource = series.source;
  updateSourceBadge();
  dimensions = series.dimensions;
  spacing = series.spacing;
  cursor = dimensions.map((size, axis) => Math.round((size - 1) * (paintSlices
    ? previousCursor[axis] / (previousDimensions[axis] - 1)
    : axis === 2 ? 0.65 : 0.5)));
  mpr.setSeries(series);
  mpr.setLayout(layout, activePlane);
  paintSlices = createMprPreview(mpr.entries, series);
  renderedSliceView = undefined;
  tones.setSeries(series, { preserveWindow: showingPreview && series.source === 'local' });
  learning.setSeries(series);
  sliceInput.disabled = false;
  configureSliceAxis();
  mapper.reset(index);
  chooseSlice(index);
}

const loadingPanel = byId('volume-loading');
const loadLabel = byId('volume-load-label');
const loadReadout = byId('volume-load-readout');
const loadBar = byId('volume-load-bar');
const retryVolume = byId('retry-volume');
let showingPreview = false;
let progressFrame;
function showProgress(received, total) {
  cancelAnimationFrame(progressFrame);
  progressFrame = requestAnimationFrame(() => {
    const mb = bytes => (bytes / 1e6).toFixed(2);
    if (total) {
      const percent = Math.min(100, Math.round(received / total * 100));
      loadBar.value = percent;
      loadReadout.textContent = `${mb(received)} / ${mb(total)} MB · ${percent}%`;
    } else {
      loadBar.removeAttribute('value');
      loadReadout.textContent = received ? `${mb(received)} MB` : '';
    }
  });
}

async function loadImaging(initial = false) {
  loadingPanel.hidden = false;
  retryVolume.hidden = true;
  loadBar.hidden = false;
  loadLabel.textContent = showingPreview ? '低分辨率预览 · 加载完整 CT / MRI' : '正在加载断层影像';
  showProgress(0, 0);
  try {
    const series = await loadVolumePair(base, available, {
      firstMetadata: initial ? firstMetadata : undefined,
      onProgress: showProgress,
      async onMetadata(metadata, format) {
        if (!paintSlices && format[0] === 'meta.json' && import.meta.env.PROD && typeof DecompressionStream === 'function') {
          try {
            showSeries(await loadVolumePreview(base, metadata));
            showingPreview = true;
          } catch {
            // 完整体数据也可以独立加载。
          }
        }
        loadLabel.textContent = showingPreview ? '低分辨率预览 · 加载完整断层' : '正在下载完整断层影像';
      },
      hasPreview: () => Boolean(paintSlices),
    });
    if (series) showSeries(series);
    loadingPanel.hidden = Boolean(series && series.source !== 'fallback');
    if (loadingPanel.hidden) showingPreview = false;
    else loadLabel.textContent = showingPreview ? '完整影像加载失败，已保留低分辨率预览。' : '完整影像加载失败，正在显示合成断层。';
  } catch {
    loadLabel.textContent = '断层影像暂不可用。';
  } finally {
    cancelAnimationFrame(progressFrame);
    loadBar.hidden = true;
    loadReadout.textContent = '';
    retryVolume.hidden = loadingPanel.hidden;
  }
}

retryVolume.addEventListener('click', () => loadImaging());
loadImaging(true);

if (import.meta.env.PROD && 'serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register(base + 'sw.js', { updateViaCache: 'none' }).catch(() => {});
}
