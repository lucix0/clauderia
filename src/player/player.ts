import { PLAYER_EYE, REACH } from '../config';
import { B, collisionHeight } from '../world/blocks';
import { collisionBoxes, isShaped } from '../world/shapes';
import type { World } from '../world/world';
import { createBody, stepBody, type Body, type CollisionWorld, type MoveInput } from './physics';
import { raycast, type RayHit } from './raycast';

const PITCH_LIMIT = Math.PI / 2 - 0.001;

/**
 * Adapts the world to what the physics expects: map edges and unloaded chunks
 * are walls (so nothing ever falls through terrain that isn't there yet).
 */
export function collisionWorld(world: World): CollisionWorld {
  return {
    solidHeight(x, y, z) {
      if (y < 0 || !world.inColumnBounds(x, z)) return 1;
      const chunk = world.chunkAt(x, z);
      if (!chunk) return 1;
      if (y >= world.height) return 0;
      return collisionHeight(chunk.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)]! & 0xff);
    },
    liquidAt(x, y, z) {
      const id = world.getVirtual(x, y, z) & 0xff;
      return id === B.WATER ? 1 : id === B.LAVA ? 2 : 0;
    },
    boxes(x, y, z) {
      if (y < 0 || y >= world.height) return null;
      const value = world.get(x, y, z);
      return isShaped(value & 0xff) ? collisionBoxes(world, x, y, z, value) : null;
    },
    climbable(x, y, z) {
      return world.getId(x, y, z) === B.LADDER;
    },
  };
}

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
}

/** Player: physics body plus view angles and spawn point. */
export class Player {
  readonly body: Body;
  yaw = 0;
  pitch = 0;
  /** Feet position at the previous physics step, for render interpolation. */
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  spawn = { x: 0, y: 0, z: 0 };

  constructor() {
    this.body = createBody(0, 0, 0);
  }

  get eyeY(): number {
    return this.body.y + PLAYER_EYE;
  }

  /** Put the player at a feet position and remember it as the spawn point. */
  setSpawn(x: number, y: number, z: number): void {
    this.spawn = { x, y, z };
  }

  teleport(x: number, y: number, z: number): void {
    const b = this.body;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.onGround = false;
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
  }

  respawn(): void {
    this.teleport(this.spawn.x, this.spawn.y, this.spawn.z);
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw = (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
  }

  step(world: CollisionWorld, input: Omit<MoveInput, 'yaw'>, dt: number): void {
    this.prevX = this.body.x;
    this.prevY = this.body.y;
    this.prevZ = this.body.z;
    stepBody(world, this.body, { ...input, yaw: this.yaw }, dt);
  }

  /** Unit view direction. */
  viewDir(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  /** Block under the crosshair, measured from the interpolated eye. */
  target(world: World, eyeX: number, eyeY: number, eyeZ: number): RayHit | null {
    const [dx, dy, dz] = this.viewDir();
    return raycast(world, eyeX, eyeY, eyeZ, dx, dy, dz, REACH);
  }

  getState(): PlayerState {
    const b = this.body;
    return { x: b.x, y: b.y, z: b.z, yaw: this.yaw, pitch: this.pitch, flying: b.flying };
  }

  setState(s: PlayerState): void {
    this.teleport(s.x, s.y, s.z);
    this.yaw = s.yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, s.pitch));
    this.body.flying = s.flying;
  }
}
