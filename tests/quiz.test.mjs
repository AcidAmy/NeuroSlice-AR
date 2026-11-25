import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { layerForRatio, pickQuizTarget, QUIZ_DURATION_MS, scoreQuiz } from '../src/core/quiz.js';

const layers = JSON.parse(readFileSync(new URL('../public/data/annotations.json', import.meta.url)));

test('quiz uses all 13 verified axial levels and 49 unique structures across depths', () => {
  assert.equal(layers.length, 13);
  assert.equal(QUIZ_DURATION_MS, 15_000);
  const ids = layers.map(layer => layer.id);
  assert.equal(new Set(ids).size, 13);

  const webSlices192 = layers.map(layer => layerForRatio(layer.sliceRatio, 192) + 1);
  assert.deepEqual(webSlices192, [156, 146, 125, 119, 116, 102, 100, 94, 83, 79, 66, 56, 32]);

  const allStructures = layers.flatMap(layer => layer.structures);
  assert.equal(allStructures.length, 49);
  assert.equal(new Set(allStructures.map(item => item.name)).size, 49);

  assert.equal(layerForRatio(0.65, 120), 77);
  assert.equal(layerForRatio(0.65, 160), 103);

  const firstTarget = pickQuizTarget(layers, 192, undefined, () => 0);
  assert.equal(firstTarget.name, '中央前回');
  assert.equal(firstTarget.layerTitle, '顶部中央沟区');
  assert.equal(firstTarget.index, 155);
  assert.ok(firstTarget.hint);

  const lastTarget = pickQuizTarget(layers, 192, undefined, () => 0.9999);
  assert.equal(lastTarget.name, '腮腺区');
  assert.equal(lastTarget.layerTitle, '下颌骨与口腔');
  assert.equal(lastTarget.index, 31);

  assert.notEqual(pickQuizTarget(layers, 192, firstTarget.name, () => 0).name, firstTarget.name);
  assert.equal(pickQuizTarget([], 120), null);
});

test('quiz grades absolute slice errors, converts spacing and clamps score', () => {
  assert.deepEqual(scoreQuiz(100, 100, 1.25), { errorSlices: 0, errorMm: 0, grade: '精准命中', points: 100 });
  assert.deepEqual(scoreQuiz(98, 100, 1.25), { errorSlices: 2, errorMm: 2.5, grade: '精准命中', points: 90 });
  assert.deepEqual(scoreQuiz(105, 100, 1.25), { errorSlices: 5, errorMm: 6.3, grade: '良好', points: 75 });
  assert.equal(scoreQuiz(94, 100, 1.25).grade, '需复习');
  assert.equal(scoreQuiz(55, 100, 1.25).points, 0);
  assert.equal(scoreQuiz(94, 100).errorMm, null);
});

test('coronal and sagittal quiz targets are evaluated on the structure coordinate for that axis', () => {
  const first = layers[0].structures[0];
  const coronal = pickQuizTarget(layers, 224, undefined, () => 0, 1);
  const sagittal = pickQuizTarget(layers, 224, undefined, () => 0, 0);
  assert.equal(coronal.index, Math.round(first.y * 223));
  assert.equal(sagittal.index, Math.round(first.x * 223));
  assert.match(coronal.hint, /冠状/);
  assert.match(sagittal.hint, /矢状/);
});
