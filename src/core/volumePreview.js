export const MAX_PREVIEW_DIMENSION = 64;

export function previewDimensions(dimensions) {
  return dimensions.map(size => Math.min(size, MAX_PREVIEW_DIMENSION));
}
