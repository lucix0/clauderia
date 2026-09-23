import * as THREE from 'three';

/** Thin dark box drawn around the targeted block's bounds. */
export class BlockOutline {
  readonly object: THREE.LineSegments;

  constructor() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const material = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      fog: false,
    });
    this.object = new THREE.LineSegments(edges, material);
    this.object.visible = false;
    this.object.renderOrder = 3;
    this.object.name = 'outline';
  }

  /** Show around the box [min, max] in world space, or hide when null. */
  set(bounds: readonly [number, number, number, number, number, number] | null): void {
    if (!bounds) {
      this.object.visible = false;
      return;
    }
    const [x0, y0, z0, x1, y1, z1] = bounds;
    const pad = 0.004;
    this.object.visible = true;
    this.object.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.object.scale.set(x1 - x0 + pad, y1 - y0 + pad, z1 - z0 + pad);
  }
}
