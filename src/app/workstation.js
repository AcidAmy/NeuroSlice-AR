import { cameraActive, describeStartError, startCamera, stopCamera } from '../camera.js';
import { setProgress } from '../net.js';
import { evaluate, initQuality, quality } from '../quality.js';
import { ctOnly, extraSequences, loadModality, loadPhantom, loadVolumeMetadata, seriesGeometry, volumeFormats } from '../core/volumeSource.js';
import { modelNames, startModelDownloads } from '../core/modelSource.js';
import { medicalCacheName, pruneMedicalCaches } from '../core/assetCache.js';
import { createMprPreview } from '../imaging/slicePreview.js';
import { t } from './messages.js';
import { createSpatialMapper } from '../core/spatialMapper.js';
import { createPerformanceMonitor } from '../core/performanceMonitor.js';
import { createLearningTools } from './learningTools.js';
import { bindMeasurementPanel } from './measurementPanel.js';
import {
  OBLIQUE_ENTER_RAD, OBLIQUE_EXIT_RAD, OBLIQUE_STEP_RAD, PLANES,
  buildObliqueFrames, clampVoxel, headFrame, headToVoxel, invertQuaternion,
  obliquePointToHead, obliqueSliceIndex, quatAngle, quatDeltaAngle, stepObliquePivot,
} from '../core/mpr.js';
import { createMprViews } from '../ui/mprViews.js';
import { installPrecisionScrubber } from '../ui/precisionScrubber.js';
import { bindToneControls } from './toneControls.js';
import { bindSliceDisplayControls } from './sliceDisplayControls.js';
import { createSliceTone } from '../core/sliceTone.js';

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
const obliqueToggle = byId('toggle-oblique');
const calibration = byId('calibration-panel');
const base = import.meta.env.BASE_URL;
const { available = [], models: modelAssets, assetRelease } =
  JSON.parse(byId('medical-assets')?.textContent ?? '{}');

const controls = {
  opacity: byId('projection-opacity'),
  xOffset: byId('align-x'), yOffset: byId('align-y'), zOffset: byId('align-z'), scale: byId('align-scale'),
  scaleX: byId('align-scale-x'), scaleY: byId('align-scale-y'),
};
const display = {
  layer: 'combined', renderMode: 'specimen', half: false, lens: false,
  showPlanes: true, allPlanes: false, showLabels: false,
  showSliceTexture: false, sliceModality: 'ct',
};
let dimensions = [128, 128, 120];
let spacing = dimensions.map(size => 200 / (size - 1));
let cursor = [64, 64, 77];
let activePlane = 'axial';
let layout = 'mpr';
let projection, paintSlices, stopLoop;
let trackers;
let renderedSliceView;
let modelSource, volumeSource, sliceSeries;
let depth = 120;
let index = Number(sliceInput.value);
let session = 0;
let fpsStart = 0;
let fpsSamples = 0;
let manualPointer = null;
let wheelDelta = 0;
let quizMode = false;
let obliqueEnabled = false;
let obliqueActive = false;
let obliqueQuat = null;
let obliqueFrames = null;
let obliqueDraft = false;
let obliqueKey = 0;
let obliqueRefineTimer = null;
let headPivot = null;

function obliquePayload() {
  if (!obliqueFrames) return null;
  return {
    frames: obliqueFrames,
    draft: obliqueDraft,
    draftScale: quality.ratio < 1 ? 0.45 : 0.55,
    key: obliqueKey,
  };
}

function clearObliqueRefine() {
  if (obliqueRefineTimer !== null) {
    clearTimeout(obliqueRefineTimer);
    obliqueRefineTimer = null;
  }
}

function syncObliqueToggle() {
  obliqueToggle.disabled = quizMode;
  obliqueToggle.setAttribute('aria-pressed', String(obliqueEnabled));
  obliqueToggle.dataset.semantic = activePlane;
}

function syncSliceReadout() {
  sliceInput.value = index;
  sliceTrack.sync({ valueText: `${String(index + 1).padStart(String(depth).length, '0')} / ${depth}` });
}

function scheduleObliqueRefine() {
  clearObliqueRefine();
  obliqueRefineTimer = setTimeout(() => {
    obliqueRefineTimer = null;
    if (!obliqueFrames || !obliqueDraft) return;
    obliqueDraft = false;
    paintCurrentSlices();
    if (display.showPlanes && display.showSliceTexture) drawAR();
  }, 120);
}

function commitObliqueState(nextQuat, { draft = false } = {}) {
  headPivot ??= headFrame(cursor, dimensions, spacing).point;
  obliqueActive = true;
  obliqueQuat = nextQuat;
  obliqueDraft = draft;
  obliqueKey++;
  obliqueFrames = buildObliqueFrames(headPivot, dimensions, spacing, obliqueQuat);
  cursor = headToVoxel(headPivot, dimensions, spacing).map((value, axis) => clampVoxel(value, dimensions[axis]));
  index = obliqueSliceIndex(obliqueFrames[activePlane], headPivot, depth);
  syncSliceReadout();
  paintCurrentSlices();
  mpr.render(cursor, obliqueFrames);
  learning.drawAnnotations();
  if (draft) scheduleObliqueRefine();
  else clearObliqueRefine();
}

function exitObliquePose({ redraw = true } = {}) {
  clearObliqueRefine();
  if (headPivot) {
    cursor = headToVoxel(headPivot, dimensions, spacing).map((value, axis) => clampVoxel(value, dimensions[axis]));
  }
  headPivot = null;
  obliqueActive = false;
  obliqueQuat = null;
  obliqueFrames = null;
  obliqueDraft = false;
  renderedSliceView = undefined;
  index = cursor[PLANES[activePlane].axis];
  chooseSlice(index, redraw);
}

function syncObliquePose(rawHeadQuat, { draft = true, force = false } = {}) {
  if (!obliqueEnabled || !sliceSeries || !rawHeadQuat) return;
  const nextOblique = invertQuaternion(rawHeadQuat);
  const angle = quatAngle(nextOblique);
  if (!obliqueActive) {
    if (angle < OBLIQUE_ENTER_RAD) return;
    headPivot = headFrame(cursor, dimensions, spacing).point;
  } else {
    if (angle < OBLIQUE_EXIT_RAD) {
      exitObliquePose({ redraw: false });
      return;
    }
    if (!force && obliqueQuat && quatDeltaAngle(obliqueQuat, nextOblique) < OBLIQUE_STEP_RAD) return;
  }
  commitObliqueState(nextOblique, { draft });
}

function setObliqueEnabled(next, { redraw = true } = {}) {
  const target = Boolean(next) && !quizMode;
  if (obliqueEnabled === target) {
    syncObliqueToggle();
    return;
  }
  obliqueEnabled = target;
  syncObliqueToggle();
  if (!obliqueEnabled) {
    if (obliqueActive || headPivot) exitObliquePose({ redraw });
    else if (redraw) drawAR();
    return;
  }
  const rawHeadQuat = projection?.syncPose(Boolean(stopLoop), quality.ratio) ?? null;
  syncObliquePose(rawHeadQuat, { draft: false, force: true });
  if (redraw) drawAR();
}

const mpr = createMprViews(byId('scan-pair'), {
  onPoint: (key, next, point2d) => {
    learning.checkDeadline();
    activatePlane(key);
    if (obliqueFrames?.[key] && point2d) {
      headPivot = obliquePointToHead(obliqueFrames[key], point2d, dimensions, spacing);
      commitObliqueState(obliqueQuat, { draft: false });
      mapper.setManual(index, performance.now(), manualPointer !== null);
      drawAR();
      return;
    }
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
  label: PLANES.axial.label, output: byId('slice-number'), minus: sliceBack, plus: sliceForward,
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
  base, getCursor: () => cursor, getPlane: () => activePlane, getObliqueFrames: () => obliqueFrames, views: mpr.entries,
  onRetry: retryAssets,
  onPreset: value => {
    setObliqueEnabled(false, { redraw: false });
    if (layout !== 'mpr') selectLayout('axial');
    else activatePlane('axial');
    manualSlice(value);
  },
  onModeChange: active => {
    quizMode = active;
    if (quizMode) setObliqueEnabled(false, { redraw: true });
    else syncObliqueToggle();
  },
  onRoundStart: () => {
    mapper.unlock();
    byId('slice-lock').hidden = true;
  },
});
const resolveTone = createSliceTone();
const tones = bindToneControls(() => {
  sliceTone = tones.options();
  mpr.setMriLabel('MRI ' + tones.mriLabel());
  for (const track of toneTracks) track.sync();
  paintCurrentSlices();
  if (display.showPlanes && display.showSliceTexture) drawAR();
}, key => requestMri(true, key));
let sliceTone = tones.options();

function paintCurrentSlices() {
  paintSlices?.(cursor, sliceTone, layout === 'mpr' ? undefined : layout, sliceSeries, obliquePayload());
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
  index = obliqueFrames?.[activePlane] && headPivot
    ? obliqueSliceIndex(obliqueFrames[activePlane], headPivot, depth)
    : cursor[plane.axis];
  sliceInput.max = depth - 1;
  syncSliceReadout();
  sliceTrack.sync({ defaultValue: Math.round((depth - 1) * (activePlane === 'axial' ? 0.65 : 0.5)) });
  byId('slice-controls').dataset.semantic = activePlane;
  byId('toggle-scan-line').dataset.semantic = activePlane;
  byId('toggle-slice-texture').dataset.semantic = activePlane;
  syncObliqueToggle();
  sliceTrack.label.textContent = plane.label;
  sliceInput.setAttribute('aria-label', plane.label);
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
  if (obliqueFrames) {
    paintCurrentSlices();
    mpr.render(cursor, obliqueFrames);
    learning.drawAnnotations();
    drawAR();
  } else {
    chooseSlice(index);
  }
}

function drawAR() {
  projection?.draw({
    live: Boolean(stopLoop),
    layer: display.layer,
    renderMode: display.renderMode,
    half: display.half,
    lens: display.lens,
    showPlanes: display.showPlanes,
    showSliceTexture: display.showSliceTexture,
    sliceModality: display.sliceModality,
    sliceSeries, sliceTone,
    showLabels: display.showLabels,
    allPlanes: display.allPlanes && layout === 'mpr',
    activePlane,
    cursor, dimensions, spacing,
    oblique: obliquePayload(),
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
  if (obliqueFrames?.[activePlane]) {
    headPivot = stepObliquePivot(
      obliqueFrames[activePlane],
      headPivot ?? headFrame(cursor, dimensions, spacing).point,
      index, depth, dimensions, spacing,
    );
    commitObliqueState(obliqueQuat, { draft: false });
    if (redraw) drawAR();
    return;
  }
  cursor[PLANES[activePlane].axis] = index;
  syncSliceReadout();
  // 像素、十字线和标注独立更新。正交态下同层事件不重复进入断层绘制。
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

// Silent while things work; speaks only when the user has to wait or act.
function setStatus(message = '') {
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !message;
}

function endCamera(message) {
  session++;
  stopLoop?.();
  stopLoop = null;
  stopCamera(video);
  projection?.setFrame(null);
  frame.hidden = true;
  viewport.classList.remove('is-live');
  fps.parentElement.hidden = true;
  fps.value = '—';
  fpsStart = fpsSamples = 0;
  manualPointer = null;
  mapper.reset(index);
  byId('slice-lock').hidden = true;
  setProgress(null);
  cameraButton.disabled = false;
  delete cameraButton.dataset.live;
  cameraButton.textContent = '启动摄像头';
  setObliqueEnabled(false, { redraw: false });
  setStatus(message);
  drawAR();
}

function handleFrame(data) {
  projection?.setFrame(data);
  const rawHeadQuat = projection?.syncPose(true, quality.ratio) ?? null;
  learning.checkDeadline();
  syncObliquePose(rawHeadQuat, { draft: true });
  const gesture = mapper.update({ ...data, depth: paintSlices ? depth : 0, plane: activePlane });
  byId('slice-lock').hidden = !gesture.locked;
  if (gesture.rawY !== null && !gesture.locked && !gesture.pickup && gesture.index !== index) {
    chooseSlice(gesture.index, false);
  }
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
  if (!data.faceLandmarks || !data.transformMatrix) setStatus('请面向摄像头');
  else if (!trackers.hand) setStatus('指尖追踪不可用');
  else if (gesture.pickup) setStatus('将指尖移到当前层附近接管');
  else setStatus();
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
  setStatus('正在请求摄像头…');
  try {
    await startCamera(video, () => {
      if (session === current) endCamera('摄像头已断开');
    });
    if (session !== current) return;
    stage = 'trackers';
    setStatus('正在加载追踪模型…');
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
    fps.parentElement.hidden = false;
    setStatus();
    monitor.reset();
    if (!quizMode) {
      obliqueEnabled = true;
      syncObliqueToggle();
    }
    stopLoop = startLive({
      video, frame, onFrame: handleFrame,
      onFrameMeasured: (now, costMs, hand) => {
        monitor.add(now, costMs, hand);
        paintMeasurements(now);
      },
      onError: () => {
        projection?.setFrame(null);
        drawAR();
        setStatus('追踪中断，正在恢复…');
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
const sliceDisplay = bindSliceDisplayControls({
  scanToggle: byId('toggle-scan-line'),
  allPlanesToggle: byId('toggle-all-planes'),
  textureToggle: byId('toggle-slice-texture'),
  modalityGroup: byId('slice-modality'),
}, display, () => {
  if (display.showSliceTexture && display.sliceModality === 'mri') requestMri(true);
  drawAR();
});
const labelToggle = byId('toggle-model-labels');
labelToggle.addEventListener('click', () => {
  display.showLabels = !display.showLabels;
  labelToggle.setAttribute('aria-pressed', String(display.showLabels));
  if (!display.showLabels) projection?.clearSelection(false, false);
  drawAR();
});
for (const button of document.querySelectorAll('[data-mpr-layout]')) {
  button.addEventListener('click', () => selectLayout(button.dataset.mprLayout));
}
obliqueToggle.addEventListener('click', () => setObliqueEnabled(!obliqueEnabled));
const calibrationValues = [
  [controls.scale, '缩放', 'value-scale'],
  [controls.scaleX, '宽度', 'value-scale-x'],
  [controls.scaleY, '高度', 'value-scale-y'],
  [controls.yOffset, '上下', 'value-y'],
  [controls.zOffset, '深度', 'value-z'],
  [controls.xOffset, '左右', 'value-x'],
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
      if (dragging) {
        projection.dragPreview(dx, dy);
        if (obliqueEnabled) syncObliquePose(projection.syncPose(false, quality.ratio), { draft: true });
      }
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
const projectionFeedback = byId('projection-feedback');
const projectionLabel = byId('projection-loading');
const projectionProgress = byId('projection-progress');
const retryProjection = byId('retry-projection');
let projectionReady = false;

async function loadProjection(metadata, options) {
  if (projectionReady) return;
  projectionFeedback.hidden = false;
  projectionProgress.hidden = false;
  projectionProgress.removeAttribute('value');
  projectionLabel.hidden = true;
  try {
    const names = (projection?.pendingModelNames ?? modelNames).filter(name => available.includes(name) &&
      (!Array.isArray(metadata?.meshFiles) || metadata.meshFiles.includes(name)));
    const downloads = startModelDownloads(base, names, metadata?.modelAssets ?? modelAssets, {
      ...options,
      onProgress(received, total) {
        if (options.signal.aborted) return;
        if (total) projectionProgress.value = Math.min(100, Math.round(received / total * 100));
        else projectionProgress.removeAttribute('value');
      },
    });
    if (!projection) {
      const { createProjection } = await import('../ar/projection.js');
      if (options.signal.aborted) return;
      projection = createProjection({
        canvas: byId('projection-image'), ring: byId('lens-guide'), base,
        labels: byId('model-labels'), labelCard: byId('model-label-card'), onSelection: drawAR, resolveTone,
      });
    }
    await projection.loadModels(downloads, options);
    modelSource = projection.modelSources;
    if (obliqueEnabled && !obliqueActive) {
      syncObliquePose(projection.syncPose(Boolean(stopLoop), quality.ratio), { draft: false, force: true });
    }
    drawAR();
    projectionReady = !modelSource.includes('fallback');
    projectionLabel.textContent = '3D 模型加载失败';
  } catch {
    if (options.signal.aborted) return;
    projectionLabel.textContent = '3D 颅脑不可用';
  } finally {
    projectionProgress.hidden = true;
    projectionLabel.hidden = projectionReady;
    projectionFeedback.hidden = projectionReady;
    retryProjection.hidden = projectionReady || options.signal.aborted;
    updateSourceBadge();
  }
}

function showSeries(series) {
  const previousDimensions = dimensions;
  const previousCursor = cursor;
  const sameGrid = sliceSeries?.dimensions === series.dimensions;
  volumeSource = series.source;
  sliceSeries = series;
  sliceDisplay.setSeries(series);
  updateSourceBadge();
  dimensions = series.dimensions;
  spacing = series.spacing;
  if (!sameGrid) {
    cursor = dimensions.map((size, axis) => Math.round((size - 1) * (paintSlices
      ? previousCursor[axis] / (previousDimensions[axis] - 1)
      : axis === 2 ? 0.65 : 0.5)));
  }
  mpr.setSeries(series);
  mpr.setLayout(layout, activePlane);
  paintSlices ??= createMprPreview(mpr.entries, undefined, resolveTone);
  renderedSliceView = undefined;
  tones.setSeries(series, { preserveWindow: sameGrid });
  learning.setSeries(series, { preserveRound: sameGrid });
  sliceInput.disabled = false;
  configureSliceAxis();
  if (!sameGrid) mapper.reset(index);
  if (obliqueActive && obliqueQuat) {
    if (!sameGrid) headPivot = headFrame(cursor, dimensions, spacing).point;
    commitObliqueState(obliqueQuat, { draft: false });
    drawAR();
  } else {
    chooseSlice(index);
  }
}

const loadingPanel = byId('volume-loading');
const loadError = byId('volume-load-error');
const loadLabel = byId('volume-load-label');
const loadBar = byId('volume-load-bar');
const retryVolume = byId('retry-volume');
const transfers = new Map();
const levels = new Map();
let progressFrame;
let loading;
let imaging;
let ctReady = false;
let mriReady = false;
let mriVisible = false;
let restarting = false;

// A thin bar while downloading; words only when a download failed.
function renderLoadState() {
  const active = [...transfers.values()].find(item => !item.failed);
  const failed = [...transfers.values()].find(item => item.failed);
  const { received = 0, total = 0 } = active ?? {};
  loadingPanel.hidden = !active && !failed;
  loadBar.hidden = !active;
  loadError.hidden = !failed;
  if (failed && loadLabel.textContent !== failed.label) loadLabel.textContent = failed.label;
  if (total) loadBar.value = Math.min(100, Math.round(received / total * 100));
  else loadBar.removeAttribute('value');
}

function scheduleLoadState() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = undefined;
    renderLoadState();
  });
}

async function downloadLayer(context, name, label, options, { preview = false, signed = false } = {}) {
  const entry = {};
  transfers.set(label, entry);
  scheduleLoadState();
  try {
    return await loadModality(base, context.metadata, name, {
      ...options, preview, signed,
      cacheName: preview ? undefined : context.cacheName,
      priority: signed && preview ? 'high' : 'low', idle: preview ? 20000 : 30000,
      progress(received, total) {
        entry.received = received;
        entry.total = total;
        scheduleLoadState();
      },
    });
  } finally {
    if (transfers.get(label) === entry) transfers.delete(label);
    scheduleLoadState();
  }
}

function volumeFailed(key, label) {
  transfers.set(key, { label, failed: true });
  scheduleLoadState();
}

function afterPaint() {
  // The timeout also allows progress if Chrome/Safari pauses animation frames in a background tab.
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 90);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });
}

function whenIdle() {
  return new Promise(resolve => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(resolve, { timeout: 500 });
    else setTimeout(resolve, 32);
  });
}

function applyCt(context, layer) {
  const sameSource = imaging === context;
  imaging = context;
  ctReady = !layer.preview;
  showSeries({
    ...context.geometry,
    ...(sameSource ? sliceSeries : { mri: null, mriSequences: {}, mriSequenceDimensions: {}, mriPending: context.hasMri }),
    ct: layer.voxels, ctDimensions: layer.dimensions, preview: layer.preview,
  });
  scheduleLoadState();
}

function applyMri(context, layer, key) {
  const mriSequences = { ...sliceSeries.mriSequences };
  const mriSequenceDimensions = { ...sliceSeries.mriSequenceDimensions };
  const native = key ?? context.metadata.mriSequence;
  // An explicitly supplied sequence takes precedence over a main-volume alias.
  if ((native === 't1' || native === 't2') && (key || !levels.has(native))) {
    mriSequences[native] = layer.voxels;
    mriSequenceDimensions[native] = layer.dimensions;
  }
  if (key) levels.set(key, layer.preview ? '预览' : '高清');
  else {
    mriReady = !layer.preview;
    levels.set('MRI', layer.preview ? '预览' : '高清');
  }
  showSeries({
    ...sliceSeries, mriSequences, mriSequenceDimensions, mriPending: false,
    ...(key ? {} : { mri: layer.voxels, mriDimensions: layer.dimensions }),
  });
  scheduleLoadState();
}

async function loadMri(context, job) {
  const [, , name] = context.format;
  const current = () => !job.options.signal.aborted && imaging === context;
  if (!sliceSeries.mri) {
    try {
      const preview = await downloadLayer(context, name, 'MRI', job.options, { preview: true });
      if (preview && current()) {
        applyMri(context, preview);
        await afterPaint();
        requestSequence(tones.options().mriPreset);
      }
    } catch { /* The full series is still usable. */ }
  }
  await job.mriGate;
  if (!job.mriUrgent) await whenIdle();
  if (!current()) return;
  try {
    const full = await downloadLayer(context, name, 'MRI', job.options);
    if (!current()) return;
    applyMri(context, full);
    requestSequence(tones.options().mriPreset);
  } catch {
    if (!current()) return;
    showSeries({ ...sliceSeries, mriPending: false });
    volumeFailed('MRI', sliceSeries.mri ? 'MRI 高清加载失败，已保留预览。' : 'MRI 加载失败。');
  }
}

function requestSequence(key) {
  const job = loading;
  const context = imaging;
  const name = extraSequences[key];
  if (!job || job.options.signal.aborted || !context?.hasMri || !available.includes(name) ||
      levels.get(key) === '高清' || job.sequences.has(key)) return;
  const label = `MRI ${key.toUpperCase()}`;
  const current = () => !job.options.signal.aborted && imaging === context;
  job.sequences.set(key, (async () => {
    if (!levels.has(key)) {
      try {
        const layer = await downloadLayer(context, name, label, job.options, { preview: true });
        if (layer && current()) {
          applyMri(context, layer, key);
          await afterPaint();
        }
      } catch { /* The full sequence is still usable. */ }
    }
    await job.mriGate;
    if (!current()) return;
    try {
      const layer = await downloadLayer(context, name, label, job.options);
      if (current()) applyMri(context, layer, key);
    } catch {
      if (current()) volumeFailed(label, `${label} 高清加载失败，已保留可用影像。`);
    } finally {
      job.sequences.delete(key);
    }
  })());
}

function requestMri(urgent = false, key = tones.options().mriPreset) {
  const job = loading;
  if (!job || job.options.signal.aborted) return;
  if (urgent) {
    job.mriUrgent = true;
    job.releaseMri();
    scheduleLoadState();
  }
  if (!imaging?.hasMri) return;
  if (!mriReady && !job.mriTask && (mriVisible || urgent || job.mriUrgent)) job.mriTask = loadMri(imaging, job);
  if (urgent || job.mriUrgent) requestSequence(key);
}

const mriCards = mpr.entries.filter(entry => entry.modality === 'mri').map(entry => entry.card);
if ('IntersectionObserver' in window) {
  const visibleCards = new Set();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleCards.add(entry.target);
      else visibleCards.delete(entry.target);
    }
    mriVisible = visibleCards.size > 0;
    if (mriVisible) requestMri();
  });
  mriCards.forEach(card => observer.observe(card));
} else mriVisible = true;
mriCards.forEach(card => card.addEventListener('pointerdown', () => requestMri(true)));

async function loadWorkstation(job) {
  const { options } = job;
  const annotations = learning.loadAnnotations(options);
  let projectionTask;
  const startProjection = context => {
    const cacheName = context?.cacheName ?? medicalCacheName(base, assetRelease);
    projectionTask ??= loadProjection(context?.metadata, { ...options, cacheName });
  };
  const getContext = async format => {
    if (imaging?.format === format) return imaging;
    const metadata = await loadVolumeMetadata(base, format, options);
    const cacheName = medicalCacheName(base, metadata.assetRelease);
    pruneMedicalCaches(cacheName);
    return { metadata, format, cacheName, geometry: seriesGeometry(metadata), hasMri: !ctOnly(metadata) };
  };

  if (!ctReady) {
    transfers.set('CT', {});
    scheduleLoadState();
    for (const format of formats) {
      try {
        const context = await getContext(format);
        if (options.signal.aborted) return;
        const [, name] = format;
        if (!sliceSeries || sliceSeries.source !== 'local') {
          try {
            const preview = await downloadLayer(context, name, 'CT', options, { preview: true, signed: true });
            if (preview && !options.signal.aborted) {
              applyCt(context, preview);
              await afterPaint();
            }
          } catch { /* A failed preview should never block the original series. */ }
        }
        if (options.signal.aborted) return;
        startProjection(context);
        requestMri();
        const full = await downloadLayer(context, name, 'CT', options, { signed: true });
        if (options.signal.aborted) return;
        applyCt(context, full);
        break;
      } catch {
        if (options.signal.aborted) return;
        // Keep a usable preview on its registered grid for retry.
        if (sliceSeries?.source === 'local') break;
      }
    }
    transfers.delete('CT');
    if (!ctReady && !options.signal.aborted) {
      if (!sliceSeries) {
        const phantom = await loadPhantom(formats.length > 0);
        if (options.signal.aborted) return;
        showSeries(phantom);
        ctReady = !formats.length;
      }
      if (!ctReady) {
        volumeFailed('CT', sliceSeries?.preview ? 'CT 高清加载失败，已保留预览。' : 'CT 加载失败，正在显示合成断层。');
      }
    }
  }
  if (options.signal.aborted) return;
  startProjection(imaging);
  job.releaseMri();
  requestMri();
  if (mriReady) requestSequence(tones.options().mriPreset);
  scheduleLoadState();
  await Promise.all([projectionTask, annotations]);
}

function startLoading(reload = false) {
  const controller = new AbortController();
  let releaseMri;
  const mriGate = new Promise(resolve => { releaseMri = resolve; });
  controller.signal.addEventListener('abort', releaseMri, { once: true });
  const job = { controller, options: { signal: controller.signal, reload }, mriGate, releaseMri, sequences: new Map() };
  loading = job;
  job.done = loadWorkstation(job).catch(() => {
    job.releaseMri();
    if (!controller.signal.aborted) volumeFailed('CT', '断层影像暂不可用。');
  });
}

async function retryAssets() {
  if (restarting) return;
  restarting = true;
  retryProjection.hidden = retryVolume.hidden = true;
  try {
    loading.controller.abort();
    await loading.done;
    transfers.clear();
    startLoading(true);
  } finally {
    restarting = false;
  }
}

retryProjection.addEventListener('click', retryAssets);
retryVolume.addEventListener('click', retryAssets);
startLoading();

if (import.meta.env.PROD && 'serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register(base + 'sw.js', { updateViaCache: 'none' }).catch(() => {});
}
