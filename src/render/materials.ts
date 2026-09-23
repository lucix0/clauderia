import * as THREE from 'three';

/**
 * Uniforms shared by every chunk material. `uDaylight` (0 night … 1 noon)
 * dims sky light in the shader, so the time of day never needs a remesh.
 */
export const lightUniforms = {
  uDaylight: { value: 1 },
};

/**
 * Patch a MeshBasicMaterial so vertex colours (face shade) are multiplied by
 * the brighter of sky light × daylight and block light, with a warm tint
 * where torches dominate. Fog and everything else stay standard.
 */
function withVoxelLight(material: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uDaylight'] = lightUniforms.uDaylight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float skyLight;
attribute float blockLight;
uniform float uDaylight;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
{
  // Night subtracts up to 11 levels of sky light (moonlight keeps 4).
  float skyLevel = max(skyLight * 15.0 - (1.0 - uDaylight) * 11.0, 0.0);
  float blockLevel = blockLight * 15.0;
  float level = max(skyLevel, blockLevel);
  float f = level / 15.0;
  float b = f / (4.0 - 3.0 * f);
  float bright = mix(0.06, 1.0, mix(b, sqrt(b), 0.45));
  float warmth = clamp((blockLevel - skyLevel) / 6.0, 0.0, 1.0);
  vec3 tint = mix(vec3(1.0), vec3(1.0, 0.8, 0.58), warmth * 0.85);
  vec3 moon = mix(vec3(0.72, 0.8, 1.0), vec3(1.0), clamp(uDaylight * 1.4 + warmth, 0.0, 1.0));
  vColor.rgb *= pow(vec3(bright), vec3(2.2)) * tint * moon;
}`,
      );
  };
  material.customProgramCacheKey = () => `voxel-light-${material.name}`;
  return material;
}

/** Unlit materials with shader-side voxel lighting, indexed by render pass. */
export function createMaterials(atlas: THREE.Texture): THREE.MeshBasicMaterial[] {
  const opaque = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true });
  const cutout = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5 });
  const translucent = new THREE.MeshBasicMaterial({
    map: atlas,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // Seen from below when swimming, so draw both sides.
    side: THREE.DoubleSide,
  });
  opaque.name = 'opaque';
  cutout.name = 'cutout';
  translucent.name = 'translucent';
  return [withVoxelLight(opaque), withVoxelLight(cutout), withVoxelLight(translucent)];
}
