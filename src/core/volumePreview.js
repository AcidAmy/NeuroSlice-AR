export function previewDimensions(dimensions) {
  return dimensions.map(size => Math.min(size, 56));
}
