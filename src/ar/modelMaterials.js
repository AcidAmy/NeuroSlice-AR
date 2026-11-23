import { Color, MeshStandardMaterial } from 'three';

const bone = new Color('#EFEBE2');
const cortex = new Color('#DFA09B');
const selectedBone = new Color('#67E8F9');
const selectedBrain = new Color('#FFBB62');

export function createModelMaterials(skull, brain, { headSpace, aperture, clipHalf }) {
  const parts = [];

  function addPart(mesh, isBone, index) {
    const xray = mesh.material.clone();
    Object.assign(xray.uniforms, { headSpace, aperture, clipHalf });
    const boneTone = 1 + ((index * 5) % 7 - 3) * 0.01;
    const base = isBone ? bone.clone().multiplyScalar(boneTone) : cortex;
    xray.uniforms.surfaceGain.value = isBone ? 1 + (boneTone - 1) * 1.7 : 1;
    const highlight = isBone ? selectedBone : selectedBrain;
    xray.uniforms.highlight.value.copy(highlight);
    const specimen = new MeshStandardMaterial({
      color: base, roughness: isBone ? 0.58 : 0.65,
    });
    specimen.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { headSpace, aperture, clipHalf });
      shader.vertexShader = shader.vertexShader.replace('#include <common>',
        '#include <common>\nuniform mat4 headSpace;\nvarying float anatomyX;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\nanatomyX = (headSpace * modelMatrix * vec4(transformed, 1.0)).x;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
        '#include <common>\nuniform bool clipHalf;\nuniform vec4 aperture;\nvarying float anatomyX;')
        .replace('#include <alphatest_fragment>', `
          if (clipHalf && anatomyX > 0.0) discard;
          if (aperture.w > 0.5) {
            float radius = length(gl_FragCoord.xy - aperture.xy);
            diffuseColor.a *= 1.0 - smoothstep(aperture.z * 0.91, aperture.z, radius);
            if (diffuseColor.a < 0.002) discard;
          }
          #include <alphatest_fragment>
        `);
    };
    parts.push({ mesh, isBone, xray, specimen, base, highlight });
  }

  function setGroup(group, isBone) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].isBone !== isBone) continue;
      const [part] = parts.splice(i, 1);
      part.xray.dispose();
      part.specimen.dispose();
    }
    let index = 0;
    group.traverse(mesh => { if (mesh.isMesh) addPart(mesh, isBone, index++); });
  }
  setGroup(skull, true);
  setGroup(brain, false);

  return {
    get parts() { return parts.map(part => part.mesh); },
    setGroup,
    update({ mode, opacity, layer, lens, half, textured = false, selected, viewAxisHead }) {
      const transparent = opacity < 1 || lens || textured;
      for (const { mesh, isBone, xray, specimen, base, highlight } of parts) {
        const active = selected?.has(mesh);
        const dimmed = selected?.size && !active;
        xray.uniforms.opacity.value = opacity * (textured ? (isBone ? 0.63 : 0.26) : 1);
        xray.depthTest = textured;
        xray.uniforms.viewAxisHead.value.copy(viewAxisHead);
        xray.uniforms.layerWeight.value = !isBone && layer === 'combined' ? 0.65 : 1;
        xray.uniforms.emphasis.value = active ? 0.78 : dimmed ? -0.24 : 0;
        const shellOpacity = half ? (isBone ? 0.40 : 0.20) : (isBone ? 0.24 : 0.10);
        specimen.opacity = opacity * (textured ? (active ? Math.max(shellOpacity, 0.55) : shellOpacity) : 1);
        specimen.depthWrite = !textured;
        if (specimen.transparent !== transparent) {
          specimen.transparent = transparent;
          specimen.needsUpdate = true;
        }
        specimen.color.copy(active ? highlight : base).multiplyScalar(dimmed ? 0.76 : 1);
        specimen.emissive.copy(highlight);
        specimen.emissiveIntensity = active ? 0.20 : 0;
        mesh.material = mode === 'xray' ? xray : specimen;
      }
    },
  };
}
