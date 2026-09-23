import * as THREE from 'three';
import { T } from '../world/blocks';
import type { World } from '../world/world';
import type { Atlas } from './atlas';
import { paintClouds, paintMoon, paintSun } from './tiles';

export type Medium = 'air' | 'water' | 'lava';

const DAY_TOP = new THREE.Color('#78a7ff');
const DAY_HORIZON = new THREE.Color('#c3dcff');
const DUSK_HORIZON = new THREE.Color('#f0a46e');
const DUSK_GLOW = new THREE.Color('#ff8f45');
const NIGHT_TOP = new THREE.Color('#03060f');
const NIGHT_HORIZON = new THREE.Color('#0b1224');
const FOG_WATER = new THREE.Color('#0e2d6e');
const FOG_LAVA = new THREE.Color('#d0520c');

/** Ticks in a full day (20 minutes at 20 ticks per second). */
export const DAY_TICKS = 24000;

/** Sun height −1…1 for a time of day (0 sunrise, 6000 noon, 12000 sunset, 18000 midnight). */
export function sunHeight(time: number): number {
  return Math.sin((time / DAY_TICKS) * Math.PI * 2);
}

/** How strongly sky light shines, 0 (night) … 1 (day). */
export function daylightAt(time: number): number {
  const h = sunHeight(time);
  const t = Math.min(1, Math.max(0, (h + 0.18) / 0.4));
  return t * t * (3 - 2 * t);
}

const EDGE_EXTENT = 4096;
const CLOUD_TEXELS = 128;
const CLOUD_TEXEL_BLOCKS = 4;
const CLOUD_SPEED = 0.7; // blocks per second

/**
 * Sky gradient, distance fog (with underwater / lava variants), a drifting
 * cloud layer and the flat ocean + bedrock floor surrounding the map.
 */
export class Sky {
  readonly fog = new THREE.Fog(DAY_HORIZON.clone(), 40, 128);
  private readonly dome: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly cloudTex: THREE.Texture;
  private readonly edge = new THREE.Group();
  private readonly waterTex: THREE.Texture;
  private readonly floorTex: THREE.Texture;
  private readonly background = new THREE.Color();
  private readonly skyUniforms = {
    uTop: { value: DAY_TOP.clone() },
    uHorizon: { value: DAY_HORIZON.clone() },
    uGlow: { value: DUSK_GLOW.clone() },
    uGlowAmount: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly edgeColor = new THREE.Color(1, 1, 1);
  private readonly tmp = new THREE.Color();
  private cloudHeight = 66;
  private cloudDrift = 0;
  /** Current daylight, 0 … 1. */
  daylight = 1;

  constructor(scene: THREE.Scene, atlas: Atlas) {
    scene.fog = this.fog;
    scene.background = this.background;

    this.dome = createDome(this.skyUniforms);
    scene.add(this.dome);
    this.sun = celestial(paintSun(), 60, true);
    this.moon = celestial(paintMoon(), 44, false);
    this.stars = createStars();
    scene.add(this.sun, this.moon, this.stars);

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
    this.cloudHeight = world.height + 2;
    const bounds = world.bounds;
    if (!bounds) return;
    const water = new THREE.Mesh(
      ringGeometry(bounds.sx, bounds.sz, world.seaLevel),
      new THREE.MeshBasicMaterial({
        map: this.waterTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        color: this.edgeColor,
      }),
    );
    water.name = 'edge-water';
    water.renderOrder = 1;
    const floor = new THREE.Mesh(
      ringGeometry(bounds.sx, bounds.sz, world.edgeFloor),
      new THREE.MeshBasicMaterial({ map: this.floorTex, color: this.edgeColor }),
    );
    floor.name = 'edge-floor';
    this.edge.add(floor, water);
  }

  update(dt: number, camera: THREE.Camera, medium: Medium, renderDistance: number, time: number): void {
    this.dome.position.copy(camera.position);
    this.updateCelestial(camera, time);
    // The cloud plane follows the camera; its texture stays fixed in the world.
    const span = CLOUD_TEXELS * CLOUD_TEXEL_BLOCKS;
    this.cloudDrift = (this.cloudDrift + dt * CLOUD_SPEED) % span;
    const cx = Math.round(camera.position.x);
    const cz = Math.round(camera.position.z);
    this.clouds.position.set(cx, this.cloudHeight, cz);
    this.cloudTex.offset.set(((cx + this.cloudDrift) / span) % 1, (cz / span) % 1);

    const dim = 0.25 + 0.75 * this.daylight;
    if (medium === 'water') {
      this.fog.color.copy(FOG_WATER).multiplyScalar(dim);
      this.fog.near = 0.5;
      this.fog.far = 14;
    } else if (medium === 'lava') {
      this.fog.color.copy(FOG_LAVA);
      this.fog.near = 0;
      this.fog.far = 2.5;
    } else {
      this.fog.color.copy(this.skyUniforms.uHorizon.value);
      this.fog.near = renderDistance * 0.3;
      this.fog.far = renderDistance;
    }
    const air = medium === 'air';
    this.dome.visible = air;
    this.stars.visible = air && this.daylight < 0.95;
    this.sun.visible = air;
    this.moon.visible = air;
    this.background.copy(this.fog.color);
    (this.clouds.material as THREE.MeshBasicMaterial).color.setScalar(0.18 + 0.82 * this.daylight);
    this.edgeColor.setScalar(0.12 + 0.88 * this.daylight);
  }

  /** Sky colours, sun, moon and stars for the time of day. */
  private updateCelestial(camera: THREE.Camera, time: number): void {
    const angle = (time / DAY_TICKS) * Math.PI * 2;
    // The sun rises in the east (+X), passes overhead and sets in the west.
    const sunDir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.18).normalize();
    const h = sunDir.y;
    const day = daylightAt(time);
    this.daylight = day;
    const dusk = Math.max(0, 1 - Math.abs(h) / 0.32);
    const u = this.skyUniforms;
    u.uSunDir.value.copy(sunDir);
    u.uTop.value.copy(NIGHT_TOP).lerp(DAY_TOP, day);
    u.uHorizon.value.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day);
    u.uHorizon.value.lerp(this.tmp.copy(DUSK_HORIZON).multiplyScalar(0.35 + 0.65 * day), dusk * 0.45);
    u.uGlowAmount.value = dusk;

    const d = 320;
    this.sun.position.copy(camera.position).addScaledVector(sunDir, d);
    this.sun.lookAt(camera.position);
    this.moon.position.copy(camera.position).addScaledVector(sunDir, -d);
    this.moon.lookAt(camera.position);
    this.stars.position.copy(camera.position);
    this.stars.rotation.set(0, 0, angle);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - day * 2.5);
  }
}

/** A textured square that always faces the camera from far away. */
function celestial(pixels: Uint8ClampedArray<ArrayBuffer>, size: number, additive: boolean): THREE.Mesh {
  const px = Math.sqrt(pixels.length / 4);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  canvas.getContext('2d')?.putImageData(new ImageData(pixels, px, px), 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }),
  );
  mesh.renderOrder = 0;
  mesh.frustumCulled = false;
  return mesh;
}

/** A fixed, deterministic star field on the upper sky. */
function createStars(): THREE.Points {
  const n = 700;
  const pos = new Float32Array(n * 3);
  let seed = 0x5eed;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(a) * r * 300;
    pos[i * 3 + 1] = u * 300;
    pos[i * 3 + 2] = Math.sin(a) * r * 300;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(
    g,
    new THREE.PointsMaterial({ color: 0xe8eeff, size: 2, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false }),
  );
  stars.frustumCulled = false;
  stars.name = 'stars';
  return stars;
}

/** Camera-centred gradient sphere drawn behind everything, with a dusk glow near the sun. */
function createDome(uniforms: Record<string, THREE.IUniform>): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      uniform float uGlowAmount;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.45, up));
        float g = pow(max(dot(d, uSunDir), 0.0), 5.0) * uGlowAmount * (1.0 - up * 0.8);
        c = mix(c, uGlow, clamp(g, 0.0, 0.85));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), material);
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
