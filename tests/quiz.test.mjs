import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { layerForRatio, pickQuizTarget, QUIZ_DURATION_MS, scoreQuiz } from '../src/core/quiz.js';

const layers = JSON.parse(readFileSync(new URL('../public/data/annotations.json', import.meta.url)));

test('quiz uses the five shipped levels at both 120 and 160 slices', () => {
  assert.equal(layers.length, 5);
  assert.equal(QUIZ_DURATION_MS, 15_000);
  assert.equal(layerForRatio(0.65, 120), 77);
  assert.equal(layerForRatio(0.65, 160), 103);
  const target = pickQuizTarget(layers, 160, undefined, () => 0);
  assert.equal(target.name, '半卵圆中心');
  assert.equal(target.index, 121);
  assert.ok(target.hint);
  assert.notEqual(pickQuizTarget(layers, 160, target.name, () => 0).name, target.name);
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
