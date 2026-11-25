import { PLANES, projectVoxel } from '../core/mpr.js';
import { layerForRatio, pickQuizTarget, QUIZ_DURATION_MS, scoreQuiz } from '../core/quiz.js';
import { readAssetJson } from '../core/staticAssets.js';

function validLayers(layers) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const ratio = value => Number.isFinite(value) && value >= 0 && value <= 1;
  return Array.isArray(layers) && layers.length > 0 && layers.every(layer =>
    layer && text(layer.id) && ratio(layer.sliceRatio) && text(layer.surfaceLandmark) &&
    text(layer.quizQuestion) && Array.isArray(layer.structures) && layer.structures.length > 0 &&
    layer.structures.every(item => item && text(item.name) && ratio(item.x) && ratio(item.y) &&
      text(item.description) && text(item.clinicalNote))) &&
    new Set(layers.map(layer => layer.id)).size === layers.length;
}

export function createLearningTools({ base, getCursor, getPlane, views, onPreset, onRoundStart, onRetry }) {
  const byId = id => document.getElementById(id);
  const markerKeys = new WeakMap();
  const annotationToggle = byId('toggle-annotations');
  const presetShelf = byId('slice-preset-shelf');
  const presetGrid = byId('slice-presets');
  const retry = byId('retry-annotations');
  const presetButtons = new Map();
  const detail = byId('anatomy-detail');
  const quizPanel = byId('quiz-panel');
  const quizTarget = byId('quiz-target');
  const quizHint = byId('quiz-hint');
  const quizTime = byId('quiz-time');
  const quizResult = byId('quiz-result');
  const submitButton = byId('quiz-submit');
  const nextButton = byId('quiz-next');
  let loadFailed = false;
  let layers = [];
  let series;
  let quizMode = false;
  let layout = 'mpr';
  let overviewAnnotations = false;
  let detailAnnotations = true;
  let shownLayer;
  let selectedMarker;
  let round;
  let timer;
  const scores = [];

  function showDetail(item, marker) {
    selectedMarker = marker;
    byId('anatomy-name').textContent = item.name;
    byId('anatomy-description').textContent = item.description;
    byId('anatomy-clinical').textContent = item.clinicalNote;
    detail.showModal();
    byId('anatomy-name').focus({ preventScroll: true });
  }

  function updatePresetReadouts() {
    if (!series) return;
    const depth = series.dimensions[2];
    for (const layer of layers) {
      const button = presetButtons.get(layer.id);
      if (!button) continue;
      const sliceNumber = layerForRatio(layer.sliceRatio, depth) + 1;
      const landmark = layer.landmarkLabel || layer.surfaceLandmark;
      button.querySelector('small').textContent = `${sliceNumber} · ${landmark}`;
    }
  }

  function buildPresets() {
    for (const layer of layers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slice-preset';
      button.setAttribute('aria-pressed', 'false');
      button.title = `${layer.title || layer.structures[0].name} · ${layer.surfaceLandmark}`;
      const name = document.createElement('span');
      name.textContent = layer.title || layer.structures[0].name;
      const readout = document.createElement('small');
      readout.className = 'numeric';
      readout.textContent = layer.landmarkLabel || layer.surfaceLandmark;
      button.append(name, readout);
      button.addEventListener('click', () => {
        if (series && !quizMode) onPreset(layerForRatio(layer.sliceRatio, series.dimensions[2]));
      });
      presetButtons.set(layer.id, button);
      presetGrid.append(button);
    }
    updatePresetReadouts();
  }

  function drawAnnotations() {
    presetShelf.hidden = quizMode || (!layers.length && !loadFailed);
    annotationToggle.disabled = !series || !layers.length || quizMode;
    for (const button of presetButtons.values()) button.disabled = !series;
    const showMarkers = !annotationToggle.disabled && (layout === 'mpr' ? overviewAnnotations : detailAnnotations);
    annotationToggle.setAttribute('aria-pressed', String(showMarkers));
    annotationToggle.dataset.semantic = getPlane();
    if (!series) return;
    const dimensions = series.dimensions;
    const cursor = getCursor();
    let axialLayer;
    if (!quizMode) {
      let smallest = 3;
      for (const item of layers) {
        const distance = Math.abs(layerForRatio(item.sliceRatio, dimensions[2]) - cursor[2]);
        if (distance < smallest) {
          axialLayer = item;
          smallest = distance;
        }
      }
    }
    const layer = getPlane() === 'axial' ? axialLayer : undefined;
    if (layer !== shownLayer) {
      shownLayer = layer;
      for (const [id, button] of presetButtons) button.setAttribute('aria-pressed', String(layer?.id === id));
      const activeButton = layer && presetButtons.get(layer.id);
      if (activeButton && presetGrid.scrollWidth > presetGrid.clientWidth) {
        const left = activeButton.offsetLeft - (presetGrid.clientWidth - activeButton.offsetWidth) / 2;
        presetGrid.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
      }
    }
    for (const view of views) {
      view.overlay.hidden = !showMarkers || (layout !== 'mpr' && view.key !== layout) ||
        (view.modality === 'mri' && !series.mri);
      if (view.overlay.hidden) continue;
      const hits = [];
      for (const entry of view.key === 'axial' ? (axialLayer ? [axialLayer] : []) : layers) {
        for (const [i, item] of entry.structures.entries()) {
          const voxel = [item.x, item.y, entry.sliceRatio].map((ratio, axis) => layerForRatio(ratio, dimensions[axis]));
          if (Math.abs(voxel[view.plane.axis] - cursor[view.plane.axis]) > 2) continue;
          const position = view.key === 'axial' ? [item.x, item.y] : projectVoxel(view.plane, voxel, dimensions);
          hits.push({ key: entry.id + '/' + i, item, position });
        }
      }
      const key = hits.map(hit => hit.key).join('|');
      if (markerKeys.get(view.overlay) === key) continue;
      markerKeys.set(view.overlay, key);
      view.overlay.replaceChildren(...hits.map(({ item, position }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'anatomy-point';
        button.title = item.name;
        button.setAttribute('aria-label', item.name);
        button.style.setProperty('--point-x', position[0] * 100 + '%');
        button.style.setProperty('--point-y', position[1] * 100 + '%');
        button.addEventListener('click', () => showDetail(item, button));
        return button;
      }));
    }
  }

  function finish(timedOut) {
    if (!round || round.finished) return;
    round.finished = true;
    clearInterval(timer);
    const actual = getCursor()[round.axis];
    const score = scoreQuiz(actual, round.target.index, series.spacing[round.axis]);
    scores.push({ ...score, target: round.target.name, targetIndex: round.target.index, actualIndex: actual, timedOut });
    const spacingLabel = series.spacingSource === 'metadata' ? '按资产间距' : '按示意间距';
    const physical = score.errorMm === null ? '' : `（约 ${score.errorMm} mm，${spacingLabel}）`;
    const layerNote = round.axis === 2 && round.target.layerTitle ? ` · ${round.target.layerTitle}` : '';
    quizResult.textContent = `${timedOut ? '时间到。' : ''}${score.grade} · ${score.points} 分 · 误差 ${score.errorSlices} 层${physical} · 目标第 ${round.target.index + 1} 层${layerNote}`;
    quizResult.dataset.semantic = score.grade === '精准命中' ? 'coronal' : 'sagittal';
    quizResult.hidden = false;
    submitButton.disabled = true;
    nextButton.disabled = false;
  }

  function checkDeadline() {
    if (!round || round.finished) return;
    const remaining = Math.max(0, round.deadline - performance.now());
    quizTime.value = Math.ceil(remaining / 1000) + ' 秒';
    if (remaining === 0) finish(true);
  }

  function submit() {
    checkDeadline();
    finish(false);
  }

  function startRound() {
    if (!quizMode || !series || series.preview || !layers.length || (round && !round.finished)) return;
    const plane = PLANES[getPlane()];
    const target = pickQuizTarget(layers, series.dimensions[plane.axis], round?.target.name ?? scores.at(-1)?.target,
      Math.random, plane.axis);
    if (!target) return;
    onRoundStart();
    round = { target, axis: plane.axis, deadline: performance.now() + QUIZ_DURATION_MS, finished: false };
    quizTarget.textContent = '定位 · ' + target.name;
    quizHint.textContent = plane.label + ' · ' + target.hint;
    quizResult.hidden = true;
    submitButton.disabled = false;
    nextButton.disabled = true;
    checkDeadline();
    timer = setInterval(checkDeadline, 100);
  }

  function setMode(mode) {
    const nextMode = mode === 'quiz';
    if (quizMode === nextMode) return;
    quizMode = nextMode;
    quizPanel.hidden = !quizMode;
    drawAnnotations();
    if (quizMode) {
      quizTarget.textContent = loadFailed ? '暂时无法读取题库' : '加载题库与切片后开始';
      quizTime.value = '15 秒';
      startRound();
    } else {
      clearInterval(timer);
      round = null;
      quizHint.textContent = '';
      quizResult.hidden = true;
      submitButton.disabled = true;
      nextButton.disabled = true;
    }
  }

  byId('close-anatomy').addEventListener('click', () => detail.close());
  annotationToggle.addEventListener('click', () => {
    if (layout === 'mpr') overviewAnnotations = !overviewAnnotations;
    else detailAnnotations = !detailAnnotations;
    drawAnnotations();
  });
  detail.addEventListener('close', () => {
    if (selectedMarker?.isConnected) selectedMarker.focus({ preventScroll: true });
    selectedMarker = null;
  });
  submitButton.addEventListener('click', submit);
  nextButton.addEventListener('click', startRound);
  async function loadAnnotations(options) {
    if (layers.length) return;
    retry.disabled = true;
    try {
      const data = await readAssetJson(base + 'data/annotations.json', { ...options, priority: 'high' });
      if (!validLayers(data)) throw new Error('解剖标注格式有误');
      layers = data;
      loadFailed = false;
      buildPresets();
    } catch {
      loadFailed = true;
      if (quizMode) quizTarget.textContent = '暂时无法读取题库';
    }
    retry.hidden = !loadFailed;
    retry.disabled = false;
    drawAnnotations();
    startRound();
  }
  retry.addEventListener('click', onRetry);
  presetGrid.addEventListener('wheel', event => {
    if (!event.deltaY || presetGrid.scrollWidth <= presetGrid.clientWidth) return;
    event.preventDefault();
    presetGrid.scrollLeft += event.deltaY;
  }, { passive: false });

  return {
    drawAnnotations, setMode, checkDeadline, loadAnnotations,
    setLayout(value) {
      if (layout === value) return;
      layout = value;
      if (layout !== 'mpr') detailAnnotations = true;
      drawAnnotations();
    },
    confirmGesture() { if (quizMode) submit(); },
    setSeries(value, { preserveRound = false } = {}) {
      if (round && !preserveRound) {
        clearInterval(timer);
        round = null;
      }
      series = value;
      updatePresetReadouts();
      drawAnnotations();
      startRound();
    },
  };
}
