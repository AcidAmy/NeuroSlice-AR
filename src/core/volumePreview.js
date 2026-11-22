export const MAX_PREVIEW_DIMENSION = 56;

export function previewDimensions(dimensions) {
  return dimensions.map(size => Math.min(size, MAX_PREVIEW_DIMENSION));
}
