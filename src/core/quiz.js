export const QUIZ_DURATION_MS = 15_000;
export const layerForRatio = (ratio, depth) => Math.round(ratio * (depth - 1));

export function pickQuizTarget(layers, depth, previousName, random = Math.random, axis = 2) {
  const all = layers.flatMap(layer => layer.structures.map(structure => ({
    name: structure.name,
    layerTitle: layer.title || '',
    index: layerForRatio([structure.x, structure.y, layer.sliceRatio][axis], depth),
    hint: axis === 2 ? layer.quizQuestion : axis === 1
      ? '沿前后轴寻找结构所在的冠状面。' : '沿左右轴寻找结构所在的矢状面。',
  })));
  const alternatives = all.filter(item => item.name !== previousName);
  const pool = alternatives.length ? alternatives : all;
  return pool[Math.floor(random() * pool.length)] ?? null;
}

export function scoreQuiz(actual, target, spacingMm) {
  const errorSlices = Math.abs(Math.round(actual) - Math.round(target));
  const errorMm = Number.isFinite(spacingMm) && spacingMm > 0 ? Number((errorSlices * spacingMm).toFixed(1)) : null;
  const grade = errorSlices <= 2 ? '精准命中' : errorSlices <= 5 ? '良好' : '需复习';
  return { errorSlices, errorMm, grade, points: Math.max(0, 100 - 5 * errorSlices) };
}
