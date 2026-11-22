import { Color, DoubleSide, Matrix4, ShaderMaterial, Vector3, Vector4 } from 'three';

// 视空间主光和补光表现表面起伏，掠视边缘保留透视描边。
export function createXRayFresnelShader({ tint, rimTint, rimAccent, shadowTint, density, edgePower, body }) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    forceSinglePass: true,
    defines: rimAccent ? { CLINICAL_BONE: 1 } : {},
    uniforms: {
      tint: { value: new Color(tint) },
      rimTint: { value: new Color(rimTint) },
      rimAccent: { value: new Color(rimAccent ?? rimTint) },
      shadowTint: { value: new Color(shadowTint) },
      subduedBrainTint: { value: new Color('#726D9B') },
      density: { value: density },
      edgePower: { value: edgePower },
      body: { value: body },
      surfaceGain: { value: 1 },
      layerWeight: { value: 1 },
      opacity: { value: 0.82 },
      highlight: { value: new Color() },
      emphasis: { value: 0 },
      headSpace: { value: new Matrix4() },
      viewAxisHead: { value: new Vector3(0, 0, 1) },
      clipHalf: { value: false },
      aperture: { value: new Vector4() },
    },
    vertexShader: `
      uniform mat4 headSpace;
      varying vec3 surfaceNormal;
      varying vec3 headPosition;
      void main() {
        surfaceNormal = normalMatrix * normal;
        vec4 vertex = vec4(position, 1.0);
        headPosition = (headSpace * modelMatrix * vertex).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vertex;
      }
    `,
    fragmentShader: `
      uniform vec3 tint;
      uniform vec3 rimTint;
      uniform vec3 rimAccent;
      uniform vec3 shadowTint;
      uniform vec3 subduedBrainTint;
      uniform float density;
      uniform float edgePower;
      uniform float body;
      uniform float surfaceGain;
      uniform float layerWeight;
      uniform float opacity;
      uniform vec3 highlight;
      uniform float emphasis;
      uniform vec3 viewAxisHead;
      uniform bool clipHalf;
      uniform vec4 aperture;
      varying vec3 surfaceNormal;
      varying vec3 headPosition;
      void main() {
        if (clipHalf && headPosition.x > 0.0) discard;
        float passesLens = 1.0;
        if (aperture.w > 0.5) {
          float distanceToCenter = length(gl_FragCoord.xy - aperture.xy);
          passesLens = 1.0 - smoothstep(aperture.z * 0.91, aperture.z, distanceToCenter);
          if (passesLens < 0.002) discard;
        }
        vec3 normal = normalize(surfaceNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float incidence = abs(normal.z);
        float grazing = 1.0 - incidence;
        float fresnel = pow(grazing, edgePower);
        float key = max(dot(normal, vec3(-0.52, 0.69, 0.50)), 0.0);
        float fill = max(dot(normal, vec3(0.78, -0.18, 0.60)), 0.0);
        float diffuse = smoothstep(0.10, 0.86, 0.14 + 0.73 * key + 0.18 * fill);
        float depth = dot(headPosition, viewAxisHead);
        float depthWeight = smoothstep(-0.74, 0.42, depth);
        #ifdef CLINICAL_BONE
          // Each bone contributes a narrow cyan rim with a darker inner band at the suture.
          float edge = smoothstep(0.35, 0.76, fresnel);
          float rimCore = smoothstep(0.56, 0.92, fresnel);
          float innerBand = smoothstep(0.14, 0.25, fresnel) * (1.0 - smoothstep(0.30, 0.46, fresnel));
          vec3 shaded = mix(shadowTint, tint * surfaceGain, diffuse);
          shaded = mix(shaded, shadowTint, 0.24 * innerBand);
          vec3 color = mix(shaded, mix(rimAccent, rimTint, rimCore), edge);
          float profile = body * (0.96 - 0.15 * diffuse) + 0.06 * innerBand + 0.47 * edge + 0.15 * rimCore;
          float strength = opacity + 0.40 * opacity * (1.0 - opacity);
          float transmission = mix(0.78, 1.0, depthWeight);
          float facing = gl_FrontFacing ? 1.0 : 0.16;
        #else
          float edge = smoothstep(0.34, 0.94, fresnel);
          vec3 shaded = mix(shadowTint, tint, diffuse);
          vec3 color = mix(shaded, rimTint, 0.85 * edge);
          color = mix(color, subduedBrainTint, 0.64 * (1.0 - layerWeight));
          float profile = body * (0.84 + 0.16 * diffuse) + 0.28 * fresnel + 0.19 * edge;
          float strength = opacity * layerWeight;
          float transmission = mix(0.70, 1.0, depthWeight);
          float facing = gl_FrontFacing ? 1.0 : 0.28;
        #endif
        color = mix(color, highlight, max(emphasis, 0.0)) * (1.0 + min(emphasis, 0.0));
        float alpha = min(1.0, density * strength * transmission * facing * profile *
          (1.0 + max(emphasis, 0.0) * 0.45)) * passesLens;
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}
