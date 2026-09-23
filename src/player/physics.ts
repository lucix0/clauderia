/**
 * Pure player physics: AABB vs voxel collision resolved one axis at a time,
 * plus the fixed-step movement model (walk / jump / swim / fly).
 */
import {
  FLY_SPEED,
  FLY_VERTICAL_SPEED,
  GRAVITY,
  JUMP_VELOCITY,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  STEP_HEIGHT,
  TERMINAL_VELOCITY,
  WALK_SPEED,
} from '../config';

/** What the physics needs from the world. */
export interface CollisionWorld {
  /**
   * Height (0..1) of the solid collision box in a cell: 0 = passable,
   * 1 = full block, 0.5 = slab. Cells outside the map count as walls.
   */
  solidHeight(x: number, y: number, z: number): number;
  /** Liquid in a cell: 0 none, 1 water, 2 lava. */
  liquidAt(x: number, y: number, z: number): number;
}

export interface Body {
  /** Feet position: centre of the bottom of the AABB. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  /** Last move was blocked horizontally. */
  hitWall: boolean;
  flying: boolean;
  /** 0 none, 1 water, 2 lava (body immersion). */
  liquid: number;
}

export interface MoveInput {
  /** -1..1 along the facing direction. */
  forward: number;
  /** -1..1 to the right. */
  strafe: number;
  jump: boolean;
  /** Descend while flying. */
  down: boolean;
  /** Facing, radians. yaw 0 looks toward -Z. */
  yaw: number;
}

export function createBody(x: number, y: number, z: number): Body {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, hitWall: false, flying: false, liquid: 0 };
}

const HALF = PLAYER_WIDTH / 2;
const EPS = 1e-7;

interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function bodyBox(x: number, y: number, z: number): Box {
  return { minX: x - HALF, minY: y, minZ: z - HALF, maxX: x + HALF, maxY: y + PLAYER_HEIGHT, maxZ: z + HALF };
}

/** Collect the collision boxes of every solid cell touching the swept region. */
function gatherBoxes(world: CollisionWorld, b: Box, dx: number, dy: number, dz: number): Box[] {
  const minX = Math.floor(Math.min(b.minX, b.minX + dx) - EPS);
  const minY = Math.floor(Math.min(b.minY, b.minY + dy) - EPS) - 1;
  const minZ = Math.floor(Math.min(b.minZ, b.minZ + dz) - EPS);
  const maxX = Math.floor(Math.max(b.maxX, b.maxX + dx) + EPS);
  const maxY = Math.floor(Math.max(b.maxY, b.maxY + dy) + EPS);
  const maxZ = Math.floor(Math.max(b.maxZ, b.maxZ + dz) + EPS);
  const out: Box[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const h = world.solidHeight(x, y, z);
        if (h > 0) out.push({ minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + h, maxZ: z + 1 });
      }
    }
  }
  return out;
}

function clipY(boxes: Box[], b: Box, dy: number): number {
  for (const o of boxes) {
    if (o.maxX <= b.minX + EPS || o.minX >= b.maxX - EPS) continue;
    if (o.maxZ <= b.minZ + EPS || o.minZ >= b.maxZ - EPS) continue;
    if (dy > 0 && o.minY >= b.maxY - EPS) dy = Math.min(dy, o.minY - b.maxY);
    else if (dy < 0 && o.maxY <= b.minY + EPS) dy = Math.max(dy, o.maxY - b.minY);
  }
  return dy;
}

function clipX(boxes: Box[], b: Box, dx: number): number {
  for (const o of boxes) {
    if (o.maxY <= b.minY + EPS || o.minY >= b.maxY - EPS) continue;
    if (o.maxZ <= b.minZ + EPS || o.minZ >= b.maxZ - EPS) continue;
    if (dx > 0 && o.minX >= b.maxX - EPS) dx = Math.min(dx, o.minX - b.maxX);
    else if (dx < 0 && o.maxX <= b.minX + EPS) dx = Math.max(dx, o.maxX - b.minX);
  }
  return dx;
}

function clipZ(boxes: Box[], b: Box, dz: number): number {
  for (const o of boxes) {
    if (o.maxY <= b.minY + EPS || o.minY >= b.maxY - EPS) continue;
    if (o.maxX <= b.minX + EPS || o.minX >= b.maxX - EPS) continue;
    if (dz > 0 && o.minZ >= b.maxZ - EPS) dz = Math.min(dz, o.minZ - b.maxZ);
    else if (dz < 0 && o.maxZ <= b.minZ + EPS) dz = Math.max(dz, o.maxZ - b.minZ);
  }
  return dz;
}

function offset(b: Box, dx: number, dy: number, dz: number): Box {
  return {
    minX: b.minX + dx,
    minY: b.minY + dy,
    minZ: b.minZ + dz,
    maxX: b.maxX + dx,
    maxY: b.maxY + dy,
    maxZ: b.maxZ + dz,
  };
}

export interface MoveResult {
  dx: number;
  dy: number;
  dz: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  landed: boolean;
}

/** Sweep the box by (dx, dy, dz): Y first, then X, then Z. Never tunnels. */
function sweep(world: CollisionWorld, start: Box, dx: number, dy: number, dz: number): { box: Box; dx: number; dy: number; dz: number } {
  const boxes = gatherBoxes(world, start, dx, dy, dz);
  const ry = clipY(boxes, start, dy);
  let b = offset(start, 0, ry, 0);
  const rx = clipX(boxes, b, dx);
  b = offset(b, rx, 0, 0);
  const rz = clipZ(boxes, b, dz);
  b = offset(b, 0, 0, rz);
  return { box: b, dx: rx, dy: ry, dz: rz };
}

/**
 * Move a body by a displacement, resolving collisions axis by axis. When the
 * body starts on the ground and is blocked horizontally, it tries to step up
 * onto ledges up to STEP_HEIGHT (slabs).
 */
export function moveBody(world: CollisionWorld, body: Body, dx: number, dy: number, dz: number): MoveResult {
  const start = bodyBox(body.x, body.y, body.z);
  let r = sweep(world, start, dx, dy, dz);

  const blockedH = Math.abs(r.dx - dx) > EPS || Math.abs(r.dz - dz) > EPS;
  if (blockedH && body.onGround && dy <= 0) {
    // Step-up: lift, move horizontally, drop back down.
    const upBoxes = gatherBoxes(world, start, 0, STEP_HEIGHT, 0);
    const lift = clipY(upBoxes, start, STEP_HEIGHT);
    const lifted = offset(start, 0, lift, 0);
    const moved = sweep(world, lifted, dx, 0, dz);
    const downBoxes = gatherBoxes(world, moved.box, 0, -lift + Math.min(0, dy), 0);
    const drop = clipY(downBoxes, moved.box, -lift + Math.min(0, dy));
    const stepped = { box: offset(moved.box, 0, drop, 0), dx: moved.dx, dy: lift + drop, dz: moved.dz };
    if (stepped.dx * stepped.dx + stepped.dz * stepped.dz > r.dx * r.dx + r.dz * r.dz + EPS) r = stepped;
  }

  body.x = (r.box.minX + r.box.maxX) / 2;
  body.y = r.box.minY;
  body.z = (r.box.minZ + r.box.maxZ) / 2;
  const hitX = Math.abs(r.dx - dx) > EPS;
  const hitZ = Math.abs(r.dz - dz) > EPS;
  const hitY = Math.abs(r.dy - dy) > EPS && Math.abs(dy) > EPS && !(r.dy > 0 && dy < 0);
  const landed = dy < 0 && r.dy > dy + EPS;
  return { dx: r.dx, dy: r.dy, dz: r.dz, hitX, hitY, hitZ, landed };
}

/** Which liquid the body is immersed in (lava wins). */
export function liquidAround(world: CollisionWorld, body: Body): number {
  const x0 = Math.floor(body.x - HALF + 0.001);
  const x1 = Math.floor(body.x + HALF - 0.001);
  const z0 = Math.floor(body.z - HALF + 0.001);
  const z1 = Math.floor(body.z + HALF - 0.001);
  const y0 = Math.floor(body.y + 0.1);
  const y1 = Math.floor(body.y + PLAYER_HEIGHT * 0.6);
  let found = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const l = world.liquidAt(x, y, z);
        if (l === 2) return 2;
        if (l > found) found = l;
      }
    }
  }
  return found;
}

/** Does the player's box overlap cell (x, y, z) with a collision box of height h? */
export function bodyOverlapsCell(body: Body, x: number, y: number, z: number, h = 1): boolean {
  const b = bodyBox(body.x, body.y, body.z);
  return b.maxX > x + EPS && b.minX < x + 1 - EPS && b.maxY > y + EPS && b.minY < y + h - EPS && b.maxZ > z + EPS && b.minZ < z + 1 - EPS;
}

function approach(v: number, target: number, rate: number, dt: number): number {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

/** Advance the body by one fixed step. */
export function stepBody(world: CollisionWorld, body: Body, input: MoveInput, dt: number): void {
  body.liquid = body.flying ? 0 : liquidAround(world, body);

  // Wish direction on the ground plane.
  let fx = input.forward;
  let fs = input.strafe;
  const len = Math.hypot(fx, fs);
  if (len > 1) {
    fx /= len;
    fs /= len;
  }
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // yaw 0 → forward is -Z, right is +X.
  const wishX = -sin * fx + cos * fs;
  const wishZ = -cos * fx - sin * fs;

  let dy: number;
  if (body.flying) {
    body.vx = approach(body.vx, wishX * FLY_SPEED, 12, dt);
    body.vz = approach(body.vz, wishZ * FLY_SPEED, 12, dt);
    const vertical = (input.jump ? 1 : 0) - (input.down ? 1 : 0);
    body.vy = approach(body.vy, vertical * FLY_VERTICAL_SPEED, 12, dt);
    dy = body.vy * dt;
  } else if (body.liquid) {
    const mul = body.liquid === 2 ? 0.35 : 0.5;
    body.vx = approach(body.vx, wishX * WALK_SPEED * mul, 8, dt);
    body.vz = approach(body.vz, wishZ * WALK_SPEED * mul, 8, dt);
    if (input.jump) {
      body.vy = approach(body.vy, body.liquid === 2 ? 2.2 : 3.2, 6, dt);
      // Climb out over a ledge.
      if (body.hitWall) body.vy = Math.max(body.vy, 5.5);
    } else {
      body.vy = approach(body.vy, body.liquid === 2 ? -1.2 : -2.2, 3, dt);
    }
    dy = body.vy * dt;
  } else {
    const rate = body.onGround ? 20 : 6;
    body.vx = approach(body.vx, wishX * WALK_SPEED, rate, dt);
    body.vz = approach(body.vz, wishZ * WALK_SPEED, rate, dt);
    if (input.jump && body.onGround) body.vy = JUMP_VELOCITY;
    // Exact parabola over the step (velocity Verlet) so jump height matches.
    dy = body.vy * dt - 0.5 * GRAVITY * dt * dt;
    body.vy = Math.max(-TERMINAL_VELOCITY, body.vy - GRAVITY * dt);
  }

  const wasOnGround = body.onGround;
  const r = moveBody(world, body, body.vx * dt, dy, body.vz * dt);
  if (r.hitX) body.vx = 0;
  if (r.hitZ) body.vz = 0;
  body.hitWall = r.hitX || r.hitZ;
  if (r.landed) {
    body.onGround = true;
    body.vy = 0;
  } else {
    if (r.hitY) body.vy = 0;
    // Still standing if a probe just below finds support.
    body.onGround = wasOnGround && dy <= 0 ? probeGround(world, body) : r.landed;
  }
}

function probeGround(world: CollisionWorld, body: Body): boolean {
  const b = bodyBox(body.x, body.y, body.z);
  const boxes = gatherBoxes(world, b, 0, -0.01, 0);
  return clipY(boxes, b, -0.01) > -0.01 + EPS;
}
