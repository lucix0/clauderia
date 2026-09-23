import * as THREE from 'three';
import { CHUNK_SHIFT, CHUNK_SIZE } from '../config';
import { PASS_COUNT, PASS_TRANSLUCENT } from '../world/blocks';
import type { World } from '../world/world';
import { meshChunk, type PassMesh } from './mesher';

/** Render order per pass: translucent water is drawn after everything else. */
const RENDER_ORDER = [0, 0, 2];

/**
 * Owns one merged BufferGeometry per chunk per render pass, rebuilding dirty
 * chunks within a per-frame time budget.
 */
export class ChunkManager {
  readonly group = new THREE.Group();
  /** Total chunk rebuilds since start. */
  rebuilds = 0;
  private world: World | null = null;
  private meshes: Array<Array<THREE.Mesh | null>> = [];

  constructor(private readonly materials: readonly THREE.Material[]) {
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;
  }

  setWorld(world: World): void {
    this.disposeAll();
    this.world = world;
    this.meshes = Array.from({ length: world.chunkCount }, () => Array<THREE.Mesh | null>(PASS_COUNT).fill(null));
    world.markAllDirty();
  }

  get pending(): number {
    return this.world?.dirty.size ?? 0;
  }

  /** Mesh every dirty chunk, yielding to the browser between batches. */
  async buildAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const world = this.world;
    if (!world) return;
    const total = world.dirty.size;
    let done = 0;
    let sliceStart = performance.now();
    for (const index of [...world.dirty]) {
      this.rebuild(index);
      done++;
      if (performance.now() - sliceStart > 30) {
        onProgress?.(done, total);
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    onProgress?.(total, total);
  }

  /** Rebuild the chunk containing a cell right now (used after player edits). */
  rebuildAt(x: number, y: number, z: number): void {
    const world = this.world;
    if (!world || !world.inBounds(x, y, z)) return;
    const index = world.chunkIndex(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (world.dirty.has(index)) this.rebuild(index);
  }

  /** Rebuild dirty chunks nearest the camera first, until the budget is spent. */
  update(camera: THREE.Vector3, budgetMs: number): number {
    const world = this.world;
    if (!world || world.dirty.size === 0) return 0;
    const start = performance.now();
    const dist = (index: number): number => {
      const cx = index % world.chunksX;
      const cz = Math.floor(index / world.chunksX) % world.chunksZ;
      const cy = Math.floor(index / (world.chunksX * world.chunksZ));
      const dx = (cx + 0.5) * CHUNK_SIZE - camera.x;
      const dy = (cy + 0.5) * CHUNK_SIZE - camera.y;
      const dz = (cz + 0.5) * CHUNK_SIZE - camera.z;
      return dx * dx + dy * dy + dz * dz;
    };
    const order = [...world.dirty].sort((a, b) => dist(a) - dist(b));
    let built = 0;
    for (const index of order) {
      this.rebuild(index);
      built++;
      if (performance.now() - start >= budgetMs) break;
    }
    return built;
  }

  /** Hide chunks beyond the render distance (horizontal). */
  updateVisibility(camera: THREE.Vector3, distance: number): void {
    const world = this.world;
    if (!world) return;
    const reach = distance + CHUNK_SIZE * 0.75;
    const reach2 = reach * reach;
    for (let index = 0; index < this.meshes.length; index++) {
      const cx = index % world.chunksX;
      const cz = Math.floor(index / world.chunksX) % world.chunksZ;
      const dx = (cx + 0.5) * CHUNK_SIZE - camera.x;
      const dz = (cz + 0.5) * CHUNK_SIZE - camera.z;
      const visible = dx * dx + dz * dz <= reach2;
      for (const mesh of this.meshes[index]!) if (mesh) mesh.visible = visible;
    }
  }

  private rebuild(index: number): void {
    const world = this.world;
    if (!world) return;
    world.dirty.delete(index);
    const cx = index % world.chunksX;
    const cz = Math.floor(index / world.chunksX) % world.chunksZ;
    const cy = Math.floor(index / (world.chunksX * world.chunksZ));
    const data = meshChunk(world, cx, cy, cz);
    const slots = this.meshes[index]!;
    for (let pass = 0; pass < PASS_COUNT; pass++) {
      const passMesh = data[pass] ?? null;
      const existing = slots[pass] ?? null;
      if (!passMesh) {
        if (existing) {
          existing.geometry.dispose();
          this.group.remove(existing);
          slots[pass] = null;
        }
        continue;
      }
      const geometry = toGeometry(passMesh, cx, cy, cz);
      if (existing) {
        existing.geometry.dispose();
        existing.geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, this.materials[pass]);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = RENDER_ORDER[pass]!;
        mesh.name = `chunk ${cx},${cy},${cz} p${pass}`;
        if (pass === PASS_TRANSLUCENT) mesh.userData['translucent'] = true;
        this.group.add(mesh);
        slots[pass] = mesh;
      }
    }
    this.rebuilds++;
  }

  disposeAll(): void {
    for (const slots of this.meshes) {
      for (const mesh of slots) {
        if (!mesh) continue;
        mesh.geometry.dispose();
        this.group.remove(mesh);
      }
    }
    this.meshes = [];
  }
}

function toGeometry(m: PassMesh, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  const min = new THREE.Vector3(cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE);
  const max = min.clone().addScalar(CHUNK_SIZE);
  g.boundingBox = new THREE.Box3(min, max);
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}
