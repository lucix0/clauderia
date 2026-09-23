# Add survival mode and infinite worlds with biomes

This repo is a browser voxel game in the style of Minecraft Classic (see README.md and PLAN.md). Read those and the code before changing anything.

We're adding two big features: an infinite world type with biomes, and a survival game mode. This replaces the survival, infinite-world and day/night non-goals in the original plan.

Existing rules still apply:
- TypeScript strict, and `three` stays the only runtime dependency.
- Core logic stays in pure, unit-tested modules.
- All art stays original and procedurally generated, including every new block, item, mob and icon.

Do the work on a new git branch so main stays playable.

## World model
- Replace the flat world array with chunk columns (16×16, 128 tall), stored in a map keyed by chunk coordinates.
  - Mesh per 16³ section, so edits stay cheap and empty sections cost nothing.
  - Negative coordinates must work everywhere. Use floor division and a positive modulo for chunk/local conversion.
- Two world types, chosen independently of game mode:
  - Infinite (new default): unbounded in X/Z, 128 tall, sea level ≈ 62.
  - Classic: the existing finite generator, sizes, edge ocean and bounds, now writing into chunk storage.
- Vertex positions stay chunk-local, and shaders never use world-space positions. That keeps rendering stable 100k+ blocks from the origin.

## Streaming
- Load chunks within the render distance (4–16 chunks, default 8). Unload beyond it with some hysteresis.
- Generation, initial lighting and meshing run in a Web Worker pool.
  - Pass data as transferable typed arrays.
  - Process the nearest and in-view chunks first.
  - The main thread only uploads geometry, within a per-frame budget.
- Block edits still remesh immediately on the main thread.
- Mesh a chunk only once its 8 neighbors are generated and lit. That way borders never show holes or remesh over and over.
- Nothing simulates in chunks that aren't loaded yet: the player, mobs, items and fluids all wait.
  - Nothing may ever fall through unloaded terrain.
  - Spawning and respawning wait for the ground to load.
- Target: steady 60 FPS while flying through new terrain at render distance 8 on a mid-range laptop.

## Saving
- Save format v2 in IndexedDB:
  - One gzipped record per chunk, only for chunks changed since generation. Unchanged chunks regenerate from the seed.
  - A chunk record includes its block entities, dropped items and passive mobs. Hostile mobs just despawn.
  - A world record holds metadata, player state and time.
- Batch writes into single transactions. Save chunks as they unload, and save everything on pause and quit.
- Migrate v1 saves into Classic worlds on first load.
- Add a title screen with a world list:
  - create (name, seed, world type, Classic size, game mode, difficulty)
  - play
  - delete, with confirmation

## Infinite generation and biomes
- Generation is a pure function of seed + coordinates. It must never depend on the order chunks are generated in.
  - Terrain, climate and caves come from noise. Caves are 3D-noise tunnels plus occasional larger caverns.
  - Features that cross chunk borders (trees, ore veins) come from deterministic per-chunk seeds. Each chunk also draws the parts of its neighbors' features that overlap it.
- Choose biomes from temperature and humidity noise, plus a continentalness noise for land vs. ocean:
  - ocean and deep ocean: sand, gravel and clay floors
  - beach
  - plains: tall grass, flowers, the odd oak
  - forest: oak and birch
  - taiga: spruce
  - snowy tundra: snow layer, frozen water
  - desert: sand over sandstone, cactus, dead bushes
  - swamp: shallow murky water, low oaks
  - mountains: tall stone peaks, snow above a height line
  - rivers: winding across the other biomes, frozen in cold ones
- Blend terrain height parameters across biome borders, so biomes never meet at a cliff.
- Blend grass, foliage and water tints per column, so colors shift gradually.
- The world spawn is on dry land near the origin.
- Add new blocks as needed:
  - sandstone, snow block, snow layer (thin, walk-over), ice (translucent)
  - cactus (slightly inset, hurts on contact)
  - dead bush, tall grass, clay
  - spruce and birch logs, leaves and planks
  - diamond ore (rare, deep)
- Block states (log axis, torch attachment, furnace facing and lit state, fluid level) can be extra IDs or a compact per-block state. Widen storage to Uint16 if IDs get tight.

## Lighting and day/night
- Replace the Classic column shadows with flood-fill lighting in all worlds:
  - skylight 0–15
  - block light: torch 14, lava 15, lit furnace 13
  - light propagates across chunk borders
  - edits relight incrementally (a removal pass, then a re-add pass)
- Send skylight and block light as separate vertex attributes. Combine them in the shader with a daylight uniform, so time of day never triggers remeshing. Keep fog working.
- Add a 20-minute day cycle:
  - sun, moon, and stars at night
  - sky and fog colors follow the time of day
  - time is saved per world
  - a per-world option to lock daytime

## Survival mode
Creative mode keeps what it has now: flying, instant breaking, `R` respawn, no damage or hunger. The block picker becomes a creative inventory listing every block and item.

### Player
- 20 health, 20 hunger, and 10 air bubbles underwater.
- Hunger drains faster when sprinting, jumping and mining.
- Health regenerates while hunger is high. An empty hunger bar hurts.
- Damage sources:
  - falls of more than 3 blocks
  - drowning
  - lava, with a lingering burn that water puts out
  - cactus
  - suffocation
  - mobs
- Each hit gives brief invulnerability, knockback and a red flash.
- Death screen with a Respawn button. The inventory drops where you died, and you respawn at the world spawn.
- Sprint by double-tapping W. Don't use Ctrl, because Ctrl+W closes the tab in most browsers.
- Sneak with Shift: it lowers the camera and stops you walking off edges.

### Items and inventory
- Add an item registry, separate from blocks. It holds block items plus:
  - sticks, coal, charcoal
  - iron and gold ingots, diamonds
  - apples, raw and cooked pork and beef
  - bones, which craft into bone meal (instantly grows saplings)
  - string (4 → wool)
  - buckets
- Stacks hold 64. Tools don't stack and show durability.
- `E` opens a 36-slot inventory (27 slots + hotbar) with a 2×2 crafting grid.
- Slot interactions:
  - left click picks up, places or swaps
  - right click takes half or places one
  - shift-click quick-moves
  - `Q` drops the selected item
  - hovering shows a tooltip
- Closing a screen returns crafting-grid items to the inventory, or drops them if it's full.

### Mining
- Break time comes from block hardness and the held tool. The wrong tool is slower.
- Some drops need a minimum tool tier:
  - stone and coal ore need any pickaxe
  - iron ore needs stone or better
  - gold and diamond ore need iron or better
- Tools: pickaxe, axe, shovel and sword, each in wood, stone, iron, gold and diamond. Gold is fast but fragile.
- A procedural crack overlay shows mining progress. Progress resets if you stop or look away.
- Drops follow sensible rules:
  - stone gives cobblestone
  - grass gives dirt
  - leaves sometimes give saplings or apples
  - glass gives nothing
- Dropped items are small bobbing entities.
  - A nearby player pulls them in and picks them up.
  - They merge with nearby stacks.
  - They despawn after 5 minutes.

### Crafting, containers, food
- Recipes are data:
  - shaped recipes match anywhere in the grid, and mirrored
  - shapeless recipes are supported
  - tags like "any planks" work as ingredients
- Essential recipes: planks, sticks, crafting table, torches, all tools, furnace, chest, bucket, and storage blocks for ingots and diamonds.
- Blocks with no sensible survival source stay creative-only (sponge, bedrock, colored wool).
- Right-clicking a crafting table (3×3), furnace or chest opens its screen.
- Furnace (block entity): input, fuel and output slots, with progress. It keeps smelting while its chunk is loaded. Smelting recipes:
  - ores → ingots
  - sand → glass
  - cobblestone → stone
  - raw meat → cooked
  - logs → charcoal
  - clay → bricks
- Chest (block entity): 27 slots. Its contents drop when broken.
- To eat, hold right click for about 1.5 s. Cooked food restores more than raw.

### Fluids
- Unlimited spread would never stop in an infinite world, so Infinite worlds use finite flow:
  - source blocks with flowing levels
  - water reaches about 7 blocks and heads for nearby drops
  - lava reaches about 3 blocks, more slowly
  - lower levels render with a lower surface
  - lava source + water → obsidian; flowing lava + water → cobblestone
- Buckets pick up and place source blocks.
- Classic worlds keep their current fluid behavior.

## Mobs
- Build a shared entity system:
  - AABB physics that reuses the player's collision code
  - health
  - AI that ticks at a lower rate than rendering
- Use simple cuboid models with procedural textures and walk and hurt animations.
  - Designs must be your own original look. Generic creature types are fine.
  - Don't recreate Minecraft's mob designs, and skip creatures original to Minecraft.
- Passive mobs: pig, cow and sheep.
  - They spawn with new chunks in grassy biomes.
  - They wander, and flee when hit.
  - They drop meat, and sheep drop wool.
- Hostile mobs:
  - zombie: a melee chaser
  - skeleton archer: keeps its distance and fires arrows that arc; drops bones
  - spider: fast, climbs walls, neutral in daylight; drops string
- Hostile spawning:
  - only in darkness (light ≤ 7), at least ~24 blocks from the player
  - capped in number
  - despawn when far away
  - undead burn in direct sunlight
- Steering is enough, no full pathfinding: head for the target, hop 1-block steps, avoid lava and big drops.
- Combat:
  - left click hits the targeted mob (entity raycast checked before blocks, ~3-block reach)
  - damage depends on the weapon
  - hits cause knockback and a hurt flash
  - mobs play a death animation, then drop loot
- Difficulty is Peaceful (no hostiles, health regenerates) or Normal.

## Test hooks (ship them)
- A `/` command bar with: `/tp`, `/gamemode`, `/time set`, `/give`, `/setblock`, `/summon`, `/kill`, `/seed`, `/biome`, `/locatebiome <name>`, `/difficulty`.
- The same commands can be called from the `?debug` API as `window.__game.command(...)`.
- The F3 overlay adds: chunk coords, biome, sky and block light at the player, loaded chunks, worker queue, entity count.

## Non-goals
Multiplayer, Nether/End, redstone, XP/enchanting, potions, villages and other structures, boats and minecarts, armor, weather, touch controls, vertical infinity. Aim for the feel of survival, not exact vanilla numbers.

## How to work
1. Read the codebase. Write PLAN-2.md covering the architecture changes, save format v2 and milestones. Then build without waiting for me. If something is ambiguous, make a sensible call, note it in the README, and keep going.
2. Milestones:
   - M1: chunked storage, save v2 and migration, title screen and world list. Classic worlds must play exactly as before, and existing tests must pass (updated for the new API).
   - M2: Infinite streaming with workers and a placeholder generator (terrain + caves). Add the command bar and debug API.
   - M3: flood-fill lighting, day/night, torches.
   - M4: biomes, blending and tints, rivers, new blocks and trees, ores.
   - M5: survival core: game modes, health/hunger/air, damage and death, items and inventory, mining and tools, item drops, crafting.
   - M6: furnace, chests, food, finite fluids, buckets.
   - M7: mobs, spawning, combat, difficulty.
   - M8 (stretch, only once M1–M7 are solid): smooth lighting with AO, leaf decay, farming (hoe, seeds, wheat, bread), bow and arrows for the player, beds, doors/ladders/fences, simple procedural sound effects.
3. After each milestone, `typecheck`, `test` and `build` must pass and the game must be playable. Then commit. Don't present TODO stubs as finished features.
4. Write unit tests for at least:
   - coordinate math with negative coordinates
   - same seed → identical chunks, and building a 3×3 area in two different orders → identical blocks
   - continuous terrain height across biome borders
   - light spread and removal, including across chunk borders
   - recipe matching (offset, mirrored, shapeless, tags)
   - inventory stack operations
   - mining time and tier-gated drops
   - fall damage and drowning timers
   - finite flow and lava/water reactions
   - furnace smelting and fuel use
   - save v2 round-trip and v1 migration
5. Add `npm run bench`: a Node script reporting chunks/second for generation, lighting and meshing.
6. Extend (or create) the Playwright smoke test. Using the debug API, take screenshots of:
   - spawn at noon and at midnight
   - a torch-lit cave
   - each biome, found with `/locatebiome` and `/tp`
   - the survival HUD and inventory screen
   Inspect them for holes at chunk borders, lighting seams, missing biome variety and broken UI.
7. Finish with a summary: new controls and commands, what's done, known issues, next steps. Update the README.
