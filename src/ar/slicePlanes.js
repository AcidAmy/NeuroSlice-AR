import {
  BufferGeometry, EdgesGeometry, Euler, Float32BufferAttribute, Group, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, DoubleSide, Vector4,
} from 'three';
import { AXIS_PLANES, PLANES, headFrame } from '../core/mpr.js';
import { createSliceTexture } from './sliceTextures.js';

const baseQuaternions = Object.fromEntries(Object.entries({
  axial: [Math.PI / 2, 0, 0],
  coronal: [0, 0, 0],
  sagittal: [0, Math.PI / 2, 0],
}).map(([key, angles]) => [key, new Quaternion().setFromEuler(new Euler(...angles))]));

function crossGeometry(vertical) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(
    vertical ? [0, -1, 0, 0, 1, 0] : [-1, 0, 0, 1, 0, 0], 3,
  ));
  return geometry;
}

export function attachSlicePlanes(head, aperture = { value: new Vector4() }) {
  const geometry = new PlaneGeometry(2, 2);
  const outlineGeometry = new EdgesGeometry(geometry);
  const obliqueQuat = new Quaternion();
  const planes = Object.entries(PLANES).map(([key, plane]) => {
    const group = new Group();
    group.name = key + '-plane';
    group.quaternion.copy(baseQuaternions[key]);
    const fill = new MeshBasicMaterial({
      color: plane.color, transparent: true, opacity: 0.085, depthTest: false,
      depthWrite: false, side: DoubleSide, forceSinglePass: true,
    });
    const surface = new Mesh(geometry, fill);
    surface.renderOrder = 10;
    const texture = createSliceTexture(plane, aperture);
    const edge = new LineSegments(outlineGeometry, new LineBasicMaterial({
      color: plane.color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    }));
    edge.renderOrder = 11;
    const lines = plane.axes.map((axis, i) => {
      const line = new LineSegments(crossGeometry(i === 0), new LineBasicMaterial({
        color: PLANES[AXIS_PLANES[axis]].color, transparent: true, opacity: 0.85,
        depthTest: false, depthWrite: false,
      }));
      line.renderOrder = 12;
      return line;
    });
    group.add(surface, edge, ...lines);
    head.add(group);
    return { key, plane, group, fill, surface, texture, edge, lines };
  });

  let previousSeries;
  return ({ cursor, dimensions, spacing, activePlane, allPlanes, showPlanes, oblique }, series, tone) => {
    const changed = previousSeries?.deref() !== series;
    if (changed) previousSeries = series ? new WeakRef(series) : undefined;
    const obliqueFrames = oblique?.frames ?? null;
    const { point: [x, y, z], halfX, halfZ } = obliqueFrames
      ? { point: [0, 0, 0], halfX: 1, halfZ: 1 }
      : headFrame(cursor, dimensions, spacing);
    for (const { key, plane, group, fill, surface, texture, edge, lines } of planes) {
      const active = key === activePlane;
      group.visible = showPlanes && (active || allPlanes);
      if (changed && (!group.visible || !tone)) texture.clear();
      if (!group.visible) continue;
      const frame = obliqueFrames?.[key] ?? null;
      if (tone) {
        texture.update(
          series,
          cursor[plane.axis],
          tone,
          frame ? { frame, draft: oblique.draft, draftScale: oblique.draftScale, key: oblique.key } : null,
        );
      }
      surface.material = tone ? texture.material : fill;
      // 写入切面深度后，再混合颅骨和大脑表面，最后绘制语义线。
      surface.renderOrder = tone ? 0 : 10;
      fill.opacity = active ? 0.12 : 0.064;
      edge.material.opacity = active ? 0.88 : 0.50;
      if (frame) {
        const [qx, qy, qz, qw] = frame.quat;
        obliqueQuat.set(qx, qy, qz, qw);
        group.quaternion.copy(obliqueQuat).multiply(baseQuaternions[key]);
        group.position.set(frame.center[0], frame.center[1], frame.center[2]);
        group.scale.set(frame.halfU, frame.halfV, 1);
        lines[0].position.x = 2 * frame.cross[0] - 1;
        lines[1].position.y = 1 - 2 * frame.cross[1];
      } else {
        group.quaternion.copy(baseQuaternions[key]);
        if (key === 'axial') {
          group.position.set(0, y, 0);
          group.scale.set(halfX, halfZ, 1);
          lines[0].position.x = x / halfX;
          lines[1].position.y = z / halfZ;
        } else if (key === 'coronal') {
          group.position.set(0, 0, z);
          group.scale.set(halfX, 1, 1);
          lines[0].position.x = x / halfX;
          lines[1].position.y = y;
        } else {
          group.position.set(x, 0, 0);
          group.scale.set(halfZ, 1, 1);
          lines[0].position.x = -z / halfZ;
          lines[1].position.y = y;
        }
      }
    }
  };
}
