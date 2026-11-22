import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Matrix4, Mesh, Raycaster, Vector3, Vector4 } from 'three';
import { createModelLabels, surfaceAnchor } from '../src/ar/labels3d.js';
import { createModelMaterials } from '../src/ar/modelMaterials.js';
import { pickAnatomy, setLayerVisibility } from '../src/ar/projection.js';
import { createXRayFresnelShader } from '../src/ar/xrayFresnelShader.js';

test('skull and brain visibility stays exclusive when a selected layer is clicked again', () => {
  const anatomy = new Group();
  const skull = new Group().add(new Mesh());
  const brain = new Group().add(new Mesh());
  anatomy.add(skull, brain);
  for (const [layer, expected] of [
    ['skull', [skull]], ['skull', [skull]], ['brain', [brain]], ['combined', [skull, brain]],
  ]) {
    setLayerVisibility(skull, brain, layer);
    const drawn = [];
    anatomy.traverseVisible(object => { if (object.isMesh) drawn.push(object.parent); });
    assert.deepEqual(drawn, expected);
  }
});

function part(name, x = 0, z = 0) {
  const mesh = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), createXRayFresnelShader({
    tint: '#F1F5F9', rimTint: '#E0F2FE', shadowTint: '#64748B', density: 0.93, edgePower: 3.8, body: 0.40,
  }));
  mesh.name = name;
  mesh.position.set(x, 0, z);
  return mesh;
}

test('the specimen and X-ray materials retain opacity, clipping, and independent selection', () => {
  const left = part('zygomatic_bone_l');
  const right = part('zygomatic_bone_r');
  const cerebellum = part('cerebellum');
  const clipHalf = { value: true };
  const materials = createModelMaterials(new Group().add(left, right), new Group().add(cerebellum), {
    headSpace: { value: new Matrix4() }, aperture: { value: new Vector4() }, clipHalf,
  });
  const state = {
    mode: 'specimen', opacity: 0.63, layer: 'combined', lens: false,
    selected: new Set([left]), viewAxisHead: new Vector3(0, 0, 1),
  };
  materials.update(state);
  assert.ok(left.material.isMeshStandardMaterial);
  assert.notEqual(left.material, right.material);
  assert.equal(left.material.roughness, 0.58);
  assert.equal(cerebellum.material.roughness, 0.65);
  assert.equal(left.material.color.getHexString(), '67e8f9');
  assert.equal(right.material.emissiveIntensity, 0);
  assert.equal(left.material.opacity, 0.63);
  assert.equal(left.material.transparent, true);
  const specimen = left.material;

  materials.update({ ...state, mode: 'xray' });
  assert.ok(left.material.isShaderMaterial);
  assert.equal(left.material.uniforms.opacity.value, 0.63);
  assert.equal(left.material.uniforms.clipHalf, clipHalf);
  assert.ok(left.material.uniforms.emphasis.value > 0);
  assert.ok(right.material.uniforms.emphasis.value < 0);

  materials.update({ ...state, opacity: 1, selected: new Set() });
  assert.equal(left.material, specimen);
  assert.equal(left.material.emissiveIntensity, 0);
  assert.equal(left.material.transparent, false);
});

test('ray picking uses the frontmost visible part and skips clipped intersections', () => {
  const left = part('zygomatic_bone_l', 0.3, 0.5);
  const right = part('zygomatic_bone_r', -0.3, 0.5);
  const brain = part('cerebrum_l', 0.3, 0);
  const skullGroup = new Group().add(left, right);
  const anatomy = new Group().add(skullGroup, brain);
  anatomy.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(0.3, 0, 3), new Vector3(0, 0, -1));
  const inverseHead = new Matrix4();
  assert.equal(pickAnatomy(ray, [left, right, brain], { half: false, inverseHead }), left);
  assert.equal(pickAnatomy(ray, [left, right, brain], { half: true, inverseHead }), undefined);
  skullGroup.visible = false;
  assert.equal(pickAnatomy(ray, [left, right, brain], { half: false, inverseHead }), brain);
});

test('surface anchors follow transformed mesh bounds and land on real faces', () => {
  const mesh = part('frontal_bone', 0.4, 0.2);
  const root = new Group().add(mesh);
  root.position.x = 4;
  root.updateMatrixWorld(true);
  const { point } = surfaceAnchor(mesh, root.matrixWorld.clone().invert(), new Vector3(0, 0, 1));
  assert.ok(point.distanceTo(new Vector3(0.4, 0, 0.3)) < 1e-7);
});

class TestElement extends EventTarget {
  children = [];
  dataset = {};
  attributes = new Map();
  hidden = true;

  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}

test('a bilateral tag selects both parts, a model click selects one, and close resets both', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new TestElement() };
  t.after(() => { globalThis.document = previousDocument; });
  const overlay = new TestElement();
  const card = new TestElement();
  card.parentElement = new TestElement();
  const elements = new Map(['h3', '[lang="en"]', '.model-label-location', '.model-label-notes', 'button']
    .map(selector => [selector, new TestElement()]));
  card.querySelector = selector => elements.get(selector);
  const left = part('zygomatic_bone_l', 0.35);
  const right = part('zygomatic_bone_r', -0.35);
  const leftFrontal = part('frontal_lobe_l');
  const leftCerebrum = part('cerebrum_l').add(leftFrontal);
  const labels = createModelLabels(overlay, card, new Group().add(left, right, leftCerebrum));
  const tagNamed = name => overlay.children.flatMap(node => node.children).find(node => node.textContent === name);
  const tag = tagNamed('颧骨');
  tag.dispatchEvent(new Event('click'));
  assert.deepEqual(labels.selectedMeshes, new Set([left, right]));
  assert.equal(card.hidden, false);

  labels.selectMesh(right);
  assert.deepEqual(labels.selectedMeshes, new Set([right]));
  assert.equal(elements.get('h3').textContent, '右颧骨');
  elements.get('button').dispatchEvent(new Event('click'));
  assert.equal(labels.selectedMeshes.size, 0);
  assert.equal(tag.attributes.get('aria-expanded'), 'false');
  assert.equal(card.hidden, true);

  tagNamed('大脑半球').dispatchEvent(new Event('click'));
  assert.deepEqual(labels.selectedMeshes, new Set([leftCerebrum, leftFrontal]));
  labels.selectMesh(leftFrontal);
  assert.deepEqual(labels.selectedMeshes, new Set([leftFrontal]));
  assert.equal(elements.get('h3').textContent, '左额叶');
});
