import * as THREE from 'three';
import { T } from '../world/blocks';
import type { World } from '../world/world';
import type { Atlas } from './atlas';
import { paintClouds } from './tiles';

export type Medium = 'air' | 'water' | 'lava';

const SKY_TOP = new THREE.Color('#78a7ff');
const FOG_AIR = new THREE.Color('#c3dcff');
const FOG_WATER = new THREE.Color('#0e2d6e');
const FOG_LAVA = new THREE.Color('#d0520c');

const EDGE_EXTENT = 4096;
const CLOUD_TEXELS = 128;
const CLOUD_TEXEL_BLOCKS = 4;
const CLOUD_SPEED = 0.7; // blocks per second

/**
 * Sky gradient, distance fog (with underwater / lava variants), a drifting
 * cloud layer and the flat ocean + bedrock floor surrounding the map.
 */
export class Sky {
  readonly fog = new THREE.Fog(FOG_AIR.clone(), 40, 128);
  private readonly dome: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly cloudTex: THREE.Texture;
  private readonly edge = new THREE.Group();
  private readonly waterTex: THREE.Texture;
  private readonly floorTex: THREE.Texture;
  private readonly background = new THREE.Color();

  constructor(scene: THREE.Scene, atlas: Atlas) {
    scene.fog = this.fog;
    scene.background = this.background;

    this.dome = createDome();
    scene.add(this.dome);

    const cloudCanvas = document.createElement('canvas');
    cloudCanvas.width = CLOUD_TEXELS;
    cloudCanvas.height = CLOUD_TEXELS;
    const ctx = cloudCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(new ImageData(paintClouds(CLOUD_TEXELS, 0xc10d), CLOUD_TEXELS, CLOUD_TEXELS), 0, 0);
    this.cloudTex = new THREE.CanvasTexture(cloudCanvas);
    this.cloudTex.magFilter = THREE.NearestFilter;
    this.cloudTex.minFilter = THREE.NearestFilter;
    this.cloudTex.generateMipmaps = false;
    this.cloudTex.wrapS = THREE.RepeatWrapping;
    this.cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex.colorSpace = THREE.SRGBColorSpace;
    const cloudSize = EDGE_EXTENT * 2;
    this.cloudTex.repeat.set(cloudSize / (CLOUD_TEXELS * CLOUD_TEXEL_BLOCKS), cloudSize / (CLOUD_TEXELS * CLOUD_TEXEL_BLOCKS));
    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(cloudSize, cloudSize).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: this.cloudTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.clouds.name = 'clouds';
    this.clouds.renderOrder = 1;
    scene.add(this.clouds);

    this.waterTex = atlas.tileTexture(T.WATER);
    this.floorTex = atlas.tileTexture(T.BEDROCK);
    this.edge.name = 'edge';
    scene.add(this.edge);
  }

  /** Rebuild the ocean ring and cloud height for a new world. */
  setWorld(world: World): void {
    for (const child of [...this.edge.children]) {
      this.edge.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    const water = new THREE.Mesh(
      ringGeometry(world.sx, world.sz, world.seaLevel),
      new THREE.MeshBasicMaterial({
        map: this.waterTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    water.name = 'edge-water';
    water.renderOrder = 1;
    const floor = new THREE.Mesh(
      ringGeometry(world.sx, world.sz, world.edgeFloor),
      new THREE.MeshBasicMaterial({ map: this.floorTex, color: new THREE.Color(0.75, 0.75, 0.75) }),
    );
    floor.name = 'edge-floor';
    this.edge.add(floor, water);
    this.clouds.position.set(world.sx / 2, world.sy + 2, world.sz / 2);
  }

  update(dt: number, camera: THREE.Camera, medium: Medium, renderDistance: number): void {
    this.dome.position.copy(camera.position);
    this.cloudTex.offset.x += (dt * CLOUD_SPEED) / (CLOUD_TEXELS * CLOUD_TEXEL_BLOCKS);
    this.cloudTex.offset.x %= 1;

    if (medium === 'water') {
      this.fog.color.copy(FOG_WATER);
      this.fog.near = 0.5;
      this.fog.far = 14;
    } else if (medium === 'lava') {
      this.fog.color.copy(FOG_LAVA);
      this.fog.near = 0;
      this.fog.far = 2.5;
    } else {
      this.fog.color.copy(FOG_AIR);
      this.fog.near = renderDistance * 0.3;
      this.fog.far = renderDistance;
    }
    this.dome.visible = medium === 'air';
    this.background.copy(this.fog.color);
  }
}

/** Camera-centred gradient sphere drawn behind everything. */
function createDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(10, 24, 16);
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 10);
    const k = Math.min(1, t / 0.45);
    c.copy(FOG_AIR).lerp(SKY_TOP, k * k * (3 - 2 * k));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = 'sky';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}

/** Four horizontal quads around the map rectangle at height y, UVs in blocks. */
function ringGeometry(sx: number, sz: number, y: number): THREE.BufferGeometry {
  const E = EDGE_EXTENT;
  const rects: Array<[number, number, number, number]> = [
    [-E, -E, sx + E, 0],
    [-E, sz, sx + E, sz + E],
    [-E, 0, 0, sz],
    [sx, 0, sx + E, sz],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  rects.forEach(([x0, z0, x1, z1], k) => {
    // Counter-clockwise seen from above: (x0,z1) (x1,z1) (x1,z0) (x0,z0).
    positions.push(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0);
    uvs.push(x0, -z1, x1, -z1, x1, -z0, x0, -z0);
    const v = k * 4;
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}
