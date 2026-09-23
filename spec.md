# Build a browser voxel sandbox inspired by Minecraft Classic

Build a simple, polished, single-player block-building game that runs in the browser and plays like Minecraft Classic (the 2009 creative-mode version). It should have a fixed-size generated world, first-person movement, and instant block breaking and placing from a palette of about 50 blocks. It's a static site with no backend. Scaffold it in the current directory.

Give the game its own original name. Don't use Minecraft's name, logo, textures, or sounds. All art is generated procedurally (see Textures).

## Stack
- Vite + TypeScript (strict, avoid `any`) + three.js. `three` is the only runtime dependency. Write the seeded PRNG and noise yourself.
- Vitest for unit tests. npm scripts: `dev`, `build`, `preview`, `typecheck`, `test`.
- Target latest desktop Chrome/Firefox/Edge. The default world size should run at 60 FPS on integrated laptop graphics.

## World
- Fixed size, 64 blocks tall: Small 128×128, Normal 256×256 (default), Large 512×512. Store block IDs in a flat `Uint8Array`.
- The player can't walk off the map. Outside it, render a flat ocean at sea level out to the horizon, with a bedrock floor just below, like Classic.
- Seeded, deterministic generation in the Classic style:
  - a noise heightmap around sea level (half the world height)
  - dirt over stone, with a bedrock floor
  - worm-style caves
  - ore veins (coal common, iron mid, gold rare and deep)
  - ocean flood-filled inward from the map edges so enclosed caves stay dry (iterative, not recursive)
  - lava pools near the bottom
  - sand and gravel beaches, grass on exposed dirt
  - trees, and patches of flowers and mushrooms
- Show a "Generating level…" progress screen. A Normal world should be playable within a few seconds. Spawn on dry land near the center.

## Blocks
Use a registry where each block defines: name, texture tile per face, solid (collides), blocks light, render shape (cube / cross / slab), and render pass (opaque / cutout / translucent).

The blocks are: stone, grass, dirt, cobblestone, planks, log, leaves, glass, sand, gravel, bedrock, water, lava, coal/iron/gold ore, iron block, gold block, bricks, mossy cobblestone, obsidian, sponge, bookshelf, TNT (decorative), slab and double slab, 16 wool colors, dandelion, rose, red and brown mushrooms, and sapling.
- A slab placed on a slab merges into a double slab.
- Flowers, mushrooms and saplings are non-solid X-shaped sprites (two diagonal quads). They pop off when the block under them is removed.
- Water and lava are non-solid and static for now, and the player swims through them. Water is translucent; lava is opaque and always fully lit.
- The bottom bedrock layer can't be broken.

## Textures
- Generate every texture at startup as deterministic 16×16 pixel-art tiles drawn into one canvas atlas. They should be readable and cohesive:
  - dithered stone, dirt and sand
  - grass top, plus a grass-over-dirt side
  - log bark and rings, plank boards
  - outlined cobblestone, speckled ores
  - leaves and glass with transparent pixels
  - translucent water
- Atlas settings: `NearestFilter`, no mipmaps, and UVs inset slightly to prevent atlas bleeding. Set the atlas texture's colorSpace to sRGB so colors aren't washed out.

## Rendering
- Never use one mesh per block. Split the world into chunks (16³ is fine; go larger if draw calls become the bottleneck).
  - Build one merged `BufferGeometry` per chunk per render pass.
  - Emit only faces that touch air or a non-occluding block.
  - Cull faces between two blocks of the same transparent type (glass–glass, water–water).
  - Skip greedy meshing; it complicates atlas tiling.
- Use three render passes:
  - opaque
  - cutout (leaves, glass, plants): alpha test, sprites double-sided
  - translucent water: blended, no depth write, drawn last
- Use unlit materials (e.g. `MeshBasicMaterial` + vertex colors) with lighting baked in, Classic style:
  - Each face gets a brightness: ≈1.0 top, 0.8 and 0.6 for the two side axes, 0.5 bottom.
  - Multiply by a shadow factor (≈0.6) when the cell the face looks into is below the highest light-blocking block in its column.
  - Keep a per-column height map and update it on every edit.
- Remesh only dirty chunks, within a per-frame time budget. Rebuild the chunk the player just edited immediately.
  - Also dirty neighbor chunks when an edit sits on a chunk border.
  - When a column's light height changes, dirty every chunk between the old and new height in that column and its four neighbor columns.
  - Dispose of old geometry.
- Sky color with distance fog. `F` cycles render-distance presets. Use dense blue or orange fog when the camera is in water or lava. Add a slowly drifting flat cloud layer.

## Player and controls
- First-person camera with pointer lock (yaw/pitch, pitch clamped), behind a "Click to play" overlay.
  - `Esc`, or losing pointer lock for any reason, opens the pause menu.
  - The click that resumes must not also break or place a block.
- Physics on a fixed 60 Hz step with an accumulator (clamp long frame gaps):
  - AABB 0.6 × 1.8 × 0.6, eye height 1.62
  - walk ≈ 4.3 blocks/s, gravity ≈ 32 blocks/s², jump height ≈ 1.25 blocks
  - Resolve collisions one axis at a time against solid blocks (respecting slab height), so the player never tunnels through floors or sticks to walls.
  - Movement is slower in water and lava, and Space swims up.
- Keys: WASD move, Space jump, `Z` toggles fly (Space up, Shift down), `R` respawns at spawn.
- Target blocks with a voxel DDA raycast (not three.js `Raycaster`), 5-block reach. Draw an outline around the targeted block's bounds.
  - Left click breaks.
  - Right click places against the hit face, never overlapping the player.
  - Middle click copies the targeted block into the selected hotbar slot.
  - Holding a button repeats every ~0.25 s. Suppress the context menu.

## UI (HTML/CSS overlay)
- Crosshair.
- 9-slot hotbar (keys 1–9, mouse wheel). Default contents: stone, cobblestone, bricks, dirt, planks, log, leaves, glass, slab.
- `B` opens a block picker grid of every block except air. Clicking one puts it in the selected hotbar slot.
  - Icons are small isometric cubes drawn from the atlas with 2D canvas transforms. X-shaped blocks use flat sprites.
- Pause menu: Resume, Save, Load, New World (size + seed), Settings (mouse sensitivity, FOV, render distance, invert Y; persisted in localStorage).
- `F3` debug overlay: FPS, position, targeted block, chunk rebuilds, draw calls.

## Saving
- Save to IndexedDB, gzipped with `CompressionStream`:
  - the world (blocks, size, seed)
  - player position and orientation
  - hotbar
- Autosave every 60 s and on pause.
- On startup, load the last save if there is one. Otherwise generate a Normal world with a random seed.

## Architecture
- Use small, focused modules, e.g.:
  - `world/`: storage, registry, generator, height map
  - `render/`: atlas, mesher, chunk manager, sky
  - `player/`: input, physics, raycast
  - `ui/`, `save/`
  - `util/`: PRNG, noise
- Keep the mesher, raycast, collision, generator and serialization pure (no three.js or DOM) so they're unit-testable.
- Route every block change through a single `setBlock(x, y, z, id)`. It updates the height map, marks dirty chunks, and handles neighbor effects.

## Non-goals
Survival (health, inventory, crafting, mobs), infinite worlds, day/night, multiplayer, touch controls, sound.

## How to work
1. Write a short PLAN.md (file layout + milestones), then build without waiting for me. When something is ambiguous, make a sensible call, note it in the README, and keep going.
2. Milestones:
   - M1: scaffold, game loop, block registry, texture atlas, chunk mesher, fly camera over a flat test world.
   - M2: generator, lighting, all three render passes, sky/fog/edge ocean, loading screen.
   - M3: player physics, pointer lock, raycast, break/place/pick, hotbar and picker, live remeshing.
   - M4: menus, settings, save/load, new world, debug overlay, README.
   - M5 (only once M1–M4 are solid): Classic block behaviors on a tick:
     - sand and gravel fall
     - water and lava spread Classic-style: unlimited spread, lava slower, with capped updates per tick so floods can't stall the game
     - sponges clear and block water within 2 blocks
     - saplings grow into trees
     - grass spreads onto lit dirt and dies when covered
3. After each milestone, `typecheck`, `test` and `build` must all pass. Then commit with a descriptive message (git init first if needed). Don't present TODO stubs as finished features.
4. Unit tests at minimum:
   - world indexing
   - mesher culling (two adjacent cubes → 10 faces)
   - raycast hit block and face
   - collision (lands on ground, blocked by walls, can't place inside self)
   - save round-trip
   - same seed → identical world
5. Visual check:
   - Add a `?debug` URL flag that uses a fixed seed, skips the click-to-play overlay, and puts the camera at a fixed viewpoint. It should set `window.__ready = true` once the world is meshed.
   - If you can, write a Playwright smoke test that opens the preview build with that flag, fails on any console error, and saves a screenshot for you to inspect. Headless Chromium may need software-GL flags such as `--use-angle=swiftshader` or `--enable-unsafe-swiftshader`.
   - If headless WebGL won't cooperate in reasonable time, skip the smoke test and tell me what to check by hand.
6. Finish with a summary: how to run it, controls, what's done, known issues, and next steps.
