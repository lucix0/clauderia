/**
 * Draws dropped items: spinning mini blocks, or flat sprites turned toward
 * the camera for plants, torches and non-block items. Lit by the voxel
 * shader from the light level of the cell they sit in.
 */
import * as THREE from 'three';
import { ITEM_FIRST } from '../items/items';
import { ITEM_ATLAS_COLUMNS, ITEM_ATLAS_SLOTS } from '../render/itemTiles';
import { iconTile, PASS } from '../world/blocks';
import type { ItemEntities } from './items';
import { blockItemGeometry, blockTint, setGeometryLight, spriteGeometry, tileUV, type UVRect } from './models';

export interface ItemMaterials {
  /** Chunk materials by render pass (opaque, cutout, translucent). */
  readonly blocks: readonly THREE.Material[];
  /** Double-sided sprite material on the block atlas. */
  readonly blockSprites: THREE.Material;
  /** Double-sided sprite material on the item atlas. */
  readonly itemSprites: THREE.Material;
}

interface Shown {
  readonly mesh: THREE.Mesh;
  readonly sprite: boolean;
  readonly itemId: number;
}

export function itemAtlasUV(id: number): UVRect {
  const i = id - ITEM_FIRST;
  const rows = Math.ceil(ITEM_ATLAS_SLOTS / ITEM_ATLAS_COLUMNS);
  const col = i % ITEM_ATLAS_COLUMNS;
  const row = Math.floor(i / ITEM_ATLAS_COLUMNS);
  const e = 0.0005;
  return [col / ITEM_ATLAS_COLUMNS + e, 1 - (row + 1) / rows + e, (col + 1) / ITEM_ATLAS_COLUMNS - e, 1 - row / rows - e];
}

export class ItemRenderer {
  readonly group = new THREE.Group();
  private readonly shown = new Map<number, Shown>();

  constructor(private readonly materials: ItemMaterials) {
    this.group.name = 'items';
  }

  private create(id: number): Shown {
    let mesh: THREE.Mesh;
    let sprite = true;
    if (id >= ITEM_FIRST) {
      mesh = new THREE.Mesh(spriteGeometry(itemAtlasUV(id), 0.4), this.materials.itemSprites);
    } else if (iconTile(id) >= 0) {
      mesh = new THREE.Mesh(spriteGeometry(tileUV(iconTile(id)), 0.4, blockTint(id)), this.materials.blockSprites);
    } else {
      mesh = new THREE.Mesh(blockItemGeometry(id, 0.25), this.materials.blocks[PASS[id]!]!);
      sprite = false;
    }
    mesh.matrixAutoUpdate = true;
    this.group.add(mesh);
    return { mesh, sprite, itemId: id };
  }

  /**
   * Sync meshes with the entity list. `alpha` interpolates between physics
   * steps; `lightAt` gives the packed light of a cell.
   */
  update(items: ItemEntities, alpha: number, time: number, cameraYaw: number, lightAt: (x: number, y: number, z: number) => number): void {
    const alive = new Set<number>();
    for (const e of items.list) {
      if (e.removed) continue;
      alive.add(e.id);
      let s = this.shown.get(e.id);
      if (s && s.itemId !== e.stack.id) {
        this.drop(e.id, s);
        s = undefined;
      }
      if (!s) {
        s = this.create(e.stack.id);
        this.shown.set(e.id, s);
      }
      const b = e.body;
      const x = e.prevX + (b.x - e.prevX) * alpha;
      const y = e.prevY + (b.y - e.prevY) * alpha;
      const z = e.prevZ + (b.z - e.prevZ) * alpha;
      const bob = Math.sin(time * 2.5 + e.phase) * 0.06 + 0.1;
      s.mesh.position.set(x, y + bob, z);
      s.mesh.rotation.y = s.sprite ? cameraYaw : time * 1.2 + e.phase;
      setGeometryLight(s.mesh.geometry, lightAt(Math.floor(x), Math.floor(y + 0.2), Math.floor(z)));
    }
    for (const [id, s] of this.shown) if (!alive.has(id)) this.drop(id, s);
  }

  private drop(id: number, s: Shown): void {
    s.mesh.geometry.dispose();
    this.group.remove(s.mesh);
    this.shown.delete(id);
  }

  clear(): void {
    for (const [id, s] of [...this.shown]) this.drop(id, s);
  }
}
