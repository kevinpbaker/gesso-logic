# Phase 0: what the spikes found

**The exit criterion is met on a GPU. In headless software rendering
it is met only with two changes to how Phase 3 draws.** A 10,000-gate
scene pans and zooms with signals arriving from the application worker
at 60 Hz and 10% of nets changing on every step:

| run (tiles, blocks LOD, settle zoom) | GPU cost | GPU p95 | software cost | software p95 |
| ------------------------------------ | -------: | ------: | ------------: | -----------: |
| still, all 10,000 gates              |   4.5 ms |  6.9 ms |        8.6 ms |      11.9 ms |
| pan, all 10,000 gates                |   4.5 ms |  5.8 ms |        8.3 ms |      11.2 ms |
| zoom, all 10,000 gates               |   4.5 ms | 10.3 ms |       13.8 ms |  **58.4 ms** |
| pan, mid zoom (≈ 1,200 gates, full detail) | 5.5 ms | 7.5 ms |  **17.8 ms** |     23.6 ms |
| zoom, mid zoom                       |   5.3 ms | 12.6 ms |   **17.9 ms** |     57.2 ms |

The simulator does **59–68 M evaluations a second**, over the 50 M bar,
but that bar was set on a wrong guess. A CPU-shaped circuit costs about
3,650 evaluations per clock cycle, not the 500 the roadmap assumed, so
the same kernel gives 16–20 kHz of simulated clock. Pong needs about
30 kHz. See §4.

The chunk size is **256 nets**, sent as **hex strings**. The tile size
is **256 px**. Both are measured below, not guessed.

"Cost" is the work the render worker did for a frame, from
`FrameService`. Headless Chrome schedules frames however it likes, so
the gap between frames tells you about the compositor, not about the
app. That's why cost is the number compared with 16.7 ms. All numbers
come from one machine: an AMD Ryzen 5 5600X on Linux, Chrome
154.0.8037.57, headless, at device scale 1 in a 1400 × 900 window.
"Software" is headless Chrome's default. "GPU" is `--gpu`, which lets
`OffscreenCanvas` rasterise on the graphics card. Both runs drew with
Gesso's Canvas2D backend. The shape of the differences held across
runs. The third decimal did not: the same configuration moved by
10–25% between runs.

## How to run it

```bash
pnpm phase0:sim                # spike 3, in Node: ~20 s
pnpm phase0                    # spikes 1 and 2: the full matrix, ~12 min
pnpm phase0 --only='^confirm'  # just the runs whose label matches
pnpm phase0 --gpu              # without forcing software rendering
pnpm phase0 --shot=a.png --input   # a real drag and ctrl-wheel, then a screenshot
```

`pnpm phase0` builds the page, serves it, opens it in headless Chrome
with `?bench`, and prints a table from the JSON the render worker
logs. Each run is appended to `phase0-results.jsonl` as it finishes. It
is gessosheet's `scripts/phase0.ts` with a different table. `pnpm dev`
shows the same page with the knobs on screen: paint strategy, tile
size, level of detail, zoom raster mode, wire shape and activity.

---

## 1. Paint: the cost is pixels, not the recording

The roadmap suspected `Paint` would be the problem: ten thousand gates
re-recorded because one wire changed colour. That is half right.
Re-recording does happen every frame, but recording is not what costs.

With every gate on screen and signals flowing, the first run measured
this (software rendering):

| run | cost | render phase | inside the painters | recordings per frame |
| --- | ---: | -----------: | ------------------: | -------------------: |
| one `Paint` for the view | 57.3 ms | 56.8 ms | 2.9 ms | 1 |
| 16 tiles × (gates + wires) | 46.1 ms | 45.6 ms | 3.9 ms | 16 |
| idle: nothing changing | 1.3 ms | 0.7 ms | 0 | 0 |

"Inside the painters" is the time the draw functions spent emitting
about 80,000 `PaintOp`s. It is 3–4 ms of a 45–57 ms render phase. The
rest is `replayPaint` stroking those paths onto an `OffscreenCanvas`
and turning the result into a bitmap. So a retained or tiled `Paint`
that re-records only what changed would save the cheap part. The
render phase follows pixel area and stroke count, and the evidence for
that is §1.3: doubling a tile's raster size roughly doubles or triples
its cost at the same op count.

### 1.1 Tiles beat one `Paint` only when layers are split

At 10% activity, 1,000 random nets out of 10,000 flip every step, so
every 256-net chunk changes on every step. At 1%, 100 flips still reach
most chunks. `activity-1-still-all` cost 45.7 ms against 46.1 ms at 10%.
So no chunk or tile granularity can keep a live wire layer from being
redrawn every frame. That leaves two things tiling can do:

- **It makes pan free.** A tile that is still on screen is moved by
  `left`/`top` and records nothing. `idle-pan-all` cost 1.1 ms.
- **It splits the layers.** Gates, and anything else that changes only
  on an edit, go in a `Paint` whose inputs never change. That's why
  `blocks-tiles-still-all` costs 8.3 ms and `blocks-single-still-all`
  costs 58.9 ms with identical drawing: the single `Paint` re-strokes
  20,000 static wires every frame because one gate changed colour.

### 1.2 Level of detail is the lever at fit-all zoom

At the zoom that shows all 10,000 gates (0.13 screen px per world unit)
a gate is 4 px wide and a wire is a pixel or less. You can't read its
colour. Below 0.3 zoom, the `blocks` level of detail draws the wires
once, unlit, in the static layer, and shows the live values on the
gates: each is a block filled by its output. That's 10,000 rects per
snapshot instead of 20,000 three-segment polylines.

| run (software) | full | blocks |
| -------------- | ---: | -----: |
| tiles, still, all | 46.1 ms | 8.3 ms |
| tiles, pan, all | 43.0 ms | 8.3 ms |
| single, still, all | 57.3 ms | 58.9 ms |

This is Phase 3's "below a zoom threshold, gates become filled blocks"
with one addition: **wires stop carrying live colour at the same
threshold, and the gates carry it instead.** Above 0.3 zoom wires are
drawn in full. Mid zoom (0.5, about 1,200 gates on screen) is the
remaining software-rendering miss at 16–18 ms. See §6.

### 1.3 Zoom: scale during the gesture, redraw 1:1 when it settles

A tile resized on every frame of a zoom re-records and re-rasterises
both its layers on every frame. The tile set is stable within an
octave, because tiles sit on a world grid per power of two, but their
boxes are not. Three strategies were tried, with blocks LOD, software
rendering:

| zoom raster | fit-all cost / p95 | mid cost / p95 | still, fit-all |
| ----------- | -----------------: | -------------: | -------------: |
| `resize`: box = screen size | 59.0 / 83.5 ms | 42.7 / 88.2 ms | 8.3 ms |
| `scale`: box = top of octave, `transform` down | 14.6 / 56.4 ms | 36.1 / 77.5 ms | 16.7 ms |
| `settle`: keep the drawn box, scale, redraw 150 ms after | 13.8 / 58.4 ms | 17.9 / 57.2 ms | 8.6 ms |

`scale` rasterises every tile at twice its nominal size, which costs up
to four times the pixels on every live-layer redraw. That's a bad trade
everywhere except mid-zoom. `settle` is what map viewers do, and it
wins or ties on every row. Its p95 is the frame where the zoom settles
and all ~24 tiles redraw at once. On the GPU the same spike is 10.3 ms
at p95 and 25 ms at worst. **Phase 3 should spread that redraw over
frames** (visible tiles first, a few a frame, the stale scaled bitmap
shown until each is done). That's app-side work.

### 1.4 The tile size is 256 px

Fit-all, full detail, software rendering:

| tile | tiles | still | pan |
| ---: | ----: | ----: | --: |
| 128 px | 49 | 52.8 ms | 55.3 ms |
| 256 px | 16 | 44.6 ms | 44.2 ms |
| 512 px | 4 | 44.2 ms | 46.8 ms |

128 pays a per-tile overhead (a bitmap, a replay, a `drawImage`) 49
times. 256 and 512 cost the same still. 256 is cheaper panning because
a tile entering the view is a quarter of the pixels. Tiles are 256 px
nominal and run from 256 to 512 px across an octave.

### 1.5 On a GPU, none of this was needed

The same configurations with `--gpu`:

| run | software | GPU |
| --- | -------: | --: |
| one `Paint`, still, all, full detail | 57.3 ms | 7.5 ms |
| tiles, still, all, full detail | 46.1 ms | 8.5 ms |
| tiles, pan, mid, full detail | 15.7 ms | 5.4 ms |
| tiles, still, all, blocks | 8.3 ms | 4.3 ms |
| zoom `resize`, all | 59.0 ms | 10.6 ms |

Accelerated `OffscreenCanvas` strokes about six times faster. But the
proof has to hold on whatever machine opens the url, and `pnpm proof`
will run in software in CI, so the design is set by the software
numbers. Tiles, the layer split, blocks LOD and settle zoom are all
Phase 3 work, and none of them is an engine change.

---

## 2. The wire: hex chunks of 256, and the record shape exposes an engine bug

`signals` is a `Record<chunkId, string>`, one chunk per 16 × 16 block
of gates. Net ids are laid out spatially so a chunk is a patch of the
canvas. The comparison with the obvious shape, `Record<netId, 0 | 1>`:

| shape | view | nets | patches / publish | bytes / publish | apply (patch phase) |
| ----- | ---- | ---: | ----------------: | --------------: | ------------------: |
| `hex` | fit-all | 10,000 | 50.7 | 6.7 KiB | 0.1–1.3 ms |
| `base64` | fit-all | 10,000 | 50.7 | 5.6 KiB | 0.1–1.3 ms |
| `hex` | close | 891 | 18 | 2.3 KiB | 0.1 ms |
| `base64` | close | 891 | 18 | 1.9 KiB | 0.1 ms |
| `record` | close | 891 | 82.6 | 5.7 KiB | **33.9 ms** |
| `record` | fit-all | 10,000 | 908 | 62.7 KiB | **fell ~7 minutes behind** |

On the application thread, building a snapshot costs 0.1 ms and the
differ another 0.1 ms, in every packed configuration. The render worker
drew values 12–17 ms old when it held its frame, which is one frame.
Missed (visible nets with no value yet) was 0% in every run except two
zoom runs, which briefly outran the quarter-viewport band at 1–2%.

**Strings are good enough; the binary channel key is not worth
building for this.** Hex over base64: 15–20% more bytes, one less alphabet
to get wrong, and no measurable difference in draw cost. 400 KiB a
second at 60 Hz with everything on screen is not a number worth
optimising.

**The engine bug.** `record` at fit-all left the render worker's patch
phase measuring 420 s for a single frame, and the run never recovered.
The cause is in `gesso/packages/framework/src/channel/StorePatch.ts`:
`applyPatches` applies patches one at a time, and `setIn` clones every
container on the path for each one. So a batch of N patches into one
K-key object costs N × K property copies. Here that's roughly 900 ×
10,000 per publish, 60 publishes a second, and the replica never catches
up. The packed shapes never see this (50 patches into a 49-key object).
But any application that publishes a wide keyed map, with a spreadsheet
viewport being the obvious one, pays for it quadratically. **The fix is
to clone each container once per batch**, keeping track of which
containers this batch has already copied. That's an engine change,
logged under Phase 0b.

**Fixed in Phase 0b.** A batch now copies each container once, and the
`record` run at fit-all holds its frame: its patch phase is 0.41 ms,
and 0.28 ms close up. Hex stays the contract, for the bytes.

---

## 3. The suspected gaps, confirmed or removed

| gap (ROADMAP) | verdict |
| ------------- | ------- |
| A large `Paint` scene | **Removed as an engine question.** Recording is 3–4 ms of the cost; the rest is rasterisation. Tiles, a static/live layer split, blocks LOD and settle zoom do it app-side (§1). |
| Binary data on the channel | **Removed.** Hex chunks of 256 cost 51 patches and 6.7 KiB per publish with 10,000 nets visible (§2). |
| Channel throughput at 60 Hz, forever | **Holds** for the packed shapes: ~100 publishes a second while panning (commands add publishes), 0.1 ms to build and diff. **Fails** for a wide keyed map, because of the replica bug in §2. |
| Zoom | **Confirmed, and fixed in the engine.** The events arrive and the canvas zooms (checked by CDP and in a desktop browser). But no wheel over the canvas was cancelled, so a ctrl-wheel, or a trackpad pinch, zoomed the page as well. The documented fix, `overscrollBehavior="contain"` on the app's root, did nothing in a mounted app. It now works (§5). The engine also makes the zoom *strategy* matter (§1.3). |
| Pointer capture for long drags | **Not exercised.** There are no panels yet. Still open for Phase 4. |

Two more things turned up, both about transforms:

- **Culling stops at a transform.** `Canvas2DRenderer.renderNode` turns
  culling off for a transformed node's descendants (the comment says
  so: record coordinates no longer match). So the obvious pan and zoom
  design, one world container with a `transform`, would rasterise and
  draw every tile in the world on every frame. The spike places tiles
  in screen space instead, and each tile may carry its own scale
  transform because the renderer pivots on the node's top-left, so a
  tile scaled ≤ 1 stays inside its layout box and can't be culled
  wrongly. Culling through a translate-and-scale transform is a
  reasonable engine change, but nothing here needs it.
- **A `Paint` rasterises at its box size times the device scale.** A
  tile shown under a scale transform is a resampled bitmap until it is
  redrawn. A "raster scale" on `Paint` would let a zoomed tile be sharp
  without being resized, but settle zoom makes that unnecessary for
  now.

---

## 4. The simulator: fast enough per gate, too many gates per cycle

Spike 3 builds a 10,000-gate circuit with the CPU's shape out of parts
that really clock. It has a 7-bit PC and incrementer; 128 bytes of RAM
as 4-NAND gated D latches, with an unshared 7 → 128 decoder and a
128 → 1 AND-OR read tree per bit; A, B, X and IR registers of
master–slave flip-flops; an ALU; and a control block filling the rest.
The bench checks the PC counts 300 cycles on both kernels before it
times anything. Everything is unit delay, and a cycle is "rise, run
until quiet, fall, run until quiet".

| control block | kernel | M evals / s | evals / cycle | ticks / cycle | kHz |
| ------------- | ------ | ----------: | ------------: | ------------: | --: |
| PLA (AND-OR plane) | event-driven | 59–68 | 3,650 | 21.7 | 16–20 |
| PLA | oblivious sweep | 140–160 | 217,000 | 21.7 | 0.7 |
| random gates | event-driven | 48–55 | 8,900 | 56.8 | 5.4–6.2 |

Where one cycle's 3,650 evaluations go (PLA control):

| block | gates | evals / cycle | share | output changes / cycle |
| ----- | ----: | ------------: | ----: | ---------------------: |
| control (PLA) | 2,360 | 1,691 | 46% | 798 |
| registers | 376 | 839 | 23% | 379 |
| RAM storage | 4,234 | 442 | 12% | 15 |
| RAM decode | 775 | 351 | 10% | 136 |
| PC + incrementer | 70 | 147 | 4% | 69 |
| ALU, RAM read, muxes | 2,183 | 182 | 5% | 128 |

What this changes:

- **The ≥ 50 M bar is met, but it measured the wrong thing.** The
  roadmap's speed budget assumed ~500 gate evaluations per cycle "since
  the RAM read tree dominates". Measured, the RAM is 22% of the work.
  Every flip-flop sees both clock edges, and a control decoder
  re-evaluates on every change of its inputs, which is most of what
  happens. At 3,650 per cycle, 30 kHz for Pong needs about 110 M
  evaluations a second, roughly 1.7× what this kernel does. **Phase 12
  owns closing that**, and the first profile says where to look: the
  flip-flops' clock fan-out (a clock edge wakes both latches of every
  flip-flop even when D has not moved) and the control plane. The ISA
  sketch's slower lever is still there too: fewer cycles per frame.
- **Event-driven is the right kernel, by 26×.** The oblivious sweep
  evaluates 2.4× more gates per second and completes 26× fewer cycles.
- **The logic style of a block moves its cost by 4–5×.** A random,
  XOR-rich cloud of 2,360 gates cost 6,900 evaluations a cycle, and the
  PLA the same size cost 1,700. Glitches drive this: unit delay
  propagates every hazard. The real control unit is a PLA, so the PLA
  row is the one to plan against. But a gate count alone doesn't say
  what a design will cost to simulate.
- **Hold time is real under unit delay, and it will bite.** The first
  circuit oscillated. The RAM's write enable closed one tick after the
  accumulator, which is its data, had already changed. A latch saw its
  data move while it was still open, both halves of its SR pair went
  low for a tick, and it rang forever. Real latches fail the same way.
  The fix was one tick of margin: the strobe comes from the clock
  through one gate instead of two, and the data goes through a buffer.
  **Phase 14's RAM generator and Phase 16's control unit have to be
  designed for hold margin, and Phase 1's oscillation detector will
  find it the first time they are not.** It should report the net that
  is ringing, not only that something is.

## 5. By hand, in a desktop browser

After the bench, the spike was driven in a real Chrome 154 window
(1271 × 887, device scale 1.33, a display refreshing at about 166 Hz)
under `pnpm dev`. The dev server works, and the application worker is
found and served just as in the build.

| settings | what was done | FPS | worst gap |
| -------- | ------------- | --: | --------: |
| defaults (`full`, `resize`) | opened, fit-all | 32 | 61 ms |
| `blocks`, `settle` | fit-all, still | 166 | 9 ms |
| `blocks`, `settle` | drag to pan | 164 | 17 ms at the drag, then 9 ms |
| `blocks`, `settle` | Mid, Pan sweep (full detail) | 166 | 9 ms |
| `blocks`, `settle` | All, Pan sweep | 166 | 10 ms |
| `blocks`, `settle` | Zoom sweep | 160 | 12 ms |
| `full`, `settle` | All, still | 123 | 30 ms |

These come from the on-screen readout, not the bench: the bench's
results go to the render worker's console, which the browser tool could
not read. They agree with §1. The default configuration drops frames at
fit-all, and the chosen one holds a 166 Hz display everywhere tried,
including mid zoom at full detail, which misses in headless software
rendering.

**What was found by hand:** ctrl-wheel zoomed the canvas, and nothing
stopped it zooming the page too. A wheel event dispatched on the canvas
with `ctrlKey` came back with `defaultPrevented` false. The page-zoom
itself is inferred from the code, because the browser tool can't send a
real ctrl-wheel. Chrome sends a trackpad pinch as a ctrl-wheel, so a
pinch would have done the same.

The first reading was wrong in a useful way. The render-worker shell
(`WorkerApp.ts`, `onWheel`) cancels a wheel only when the worker last
reported that something under the pointer takes it. That looked like a
missing feature, but Gesso already has the answer:
`overscrollBehavior="contain"`, whose documentation says an app that
fills the viewport wants it on its root. Setting it on the spike's root
changed nothing. The bug was two lines in `UiWheelController`:

- It read containment from the tree's topmost node. In a mounted app
  that isn't the app's root: `GessoRuntime.buildRoot` wraps the app in a
  stack beside the overlay layer. So `contain` on the app's root was set
  on a node nothing asked. The controller's own specs passed because they
  build the tree themselves and set it on the harness root.
- It honoured `contain` in the middle of the chain only on scroll
  containers. So a canvas embedded in a scrolling page, which is a plain
  box handling its own wheel, had no way to keep the wheel either.

**Fixed in `../gesso`**, not committed:

- `UiWheelController` honours `contain` on any ancestor of the target.
  It also asks the root it is given, which the runtime now passes as the
  app's root: the same choice the keyboard controller already made, for
  the same reason.
- Two controller specs and a new `GessoRuntime.wheel.spec.ts`, which
  mounts a real runtime. Each new spec fails without the fix. Gesso's
  suite passes (405 files, 4,403 tests), and so do format, lint,
  typecheck, the API report and the docs reference check.
- Vendored into this repo with `scripts/vendor-gesso.sh`, copied from
  gessosheet, and checked in the desktop browser. Ctrl-wheel, plain
  wheel and horizontal wheel over the canvas are all cancelled now, the
  canvas still zooms, and clicks and drags are unaffected.

`gesso.lock` names Gesso's HEAD, and that isn't what was packed until
the change is committed there and the vendoring re-run.

---

---

## What is throwaway and what is not

Throwaway: `src/spike/`, `src/App.tsx`, `src/AppWorker.ts`. Phase 1
starts `src/sim` from nothing, and Phase 3 starts the canvas from
nothing.

Worth keeping:

- **The four drawing decisions from §1**: static/live layers, tiles
  on a world grid per octave, a blocks LOD below 0.3 that moves live
  colour onto the gates, and settle zoom. The spike's `App.tsx` is a
  working reference for each.
- **The wire contract from §2**: spatial net ids in 16 × 16 blocks,
  `signals: Record<chunkId, hexString>`, and the band on the publishing
  side.
- **`scripts/phase0-sim.ts`'s shape**: the synthetic CPU and the
  per-block evaluation profile are the benchmark Phase 12 asks for. They
  will need rebuilding on Phase 1's netlist. The numbers in §4 are the
  baseline to beat.
- **`scripts/phase0.ts`**, until Phase 7 rebuilds it as `pnpm proof`
  against the real canvas, driving input rather than the camera.

## What is still unknown

- **Touch.** Nothing here had a finger in it. A touch pinch arrives as
  `onPinchMove` and goes through the same `zoomAt` as the wheel, but has
  never run. A trackpad pinch arrives as ctrl-wheel and is now kept by
  the canvas (§5).
- **Mid zoom in software rendering.** Full-detail wires at 0.5 zoom cost
  16–18 ms. The levers are a second LOD step (thinner or unlit wires
  between 0.3 and 0.6) or fewer, larger tiles. Phase 3 should decide
  with the real canvas's pixels, which will differ from these.
- **The engine at full speed alongside the canvas.** The application
  worker here flips bits on a timer. It doesn't run a simulator in
  slices. Phase 2 has to show that a slice loop at full speed still
  publishes at 60 Hz. gessosheet's §7 is the warning: a busy
  application thread left the view with no values while the frame rate
  stayed perfect.
- **WebGPU.** Every frame here was drawn by Canvas2D, because the
  renderer didn't choose WebGPU in either configuration. Painted nodes
  reach WebGPU as the same bitmaps, so the paint cost should carry
  over. That is inference, not measurement.
