import * as THREE from 'three';

/** Unlit materials with baked vertex lighting, indexed by render pass. */
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
  return [opaque, cutout, translucent];
}
