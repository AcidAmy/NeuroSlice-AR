import {
  CatmullRomCurve3, Group, Mesh,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three';

export const PHANTOM_DIMENSIONS = Object.freeze([128, 128, 120]);

// 坐标统一采用 +X 向观察者右侧、+Y 向头顶、+Z 向前。层号从足侧递增。
export function sliceHeight(index, depth) {
  return 2 * index / (depth - 1) - 1;
}

function ellipsoidDistance(x, y, z, cx, cy, cz, rx, ry, rz) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
}

const skullVault = [0, 0.23, -0.08, 0.71, 0.75, 0.72];
const brainEnvelope = [0, 0.3, -0.1, 0.61, 0.59, 0.61];
const ventricle = [0.145, 0.23, -0.02, 0.09, 0.1, 0.27];
const cerebellum = [0, -0.22, -0.36, 0.43, 0.21, 0.31];

function orbit(x, y, z) {
  return z > 0.23 && ((Math.abs(x) - 0.29) / 0.2) ** 2 + ((y + 0.08) / 0.16) ** 2 < 1;
}

function nasalSpace(x, y, z) {
  return z > 0.24 && (x / 0.105) ** 2 + ((y + 0.3) / 0.23) ** 2 < 1;
}

// 合成强度用于展示组织对比，CT 存有符号 HU，MRI 存 8 位相对信号。
export function generatePhantomVolume() {
  const [width, height, depth] = PHANTOM_DIMENSIONS;
  const ct = new Int16Array(width * height * depth);
  const mri = new Uint8Array(ct.length);
  let offset = 0;
  for (let layer = 0; layer < depth; layer++) {
    const y = sliceHeight(layer, depth);
    const basalLevel = Math.abs(y - 0.12) < 0.105;
    const midbrainLevel = Math.abs(y + 0.10) < 0.055;
    const ponsLevel = Math.abs(y + 0.28) < 0.072;
    for (let row = 0; row < height; row++) {
      const z = 1 - 2 * row / (height - 1);
      for (let column = 0; column < width; column++, offset++) {
        const x = 2 * column / (width - 1) - 1;
        const vault = ellipsoidDistance(x, y, z, ...skullVault);
        const face = ellipsoidDistance(x, y, z, 0, -0.35, 0.16, 0.59, 0.52, 0.58);
        const brain = ellipsoidDistance(x, y, z, ...brainEnvelope);
        const posterior = ellipsoidDistance(x, y, z, ...cerebellum);
        const stem = y < 0.03 && ellipsoidDistance(x, y, z, 0, -0.22, -0.12, 0.155, 0.23, 0.15) < 1;
        const jaw = y < -0.45 ? ellipsoidDistance(x, y, z, 0, -0.58, 0.21, 0.48, 0.29, 0.51) : Infinity;
        if (vault >= 1.15 && face >= 1.05 && brain >= 1 && posterior >= 1 && jaw >= 1 && !stem) {
          ct[offset] = -1000;
          continue;
        }
        const fold = Math.sin(28 * x + 8 * z) * Math.sin(20 * z - 12 * y);
        const grain = ((column * 17 + row * 37 + layer * 53) % 19 - 9) * 0.46;
        let hu = -1000;
        let mr = 0;
        if (vault < 1.15 || face < 1.05) {
          hu = 18;
          mr = 45;
          if ((vault > 1.02 && vault < 1.15) || (face > 0.91 && face < 1.05)) {
            hu = -65;
            mr = 110;
          }
        }
        if ((vault > 0.79 && vault < 1 && !orbit(x, y, z)) ||
            (jaw > 0.73 && jaw < 1)) {
          hu = 920 + 75 * fold;
          mr = 13;
        }
        if (brain < 1 || posterior < 1 || stem) {
          const rim = brain > 0.67 + fold * 0.07 || posterior < 1;
          hu = rim ? 42 + 4 * fold : 30;
          mr = rim ? 122 + 18 * fold : 175 + 9 * fold;
          const fluid = ellipsoidDistance(Math.abs(x), y, z, ...ventricle);
          const cistern = midbrainLevel && (ellipsoidDistance(x, y, z, 0, -0.10, 0.08, 0.13, 0.052, 0.07) < 1 ||
            ellipsoidDistance(Math.abs(x), y, z, 0.14, -0.10, -0.20, 0.05, 0.045, 0.11) < 1);
          const fourthVentricle = ponsLevel && ellipsoidDistance(x, y, z, 0, -0.28, -0.28, 0.075, 0.075, 0.075) < 1;
          if (fluid < 1 || cistern || fourthVentricle || (Math.abs(x) < 0.025 && y > 0.37)) {
            hu = 8;
            mr = 32;
          } else if (basalLevel) {
            const absX = Math.abs(x);
            const deepGray = ellipsoidDistance(absX, y, z, 0.27, 0.12, -0.02, 0.10, 0.09, 0.17) < 1 ||
              ellipsoidDistance(absX, y, z, 0.09, 0.12, -0.18, 0.08, 0.085, 0.10) < 1 ||
              ellipsoidDistance(absX, y, z, 0.145, 0.12, 0.14, 0.066, 0.092, 0.09) < 1;
            if (deepGray) { hu = 47; mr = 116; }
            else if (absX > 0.13 && absX < 0.19 && z < -0.04 && z > -0.19) { hu = 30; mr = 181; }
          } else if (stem) {
            hu = 44 + 3 * fold;
            mr = 138 + 8 * fold;
          }
        } else if (face < 1.05 && nasalSpace(x, y, z)) {
          hu = -920;
          mr = 1;
        } else if (orbit(x, y, z) && face < 1) {
          const globe = ellipsoidDistance(Math.abs(x), y, z, 0.29, -0.09, 0.49, 0.135, 0.13, 0.15);
          hu = globe < 1 ? 20 : -92;
          mr = globe < 1 ? 64 : 150;
        }
        ct[offset] = Math.round(hu + (mr ? grain : 0));
        mri[offset] = Math.round(Math.max(0, mr + (mr ? grain : 0)));
      }
    }
  }
  return { dimensions: PHANTOM_DIMENSIONS, ct, mri, source: 'phantom' };
}

function ellipsoid(center, radii) {
  const geometry = new SphereGeometry(1, 64, 42);
  geometry.scale(...radii);
  geometry.translate(...center);
  return geometry;
}

function vaultGeometry() {
  const geometry = ellipsoid(skullVault.slice(0, 3), skullVault.slice(3));
  const vertices = geometry.getAttribute('position');
  const surface = geometry.index.array;
  const faces = [];
  for (let i = 0; i < surface.length; i += 3) {
    const a = surface[i], b = surface[i + 1], c = surface[i + 2];
    const x = (vertices.getX(a) + vertices.getX(b) + vertices.getX(c)) / 3;
    const y = (vertices.getY(a) + vertices.getY(b) + vertices.getY(c)) / 3;
    const z = (vertices.getZ(a) + vertices.getZ(b) + vertices.getZ(c)) / 3;
    if ((z > 0.1 && y < -0.36) || orbit(x, y, z) || nasalSpace(x, y, z)) continue;
    faces.push(a, b, c);
  }
  geometry.setIndex(faces);
  return geometry;
}

function curveGeometry(points, radius) {
  const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)));
  return new TubeGeometry(curve, 40, radius, 10, false);
}

function brainHemisphere(sign) {
  const geometry = new SphereGeometry(1, 86, 60);
  const vertices = geometry.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    const ripple = 1 + 0.022 * Math.sin(22 * y + 15 * z + 4 * Math.sin(9 * x)) +
      0.013 * Math.cos(29 * z - 16 * x);
    vertices.setXYZ(i, sign * (0.322 + 0.29 * x * ripple), 0.3 + 0.57 * y * ripple, -0.1 + 0.6 * z * ripple);
  }
  // 镜像一侧的顶点时也反转三角形绕序，保持法线朝外。
  if (sign < 0) {
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  }
  geometry.computeVertexNormals();
  return geometry;
}

function addSurface(group, geometry, material) {
  group.add(new Mesh(geometry, material));
}

export function generatePhantomSkull(material) {
  const skull = new Group();
  addSurface(skull, vaultGeometry(), material);
  for (const side of [-1, 1]) {
    const orbitalRim = new TorusGeometry(0.18, 0.042, 12, 36);
    orbitalRim.scale(1.08, 0.85, 1);
    orbitalRim.rotateY(side * 0.32);
    orbitalRim.translate(side * 0.29, -0.08, 0.52);
    addSurface(skull, orbitalRim, material);
    addSurface(skull, curveGeometry([
      [side * 0.58, -0.17, 0.16], [side * 0.5, -0.28, 0.45], [side * 0.27, -0.32, 0.57],
      [side * 0.17, -0.43, 0.62],
    ], 0.056), material);
  }
  addSurface(skull, curveGeometry([
    [-0.51, -0.22, 0.1], [-0.48, -0.56, 0.18], [-0.35, -0.74, 0.41], [0, -0.83, 0.58],
    [0.35, -0.74, 0.41], [0.48, -0.56, 0.18], [0.51, -0.22, 0.1],
  ], 0.069), material);
  addSurface(skull, ellipsoid([0, -0.23, 0.58], [0.052, 0.18, 0.065]), material);
  return skull;
}

export function generatePhantomBrain(brainMaterial, ventricleMaterial) {
  const brain = new Group();
  for (const side of [-1, 1]) {
    addSurface(brain, brainHemisphere(side), brainMaterial);
    addSurface(brain, ellipsoid([side * ventricle[0], ...ventricle.slice(1, 3)], ventricle.slice(3)), ventricleMaterial);
  }
  addSurface(brain, ellipsoid(cerebellum.slice(0, 3), cerebellum.slice(3)), brainMaterial);
  addSurface(brain, ellipsoid([0, -0.36, -0.15], [0.12, 0.25, 0.12]), brainMaterial);
  return brain;
}
