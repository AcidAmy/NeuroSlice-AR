import { MathUtils, Matrix3, Matrix4, Triangle, Vector3 } from 'three';

// 锚点沿用模型局部坐标，X 向左、Y 向上、Z 向前。
const landmarks = [
  ['skull', '额骨', 'Frontal bone', [-0.181, 0.558, 0.577], [-0.25, 0.55, 0.80],
    '前额，眉弓上方', '形成前额和眼眶顶部，也构成前颅窝的一部分。'],
  ['skull', '眼眶', 'Orbit', [0.377, 0.127, 0.647], [0.36, 0.05, 0.93],
    '眼球周围的骨性凹陷', '由多块颅面骨围成，容纳眼球、眼外肌和相关神经血管。'],
  ['skull', '鼻骨', 'Nasal bone', [0.024, -0.046, 0.806], [0.02, 0.06, 1],
    '两眼之间向下的鼻梁上段', '左右鼻骨相接，构成鼻背上部的骨性支架。'],
  ['skull', '颧骨', 'Zygomatic bone', [-0.483, -0.163, 0.488], [-0.72, -0.08, 0.69],
    '眼外侧下方的上脸颊', '形成颊部隆起和眼眶外侧的一部分，并参与构成颧弓。'],
  ['skull', '上颌骨', 'Maxilla', [0.138, -0.378, 0.536], [0.38, -0.12, 0.92],
    '鼻翼两侧至上排牙齿上方', '承托上牙列，参与构成硬腭、鼻腔和眼眶底。'],
  ['skull', '下颌骨', 'Mandible', [-0.152, -0.728, 0.627], [-0.35, -0.25, 0.90],
    '下巴与下颌缘', '承托下牙列，并通过颞下颌关节参与张口和咀嚼。'],
  ['skull', '顶骨', 'Parietal bone', [0.387, 0.692, -0.290], [0.59, 0.80, -0.12],
    '头顶两侧，位于额骨后方', '左右顶骨沿矢状缝相接，构成颅盖的大部分。'],
  ['brain', '额叶', 'Frontal lobe', [-0.253, 0.249, 0.504], [-0.34, 0.30, 0.89],
    '前额深面，中央沟前方', '参与计划、控制行为和随意运动。初级运动皮层位于中央沟前。'],
  ['brain', '顶叶', 'Parietal lobe', [0.275, 0.610, -0.328], [0.48, 0.85, -0.12],
    '头顶偏后深面，中央沟后方', '参与体感信息整合和空间定位。初级体感皮层位于中央沟后。'],
  ['brain', '颞叶', 'Temporal lobe', [0.426, -0.103, 0.022], [0.82, -0.12, 0.55],
    '耳上方与太阳穴深面', '与听觉处理和记忆有关，上颞区也参与语言理解。'],
];

const atlasParts = {
  '额骨': ['frontal_bone'],
  '眼眶': ['frontal_bone', 'zygomatic_bone_l', 'zygomatic_bone_r', 'maxilla_l', 'maxilla_r', 'sphenoid_bone'],
  '鼻骨': ['nasal_bone_l', 'nasal_bone_r'],
  '颧骨': ['zygomatic_bone_l', 'zygomatic_bone_r'],
  '上颌骨': ['maxilla_l', 'maxilla_r'],
  '下颌骨': ['mandible'],
  '顶骨': ['parietal_bone_l', 'parietal_bone_r'],
  '颞骨': ['temporal_bone_l', 'temporal_bone_r'],
  '枕骨': ['occipital_bone'],
  '蝶骨': ['sphenoid_bone'],
  '大脑半球': ['cerebrum_l', 'cerebrum_r'],
  '额叶': ['frontal_lobe_l', 'frontal_lobe_r'],
  '顶叶': ['parietal_lobe_l', 'parietal_lobe_r'],
  '颞叶': ['temporal_lobe_l', 'temporal_lobe_r'],
  '小脑': ['cerebellum'],
  '脑干': ['brainstem'],
};
const atlasLandmarks = [
  ['skull', '颞骨', 'Temporal bone', [-0.51, 0.02, -0.14], [-1, 0, -0.07],
    '颅骨两侧，耳周及颅底', '包围中耳和内耳，参与构成颧弓与颞下颌关节。'],
  ['skull', '枕骨', 'Occipital bone', [0, 0.02, -0.76], [0, 0.12, -1],
    '后脑勺至颅底后部', '枕骨大孔连接颅腔与椎管，两侧枕髁与寰椎形成关节。'],
  ['skull', '蝶骨', 'Sphenoid bone', [-0.33, 0.09, 0.27], [-0.74, 0.22, 0.65],
    '颅底中央和眼眶后部', '蝶骨体上的蝶鞍容纳垂体，大翼参与构成颅底和眼眶外侧壁。'],
  ['brain', '大脑半球', 'Cerebral hemisphere', [-0.31, 0.38, 0.35], [-0.55, 0.4, 0.73],
    '纵裂两侧的大脑皮层与深部结构', '左右半球由纵裂分隔，并通过胼胝体等连合纤维互相联系。'],
  ['brain', '小脑', 'Cerebellum', [-0.27, -0.32, -0.44], [-0.34, -0.25, -0.9],
    '大脑后下方，脑干后侧', '参与协调动作、维持平衡和调节肌张力。'],
  ['brain', '脑干', 'Brainstem', [0, -0.43, -0.09], [0, -0.48, 0.88],
    '间脑下方，连接大脑与脊髓', '由中脑、脑桥和延髓组成，包含调节呼吸和循环的神经中枢。'],
];

export function surfaceAnchor(mesh, rootInverse, direction, hint) {
  const { geometry } = mesh;
  geometry.computeBoundingBox();
  const toAnatomy = new Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
  const bounds = geometry.boundingBox.clone().applyMatrix4(toAnatomy);
  const extent = bounds.getSize(new Vector3()).multiplyScalar(0.5);
  const target = hint ?? bounds.getCenter(new Vector3())
    .add(extent.multiply(direction.clone().normalize()).multiplyScalar(1.7));
  const triangle = new Triangle();
  const candidate = new Vector3();
  const point = new Vector3();
  const corners = [triangle.a, triangle.b, triangle.c];
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  let best = Infinity;
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = i + corner;
      corners[corner].fromBufferAttribute(position, index ? index.getX(vertex) : vertex).applyMatrix4(toAnatomy);
    }
    triangle.closestPointToPoint(target, candidate);
    const distance = candidate.distanceToSquared(target);
    if (distance < best) {
      best = distance;
      point.copy(candidate);
    }
  }
  return { point, outward: direction.clone().normalize() };
}

export function createModelLabels(overlay, card, anatomy) {
  const title = card.querySelector('h3');
  const english = card.querySelector('[lang="en"]');
  const location = card.querySelector('.model-label-location');
  const notes = card.querySelector('.model-label-notes');
  const closeButton = card.querySelector('button');
  const normalMatrix = new Matrix3();
  const normal = new Vector3();
  const view = new Vector3();
  const projected = new Vector3();
  const center = new Vector3();
  anatomy.updateMatrixWorld(true);
  const rootInverse = anatomy.matrixWorld.clone().invert();
  const meshes = new Map();
  anatomy.traverse(mesh => { if (mesh.isMesh) meshes.set(mesh.name, mesh); });
  const partsToRecord = new Map();
  const records = [];
  for (const [group, name, translation, anchor, outward, surface, detail] of [...landmarks, ...atlasLandmarks]) {
    const models = atlasParts[name].map(part => meshes.get(part)).filter(Boolean);
    if (!models.length && atlasLandmarks.some(item => item[1] === name)) continue;
    const parts = [];
    for (const model of models) model.traverse(mesh => { if (mesh.isMesh) parts.push(mesh); });
    const node = document.createElement('div');
    node.className = 'model-label';
    node.dataset.group = group;
    node.hidden = true;
    const leader = document.createElement('span');
    leader.className = 'model-label-leader';
    leader.setAttribute('aria-hidden', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-label-tag';
    button.textContent = name;
    button.setAttribute('aria-controls', card.id);
    button.setAttribute('aria-expanded', 'false');
    const direction = new Vector3(...outward);
    const anchors = models.map(part => {
      const side = part.name.endsWith('_l') ? 1 : part.name.endsWith('_r') ? -1 : 0;
      const facing = direction.clone();
      if (side) facing.x = Math.abs(facing.x) * side;
      const hint = name === '眼眶' ? new Vector3(...anchor) : undefined;
      return surfaceAnchor(part, rootInverse, facing, hint);
    });
    if (!anchors.length) anchors.push({ point: new Vector3(...anchor), outward: direction.normalize() });
    if (name === '眼眶' && parts.length) {
      const hint = new Vector3(...anchor);
      anchors.sort((a, b) => a.point.distanceToSquared(hint) - b.point.distanceToSquared(hint));
      anchors.splice(1);
    }
    const record = { group, name, translation, surface, detail, node, leader, button, parts,
      anchors, side: Math.sign(anchor[0]) || -1 };
    if (name !== '眼眶') for (const model of models) partsToRecord.set(model, record);
    button.addEventListener('click', () => show(record));
    node.append(leader, button);
    overlay.append(node);
    records.push(record);
  }
  let selected;
  let selectedMeshes = new Set();

  function close(restoreFocus = false, redraw = true) {
    if (!selected) return;
    selected.button.setAttribute('aria-expanded', 'false');
    card.hidden = true;
    if (restoreFocus && !overlay.hidden && !selected.node.hidden) selected.button.focus();
    selected = undefined;
    selectedMeshes.clear();
    if (redraw) onChange();
  }

  let onChange = () => {};
  function show(record, mesh) {
    if (!mesh && selected === record && selectedMeshes.size === record.parts.length) return close(true);
    close(false, false);
    selected = record;
    if (mesh) mesh.traverse(part => { if (part.isMesh) selectedMeshes.add(part); });
    else selectedMeshes = new Set(record.parts);
    record.button.setAttribute('aria-expanded', 'true');
    card.dataset.group = record.group;
    const side = mesh?.name.slice(-2);
    title.textContent = (side === '_l' ? '左' : side === '_r' ? '右' : '') + record.name;
    english.textContent = (side === '_l' ? 'Left ' : side === '_r' ? 'Right ' : '') + record.translation;
    location.textContent = record.surface;
    notes.textContent = record.detail;
    card.hidden = false;
    onChange();
  }

  const listeners = new AbortController();
  closeButton.addEventListener('click', () => close(true), { signal: listeners.signal });
  card.parentElement.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) {
      event.stopPropagation();
      close(true);
    }
  }, { signal: listeners.signal });

  function placeColumn(items, x, height) {
    items.sort((a, b) => a.y - b.y);
    const gap = Math.min(26, (height - 28) / Math.max(1, items.length - 1));
    let y = 14 - gap;
    for (const item of items) {
      y = Math.max(y + gap, MathUtils.clamp(item.y, 14, height - 14));
      item.labelY = y;
    }
    y = height - 14 + gap;
    for (const item of items.reverse()) {
      y = Math.min(y - gap, item.labelY);
      const dx = x - item.x;
      const dy = y - item.y;
      item.leader.style.transform = `translate(${item.x}px,${item.y}px) rotate(${Math.atan2(dy, dx)}rad) scaleX(${Math.hypot(dx, dy)})`;
      item.button.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
    }
  }

  function update({ enabled, visible, layer, world, camera, width, height, half, lens, cursor, radius }) {
    overlay.hidden = !enabled || !visible;
    if (selected && layer !== 'combined' && selected.group !== layer) close(false, false);
    if (overlay.hidden) return;
    normalMatrix.getNormalMatrix(world);
    camera.getWorldDirection(view).negate();
    center.setFromMatrixPosition(world).project(camera);
    const centerX = (1 + center.x) * width / 2;
    const m = world.elements;
    const lateralReach = Math.hypot(0.65 * m[0], 0.88 * m[4], 0.88 * m[8]) * height / 2;
    const left = [];
    const right = [];
    for (const item of records) {
      let facing = -1;
      for (const anchor of item.anchors) {
        if (half && anchor.point.x > 0) continue;
        const alignment = normal.copy(anchor.outward).applyNormalMatrix(normalMatrix).dot(view);
        if (alignment <= facing) continue;
        projected.copy(anchor.point).applyMatrix4(world).project(camera);
        if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) continue;
        const x = (1 + projected.x) * width / 2;
        const y = (1 - projected.y) * height / 2;
        if (lens && Math.hypot(x - cursor.x, y - cursor.y) > radius) continue;
        facing = alignment;
        item.x = x;
        item.y = y;
      }
      const opacity = MathUtils.smoothstep(facing, 0.02, 0.38);
      item.node.hidden = opacity < 0.02 || (layer !== 'combined' && item.group !== layer);
      if (item.node.hidden) continue;
      item.node.style.opacity = opacity.toFixed(2);
      if (Math.abs(item.x - centerX) > 12) item.side = Math.sign(item.x - centerX);
      (item.side < 0 ? left : right).push(item);
    }
    const inset = 35;
    const reach = lateralReach + 36;
    placeColumn(left, MathUtils.clamp(centerX - reach, inset, width - inset), height);
    placeColumn(right, MathUtils.clamp(centerX + reach, inset, width - inset), height);
  }
  return {
    update,
    close,
    dispose() {
      close(false, false);
      listeners.abort();
      for (const record of records) record.node.remove();
    },
    get selectedMeshes() { return selectedMeshes; },
    selectMesh(mesh) {
      const record = partsToRecord.get(mesh);
      if (record) show(record, mesh);
      else close();
    },
    setOnChange(callback) { onChange = callback; },
  };
}
