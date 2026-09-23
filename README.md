# Blocktide

A small, single-player block-building sandbox for the browser, in the spirit of
the 2009-era creative "classic" block games: a fixed-size generated island
world, first-person movement, and instant block breaking and placing from a
palette of 47 blocks. All textures are generated procedurally at startup; there
are no external assets, no backend and no sound.

Built with Vite + TypeScript (strict) + three.js (the only runtime dependency).

## Running it

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/ at http://localhost:4173
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
npm run smoke      # build, then the headless Playwright smoke test (see below)
```

URL flags:

| Flag | Effect |
| --- | --- |
| `?debug` | Fixed seed (1337), fixed camera, no click-to-play overlay, no saving. Sets `window.__ready = true` once the world is meshed and a frame has rendered, and exposes `window.__game`. |
| `?size=small\|normal\|large` | World size used when a *new* world is generated at startup (default `normal`). |

## Controls

| Input | Action |
| --- | --- |
| Click | Capture the mouse and play |
| Mouse | Look |
| `W` `A` `S` `D` | Move |
| `Space` | Jump; swim up in water/lava; fly up |
| `Shift` | Fly down |
| `Z` | Toggle flying |
| `R` | Respawn at the spawn point |
| Left click (hold to repeat) | Break block |
| Right click (hold to repeat) | Place the selected block against the targeted face |
| Middle click | Copy the targeted block into the selected hotbar slot |
| `1`–`9`, mouse wheel | Select hotbar slot |
| `B` | Block picker (click a block to put it in the selected slot) |
| `F` | Cycle render distance (Tiny 32 → Short 64 → Normal 128 → Far 256 → Extreme 512) |
| `F3` | Debug overlay (FPS, position, target, chunk rebuilds, draw calls) |
| `Esc` | Pause menu (Resume, Save, Load, New World, Settings) |

## What's in it

**World** — Small 128², Normal 256² (default) or Large 512², all 64 tall, stored as
one flat `Uint8Array`. Seeded, deterministic Classic-style generation running in
a Web Worker: combined-octave noise heightmap around sea level (y = 32), dirt over
stone on a bedrock floor, worm-style caves, coal/iron/gold veins by depth, ocean
flood-filled inward from the map edges with an explicit stack (enclosed caves stay
dry), lava pools near the bottom, sand and gravel shores, grass on exposed dirt,
trees, and patches of flowers and mushrooms. Outside the map a flat ocean at sea
level stretches to the horizon over a bedrock floor two blocks down; the map edges
are walls. Even in headless, software-rendered Chromium a Normal world is
generated, meshed and on screen in under two seconds.

**Blocks** — A registry of 48 ids (air + 47 blocks) with per-face tiles, solidity,
light blocking, render shape (cube / cross / slab) and render pass (opaque / cutout /
translucent). Slab-on-slab merges into a double slab; flowers, mushrooms and
saplings are X-shaped sprites that pop off when their support goes; water and lava
are static, non-solid and swimmable; lava is always fully lit; the bottom bedrock
layer can't be broken.

**Rendering** — 32³ chunks, one merged `BufferGeometry` per chunk per pass, faces
emitted only against air or non-occluding blocks, same-type transparent faces
culled (glass–glass, water–water). Unlit `MeshBasicMaterial` with vertex colours
carrying baked Classic lighting: 1.0 top, 0.8/0.6 sides, 0.5 bottom, × 0.6 when
the cell a face looks into is below its column's light height. The height map is
updated on every edit; dirty chunks are remeshed nearest-first within a 4 ms
per-frame budget, the chunk the player edited is rebuilt immediately, border edits
and light-height changes dirty their neighbours. Sky gradient, distance fog, dense
blue/orange fog in water/lava, drifting cloud layer.

**Textures** — 55 deterministic 16×16 tiles painted with a seeded PRNG into one
canvas atlas (`NearestFilter`, no mipmaps, sRGB, inset UVs): dithered stone/dirt/
sand, grass top and grass-over-dirt side, bark and rings, planks, outlined
cobblestone, speckled ores, leaves and glass with transparent pixels, translucent
water, bricks, wool in 16 colours, and so on. Hotbar/picker icons are isometric
cubes drawn from the atlas with 2D canvas transforms.

**Player** — Pointer-lock first-person camera, fixed 60 Hz physics with an
accumulator (long gaps clamped) and render interpolation. 0.6 × 1.8 × 0.6 box,
eye at 1.62, walk 4.3 b/s, gravity 32 b/s², 1.25-block jump, collisions resolved
one axis at a time against slab-aware boxes (no tunnelling, no wall sticking),
slower movement in liquids, fly mode. Targeting is a voxel DDA raycast with 5-block
reach and an outline around the target's bounds.

**Block behaviours** — A 20 Hz tick on the same fixed clock drives the Classic
rules: sand and gravel fall; water and lava spread without limit into air (down
and sideways, lava six times slower), with at most 400 scheduled updates per tick
so a flood can never stall a frame (the backlog simply waits); where water and
lava meet the flow hardens into stone; digging into the map edge below sea level
lets the outer ocean pour in; sponges clear water within 2 blocks and keep it out
until removed; saplings grow into trees; grass spreads onto lit dirt and dies
when a light-blocking block covers it. Updates are event-driven (a change wakes
only the neighbours that can react) plus a few random surface-column ticks.

**UI & saving** — Crosshair, 9-slot hotbar, block picker, pause menu with Save /
Load / New World (size + seed; text seeds are hashed) / Settings (sensitivity, FOV,
render distance, invert Y — persisted in `localStorage`), F3 overlay. Saves are a
compact binary format (world blocks + size + seed, player position/orientation/
spawn, hotbar) gzipped with `CompressionStream` into IndexedDB. Autosave every 60 s
and whenever the game pauses; the last save is loaded on startup, otherwise a new
Normal world with a random seed is generated.

## Code layout

```
src/
  main.ts, game.ts, config.ts, style.css
  util/     prng.ts (sfc32), noise.ts (gradient / octave / combined noise)
  world/    blocks.ts (registry), world.ts (storage + setBlock), heightmap.ts,
            generator.ts, gen.worker.ts, generate.ts, trees.ts, placement.ts,
            sizes.ts, flat.ts
  render/   tiles.ts (pixel painters), atlas.ts, mesher.ts, chunks.ts,
            materials.ts, sky.ts, outline.ts
  player/   input.ts, physics.ts, raycast.ts, player.ts
            ticker.ts (M5 block behaviours)
  ui/       hud.ts, icons.ts, picker.ts, menu.ts, loading.ts, debug.ts,
            settings.ts, dom.ts
  save/     serialize.ts, compress.ts, storage.ts
tests/      unit tests for the pure modules
scripts/    smoke.mjs (Playwright)
```

The mesher, raycast, physics, generator, ticker, tile painters, placement rules
and save serialisation are pure (no three.js, no DOM) and unit-tested. Every block
change goes through `World.setBlock`, which updates the light height map, marks
dirty chunks and applies neighbour effects.

## Tests

`npm test` covers world indexing and `setBlock` side effects, mesher culling (two
adjacent cubes → 10 faces, same-type transparent culling, slabs, sprites, baked
shading), raycast hit block and face (including slabs and plants), collision
(landing, no tunnelling, walls, map edges, ceilings, jump height, slab step-up,
swimming, flying, can't place inside yourself), save round-trip (with gzip),
determinism (same seed → identical world), spawn on dry land, and the block
behaviours (falling sand, unlimited water spread, slower lava, the per-tick cap,
water + lava → stone, edge-ocean inflow, sponges, sapling growth, grass spread and
death).

`npm run smoke` builds, serves `dist/` with `vite preview`, opens `?debug` in
headless Chromium (software GL via SwiftShader), fails on any console error, walks,
breaks and places a block, checks the F3 overlay, underwater fog and the picker,
then checks that a Small world survives a page reload via IndexedDB. Screenshots
land in `artifacts/`. Set `CHROMIUM_PATH` to use a specific Chrome binary;
otherwise run `npx playwright install chromium` once.

## Judgement calls

Things the brief left open, and what I chose:

- **Chunk size 32³** rather than 16³: a Normal world is 128 chunks, so a full view
  is roughly 150–250 draw calls; a chunk still remeshes in about a millisecond.
- **Leaves** are cutout but faces between two leaf blocks are kept (a "fancy
  leaves" look, so canopies aren't hollow); glass–glass and water–water are culled.
- **What blocks light**: every full cube including leaves and water (so trees cast
  shadows and sea floors are shaded), plus slabs; glass and plants don't. Lava
  blocks light but its own faces are always full-bright.
- **Slabs** can be walked up without jumping (0.5-block step height).
- **Plants** need a full solid block underneath to be placed and pop off when it
  goes. Mushrooms generate on dark cave floors plus a few surface patches.
- **Liquids** can't be targeted (the ray passes through), and blocks can be placed
  into liquid cells. Water, lava, bedrock and the double slab are in the picker.
- **Middle click** copies the block into the *selected* slot as specified, even if
  it's already elsewhere on the hotbar.
- **Default render distance** is Far (256) with linear fog starting at 30 %.
- **Pointer lock**: Chrome refuses to re-lock for about a second after `Esc`; when
  that happens the "Click to play" overlay comes back and the next click works.
  Mouse presses within 200 ms of gaining lock are ignored, so the resuming click
  never breaks or places.
- **Saving** uses one slot. `?debug` never saves or loads.
- **Liquids** follow the Classic "unlimited" rule literally: a source placed in
  mid-air spreads sideways forever as well as down, so it floods the map at that
  level. Water meeting lava turns the contact cell to stone (not in the brief, but
  it keeps the two from sitting side by side forever).
- **Grass** counts as covered when the block directly above blocks light (so a
  slab or dirt kills it, glass doesn't). Dirt turns green when sunlight reaches
  it and grass is within the 3×5×3 neighbourhood Classic used; saplings need
  sunlight, grass/dirt below and room for the canopy.
- **Timings**: water spreads a block every 0.25 s, lava every 1.5 s, sand falls
  10 blocks/s; placed saplings try to grow after 5–20 s, covered grass dies after
  2–6 s and exposed dirt near grass greens after 3–10 s.

## Known issues

- Headless / software-GL runs are slow (≈5 FPS under SwiftShader); real GPUs are
  what the 60 FPS target is about. I could only verify performance numbers
  (≈1 ms per chunk remesh, ~200 draw calls at Far) — not a real integrated GPU.
- Translucent water is sorted per chunk, not per face; looking through two water
  surfaces at once can occasionally blend in the wrong order.
- Pending block updates aren't saved: a flood or falling sand that was mid-way
  when you saved sits still after loading until something next to it changes.
- `beforeunload` saves are best-effort (IndexedDB writes can be cut off when the
  tab closes); the 60 s autosave and the save on pause are the reliable ones.

## Next steps

- Greedy-free but smarter meshing (e.g. skip fully buried chunks early), and
  occlusion culling for cave chunks.
- Multiple save slots with thumbnails; export/import of save files.
- Smooth lighting / ambient occlusion as an option.
