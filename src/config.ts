/** Shared tuning constants. Pure data — safe to import from any module. */

/** Fixed simulation rate. */
export const STEP_HZ = 60;
export const STEP_DT = 1 / STEP_HZ;
/** Longest frame gap the accumulator will try to catch up on. */
export const MAX_FRAME_DT = 0.25;
/** Block behaviours tick every Nth physics step (60 / 3 = 20 ticks per second). */
export const STEPS_PER_TICK = 3;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;

export const WALK_SPEED = 4.3;
export const FLY_SPEED = 10.5;
export const FLY_VERTICAL_SPEED = 8;
export const GRAVITY = 32;
export const JUMP_HEIGHT = 1.25;
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
export const TERMINAL_VELOCITY = 60;
export const STEP_HEIGHT = 0.5;

export const REACH = 5;
export const ACTION_REPEAT_S = 0.25;

/** Face brightness (Classic-style directional shading). */
export const SHADE_TOP = 1.0;
export const SHADE_Z = 0.8;
export const SHADE_X = 0.6;
export const SHADE_BOTTOM = 0.5;

/** Render distance presets in chunks (F cycles through them). */
export const RENDER_DISTANCES: readonly number[] = [4, 6, 8, 12, 16];
export const DEFAULT_RENDER_DISTANCE = 8;
export const MIN_RENDER_DISTANCE = 4;
export const MAX_RENDER_DISTANCE = 16;

/** Per-frame time budget for main-thread remeshing of edited sections, in ms. */
export const REMESH_BUDGET_MS = 3;
/** Per-frame time budget for uploading worker-built meshes, in ms. */
export const UPLOAD_BUDGET_MS = 3;

export const AUTOSAVE_S = 60;

/** Seed used by the ?debug flag. */
export const DEBUG_SEED = 1337;
