# Blocktide — plan

A single-player, fixed-size voxel sandbox for the browser, in the spirit of 2009-era
creative block building. Static site: Vite + TypeScript (strict) + three.js.

## File layout

```
index.html                 page shell + overlay markup
src/
  main.ts                  bootstrap: settings, load-or-generate, start the game
  game.ts                  Game: owns world/renderer/player/ui, fixed-step loop
  config.ts                shared constants (chunk size, physics, render distances)
  style.css                HUD / menus
  util/
    prng.ts                seeded PRNG (sfc32 + splitmix32 seeding), string→seed hash
    noise.ts               seeded 2D/3D gradient noise + fBm octaves
  world/
    blocks.ts              block ids + registry (tiles, solid, light, shape, pass)
    world.ts               World: flat Uint8Array, setBlock(), change listeners
    heightmap.ts           per-column light height (highest light-blocking block)
    generator.ts           pure, seeded Classic-style level generator (progress cb)
    gen.worker.ts          runs the generator off the main thread
    sizes.ts               Small / Normal / Large presets
    placement.ts           pure break/place/pick rules (slab merge, plant support…)
    ticker.ts              M5 block behaviours (falling, liquids, sponge, grass, trees)
    trees.ts               tree shape used by generator + sapling growth
  render/
    tiles.ts               tile ids and per-tile pixel painters (pure, RGBA buffers)
    atlas.ts               paints every tile into one canvas atlas → THREE texture
    mesher.ts              pure chunk mesher → typed arrays per render pass
    chunks.ts              ChunkManager: dirty set, time-budgeted remesh, meshes
    materials.ts           opaque / cutout / translucent materials
    sky.ts                 sky colour, fog, clouds, edge ocean + bedrock floor
    outline.ts             targeted-block outline
  player/
    input.ts               keyboard / mouse / pointer lock state
    physics.ts             pure AABB-vs-voxel collision, fixed-step movement
    raycast.ts             pure voxel DDA raycast (face + shaped-block boxes)
    player.ts              Player: state, controls → physics, camera pose
  ui/
    hud.ts                 crosshair + hotbar
    icons.ts               isometric block icons drawn from the atlas
    picker.ts              B block picker
    menu.ts                pause menu, new world, settings panels
    loading.ts             "Generating level…" screen
    debug.ts               F3 overlay
    settings.ts            persisted settings (localStorage)
  save/
    serialize.ts           pure binary (de)serialisation of world + player + hotbar
    compress.ts            gzip / gunzip via CompressionStream
    storage.ts             IndexedDB save slot
tests/                     vitest unit tests (pure modules only)
scripts/smoke.mjs          Playwright smoke test against `vite preview` with ?debug
```

## Milestones

- **M1** scaffold, game loop, block registry, texture atlas, chunk mesher,
  fly camera over a flat test world.
- **M2** generator (worker + progress), height-map lighting, opaque / cutout /
  translucent passes, sky / fog / clouds / edge ocean, loading screen.
- **M3** player physics, pointer lock, DDA raycast + outline, break / place /
  pick, hotbar and picker, live remeshing with budget.
- **M4** pause menu, settings, IndexedDB save/load + autosave, new world,
  F3 debug overlay, `?debug` flag, smoke test, README.
- **M5** ticked Classic behaviours: falling sand/gravel, liquid spread with
  per-tick caps, sponges, sapling growth, grass spread/death.

After each milestone: `npm run typecheck && npm test && npm run build`, then commit.
