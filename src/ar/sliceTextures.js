import {
  ClampToEdgeWrapping, DataTexture, DoubleSide, LinearFilter, RGBAFormat, ShaderMaterial, Vector2,
} from 'three';
import { sliceAddress } from '../core/mpr.js';

function smoothAlpha(value, start, end) {
  if (value <= start) return 0;
  if (value >= end) return 255;
  const t = (value - start) / (end - start);
  return Math.max(1, Math.round(255 * t * t * (3 - 2 * t)));
}

function fillSlice(pixels, width, height, address, series, { volume, lut, bias }) {
  const { offset, u, v } = address;
  const { ct } = series;
  const realCt = ct && series.source === 'local';
  for (let row = 0, pixel = 0; row < height; row++) {
    let sample = offset + row * v;
    for (let column = 0; column < width; column++, sample += u, pixel += 4) {
      // 原始信号确定轮廓，调窗后的低灰度仍可代表不透明组织。
      const alpha = realCt ? smoothAlpha(ct[sample], -450, -350)
        : ct ? smoothAlpha(ct[sample], -900, -750) : smoothAlpha(volume[sample], 2, 14);
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
  let lastSeries, lastIndex, lastTone;
  return {
    material,
    update(series, index, tone) {
      if (lastSeries === series && lastIndex === index && lastTone === tone) return;
      const [width, height] = plane.axes.map(axis => series.dimensions[axis]);
      if (texture.image.width !== width || texture.image.height !== height) {
        texture.dispose();
        texture.image = { data: new Uint8Array(width * height * 4), width, height };
        material.uniforms.uvScale.value.set(1 - 1 / width, 1 / height - 1);
        material.uniforms.uvOffset.value.set(0.5 / width, 1 - 0.5 / height);
      }
      fillSlice(texture.image.data, width, height, sliceAddress(plane, index, series.dimensions), series, tone);
      texture.needsUpdate = true;
      lastSeries = series;
      lastIndex = index;
      lastTone = tone;
    },
  };
}
