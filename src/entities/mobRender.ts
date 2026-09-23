/**
 * Mob models: boxes on pivots (legs, arms, heads swing), skinned from the
 * procedural mob atlas and lit by the voxel shader. Also draws arrows.
 */
import * as THREE from 'three';
import { TILE_UVS } from '../render/mesher';
import { ModelBuilder, setGeometryLight, type UVRect } from './models';
import type { Arrow, Mob, MobKind, Mobs } from './mobs';
import { MOB_ATLAS_COLUMNS, MOB_TILES, mobTile, paintMobTile, type MobTile } from './mobTextures';

type Anim = 'legA' | 'legB' | 'armA' | 'armB' | 'spiderA' | 'spiderB';
type Box = readonly [number, number, number, number, number, number];

interface Part {
  readonly pivot: readonly [number, number, number];
  readonly box: Box;
  /** One tile for every face, or [+X, −X, +Y, −Y, +Z, −Z]. The front is −Z. */
  readonly tiles: MobTile | readonly MobTile[];
  readonly anim?: Anim;
  readonly rot?: readonly [number, number, number];
}

const HALF_PI = Math.PI / 2;

function faces(side: MobTile, top: MobTile, bottom: MobTile, front: MobTile, back = side): MobTile[] {
  return [side, side, top, bottom, back, front];
}

function quadrupedLegs(tile: MobTile, hoof: MobTile, x: number, y: number, z: number, w: number): Part[] {
  const box: Box = [-w, -y, -w, w, 0, w];
  const t = faces(tile, tile, hoof, tile);
  return [
    { pivot: [-x, y, -z], box, tiles: t, anim: 'legA' },
    { pivot: [x, y, -z], box, tiles: t, anim: 'legB' },
    { pivot: [-x, y, z], box, tiles: t, anim: 'legB' },
    { pivot: [x, y, z], box, tiles: t, anim: 'legA' },
  ];
}

function spiderLegs(): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const z = -0.28 + i * 0.16;
    const spread = (i - 1.5) * 0.4;
    out.push(
      { pivot: [0.25, 0.45, z], box: [0, -0.04, -0.04, 0.85, 0.04, 0.04], tiles: 'spider.leg', rot: [0, -spread, -0.55], anim: i % 2 ? 'spiderA' : 'spiderB' },
      { pivot: [-0.25, 0.45, z], box: [-0.85, -0.04, -0.04, 0, 0.04, 0.04], tiles: 'spider.leg', rot: [0, spread, 0.55], anim: i % 2 ? 'spiderB' : 'spiderA' },
    );
  }
  return out;
}

function humanoid(opts: { head: MobTile[]; body: MobTile[]; arm: MobTile; leg: MobTile; limb: number; armsForward: boolean }): Part[] {
  const l = opts.limb;
  const armRot: readonly [number, number, number] = opts.armsForward ? [HALF_PI, 0, 0] : [0, 0, 0];
  return [
    { pivot: [-0.125, 0.75, 0], box: [-l, -0.75, -l, l, 0, l], tiles: opts.leg, anim: 'legA' },
    { pivot: [0.125, 0.75, 0], box: [-l, -0.75, -l, l, 0, l], tiles: opts.leg, anim: 'legB' },
    { pivot: [0, 1.1, 0], box: [-0.25, -0.35, -0.14, 0.25, 0.35, 0.14], tiles: opts.body },
    { pivot: [0, 1.45, 0], box: [-0.24, 0, -0.24, 0.24, 0.48, 0.24], tiles: opts.head },
    { pivot: [-0.25 - l, 1.4, 0], box: [-l, -0.68, -l, l, 0.05, l], tiles: opts.arm, rot: armRot, anim: 'armA' },
    { pivot: [0.25 + l, 1.4, 0], box: [-l, -0.68, -l, l, 0.05, l], tiles: opts.arm, rot: armRot, anim: 'armB' },
  ];
}

export const MODELS: Readonly<Record<MobKind, readonly Part[]>> = {
  pig: [
    { pivot: [0, 0.62, 0], box: [-0.33, -0.25, -0.48, 0.33, 0.25, 0.45], tiles: faces('pig.hide', 'pig.back', 'pig.belly', 'pig.hide') },
    { pivot: [0, 0.65, -0.46], box: [-0.25, -0.2, -0.4, 0.25, 0.25, 0], tiles: faces('pig.hide', 'pig.hide', 'pig.belly', 'pig.face') },
    { pivot: [0, 0.65, -0.46], box: [-0.13, -0.12, -0.49, 0.13, 0.05, -0.4], tiles: 'pig.snout' },
    { pivot: [0, 0.65, -0.46], box: [-0.31, 0.12, -0.3, -0.17, 0.2, -0.12], tiles: 'pig.ear' },
    { pivot: [0, 0.65, -0.46], box: [0.17, 0.12, -0.3, 0.31, 0.2, -0.12], tiles: 'pig.ear' },
    { pivot: [0, 0.75, 0.45], box: [-0.04, -0.04, 0, 0.04, 0.04, 0.1], tiles: 'pig.back' },
    ...quadrupedLegs('pig.leg', 'pig.hoof', 0.19, 0.38, 0.3, 0.09),
  ],
  cow: [
    { pivot: [0, 1.0, 0], box: [-0.4, -0.33, -0.6, 0.4, 0.3, 0.6], tiles: faces('cow.hide', 'cow.back', 'cow.hide', 'cow.hide') },
    { pivot: [0, 1.12, -0.6], box: [-0.25, -0.25, -0.38, 0.25, 0.25, 0], tiles: faces('cow.hide', 'cow.hide', 'cow.hide', 'cow.face') },
    { pivot: [0, 1.12, -0.6], box: [-0.4, 0.14, -0.26, -0.25, 0.24, -0.16], tiles: 'cow.horn' },
    { pivot: [0, 1.12, -0.6], box: [0.25, 0.14, -0.26, 0.4, 0.24, -0.16], tiles: 'cow.horn' },
    ...quadrupedLegs('cow.leg', 'cow.hoof', 0.24, 0.68, 0.44, 0.1),
  ],
  sheep: [
    { pivot: [0, 0.9, 0], box: [-0.42, -0.32, -0.55, 0.42, 0.32, 0.55], tiles: 'sheep.wool' },
    { pivot: [0, 1.05, -0.55], box: [-0.2, -0.18, -0.35, 0.2, 0.22, 0.05], tiles: faces('sheep.head', 'sheep.wool', 'sheep.head', 'sheep.face') },
    ...quadrupedLegs('sheep.leg', 'sheep.leg', 0.22, 0.58, 0.38, 0.08),
  ],
  zombie: humanoid({
    head: faces('zombie.skin', 'zombie.skin', 'zombie.skin', 'zombie.face'),
    body: faces('zombie.tunic', 'zombie.tunic', 'zombie.tunic', 'zombie.tunicFront'),
    arm: 'zombie.arm',
    leg: 'zombie.trousers',
    limb: 0.12,
    armsForward: true,
  }),
  skeleton: [
    ...humanoid({
      head: faces('skeleton.bone', 'skeleton.bone', 'skeleton.bone', 'skeleton.skull'),
      body: faces('skeleton.ribs', 'skeleton.bone', 'skeleton.bone', 'skeleton.ribs'),
      arm: 'skeleton.bone',
      leg: 'skeleton.bone',
      limb: 0.06,
      armsForward: true,
    }),
    // A bow gripped in the left hand (arm space: local z becomes world height).
    { pivot: [-0.31, 1.4, 0], box: [-0.03, -0.72, -0.4, 0.03, -0.64, 0.4], tiles: 'skeleton.bow', rot: [HALF_PI, 0, 0], anim: 'armA' },
  ],
  spider: [
    { pivot: [0, 0.5, 0.05], box: [-0.45, -0.28, 0, 0.45, 0.3, 0.8], tiles: faces('spider.body', 'spider.abdomen', 'spider.body', 'spider.body') },
    { pivot: [0, 0.45, 0], box: [-0.3, -0.18, -0.35, 0.3, 0.18, 0.05], tiles: 'spider.body' },
    { pivot: [0, 0.45, -0.35], box: [-0.26, -0.17, -0.34, 0.26, 0.19, 0], tiles: faces('spider.body', 'spider.body', 'spider.body', 'spider.head') },
    ...spiderLegs(),
  ],
};

function tileUV(tile: MobTile): UVRect {
  const i = mobTile(tile);
  return [TILE_UVS[i * 4]!, TILE_UVS[i * 4 + 1]!, TILE_UVS[i * 4 + 2]!, TILE_UVS[i * 4 + 3]!];
}

/** Paint every mob tile into a canvas (16 columns). */
export function createMobAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = MOB_ATLAS_COLUMNS * 16;
  canvas.height = MOB_ATLAS_COLUMNS * 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  MOB_TILES.forEach((_, i) => {
    const img = new ImageData(new Uint8ClampedArray(paintMobTile(i)), 16, 16);
    ctx.putImageData(img, (i % MOB_ATLAS_COLUMNS) * 16, Math.floor(i / MOB_ATLAS_COLUMNS) * 16);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Shown {
  readonly group: THREE.Group;
  readonly parts: Array<{ mesh: THREE.Mesh; part: Part }>;
  tint: number;
}

function partGeometry(p: Part): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.box(p.box, (f) => tileUV(typeof p.tiles === 'string' ? (p.tiles as MobTile) : (p.tiles as readonly MobTile[])[f]!));
  return b.build();
}

function setTint(g: THREE.BufferGeometry, rgb: number): void {
  const attr = g.getAttribute('tint') as THREE.BufferAttribute;
  const a = attr.array as Uint8Array;
  for (let i = 0; i < a.length; i += 3) {
    a[i] = (rgb >> 16) & 255;
    a[i + 1] = (rgb >> 8) & 255;
    a[i + 2] = rgb & 255;
  }
  attr.needsUpdate = true;
}

export class MobRenderer {
  readonly group = new THREE.Group();
  private readonly shown = new Map<number, Shown>();
  private readonly arrowMeshes = new Map<number, THREE.Mesh>();

  constructor(private readonly material: THREE.Material) {
    this.group.name = 'mobs';
  }

  private create(m: Mob): Shown {
    const group = new THREE.Group();
    const parts = MODELS[m.def.kind].map((part) => {
      const mesh = new THREE.Mesh(partGeometry(part), this.material);
      mesh.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
      if (part.rot) mesh.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
      group.add(mesh);
      return { mesh, part };
    });
    this.group.add(group);
    return { group, parts, tint: 0xffffff };
  }

  update(mobs: Mobs, alpha: number, time: number, lightAt: (x: number, y: number, z: number) => number): void {
    const alive = new Set<number>();
    for (const m of mobs.list) {
      if (m.removed) continue;
      alive.add(m.id);
      let s = this.shown.get(m.id);
      if (!s) {
        s = this.create(m);
        this.shown.set(m.id, s);
      }
      const b = m.body;
      const x = m.prevX + (b.x - m.prevX) * alpha;
      const y = m.prevY + (b.y - m.prevY) * alpha;
      const z = m.prevZ + (b.z - m.prevZ) * alpha;
      s.group.position.set(x, y, z);
      s.group.rotation.set(0, m.yaw, m.dying >= 0 ? Math.min(1, m.dying / 0.45) * HALF_PI : 0);
      const light = lightAt(Math.floor(x), Math.floor(y + b.height * 0.6), Math.floor(z));
      const flicker = m.fire > 0 ? (Math.sin(time * 30) > 0 ? 0xffb070 : 0xff9050) : 0xffffff;
      const tint = m.hurt > 0.25 || m.dying >= 0 ? 0xff7070 : flicker;
      const sw = Math.sin(m.walk) * m.swing;
      for (const { mesh, part } of s.parts) {
        setGeometryLight(mesh.geometry, light);
        if (tint !== s.tint) setTint(mesh.geometry, tint);
        const base = part.rot ?? [0, 0, 0];
        switch (part.anim) {
          case 'legA':
            mesh.rotation.x = base[0] + sw * 0.7;
            break;
          case 'legB':
            mesh.rotation.x = base[0] - sw * 0.7;
            break;
          case 'armA':
            mesh.rotation.x = base[0] - sw * 0.4 + Math.sin(time * 1.3) * 0.04;
            break;
          case 'armB':
            mesh.rotation.x = base[0] + sw * 0.4 - Math.sin(time * 1.3) * 0.04;
            break;
          case 'spiderA':
            mesh.rotation.y = base[1] + sw * 0.35;
            break;
          case 'spiderB':
            mesh.rotation.y = base[1] - sw * 0.35;
            break;
        }
      }
      s.tint = tint;
    }
    for (const [id, s] of this.shown) if (!alive.has(id)) this.drop(id, s);
    this.updateArrows(mobs.arrows, alpha, lightAt);
  }

  private updateArrows(arrows: readonly Arrow[], alpha: number, lightAt: (x: number, y: number, z: number) => number): void {
    const alive = new Set<number>();
    for (const a of arrows) {
      alive.add(a.id);
      let mesh = this.arrowMeshes.get(a.id);
      if (!mesh) {
        const b = new ModelBuilder();
        b.box([-0.03, -0.03, -0.35, 0.03, 0.03, 0.35], () => tileUV('arrow'));
        mesh = new THREE.Mesh(b.build(), this.material);
        this.arrowMeshes.set(a.id, mesh);
        this.group.add(mesh);
      }
      const x = a.prevX + (a.x - a.prevX) * alpha;
      const y = a.prevY + (a.y - a.prevY) * alpha;
      const z = a.prevZ + (a.z - a.prevZ) * alpha;
      mesh.position.set(x, y, z);
      if (a.stuck <= 0) mesh.lookAt(x + a.vx, y + a.vy, z + a.vz);
      setGeometryLight(mesh.geometry, lightAt(Math.floor(x), Math.floor(y), Math.floor(z)));
    }
    for (const [id, mesh] of this.arrowMeshes) {
      if (alive.has(id)) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
      this.arrowMeshes.delete(id);
    }
  }

  private drop(id: number, s: Shown): void {
    for (const { mesh } of s.parts) mesh.geometry.dispose();
    this.group.remove(s.group);
    this.shown.delete(id);
  }

  clear(): void {
    for (const [id, s] of [...this.shown]) this.drop(id, s);
    for (const mesh of this.arrowMeshes.values()) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.arrowMeshes.clear();
  }
}
