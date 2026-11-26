import {
  ClampToEdgeWrapping, DataTexture, DoubleSide, LinearFilter, RGBAFormat, ShaderMaterial, Vector2,
} from 'three';
import { rescaleVoxel, sampleObliqueSlice, sliceAddress } from '../core/mpr.js';

function smoothAlpha(value, start, end) {
  if (value <= start) return 0;
  if (value >= end) return 255;
  const t = (value - start) / (end - start);
  return Math.max(1, Math.round(255 * t * t * (3 - 2 * t)));
}

function fillSlice(pixels, width, height, plane, index, cursorIndex, series, tone, dimensions) {
  const { offset, u, v } = sliceAddress(plane, index, dimensions);
  const { ct } = series;
  const { volume, lut, bias } = tone;
  const realCt = ct && series.source === 'local';
  const ctDimensions = series.ctDimensions ?? series.dimensions;
  const sameGrid = dimensions.every((size, axis) => size === ctDimensions[axis]);
  let mask;
  if (ct && !sameGrid) {
    const maskIndex = rescaleVoxel(cursorIndex, series.dimensions[plane.axis], ctDimensions[plane.axis]);
    const address = sliceAddress(plane, maskIndex, ctDimensions);
    const [columnAxis, rowAxis] = plane.axes;
    mask = {
      rows: Array.from({ length: height }, (_, row) =>
        address.offset + address.v * rescaleVoxel(row, height, ctDimensions[rowAxis])),
      columns: Array.from({ length: width }, (_, column) =>
        address.u * rescaleVoxel(column, width, ctDimensions[columnAxis])),
    };
  }
  for (let row = 0, pixel = 0; row < height; row++) {
    let sample = offset + row * v;
    for (let column = 0; column < width; column++, sample += u, pixel += 4) {
      // 原始信号确定轮廓，调窗后的低灰度仍可代表不透明组织。
      const hu = ct?.[mask ? mask.rows[row] + mask.columns[column] : sample];
      const alpha = realCt ? smoothAlpha(hu, -450, -350)
        : ct ? smoothAlpha(hu, -900, -750) : smoothAlpha(volume[sample], 2, 14);
      const gray = lut[volume[sample] + bias];
      // 线性过滤预乘灰度，软化一像素轮廓，避免透明空气在边缘引入黑晕。
      pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = Math.round(gray * alpha / 255);
      pixels[pixel + 3] = alpha;
    }
  }
}

export function createSliceTexture(plane, aperture) {
  const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  const material = new ShaderMaterial({
    side: DoubleSide, depthTest: true, depthWrite: true,
    transparent: true, premultipliedAlpha: true, forceSinglePass: true,
    uniforms: {
      sliceImage: { value: texture },
      uvScale: { value: new Vector2() }, uvOffset: { value: new Vector2(0.5, 0.5) }, aperture,
    },
    vertexShader: `
      uniform vec2 uvScale;
      uniform vec2 uvOffset;
      varying vec2 sampleUv;
      void main() {
        // DataTexture 第 0 行是 MPR 顶行，平面几何的顶部却是 v=1。
        // 平面四角对应端点体素的中心，与头模导出时的坐标定义一致。
        sampleUv = uv * uvScale + uvOffset;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D sliceImage;
      uniform vec4 aperture;
      varying vec2 sampleUv;
      void main() {
        vec4 voxel = texture2D(sliceImage, sampleUv);
        if (aperture.w > 0.5) {
          float radius = length(gl_FragCoord.xy - aperture.xy);
          voxel *= 1.0 - smoothstep(aperture.z * 0.91, aperture.z, radius);
        }
        if (voxel.a < 0.05) discard;
        // LUT 已输出与右侧 Canvas 一致的显示灰度。
        gl_FragColor = voxel;
      }
    `,
  });
  let lastSeries, lastIndex, lastTone, lastObliqueKey, lastDraft;

  function ensureSize(width, height) {
    if (texture.image.width !== width || texture.image.height !== height) {
      texture.dispose();
      texture.image = { data: new Uint8Array(width * height * 4), width, height };
      material.uniforms.uvScale.value.set(1 - 1 / width, 1 / height - 1);
      material.uniforms.uvOffset.value.set(0.5 / width, 1 - 0.5 / height);
    }
  }

  return {
    material,
    clear() {
      if (!lastSeries) return;
      texture.dispose();
      texture.image = { data: new Uint8Array(4), width: 0, height: 0 };
      lastSeries = lastTone = lastObliqueKey = lastDraft = undefined;
    },
    update(series, cursorIndex, tone, oblique = null) {
      const dimensions = tone.dimensions ?? series.dimensions;
      if (oblique?.frame) {
        const draft = Boolean(oblique.draft);
        if (lastSeries?.deref() === series && lastTone?.deref() === tone &&
            lastObliqueKey === oblique.key && lastDraft === draft) return;
        const [fullW, fullH] = plane.axes.map(axis => dimensions[axis]);
        const scale = draft ? (oblique.draftScale ?? 0.5) : 1;
        const width = draft ? Math.max(48, Math.min(fullW, Math.round(fullW * scale))) : fullW;
        const height = draft ? Math.max(48, Math.min(fullH, Math.round(fullH * scale))) : fullH;
        ensureSize(width, height);
        const ct = series.ct;
        sampleObliqueSlice(
          texture.image.data, width, height, oblique.frame, dimensions, tone.volume, tone.lut, tone.bias,
          {
            trilinear: !draft,
            alphaMask: {
              ct,
              ctDims: series.ctDimensions ?? series.dimensions,
              realCt: Boolean(ct && series.source === 'local'),
            },
          },
        );
        texture.needsUpdate = true;
        lastSeries = new WeakRef(series);
        lastIndex = undefined;
        lastTone = new WeakRef(tone);
        lastObliqueKey = oblique.key;
        lastDraft = draft;
        return;
      }

      const index = rescaleVoxel(cursorIndex, series.dimensions[plane.axis], dimensions[plane.axis]);
      if (lastObliqueKey === undefined && lastSeries?.deref() === series &&
          lastIndex === cursorIndex && lastTone?.deref() === tone) return;
      const [width, height] = plane.axes.map(axis => dimensions[axis]);
      ensureSize(width, height);
      fillSlice(texture.image.data, width, height, plane, index, cursorIndex, series, tone, dimensions);
      texture.needsUpdate = true;
      lastSeries = new WeakRef(series);
      lastIndex = cursorIndex;
      lastTone = new WeakRef(tone);
      lastObliqueKey = undefined;
      lastDraft = undefined;
    },
  };
}
