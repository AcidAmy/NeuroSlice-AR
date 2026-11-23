import {
  DirectionalLight, Group, HemisphereLight, Matrix4, OrthographicCamera, Raycaster, Scene,
  Vector2, Vector3, Vector4, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { generatePhantomBrain, generatePhantomSkull } from '../core/phantomDataGenerator.js';
import { cameraCrop, createHeadPose, createPreviewOrbit, fitLiveHead } from './headPose.js';
import { createXRayFresnelShader } from './xrayFresnelShader.js';
import { attachSlicePlanes } from './slicePlanes.js';
import { createModelLabels } from './labels3d.js';
import { createModelMaterials } from './modelMaterials.js';
import { readCompressedOrRaw } from '../core/staticAssets.js';
import { createSliceTone } from '../core/sliceTone.js';

export function setLayerVisibility(skullGroup, brainGroup, layer) {
  skullGroup.visible = layer === 'skull' || layer === 'combined';
  brainGroup.visible = layer === 'brain' || layer === 'combined';
}

async function loadGeometry(directory, { name, material, makePhantom }, options) {
  try {
    const object = await readCompressedOrRaw(new URL(name, directory).href, {
      ...options, preferGzip: import.meta.env?.PROD, idle: 30000,
      async parse(bytes) {
        if (bytes.byteLength < 12 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) {
          throw new Error('GLB 文件头无效');
        }
        const { scene } = await new GLTFLoader().parseAsync(bytes, directory.href);
        let hasSurface = false;
        scene.traverse(object => {
          if (object.isMesh && object.geometry.getAttribute('position')?.count >= 3) {
            if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();
            object.material = material;
            hasSurface = true;
          }
        });
        if (!hasSurface) throw new Error('GLB 未包含可用表面');
        return scene;
      },
    });
    return { object, source: 'local' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { object: makePhantom(), source: 'fallback' };
  }
}

export function pickAnatomy(raycaster, meshes, { half, inverseHead }) {
  const local = new Vector3();
  return raycaster.intersectObjects(meshes.filter(mesh => mesh.visible), false)
    .find(hit => {
      for (let object = hit.object.parent; object; object = object.parent) {
        if (!object.visible) return false;
      }
      return !half || local.copy(hit.point).applyMatrix4(inverseHead).x <= 0;
    })?.object;
}

export function createProjection({
  canvas, ring, labels, labelCard, base, available, onSelection = () => {}, resolveTone = createSliceTone(),
}) {
  const contextOptions = { alpha: true, antialias: true };
  const context = canvas.getContext('webgl2', contextOptions) || canvas.getContext('webgl', contextOptions);
  if (!context) throw new Error('WebGL 不可用');
  const renderer = new WebGLRenderer({ canvas, context, ...contextOptions });
  const scene = new Scene();
  const head = new Group();
  const anatomy = new Group();
  head.add(anatomy);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 30);
  camera.position.z = 8;
  scene.add(head);
  scene.add(new HemisphereLight('#E9F1FF', '#B6A497', 0.9));
  for (const [color, intensity, position] of [
    ['#EFF6FF', 1.8, [-3, 5, 4]],
    ['#FFF4E6', 0.65, [4, 0, 3]],
    ['#D9E9FF', 1.55, [1, 3, -4]],
  ]) {
    const light = new DirectionalLight(color, intensity);
    light.position.set(...position);
    scene.add(light);
  }
  const boneShader = createXRayFresnelShader({
    tint: '#AFE1FA', rimTint: '#F0F9FF', rimAccent: '#38BDF8', shadowTint: '#0F172A',
    density: 1, edgePower: 4.3, body: 0.56,
  });
  const brainShader = createXRayFresnelShader({
    tint: '#E2A09B', rimTint: '#F6D2CC', shadowTint: '#7C3F44', density: 0.98, edgePower: 2.7, body: 0.66,
  });
  const fluidShader = createXRayFresnelShader({
    tint: '#D9B3AE', rimTint: '#F6D2CC', shadowTint: '#7C3F44', density: 0.68, edgePower: 2.7, body: 0.26,
  });
  const skullGroup = new Group();
  const brainGroup = new Group();
  anatomy.add(brainGroup, skullGroup);
  const directory = new URL(base + 'assets/', document.baseURI);
  const models = [
    { name: 'skull.glb', group: skullGroup, material: boneShader, makePhantom: () => generatePhantomSkull(boneShader) },
    { name: 'brain.glb', group: brainGroup, material: brainShader, makePhantom: () => generatePhantomBrain(brainShader, fluidShader) },
  ];

  const headPose = createHeadPose();
  const orbit = createPreviewOrbit();
  const inverseHead = new Matrix4();
  const viewAxisHead = new Vector3();
  const aperture = new Vector4();
  const apertureUniform = { value: aperture };
  const clipHalf = { value: false };
  const materials = createModelMaterials(skullGroup, brainGroup, {
    headSpace: { value: inverseHead }, aperture: apertureUniform, clipHalf,
  });
  let modelLabels;
  const updatePlanes = attachSlicePlanes(anatomy, apertureUniform);
  const calibrationDepth = new Vector3();
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let pickState;
  let width = 0;
  let height = 0;
  let ratio = 0;
  let pointer = null;
  let frame = null;
  let pose = null;
  let fittedFrame = null;
  let map;
  let frameWidth;
  let frameHeight;

  async function loadModels(metadata, { onProgress, ...options }) {
    const pending = models.filter(model => !model.source || model.source === 'fallback');
    const transfers = new Map(pending.map(model => [model.name, { received: 0, total: 0 }]));
    const results = await Promise.all(pending.map(async model => {
      if (!available.includes(model.name) ||
          (Array.isArray(metadata?.meshFiles) && !metadata.meshFiles.includes(model.name))) {
        transfers.delete(model.name);
        return { object: model.makePhantom(), source: 'phantom' };
      }
      return loadGeometry(directory, model, {
        ...options,
        progress(received, total) {
          transfers.set(model.name, { received, total });
          const downloads = [...transfers.values()];
          onProgress(downloads.reduce((sum, item) => sum + item.received, 0),
            downloads.every(item => item.total) ? downloads.reduce((sum, item) => sum + item.total, 0) : 0);
        },
      });
    }));
    if (options.signal?.aborted) throw options.signal.reason;

    let changed = false;
    for (const [index, model] of pending.entries()) {
      const { object, source } = results[index];
      if (model.source === 'fallback' && source === 'fallback') {
        object.traverse(part => { if (part.isMesh) part.geometry.dispose(); });
        continue;
      }
      const isBone = model.group === skullGroup;
      model.group.traverse(part => { if (part.isMesh) part.geometry.dispose(); });
      model.group.clear().add(object);
      object.traverse(part => { if (part.isMesh) part.renderOrder = isBone ? 2 : 1; });
      materials.setGroup(model.group, isBone);
      model.source = source;
      changed = true;
    }
    if (changed) {
      modelLabels?.dispose();
      modelLabels = createModelLabels(labels, labelCard, anatomy);
      modelLabels.setOnChange(onSelection);
    }
  }

  function resize(nextRatio) {
    const nextWidth = canvas.clientWidth;
    const nextHeight = canvas.clientHeight;
    if (!nextWidth || !nextHeight || (width === nextWidth && height === nextHeight && ratio === nextRatio)) return;
    const changedViewport = width !== nextWidth || height !== nextHeight;
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.left = -width / height;
    camera.right = width / height;
    camera.updateProjectionMatrix();
    if (changedViewport) {
      fittedFrame = null;
      map = null;
      headPose.reset();
    }
  }

  function draw(options) {
    const { live, opacity, half, lens, layer, xOffset, yOffset, zOffset, scale, scaleX, scaleY } = options;
    resize(live ? Math.min(1.25, options.ratio) : options.ratio);
    if (!width || !height) return;
    if (frame && (!map || frameWidth !== frame.width || frameHeight !== frame.height)) {
      frameWidth = frame.width;
      frameHeight = frame.height;
      map = cameraCrop(width, height, frameWidth, frameHeight);
    }
    if (live && frame && fittedFrame !== frame) {
      fittedFrame = frame;
      pose = headPose.update(frame, map, width, height);
    }
    head.visible = !live || Boolean(pose);
    // 头姿以镜像坐标表达，模型自身的解剖左右也进入同一坐标基。
    anatomy.scale.x = live ? -1 : 1;
    setLayerVisibility(skullGroup, brainGroup, layer);

    if (live && pose) {
      fitLiveHead(head, pose, options);
    } else {
      const previewSize = Math.min(0.8, width / height * 0.91) * scale;
      head.position.set(0, -0.04, 0);
      orbit.apply(head.rotation);
      head.scale.set(previewSize * scaleX, previewSize * scaleY, previewSize);
    }
    head.position.x += xOffset * width / height * 2;
    head.position.y += yOffset * 2;
    head.position.add(calibrationDepth.set(0, 0, -zOffset * head.scale.z).applyQuaternion(head.quaternion));
    head.updateMatrixWorld();
    inverseHead.copy(anatomy.matrixWorld).invert();
    viewAxisHead.set(0, 0, 1).transformDirection(inverseHead);

    const fingertip = live && frame?.handLandmarks[0]?.[8];
    const tip = fingertip && map(fingertip);
    const cursor = tip
      ? { x: width - tip.x, y: tip.y }
      : pointer ?? { x: width / 2, y: height / 2 };
    const radius = Math.min(width, height) * 0.245;
    clipHalf.value = half;
    aperture.set(cursor.x * ratio, (height - cursor.y) * ratio, radius * ratio, Number(lens));
    pickState = { half, lens, cursor, radius, opacity, inverseHead };

    ring.hidden = !lens;
    if (lens) {
      ring.style.setProperty('--lens-x', cursor.x + 'px');
      ring.style.setProperty('--lens-y', cursor.y + 'px');
      ring.style.setProperty('--lens-diameter', radius * 2 + 'px');
    }
    const { sliceSeries, sliceModality, sliceTone, showSliceTexture, showPlanes } = options;
    const tone = head.visible && showPlanes && showSliceTexture && sliceSeries
      ? resolveTone(sliceSeries, sliceModality, sliceTone) : null;
    if (head.visible) updatePlanes(options, sliceSeries, tone);
    modelLabels?.update({
      enabled: options.showLabels, visible: head.visible, layer, world: anatomy.matrixWorld, camera,
      width, height, half, lens, cursor, radius,
    });
    materials.update({
      mode: options.renderMode, opacity, layer, lens, half, textured: Boolean(tone),
      selected: modelLabels?.selectedMeshes, viewAxisHead,
    });
    renderer.render(scene, camera);
  }

  function setFrame(value) {
    frame = value;
    if (!value) {
      pose = null;
      fittedFrame = null;
      headPose.reset();
    }
  }

  return {
    draw,
    loadModels,
    setFrame,
    dragPreview: orbit.drag,
    setPointer(value) { pointer = value; },
    pick(x, y) {
      if (!modelLabels) return;
      if (!pickState || !head.visible || !pickState.opacity || x < 0 || x > width || y < 0 || y > height ||
          (pickState.lens && Math.hypot(x - pickState.cursor.x, y - pickState.cursor.y) > pickState.radius)) {
        modelLabels.close();
        return;
      }
      ndc.set(2 * x / width - 1, 1 - 2 * y / height);
      raycaster.setFromCamera(ndc, camera);
      modelLabels.selectMesh(pickAnatomy(raycaster, materials.parts, pickState));
    },
    clearSelection(...args) { modelLabels?.close(...args); },
    get modelSources() { return models.map(model => model.source); },
  };
}
