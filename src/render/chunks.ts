import * as THREE from 'three';
import { PASS_COUNT } from '../world/blocks';
import type { Chunk } from '../world/chunk';
import { CHUNK_HEIGHT, SECTIONS } from '../world/coords';
import type { World } from '../world/world';
import { meshSection, quadIndices, type ChunkMeshData, type PassMesh } from './mesher';
import { worldNeighbourhood } from './neighbourhood';
import { createPadded, fillPadded } from './padded';

/** Render order per pass: translucent water is drawn after everything else. */
const RENDER_ORDER = [0, 0, 2];

interface Column {
  readonly chunk: Chunk;
  /** Latest mesh of each 16³ section (null = empty). */
  readonly sections: Array<ChunkMeshData | null>;
  /** One merged mesh per render pass. */
  readonly meshes: Array<THREE.Mesh | null>;
  /** Passes whose merged mesh needs rebuilding. */
  stalePasses: number;
  visible: boolean;
}

/**
 * Meshes each 16³ section separately (so edits stay cheap) and draws each
 * chunk column as one merged geometry per render pass, positioned at the
 * column origin with chunk-local vertex positions.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  /** Total section rebuilds since start. */
  rebuilds = 0;
  private world: World | null = null;
  private readonly columns = new Map<number, Column>();
  private readonly padded = createPadded();

  constructor(private readonly materials: readonly THREE.Material[]) {
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;
  }

  setWorld(world: World): void {
    this.disposeAll();
    this.world = world;
  }

  /** Sections waiting for a rebuild. */
  get pending(): number {
    let n = 0;
    for (const c of this.world?.dirtyChunks ?? []) n += popcount(c.dirtySections);
    return n;
  }

  get columnCount(): number {
    return this.columns.size;
  }

  /** Mesh every dirty section, yielding to the browser between batches. */
  async buildAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const world = this.world;
    if (!world) return;
    const chunks = [...world.dirtyChunks];
    let done = 0;
    let sliceStart = performance.now();
    for (const chunk of chunks) {
      this.rebuildChunk(chunk);
      done++;
      if (performance.now() - sliceStart > 30) {
        onProgress?.(done, chunks.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    onProgress?.(chunks.length, chunks.length);
  }

  /** Rebuild the chunk containing a cell right now (used after player edits). */
  rebuildAt(x: number, _y: number, z: number): void {
    const chunk = this.world?.chunkAt(x, z);
    if (chunk && chunk.dirtySections) this.rebuildChunk(chunk);
  }

  /** Rebuild dirty sections nearest the camera first, until the budget is spent. */
  update(camera: THREE.Vector3, budgetMs: number): number {
    const world = this.world;
    if (!world || world.dirtyChunks.size === 0) return 0;
    const start = performance.now();
    const dist = (c: Chunk): number => {
      const dx = (c.cx + 0.5) * 16 - camera.x;
      const dz = (c.cz + 0.5) * 16 - camera.z;
      return dx * dx + dz * dz;
    };
    const order = [...world.dirtyChunks].sort((a, b) => dist(a) - dist(b));
    let built = 0;
    for (const chunk of order) {
      built += this.rebuildChunk(chunk);
      if (performance.now() - start >= budgetMs) break;
    }
    return built;
  }

  /** Hide columns beyond the render distance (horizontal). */
  updateVisibility(camera: THREE.Vector3, distance: number): void {
    const reach = distance + 12;
    const reach2 = reach * reach;
    for (const col of this.columns.values()) {
      const dx = (col.chunk.cx + 0.5) * 16 - camera.x;
      const dz = (col.chunk.cz + 0.5) * 16 - camera.z;
      const visible = dx * dx + dz * dz <= reach2;
      if (visible === col.visible) continue;
      col.visible = visible;
      for (const mesh of col.meshes) if (mesh) mesh.visible = visible;
    }
  }

  /** Remesh all dirty sections of one chunk and refresh its merged meshes. */
  rebuildChunk(chunk: Chunk): number {
    const world = this.world;
    if (!world) return 0;
    const mask = chunk.dirtySections;
    chunk.dirtySections = 0;
    world.dirtyChunks.delete(chunk);
    if (!mask) return 0;
    const n = worldNeighbourhood(world, chunk);
    const col = this.column(chunk);
    let built = 0;
    for (let sy = 0; sy < SECTIONS; sy++) {
      if (!(mask & (1 << sy))) continue;
      let data: ChunkMeshData | null = null;
      if (hasContent(chunk, sy)) {
        fillPadded(this.padded, n, sy);
        data = meshSection(this.padded);
      }
      this.setSection(col, sy, data);
      built++;
    }
    this.rebuilds += built;
    this.flush(col);
    return built;
  }

  /** Drop a column's meshes (chunk unloaded). */
  dropColumn(chunk: Chunk): void {
    const col = this.columns.get(chunk.key);
    if (!col) return;
    for (const mesh of col.meshes) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.columns.delete(chunk.key);
  }

  disposeAll(): void {
    for (const col of [...this.columns.values()]) this.dropColumn(col.chunk);
  }

  private column(chunk: Chunk): Column {
    let col = this.columns.get(chunk.key);
    if (!col) {
      col = {
        chunk,
        sections: Array<ChunkMeshData | null>(SECTIONS).fill(null),
        meshes: Array<THREE.Mesh | null>(PASS_COUNT).fill(null),
        stalePasses: 0,
        visible: true,
      };
      this.columns.set(chunk.key, col);
    }
    return col;
  }

  private setSection(col: Column, sy: number, data: ChunkMeshData | null): void {
    const old = col.sections[sy];
    for (let pass = 0; pass < PASS_COUNT; pass++) {
      if ((old?.[pass] ?? null) !== null || (data?.[pass] ?? null) !== null) col.stalePasses |= 1 << pass;
    }
    col.sections[sy] = data;
  }

  /** Rebuild the merged mesh of each stale pass. */
  private flush(col: Column): void {
    for (let pass = 0; pass < PASS_COUNT; pass++) {
      if (!(col.stalePasses & (1 << pass))) continue;
      const parts: PassMesh[] = [];
      for (const s of col.sections) {
        const p = s?.[pass];
        if (p) parts.push(p);
      }
      const existing = col.meshes[pass] ?? null;
      if (parts.length === 0) {
        if (existing) {
          existing.geometry.dispose();
          this.group.remove(existing);
          col.meshes[pass] = null;
        }
        continue;
      }
      const geometry = mergeParts(parts);
      if (existing) {
        existing.geometry.dispose();
        existing.geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, this.materials[pass]);
        mesh.matrixAutoUpdate = false;
        mesh.position.set(col.chunk.cx * 16, 0, col.chunk.cz * 16);
        mesh.updateMatrix();
        mesh.renderOrder = RENDER_ORDER[pass]!;
        mesh.name = `column ${col.chunk.cx},${col.chunk.cz} p${pass}`;
        mesh.visible = col.visible;
        this.group.add(mesh);
        col.meshes[pass] = mesh;
      }
    }
    col.stalePasses = 0;
  }
}

function hasContent(chunk: Chunk, sy: number): boolean {
  return (chunk.nonEmpty & (1 << sy)) !== 0;
}

function popcount(v: number): number {
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
}

/** Concatenate section meshes into one geometry. */
export function mergeParts(parts: readonly PassMesh[]): THREE.BufferGeometry {
  let quads = 0;
  for (const p of parts) quads += p.quads;
  const positions = new Float32Array(quads * 12);
  const uvs = new Float32Array(quads * 8);
  const colors = new Uint8Array(quads * 12);
  let q = 0;
  let minY = CHUNK_HEIGHT;
  let maxY = 0;
  for (const p of parts) {
    positions.set(p.positions, q * 12);
    uvs.set(p.uvs, q * 8);
    colors.set(p.colors, q * 12);
    q += p.quads;
    for (let i = 1; i < p.positions.length; i += 12) {
      const y = p.positions[i]!;
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  g.setIndex(new THREE.BufferAttribute(quadIndices(quads), 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, Math.max(0, minY - 1), 0), new THREE.Vector3(16, maxY, 16));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}
