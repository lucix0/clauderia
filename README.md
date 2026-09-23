# Blocktide

A single-player block sandbox for the browser: endless procedurally generated
worlds with biomes, rivers, caves and ores, a day/night cycle with flood-fill
and smooth lighting, and a survival mode with hunger, crafting, smelting,
farming, finite fluids, mobs, a bow and beds. The original fixed-size
"Classic" worlds are still there. Every texture, model, icon and sound is
generated in code at startup; there are no assets, no backend and no network
access.

Built with Vite + TypeScript (strict) + three.js, the only runtime dependency.

## Running it

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
npm run smoke      # build, then the headless Playwright smoke test (screenshots in artifacts/)
npm run bench      # chunk pipeline throughput: generation, lighting, meshing (chunks/s)
```

URL flags:

| Flag | Effect |
| --- | --- |
| `?debug` | Skips the title screen: a throwaway Creative world (seed 1337, noon, clock stopped, never saved), a fixed camera and `window.__game` for scripting. `window.__ready` turns true once the world is on screen. |
| `?type=classic` | With `?debug`: a Classic world instead of an Infinite one. |
| `?size=small\|normal\|large` | With `?debug&type=classic`: the Classic world size. |
| `?api` | Exposes `window.__game` (and `__ready`) for normal, saved worlds. |

## Playing

The title screen lists your worlds (newest first). **Create new world** asks
for a name, a seed (blank = random, text is hashed), the world type (Infinite
or Classic, with a size), the game mode (Survival or Creative) and, for
Survival, the difficulty (Normal or Peaceful). Worlds can be played or deleted
(with a confirmation). An old single-slot save from the first version is
converted into a Classic world automatically.

### Controls

| Input | Action |
| --- | --- |
| Click | Capture the mouse and play |
| Mouse | Look |
| `W` `A` `S` `D` | Move; double-tap `W` to sprint |
| `Space` | Jump; swim up; fly up |
| `Shift` | Sneak (lower eyes, slower, won't walk off edges, hold still on a ladder); fly down |
| Left click | Survival: hold to mine (a crack shows progress), hit mobs. Creative: break instantly (hold to repeat) |
| Right click | Place the held block; use a crafting table, furnace, chest, door or bed (sneak to place against them instead); hold to eat food; buckets scoop / pour; a hoe tills grass or dirt; seeds sow farmland; bone meal grows saplings and crops |
| Hold right click with a bow | Draw (the view zooms in); let go to shoot. Survival needs arrows |
| Middle click | Creative: copy the block into the selected slot. Survival: select it if it's on the hotbar |
| `1`–`9`, mouse wheel | Select hotbar slot |
| `E` | Survival: inventory with a 2×2 crafting grid. Creative: every block and item |
| `B` | Same as `E` |
| `Q` | Drop one of the held item (`Ctrl+Q` the whole stack); over a slot in a screen, drop from that slot |
| `Z` | Creative: toggle flying |
| `R` | Creative: respawn at the world spawn |
| `F` | Cycle render distance (4, 6, 8, 12, 16 chunks) |
| `/` | Command bar |
| `F3` | Debug overlay |
| `Esc` | Pause menu: resume, save, settings (mouse, field of view, render distance, smooth lighting, sound volume), save & quit to the title screen |

Walk into a ladder (or jump) to climb it. Sound starts with the click that
captures the mouse.

In inventory screens: left click picks up / puts down / swaps a stack, right
click picks up half or puts down one, shift-click moves a stack to the other
section (or crafts as many as possible from the result slot), clicking outside
the panel throws what you're holding. Closing a crafting grid returns its
contents to the inventory (or drops them).

### Commands

Typed in the `/` bar, or run from scripts with `window.__game.command('/…')`
(`?debug` / `?api`). Coordinates accept `~` and `~n` (relative).

| Command | Does |
| --- | --- |
| `/help` | List commands |
| `/tp <x> <y> <z>` | Teleport |
| `/gamemode <creative\|survival>` | Switch game mode |
| `/time set <ticks\|day\|noon\|sunset\|night\|midnight\|sunrise>` | Set the time of day (24000 ticks = 20 minutes) |
| `/give <item> [count]` | Items by name (`iron_ingot`, `diamond_pickaxe`, `oak_log`, `torch`…) |
| `/setblock <x> <y> <z> <block>` | Place a block by name or id |
| `/summon <pig\|cow\|sheep\|zombie\|skeleton\|spider> [x y z]` | Spawn a mob (in front of you by default) |
| `/kill [@s\|@e\|<mob>]` | Kill yourself, every mob, or one kind |
| `/seed` | Show the world seed |
| `/biome` | The biome you're standing in |
| `/locatebiome <name>` | Nearest patch of a biome, with coordinates you can `/tp` to |
| `/difficulty <peaceful\|normal>` | Set the difficulty |

F3 shows FPS and frame time, position, chunk and facing, the targeted block,
section rebuilds, streaming (loaded / meshed chunks, busy workers, queued
jobs), draw calls, triangles, sky and block light at your eyes, the time of
day, entity counts (mobs, items, arrows) and the biome.

## What's in it

**Worlds.** *Infinite* worlds (the default) are unbounded in X and Z and 128
blocks tall with the sea at y = 62. *Classic* worlds keep the original
generator (Small 128², Normal 256², Large 512², 64 tall, an endless ocean
outside the map) but now live in the same chunked storage.

**Chunks and streaming.** The world is a map of 16×16×128 chunk columns,
meshed as 16³ sections and drawn as one merged geometry per column and render
pass, with chunk-local vertex positions (so rendering is stable 100 000
blocks from the origin). Negative coordinates use floor division and a
positive modulo. A pool of 2–4 Web Workers generates, lights and meshes
columns, nearest and in-view first, transferring typed arrays both ways;
the main thread only copies neighbour borders and uploads finished meshes
within a small per-frame budget. A column is meshed once all eight
neighbours are generated and lit; chunks load within the render distance
(default 8) plus a margin and unload further out. Player edits remesh
immediately on the main thread. Nothing simulates in chunks that aren't
loaded and lit, and the player waits for the ground to exist.

**Generation.** A pure function of seed and chunk position (so chunks come out
identical in any order). Continentalness decides oceans and coasts;
temperature and humidity pick the land biome; an "erosion" field raises
mountains; rivers follow the zero line of their own noise. Biome heights and
colours are blended over a 33-block kernel so borders never form cliffs.
Eleven biomes: ocean and deep ocean (sand, gravel and clay floors), beach,
plains, forest (oak and birch), taiga (spruce), snowy tundra (snow layers,
frozen water), desert (sand over sandstone, cacti, dead bushes), swamp
(shallow murky water, low wide oaks), mountains (stone peaks, snow line) and
rivers (frozen in the cold). 3D noise carves spaghetti tunnels and larger
caverns, with lava below y = 10 and the odd cave mouth. Trees and ore veins
(coal, iron, gold, deep diamonds, dirt and gravel pockets) are seeded per
chunk and drawn by every chunk they reach. You spawn on dry land near the
origin.

**Lighting.** Flood-fill sky light (0–15, falling straight down undimmed) and
block light (torches 14, lava 15, a burning furnace 13), computed per column
in the workers across chunk borders and updated incrementally on every edit
(removal then re-add). Sky and block light are separate vertex attributes;
a daylight uniform dims the sky in the shader, so the time of day never
remeshes anything. Torch light is warm, moonlight slightly blue.

**Day and night.** A 20-minute day: sun, moon and stars, a sky that fades
through dusk and dawn, fog that follows the sky. The time is saved per
world; a world can lock daytime (pause menu).

**Smooth lighting.** On by default (Settings): every face corner averages the
light of the four cells in front of it and darkens with ambient occlusion
where blocks meet, with the quad split along the smoother diagonal. Turning
it off remeshes everything with flat per-face light.

**Blocks.** 73 blocks, including sandstone, snow block and snow layer,
translucent ice, cactus (inset, and it hurts), dead bush, tall grass, clay,
spruce and birch logs / leaves / planks, diamond ore and block, crafting
table, furnace, chest, bed, farmland, wheat, door, ladder and fence. Block
states: log axis, torch and ladder attachment, facing (furnace, chest, bed,
door), furnace lit, door open, crop stage, moist farmland, fluid level,
persistent (placed) leaves. Grass, leaves, tall grass and water take their
colour from the biome. Leaves more than four blocks from a log of their tree
decay (dropping saplings and apples); placed leaves never do.

**Doors, ladders, fences.** Their geometry comes from one module used for
drawing, collision and targeting. Doors are two tall, face away from you,
swing open to your left with a click and block mobs. Ladders hang on walls;
walking into one climbs it, sneaking holds on and letting go slides down
slowly without fall damage. Fences join each other and solid blocks and are
1.5 blocks tall to collide with, so they can't be jumped.

**Survival.** 20 health, 20 hunger (with saturation and exhaustion) and 10 air
bubbles. Sprinting, jumping, mining and healing cost hunger; health
regenerates when well fed and starving stops at half a heart. Damage from
falls (over 3 blocks), drowning, lava (with lingering fire that water puts
out), cacti, suffocation, mobs and arrows, with a moment of invulnerability,
knockback, a red flash and a camera shake. Dying shows a death screen; your
inventory spills where you fell and you respawn at your bed, or the world
spawn if you have none (or it's gone).

**Beds.** Using a bed makes it your respawn point. At night, with no monsters
within 8 blocks, you sleep: the view fades out and the clock jumps to sunrise.
Taking damage or leaving the game wakes you.

**Farming.** A hoe tills grass or dirt into farmland, which is moist within
four blocks of water, dries away from it, and turns back to dirt when bare
for a while or covered. Wheat seeds (from tall grass) grow through eight
stages when lit, twice as often on moist soil, both on a timer and on random
ticks; bone meal pushes them two to four stages. Ripe wheat gives wheat and
one to three seeds, three wheat make bread. Crops pop off when their soil
goes and wash away in water.

**Bow.** Hold right click to draw (a full draw takes a second, and the view
zooms in), let go to shoot. Arrows arc under gravity, damage (up to 4.5
hearts) and knock back mobs, and stick in blocks. In Survival each shot uses
an arrow and wears the bow, and you can walk over your stuck arrows to take
them back.

**Items, mining and crafting.** Items are separate from blocks: sticks, coal,
charcoal, iron and gold ingots, diamonds, apples, raw and cooked pork and
beef, bread, wheat and wheat seeds, bones, bone meal, string, flint, arrows,
a bow and buckets, plus pickaxes, axes, shovels, swords and hoes in wood,
stone, iron, gold and diamond. Stacks of 64; tools and the bow stack alone
and wear out. Mining time depends on the block's hardness and the tool;
some drops need a good enough pickaxe (iron needs stone, gold and diamond
need iron). Stone drops cobblestone, grass dirt, leaves sometimes a sapling or
an apple, gravel sometimes flint, tall grass sometimes seeds, glass nothing.
Recipes are data (shaped, anywhere in the grid and mirrored; shapeless; tags
such as "any planks" or "any wool"): planks, sticks, crafting table, torches,
every tool, furnace, chest, bucket, storage blocks, white wool from string,
bone meal, sandstone, slabs, bread, a bow (sticks and string), arrows (flint
on a stick), a bed (wool over planks), doors, ladders and fences. Sponge,
bedrock and coloured wool are Creative-only.

**Furnaces, chests, fluids.** Furnaces burn fuel and smelt ores into ingots,
sand into glass, cobblestone into stone, logs into charcoal, clay into bricks
and raw meat into cooked, and keep going while their chunk is loaded. Chests
hold 27 stacks. Both are saved with their chunk and spill their contents
when broken. In Infinite worlds water and lava are finite: sources and
levels, water spreading 7 blocks and lava 3 (slower), both heading for the
nearest drop, drying up without a source; two water sources make a third;
lava turns to obsidian or cobblestone where water meets it. Lower levels are
drawn lower. Buckets scoop up and pour sources. Classic worlds keep their old
unlimited fluids.

**Dropped items.** Items bob, drift toward you to be picked up, merge with
their neighbours and vanish after five minutes; they are saved with their
chunk.

**Mobs.** Pigs, cows and sheep arrive in herds with freshly generated grassy
chunks, wander, and flee when hit; they drop pork, beef and wool. At night
and in dark caves, zombies (melee), skeleton archers (keep their distance,
shoot arcing arrows, drop bones) and spiders (fast, climb walls, neutral in
daylight, drop string) spawn at least 24 blocks away, up to 20 at a time,
and despawn when far away; the undead burn in sunlight. Mobs hop up steps,
avoid drops and lava while calm, and are cuboid models with procedural skins
and walking animations — original designs, not copies. Hit them with
whatever's in your hand; they flash, get knocked back, topple over and drop
loot. Peaceful has no hostile mobs.

**Sound.** Procedural WebAudio, no samples: footsteps and landings by the
material underfoot, digging, breaking and placing, splashes, eating, pickups,
swings, hurt, doors, the bow, arrows landing, and mob voices (idle grunts,
moos, bleats, groans, rattles and hisses, plus hurt and death). Sounds in the
world fade with distance and pan with their direction. Volume is in Settings.

**Saving.** IndexedDB (`blocktide`, version 2): a world record (name, seed,
type, size, game mode, difficulty, time, daytime lock, spawn, player with
inventory, vitals and bed) and one gzipped binary record per changed chunk
(blocks when they differ from generation, plus JSON for block entities,
dropped items and animals). Writes are batched into one transaction; chunks
are saved when they unload, when the game pauses, every minute and when
quitting to the title screen.

## Code layout

```
src/
  main.ts, game.ts (loop, input, glue), session.ts (a loaded world + saving), config.ts
  world/     coords, chunk, world (storage, setBlock), blocks (registry), light, lightRegion,
             fluids, blockEntities, ticker (block behaviours), placement, trees, farming,
             shapes (doors, ladders, fences), generator / heightmap / generate (Classic),
             gen/biomes + gen/infinite
  stream/    streamer (what to generate, light, mesh, upload, unload)
  workers/   pool, protocol, chunk.worker (generate / light / mesh jobs)
  render/    tiles + itemTiles (pixel painters), atlas, mesher, meshInput, padded, chunks,
             materials (voxel light shader), sky, crack, outline
  items/     items (registry), inventory, recipes, smelting, container (screen logic)
  survival/  vitals, mining, survivor (the survival player), bow, sleep
  audio/     sound (procedural WebAudio)
  entities/  items (dropped items), mobs (mobs, AI, spawning, arrows), models,
             mobTextures, itemRender, mobRender
  player/    input, physics (shared by the player, items and mobs), raycast, player
  save/      records (format v2), db (IndexedDB), migrate (v1 → Classic), serialize, compress
  commands/  commands (pure: parsing and dispatch)
  ui/        title, hud, containerView, picker (creative), death, menu, commandBar, debug,
             loading, settings, icons, statusIcons, dom
tests/       unit tests
scripts/     smoke.mjs (Playwright), bench.ts / bench.mjs
```

Everything except rendering and UI is pure (no three.js, no DOM) and tested.
Every block change goes through `World.setBlock`, which updates light, marks
sections dirty and applies neighbour effects (slab merging, things popping off
without support).

## Tests

`npm test` (≈205 tests) covers, among others: negative-coordinate math and chunk
keys; that the same seed gives identical chunks and that a 3×3 area generated
in two different orders is identical; continuous heights across chunk and
biome borders; biome variety and `/locatebiome`; trees crossing chunk borders;
ore depths; light spreading and incremental removal across chunk borders
(checked against a full recompute); meshing (culling, slabs, snow layers,
cacti, rotated logs, tints, light attributes, ambient occlusion, bed pillows
facing the right way, fence rails); recipe matching (offset,
mirrored, shapeless, tags) and crafting through the container; inventory
stack operations; mining times and tier-gated drops; fall damage, drowning,
burning, cactus, starvation and regeneration timers; eating; finite fluid
spread, drying, drops, new sources and lava/water reactions; furnace smelting
and fuel use; block entity and save v2 round trips and the v1 migration;
item entities; sneaking at edges; mob combat, AI, archery, spawning rules,
sunlight and saving; leaf decay; tilling, sowing, crop growth and light,
farmland drying; bow draw, arrow use and hits; bed placement, breaking,
sleeping rules and the saved respawn point; doors (placing, toggling, blocking
the way), fences (can't be jumped), ladders (climbing, holding, sliding);
sound attenuation and panning (on a fake AudioContext); commands.

`npm run smoke` builds, serves `dist/` and drives headless Chromium (software
GL through SwiftShader), failing on any console error. It checks a Classic
world (walking, breaking, placing, F3, underwater fog, the creative
inventory), then an Infinite world: noon and midnight, a torch-lit cave,
every biome found with `/locatebiome` and photographed, a survival round
(crafting planks, sticks and a pickaxe through the screens, mining with
pickup, fall damage, a bucket, placing a bed and sleeping till morning,
tilling, sowing, bone meal and harvesting wheat, a hut with a door, ladder
and fences, death and respawn at the bed), every mob lined up, a night fight
with a zombie and a bow shot at a pig, streaming while flying and 100 000
blocks out;
then the title screen (create, save & quit, reload, delete), an Infinite world
whose edits, chest contents and dropped items survive unloading and a reload,
and the v1 save migration. Screenshots land in `artifacts/`. Set
`CHROMIUM_PATH` to use a specific Chrome; otherwise run
`npx playwright install chromium` once.

`npm run bench` measures single-threaded generation, lighting and meshing
throughput (at the time of writing: ~550 chunks/s generated including the
biome data of their neighbours, ~290 lit, ~760 meshed with smooth lighting).

## Judgement calls

Things the brief left open, and what I chose:

- **New worlds default to Infinite and Survival.** `?debug` is Creative.
- **Biomes**: eleven, listed above; heights come from continuous fields with
  per-biome offset / hill size / flatness blended over 33 blocks, so borders
  are gentle. Rivers fade out at coasts and in mountains rather than carving
  canyons through peaks. Strong cave tunnels may open at the surface; trees
  are never placed over one.
- **Tints**: grass, leaves, tall grass and water textures are grey and
  multiplied by a per-vertex biome colour; on the grass block only the fringe
  of the side (marked in the texture's alpha) is tinted. Spruce and birch
  leaves have fixed colours. Classic worlds keep their original look.
- **Light**: sky light passes down through air undimmed and loses one level
  per block sideways; leaves dim by 1, water and ice by 2. Night takes up to
  11 levels off sky light in the shader (moonlight keeps 4). Faces are still
  shaded by direction as in Classic.
- **Minecraft-like numbers** for mining, hunger, damage and fuel (see
  `survival/mining.ts`, `survival/vitals.ts`, `items/smelting.ts`), with
  starving stopping at half a heart on Normal.
- **Eating** takes 1.6 s of holding right click; food isn't eaten when full.
- **Right click on a crafting table, furnace or chest** opens it; sneak to
  place a block against it instead. Bone meal grows a sapling at once.
- **Bookshelves** drop three planks; ice and glass drop nothing; snow blocks
  need a shovel; double slabs drop two slabs.
- **Finite fluids** are per-cell levels without corner smoothing: lower levels
  render as lower steps. Two adjacent water sources make new sources (so a
  dug-out ocean edge refills).
- **Buckets** only scoop sources; Creative keeps the empty bucket.
- **Mobs**: about one grassy chunk in eight gets a herd; animals are saved,
  hostiles aren't (they despawn with their chunk). Hostiles also spawn in
  Creative but ignore you. Mobs are drawn up to 80 blocks away.
- **Dropped items** despawn after five minutes of simulated time (time in
  unloaded chunks doesn't count).
- **Liquids** can't be targeted except by buckets; blocks can be placed into
  them.
- **Arrows** are flint on a stick (no birds, so no feathers). A full draw
  does 9 damage; stuck player arrows last a minute, skeletons' eight seconds.
- **Beds** respawn you on top of the bed. Sleeping works from dusk (tick
  12 500) to just before sunrise and wakes you at sunrise; there's no lying
  down animation, just the fade.
- **Crops** grow in roughly two minutes on moist soil (about twice that dry):
  quicker than you might expect, since a play session is short.
- **Doors** always hinge on the left as seen when placing them; there are no
  double doors or fence gates. Zombies don't open doors.
- **Smooth lighting** only applies to full cubes; slabs, plants, fluids and
  shaped blocks keep flat light.
- **Sound** is deliberately simple synthesis (filtered noise and a few
  oscillators); nothing plays until you click into the game.
- **Pointer lock**: Chrome refuses to re-lock for about a second after `Esc`;
  when that happens the "Click to play" overlay comes back and the next click
  works. `?debug` just carries on unlocked.

## Known issues

- Performance numbers were only measured under SwiftShader (software GL) in
  a headless browser, where rendering is the bottleneck (a settled frame
  costs ~8 ms of JavaScript at render distance 8). I couldn't verify 60 FPS
  on a real GPU from here; the design (one draw call per column and pass,
  worker meshing, no remesh for time of day) is aimed at it.
- Each visible mob is several draw calls (one per body part); dozens of mobs
  in view cost a few hundred draw calls.
- Translucent water is sorted per column, not per face, so looking through
  two water surfaces can occasionally blend in the wrong order.
- Pending block updates (a flowing fluid, falling sand, a crop's next growth
  step) aren't saved; they resume when something next to them changes, and
  crops and farmland also carry on through random ticks.
- Arrows in flight or stuck in blocks aren't saved.
- Mobs path around by feel (they hop steps and avoid drops) and don't know
  about doors or fences, so a zombie can get stuck against a closed door.
- Water doesn't push the player or items along its flow.
- `pagehide` saves are best-effort; the autosave every minute, the save on
  pause and "Save & quit" are the reliable ones.

## Next steps

- Merge mob parts into one skinned geometry per mob; instanced items.
- Real pathfinding for mobs (around fences, through open doors).
- Fence gates, trapdoors and double doors; more crops (carrots, potatoes)
  and animal breeding with wheat.
- Corner-smoothed fluid surfaces and currents.
- Greedy meshing for distant columns; occlusion culling for caves.
- Save arrows and pending block updates with their chunk.
