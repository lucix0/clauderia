# Blocktide 2 — infinite worlds, biomes and survival

This extends the Classic-style game from PLAN.md with an infinite world type,
biomes, flood-fill lighting with a day cycle, and a survival mode with items,
crafting, fluids and mobs. `three` stays the only runtime dependency; logic
stays in pure, unit-tested modules; all art stays procedural.

## Architecture changes

### Coordinates and storage (`world/coords.ts`, `world/chunk.ts`, `world/world.ts`)
- Chunk columns are 16×16×128. Local index `(y << 8) | (z << 4) | x`, so a
  16³ section is one contiguous 4096-cell slice.
- Block values are `Uint16`: low byte = block id, high byte = state (fluid
  level, log axis, torch attachment, furnace facing/lit). Tables stay indexed
  by id (`v & 0xff`).
- `cx = floorDiv(x, 16)`, `lx = mod(x, 16)` everywhere, so negatives work.
  Chunk keys and block-position keys are packed into exact integers
  (< 2^53) for `Map` lookups.
- `World` owns a `Map<key, Chunk>`, the world type (`classic` | `infinite`),
  build height (Classic 64, Infinite 128), sea level (32 / 62) and, for
  Classic, the bounds. `setBlock` is still the single entry point: it updates
  light, marks dirty sections (and neighbour sections on borders) and applies
  neighbour effects. Unloaded chunks read as solid for physics, so nothing
  falls through them.
- Classic generation is unchanged (flat array from the finite generator),
  then sliced into chunks; outside the bounds the edge ocean is supplied as
  read-only virtual chunks.

### Rendering (`render/`)
- The mesher works on a padded 18×18×18 view of one 16³ section (built from
  the 3×3 chunk neighbourhood), emitting chunk-local positions. Empty sections
  produce nothing.
- Sections are meshed individually (cheap edits); for drawing, a column's
  sections are concatenated per pass into one geometry positioned at
  `(cx·16, 0, cz·16)`, keeping draw calls ~1 per visible column per pass.
- From M3 the vertex format carries face shade × tint (colour), `skyLight`
  and `blockLight` attributes; a `MeshBasicMaterial` patched with
  `onBeforeCompile` combines them with a shared `daylight` uniform, so the
  day cycle never remeshes. Fog is untouched (view-space).

### Streaming (`world/streamer.ts`, `workers/`)
- A pool of module workers (`hardwareConcurrency − 1`, 2–4) runs
  generate / light / mesh jobs. Results come back as transferable typed arrays.
- Chunk pipeline: `generated` → `lit` (needs 8 generated neighbours; the
  worker floods light over the 3×3 blocks and returns the centre) → `meshed`
  (needs 8 lit neighbours). Jobs are prioritised by distance and whether the
  column is in the view frustum, re-ranked every frame.
- Every chunk carries a version; a job result computed from stale inputs is
  dropped and re-requested. After a light result, border cells are stitched
  into lit neighbours with an add-pass.
- Radii: generate R+2, light R+1, mesh R (R = 4–16 chunks, default 8);
  unload beyond R+3. The main thread uploads geometry within a per-frame
  budget; player edits relight and remesh immediately on the main thread.
- Simulation gating: the player, mobs, items, fluids and block entities only
  tick in `lit` chunks; spawning waits for the ground to load.

### Lighting (`world/light.ts`)
- Per chunk `Uint8Array`: sky in the high nibble, block light in the low one.
  Sky 15 falls straight down through clear cells; everything else loses
  `max(1, opacity)` per step. Emitters: torch 14, lava 15, lit furnace 13.
- Edits: BFS removal pass then re-add pass, crossing chunk borders.

### Generation (`world/gen/`)
- Pure function of `(seed, cx, cz)`: continentalness / temperature /
  humidity / erosion noise → biome weights; terrain height parameters are
  blended over a radius, so borders never form cliffs. Caves are 3D-noise
  tunnels plus rarer caverns. Trees and ore veins are seeded per chunk and
  every chunk also draws the overlapping parts of its neighbours' features, so
  the result never depends on generation order.
- Per-column grass / foliage / water tints are blended and stored with the
  chunk for meshing.

### Survival (`survival/`, `items/`, `entities/`)
- Item registry separate from blocks (block items share ids < 256; items
  start at 256). Stacks of 64, tools unstackable with durability.
- Pure modules: inventory stack operations, recipe matching (shaped anywhere
  and mirrored, shapeless, tags), mining time and tier-gated drops, player
  vitals (health, hunger, saturation, air, fire, fall damage), furnace
  smelting, finite fluids.
- Entities share AABB physics with the player (`player/physics.ts`
  generalised to any box size), AI at 20 Hz, cuboid models with procedural
  textures.

## Save format v2 (IndexedDB `blocktide`, version 2)
- `worlds` store, key = world id: `{ formatVersion: 2, id, name, seed, type,
  classicSize?, gameMode, difficulty, lockDaytime, time, spawn, player,
  createdAt, lastPlayed }`. `player` holds position, orientation, flying,
  vitals and the inventory.
- `chunks` store, key = `"<worldId>/<cx>,<cz>"`, value = gzipped binary
  record: header (magic, version, cx, cz, flags), optional `Uint16` blocks
  (only when changed since generation), then a JSON section with block
  entities, dropped items and passive mobs. Unchanged chunks regenerate from
  the seed.
- Writes are batched into single transactions; modified chunks are written as
  they unload, and everything is flushed on pause and on page hide.
- v1 migration: on first open, the v1 `saves/latest` record becomes a Classic
  world; chunks that differ from a fresh regeneration are stored, then the v1
  record is removed.

## Milestones
- **M1** chunked storage (Uint16, negative-safe), section meshing, save v2 +
  v1 migration, title screen with world list (create / play / delete).
  Classic plays exactly as before; existing tests ported.
- **M2** Infinite streaming with the worker pool and a placeholder generator
  (terrain + caves); `/` command bar and `window.__game.command()`.
- **M3** flood-fill lighting, shader-side day/night with sun, moon, stars,
  time saved per world with a daytime lock, torches.
- **M4** biomes, blended heights and tints, rivers, new blocks and trees, ores.
- **M5** survival core: game modes, health/hunger/air, damage and death,
  items and inventory, mining and tools, item drops, crafting.
- **M6** furnace, chests, food, finite fluids, buckets.
- **M7** mobs, spawning, combat, difficulty.
- **M8** (stretch) smooth lighting / AO, leaf decay, farming, bow, beds,
  doors / ladders / fences, procedural sound.

After each milestone: `npm run typecheck && npm test && npm run build`, a
playable game, then a commit. `npm run bench` reports chunks/second for
generation, lighting and meshing; the Playwright smoke test grows with each
milestone.

## Decisions log (feeds the README's judgement calls)

- **M4 biomes**: eleven biomes (ocean, deep ocean, beach, plains, forest,
  taiga, snowy tundra, desert, swamp, mountains, river). Continentalness sets
  the base height and oceans; temperature × humidity pick the land biome;
  a separate "erosion" field raises mountains (continuous factor, so
  foothills blend in). Rivers are zero-crossings of their own noise: a
  valley eases the land to just above sea level and a channel cuts to
  sea − 3; they fade out at coasts and in mountains.
- Heights: per-biome offset / hill size / flatness are blended over a
  33-block kernel on a 4-block lattice, then bilinear per column.
- Tints: grass, leaves, tall grass and water textures are grey; a per-vertex
  tint multiplies them. Opaque tiles mark tinted pixels with alpha 128 (the
  grass side fringe), cutout / translucent tiles are tinted everywhere.
  Spruce and birch leaves use fixed colours. Classic keeps the old colours.
- Cave mouths: strong tunnels may cut through dry land surfaces; trees are
  never placed over one.
- Cactus collides as a full block (contact damage comes with survival);
  snow layers have no collision. Tall grass, dead bushes and snow layers are
  replaced by placing a block into them.
- `/locatebiome` returns the middle of the nearest patch (dry columns only
  for land biomes), with a y you can `/tp` to.
- **M5 survival**: new worlds default to Survival (Creative and Peaceful are
  options). Minecraft-like numbers: mining time = hardness × (1.5 if the tool
  can harvest, else 5) / tool speed; tiers wood/gold 0, stone 1, iron 2,
  diamond 3 (gold mines fastest but lasts 32 uses). Fall damage is
  ceil(distance − 3); drowning 2 per second after 15 s of air; lava 4 per
  half second plus 15 s of burning (water puts it out); cactus 1 on touch;
  suffocation 1 per half second; half a second of invulnerability after a hit.
  Starving stops at half a heart (Normal); Peaceful refills hunger and health.
- Hunger: exhaustion from sprinting (0.1/block), jumping (0.05, 0.2 sprinting),
  mining (0.005), damage (0.1) and healing; regen every 4 s at 18+ hunger,
  every half second when full with saturation left.
- E opens the inventory in Survival and the creative item grid in Creative
  (B too). Survival mining is hold-to-break with a crack overlay; a quarter
  second pause between blocks. Right click on a crafting table opens the 3×3
  grid (sneak to place against it instead). Eating: hold right click 1.6 s.
- Items drop from broken blocks, fly to the player within ~2.6 blocks, merge
  when close and vanish after five minutes; they are saved with their chunk.
- Only white wool is craftable (4 string); coloured wool, sponge and bedrock
  are Creative-only. Bookshelves drop 3 planks.
- **M6**: furnaces smelt one item per 10 s; fuel burn times (coal and
  charcoal 8 items, planks/logs 1.5, sticks 0.5, lava bucket 100, leaving
  the bucket). Ores smelt to ingots / gems (coal and diamond ore too), sand →
  glass, cobblestone → stone, clay block → bricks block, logs → charcoal,
  raw meat → cooked. A lit furnace is a block state that emits light 13.
  Furnaces and chests are block entities saved with their chunk; they only
  tick in loaded, lit chunks and spill their contents when broken.
- Finite fluids (Infinite worlds only; Classic keeps its spreading rules):
  level in the block state (0 source, 1–7 flowing, plus a falling flag);
  water reaches 7 blocks every 5 ticks, lava 3 blocks every 30 ticks; both
  prefer the direction whose nearest drop is closest (within 4 / 2 blocks).
  Two water sources make a third between them. Lava touched by water turns
  to obsidian (source) or cobblestone (flowing); lava flowing onto water
  makes stone. Surfaces are drawn per cell at (8 − level) / 9 height, with
  the step between neighbouring levels filled in (no corner smoothing).
- Buckets only scoop sources; pouring replaces air, plants, snow layers
  and flowing fluid. Creative keeps the empty bucket.
