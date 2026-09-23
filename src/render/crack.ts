import * as THREE from 'three';
import { CRACK_STAGES, T } from '../world/blocks';
import { TILE_UVS } from './mesher';

/**
 * The mining crack drawn over the block being broken: a box a hair larger
 * than the block, showing one of ten crack stages from the atlas.
 */
export class CrackOverlay {
  readonly object: THREE.Mesh;
  private stage = -1;
  /** The box's own 0/1 UVs, remapped onto a crack tile per stage. */
  private readonly baseUV: Float32Array;

  constructor(atlas: THREE.Texture) {
    const geometry = new THREE.BoxGeometry(1.004, 1.004, 1.004);
    const material = new THREE.MeshBasicMaterial({
      map: atlas,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      opacity: 0.85,
    });
    this.baseUV = Float32Array.from(geometry.getAttribute('uv').array as ArrayLike<number>);
    this.object = new THREE.Mesh(geometry, material);
    this.object.visible = false;
    this.object.renderOrder = 3;
    this.object.name = 'crack';
  }

  /** Show `progress` (0–1) on block (x, y, z), or hide with null. */
  set(cell: { x: number; y: number; z: number } | null, progress = 0): void {
    if (!cell || progress <= 0) {
      this.object.visible = false;
      return;
    }
    const stage = Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES));
    if (stage !== this.stage) this.setStage(stage);
    this.object.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
    this.object.visible = true;
  }

  private setStage(stage: number): void {
    this.stage = stage;
    const tile = T.CRACK_FIRST + stage;
    const u0 = TILE_UVS[tile * 4]!;
    const v0 = TILE_UVS[tile * 4 + 1]!;
    const u1 = TILE_UVS[tile * 4 + 2]!;
    const v1 = TILE_UVS[tile * 4 + 3]!;
    const uv = this.object.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, this.baseUV[i * 2]! < 0.5 ? u0 : u1, this.baseUV[i * 2 + 1]! < 0.5 ? v0 : v1);
    }
    uv.needsUpdate = true;
  }
}
