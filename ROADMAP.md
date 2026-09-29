# Roadmap

A digital logic simulator built on [Gesso](../gesso): wire gates on a
canvas, wrap them into chips, and run them — up to an 8-bit CPU of
about ten thousand gates, playing Pong on an LED matrix, every gate
evaluated on every clock.

It exists to be evidence, the way [gessosheet](../gessosheet) is. The
sheet's claim is that a recalculation cannot stall a scroll. This one's
is harder to fake: **a circuit simulating as fast as the machine allows
cannot make the editor hesitate.** On a single-threaded framework you
pause the simulation to edit it. Here you rewire a running CPU.

**Status:** Phases 0 to 5 done, with 0b. Phase 0's findings are in
[PHASE0.md](PHASE0.md), and the phases below are amended where they
changed anything. The simulator runs behind the `circuit` channel, and
the canvas draws it: a 10,000-gate scene pans and zooms at 60 fps with
the circuit running, circuits can be built on it by hand, and they
have switches, buttons, probes and displays to work them with. Nothing
past Phase 5 is built.

---

## The showpiece, exactly

This is the exit criterion of the whole file, written first so every
phase can be checked against it.

> Open the page. Pong is already playing on a 32 × 16 LED matrix,
> driven by an 8-bit CPU built entirely from logic gates — the status
> bar says how many (target: 9,000–11,000) and the simulated clock
> rate. Arrow keys move a paddle. Zoom into the CPU: the ALU, the
> registers and the RAM are chips you can open, and every wire inside
> is lit with its live value. Drag a gate, rewire a bus, scrub the
> waveform of the program counter — the game does not drop a frame
> and neither does the editor. Add `/proof` to the url and the strip
> along the top shows the render worker's frame cost with the CPU at
> full speed. Press **Block the main thread for 5 s**: the page
> freezes, the game keeps playing behind it.

What counts as a gate, so the number is honest:

| Counted                                                            | Not counted, and labelled as such            |
| ------------------------------------------------------------------ | -------------------------------------------- |
| NOT, AND, OR, NAND, NOR, XOR, XNOR (2+ inputs, counted as 2-input equivalents) | the program ROM (a lookup primitive, like Logisim's) |
| every latch and flip-flop, built from those gates                  | the clock source                             |
| the RAM, bit by bit                                                | switches, buttons, LEDs, the matrix, 7-segment displays |

The ROM is the one concession. A 256 × 16-bit ROM in gates is a
decoder and 4,096 constants, which would pad the count without
showing anything. Everything that *computes or remembers* is gates.

---

## The thread split

| Thread            | Owns                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Shell (main)      | the canvas, input forwarding, file open/save, the `/proof` strip                              |
| App worker        | the circuit document, undo history, the compiled netlist, the simulator, the waveform recorder |
| Render worker     | the canvas scene, pan/zoom, selection, wire routing preview, every panel                      |

The simulator runs in the app worker in time slices, yielding between
them so commands (an edit, a key press on the paddle) are handled
within a slice. The render worker never sees the netlist. It sees
geometry — where things are — and a snapshot of signal values for what
is on screen, at most once per frame.

**The constraint that shapes the contract.** Gesso's channel carries
plain data only (`requirePlainData` rejects typed arrays) and diffs each
view key structurally on every publish; gessosheet's Phase 0 measured
that an array-shaped window costs 80× the bytes of a keyed map. So:

- **Geometry and signals are separate view keys.** Geometry changes on
  an edit. Signals change every frame. A frame of simulation must not
  make the differ walk ten thousand gate positions to find nothing.
- **Signals are published as packed chunks keyed by chunk id** —
  `signals: Record<string, string>`, each value a hex string of 256
  nets — and only for nets visible in the current view plus a band.
  Net ids are laid out in 16 × 16-gate blocks so a chunk is a patch of
  the canvas. Phase 0 measured it at 60 Hz with every gate on screen: 51
  patches and 6.7 KiB per publish, 0.1 ms to build and 0.1 ms to diff.
- **Commands are small and semantic**: `placeGate`, `connect`, `move`,
  `setInput`, `run`, `pause`, `step`, `setClockHz`, `setViewport`.

---

## The CPU, sketched

Pinned down properly in Phase 13; this is enough to size everything
else against.

**Harvard, 8-bit.** Program in a 256 × 16-bit ROM (8-bit opcode, 8-bit
operand), data in an 8-bit address space. One-cycle fetch because the
ROM is 16 bits wide; one or two cycles to execute.

**Registers:** A (accumulator), B, X (index), PC, IR, flags Z / C / N,
and a link register for one level of `CALL` / `RET`.

**Instructions (≈ 24):** `LDA`/`LDB`/`LDX` immediate and absolute,
`LDA abs,X`, `STA abs` / `abs,X`, `ADD`, `SUB`, `AND`, `OR`, `XOR`,
`SHL`, `SHR`, `CMP`, `INX`, `DEX`, `JMP`, `JZ`, `JNZ`, `JC`, `JN`,
`CALL`, `RET`, `IN port`, `OUT port`, `HLT`.

**Memory map:**

| Address     | What                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `0x00–0x3F` | 64 bytes of general RAM                                                    |
| `0x40–0x7F` | 64 bytes of framebuffer — 32 × 16 pixels, one bit each                     |
| ports       | `IN 0` buttons, `IN 1` a frame tick; `OUT 0/1` the two score displays      |

The framebuffer latches *are* the pixels: the LED matrix is wired
straight to their outputs, so zooming into the RAM chip shows the
ball moving through the bits.

**Gate budget:**

| Block                         | Estimate | Why                                                          |
| ----------------------------- | -------: | ------------------------------------------------------------ |
| RAM storage, 1,024 bits       |   ~4,100 | a gated D latch is 4 gates                                   |
| RAM address decode (7 → 128)  |     ~800 | shared partial decoders                                      |
| RAM read path, 128 → 1 × 8    |   ~2,000 | AND-OR tree per bit                                          |
| Registers, ~51 bits           |     ~610 | master–slave D flip-flop (9) + load mux (3); see Phase 1      |
| ALU and flags                 |     ~250 | ripple-carry adder/subtractor, logic ops, shifter, result mux |
| PC, incrementer, branch       |      ~60 |                                                              |
| Buses and operand muxes       |     ~200 |                                                              |
| Control unit                  |     ~500 | opcode decode × cycle counter, hardwired                     |
| **Total**                     | **~8,400–9,500** | tune the RAM size to land at the target               |

Most of the gates are memory, which is true of real chips too. If the
count lands low, the lever is more RAM or a second index register; if
it lands high, a smaller framebuffer.

**Speed budget.** A Pong frame — move the ball, test four walls and two
paddles, erase and redraw three sprites with bit masks — is roughly
400–600 instructions, about 1,000 clock cycles. At 30 game frames per
second that is **30 kHz of simulated clock**. An event-driven simulator
touches perhaps 500 gates per cycle on this design (the RAM read tree
dominates), so ~15 M gate evaluations per second. Plain JavaScript over
typed arrays does 50–200 M on a laptop. That is the headroom the proof
spends: turn the clock up to "as fast as it goes" and the editor still
has to hold its frame.

**Corrected by Phase 0.** A synthetic CPU-shaped circuit costs about
**3,650** evaluations per cycle, not 500. Every flip-flop sees both
clock edges, and the control decoder re-evaluates on every input
change. The RAM is 22% of the work, not most of it. The kernel does
59–68 M evaluations a second, so 16–20 kHz, and 30 kHz needs about
110 M. Phase 12 owns the gap; PHASE0.md §4 has the per-block profile.

---

## Suspected gaps in Gesso

Found by reading, before Phase 0. **Phase 0's verdicts are in
PHASE0.md §3**: the `Paint` and binary-channel gaps are removed (the
fix is app-side, and strings are enough). Channel throughput holds for
packed chunks but found a replica bug (Phase 0b). Zoom input works with
real events, and pointer capture is still untested. The list is kept as
it was written. Where the fix belongs in the engine, it is made there
(see [Decisions](#decisions-taken-up-front)); each is general enough
that any editor, dashboard or canvas tool built on Gesso would want it.

- **A large `Paint` scene.** `Paint` records calls into a plain-data
  `PaintRecording` and replays it, and re-records when its inputs
  change. Ten thousand gates redrawn because one wire changed colour
  would re-record everything. App-side answer: separate static and
  live layers, tiled. Engine answer, if the app-side one is not
  enough: a tiled or retained `Paint` that re-records only the region
  that changed.
- **Binary data on the channel.** The channel refuses typed arrays, so
  a signal snapshot is packed into strings and diffed as strings. An
  engine answer is a channel view key declared as binary — a
  `Uint8Array` shipped by transfer or copy, replaced whole rather than
  diffed — which any app streaming samples, pixels or telemetry would
  use. Phase 0 decides whether strings are good enough or this is
  worth building.
- **Zoom.** Pinch and ctrl-wheel zoom on a canvas surface, and hit
  testing through a scale transform. The sheet never zoomed. A
  zoomable, pannable surface component is a natural `gesso-components`
  addition.
- **Pointer capture for long drags** across panels (dragging a wire
  from a pin to another chip's pin in a split view).
- **Channel throughput** for per-frame snapshots — the sheet publishes
  on scroll and on recalc slices, not every frame forever.

---

## Decisions taken up front

- **Two-state logic with unit delay.** Every signal is 0 or 1, and every
  gate takes one tick. Unit delay is what makes an SR latch built from
  two NANDs behave, which a CPU made of gates needs. A combinational
  loop that never settles is detected and shown as an oscillation, not
  hung on. Four-state (X, Z) is out of v1: there are no tri-state buses
  here, only muxes, and reset clears every latch.
- **One file format, no HDL.** Every chip, from a full adder to the
  CPU, is a circuit file the editor opens. Structures too regular to
  draw by hand — 1,024 RAM bits, the read tree — are *generated* by
  scripts that write that same format with a grid layout. There is no
  second language to learn and no second code path to trust.
- **The engine is in scope.** When the right fix for something here is
  in Gesso — and would help any application, not just this one — it is
  made in `../gesso`, with Gesso's own tests and gates, not worked
  around here. `gesso-*` 0.4.0 from the registry until the first such
  change (Phase 0b), then gessosheet's `scripts/vendor-gesso.sh`, which
  is now copied here. The `gesso.lock` deploy step, `vercel-install.sh`,
  comes with Phase 22. Each
  engine change is logged in [Engine changes](#engine-changes) below,
  with the phase that needed it.
- **The simulator imports nothing from the framework**, and runs
  headless under vitest, as the sheet model does.

---

# Part one — a simulator you can wire

## Phase 0 — Burn down the three risks

Timeboxed, throwaway code, fake circuits.

1. **Paint.** 10,000 gates and their wires in one view, panned and
   zoomed, with 10% of wires changing colour every frame.
2. **The wire.** The app worker publishing a signal snapshot for the
   visible nets at 60 Hz, forever, while the render worker draws.
   Measure patches and bytes per publish for packed-chunk strings
   against a plain `Record<netId, 0 | 1>`.
3. **The simulator.** A synthetic 10,000-gate netlist with the CPU's
   rough shape (a wide memory, a narrow datapath). Measure gate
   evaluations per second for an event-driven queue over typed arrays.

**Exit:** a 60 fps pan and zoom over the 10,000-gate scene with signals
arriving from the app worker; the chunk size and tile size as known
numbers; the simulator at ≥ 50 M evaluations per second. Findings go in
`PHASE0.md`. A miss on the first two is an engine question before it is
an app one: the spike says whether the fix is a tiled `Paint` or a
binary channel key, and that work is scheduled as Phase 0b in
`../gesso` before Phase 3 builds on it. A miss on the third changes the
simulator's design, and may lean harder on hierarchy so no view ever
holds 10,000 gates at full detail.

## Phase 0b — The replica applies a batch in one pass

Found by Phase 0 (PHASE0.md §2). `applyPatches` in
`gesso/packages/framework/src/channel/StorePatch.ts` clones every
container on a patch's path once per patch. A batch of N patches into
a K-key object therefore costs N × K. A `Record<netId, 0 | 1>` of
10,000 nets put the render worker's patch phase 7 minutes behind. The
chunked contract doesn't hit it, but any wide keyed map does, a
spreadsheet viewport included. Clone each container at most once per
batch, with a spec that applies 1,000 patches to a 10,000-key object
within a budget, and log it under Engine changes.

**Exit:** the Phase 0 `record` run at fit-all holds its frame.

**Done.** A batch now copies each container on its paths once and
writes into its own copies after that. It never writes into what it
was handed, or into a value a patch carried. `StorePatch.budget.spec.ts`
counts the copies: a batch of 1,000 sets into a 10,000-entry value
copied it 1,000 times, and now copies it once. The `record` run at
fit-all holds its frame, with a patch phase of 0.41 ms (it was 420 s),
and close up it is 0.28 ms (it was 33.9 ms). Hex chunks stay the
contract: 51 patches and 6.7 KiB a publish against 908 and 62.7 KiB.

Also found by Phase 0, by hand (PHASE0.md §5), and **done**:
`overscrollBehavior="contain"` on an app's root did nothing in a
mounted app. The wheel controller read the runtime's wrapper, not the
app's root, and honoured `contain` mid-chain only on scroll containers.
So a ctrl-wheel or a trackpad pinch over the canvas zoomed the page too.
Fixed in `../gesso` with specs, vendored, and checked in a desktop
browser. It's waiting to be committed there.

## Phase 1 — The simulator, headless

Pure TypeScript under `src/sim`, no framework import. The circuit
document (components, pins, wires, positions) and the netlist compiled
from it (nets as integers, gate inputs and outputs as typed-array
offsets). The event-driven unit-delay kernel. Primitives: the seven
gates, a clock, a constant, an input, an output. Oscillation detection.

**Exit:** specs that build an SR latch, a D flip-flop, a full adder and
a 4-bit ripple counter from gates, clock them, and assert every output
on every tick. A spec that builds a ring oscillator and asserts it is
reported, not hung on, naming a net that rings. Phase 0's first
circuit oscillated from a hold-time violation in a latch, and "it
oscillates" without the net would have taken much longer to find.

**Done.** `src/sim` holds the document (`Circuit.ts`), the compiler
(`Netlist.ts`), the kernel (`Simulator.ts`), a builder for writing
circuits in code, and the parts the specs are made of. 28 specs run in
node in about 20 ms. `boundaries.spec.ts` fails the build if anything
under `src/sim` imports from outside it. What was decided on the way:

- **Gates have two inputs.** So the six-NAND edge-triggered flip-flop,
  which needs a three-input NAND, isn't available. The flip-flop is
  master–slave, two gated latches and an inverter: 9 gates, not 6. That
  moves the register row of the gate budget from ~460 to ~610.
- **Power-on settles one gate at a time**, in document order, until a
  pass changes nothing. Lockstep would leave an SR latch with Q = Q̅
  ringing forever. So which way a latch wakes up is an accident of
  order, and the CPU still needs its reset line. A circuit with no
  settled state, a ring oscillator, goes straight to the unit-delay
  kernel and is reported on the first `settle`.
- **`settle` counts propagation delay exactly.** A net no gate reads
  isn't queued for another tick, so a full adder reports 3 ticks, its
  longest path.
- **An oscillation report names the nets that changed twice** in the 64
  ticks after the limit, sorted by name: the loop, not everything
  downstream of it. The hold-time violation from Phase 0 is a spec, and
  it names `ram7.q.out` and `ram7.qBar.out`.
- **A short is refused, not resolved.** Two drivers on one net is a
  compile error naming both pins. An undriven input reads 0 and is
  listed as floating.

## Phase 2 — The contract and the application worker

`CircuitContract.ts` with the view keys (`document`, `geometry`,
`signals`, `status`) and the commands above. The app worker owns the
document, compiles it on change, and runs the simulator in slices, with
a run / pause / step / clock-rate control.

**Exit:** a gesso-testing spec that places two switches and an AND gate
through commands, flips a switch, and reads the lit output from the
view — no browser.

**Done.** `src/app` holds the contract, a `CircuitService` (RxJS and
`src/sim`, no framework), document edits as plain functions, and
`circuitChannels`, which both `AppWorker.ts` and the exit spec serve.
`channels.spec.ts` is the exit, through `gesso-testing`'s
`serveForTest`. `CircuitService.spec.ts` drives time by hand: pacing at
a set rate, slices bounded by their budget at `max`, a command handled
between two slices, publishes never closer than 16 ms, a counter that
keeps its count across an edit while running, and an oscillation that
pauses the run and names the net. 40 specs in all. Where it departed
from the plan:

- **`place`, not `placeGate`**, since switches and outputs aren't gates.
  There is no remove yet, so a document that stops compiling stays that
  way until Phase 4. It's kept, drawn, and says why.
- **An edit keeps the running state.** The new netlist adopts the old
  simulator's values by pin, so latches keep their bits and switches
  their positions. Phase 12's incremental recompile is about speed;
  this is about not resetting.
- **Net ids are in document order, not spatial.** Phase 0's chunk
  locality relied on ids laid out by position. With document order, a
  viewport's nets are spread over more chunks. That's harmless at this
  size, and worth a renumbering pass when the CPU is on screen.
- **The viewport test is a component's origin**, since pin positions
  don't exist until Phase 3 draws shapes. A wire whose source component
  is off screen isn't lit. Phase 3 replaces this with real extents.
- **The spike's channel is renamed `spike`** and served beside
  `circuit`, until Phase 3 replaces the screen.

## Phase 3 — The canvas

A pannable, zoomable surface with a dot grid. Gates drawn in the
standard shapes, wires as orthogonal polylines, a lit wire in the
accent colour and an unlit one muted — both theme tokens, so dark mode
is free. Level of detail: below a zoom threshold, gates become filled
blocks and labels drop out.

From Phase 0 (PHASE0.md §1), four decisions this phase starts from:
256 px **tiles** on a world grid per zoom octave, placed in screen
space (culling stops at a transform), each a **static layer** (gates,
and anything that changes only on an edit) under a **live layer**. The
LOD threshold (0.3) is also where **wires stop carrying live colour
and the gate blocks take it**. **Zoom** scales the drawn tiles during
the gesture and redraws them 1:1 when it settles, spread over frames
rather than all in the settling one. Mid zoom (≈ 0.5, full detail)
cost 16–18 ms in software rendering, and this phase has to bring it
under budget.

**Exit:** Phase 0's 10,000-gate scene, now drawn by the real canvas
from the real contract, holds 60 fps panning and zooming with the
simulator running.

**Done.** `src/canvas` holds the canvas, a render-side scene index and
the painters. `src/app/Layout.ts` holds the geometry both workers
share. `src/app/Scenes.ts` holds the bench scene: Phase 0's grid made
real, a 10-bit counter driving 99 × 100 gates, 10,000 in all. `pnpm bench`
measures it (`scripts/bench.ts`, grown from Phase 0's runner, with the
driver in `src/canvas/Bench.ts`). Frame cost in ms, with the circuit
running flat out, after the engine change below:

| zoom | GPU still / pan / zoom (cost) | software still / pan / zoom (frame gap) |
| ---- | ---------------------------- | --------------------------------------- |
| fit-all, 1.3 px a unit | 2.7 / 2.9 / 2.6 ms | 16.8 / 16.8 / 18.2 ms |
| mid, 4 px a unit | 1.5 / 1.5 / 1.8 ms | 16.9 / 16.7 / 17.0 ms |
| close, 12 px a unit | 1.5 / 1.6 / 1.3 ms | 16.7 / 17.0 / 17.1 ms |

With the GPU every run holds 60 fps at a cost of at most 2.9 ms. In
software rendering every run holds 60 fps, give or take a vsync, except
zooming at fit-all, at about 55 fps: that sweep crosses the most octaves
and makes the most new tiles. Software numbers are frame gaps, not cost,
because replaying onto the frame moves raster work to the commit,
outside the worker's timer; `pnpm bench --trace` shows it as
`FinalizeFrame`.

**The engine change that closed most of it** (gesso, `PaintPictureCache.draw`):
Gesso rasterised every painted node's new recording into a bitmap of
its own, then drew the bitmap. A tile's live layer changes every frame,
so each bitmap was drawn once and thrown away. In software rendering
`transferToImageBitmap` alone was a quarter of the render worker's
time. On Canvas2D a picture whose inputs changed this frame is now
replayed straight onto the frame, clipped to its box, and gets a bitmap
only on the first frame it holds still. Mid zoom in software went from
16 ms a frame to 7.8, at the same drawing. WebGPU, which cannot replay,
keeps the bitmap path, and Gesso's parity gate still compares the
settled bitmaps both backends draw.

**And the app changes that finished it:**
- **Lit cores.** At the gates level of detail the live layer fills a
  rectangle inside each gate, not the curved body; the bodies are
  filled once in the static layer beneath. Mid zoom in software went
  from 7.8 ms to 2.3.
- **Whole-pixel tiles.** A bitmap drawn at a fractional position is
  resampled on every draw. Rounding each tile's position took a paused
  pan at mid zoom from 17.5 ms to 60 fps.
- **New tiles queued.** A tile's layers are rasterised on the frame it
  first appears, and frames that brought in a column of tiles ran 21–27
  ms. Tiles now come in three a frame, nearest the middle first, with
  the old grid covering their ground during a zoom. The blank ground
  that leaves averages under 2%; one a frame left up to 60%.
- **Half-resolution tiles during a zoom**, redrawn sharp when the zoom
  settles: a quarter of the raster on the frame a tile arrives. Mid and
  close zoom went from 18 ms to 60 fps.
- **Two layers a tile, not three.** The grid moves into the layer that
  is drawn anyway. That made no measurable frame difference, but it's a
  third less bitmap memory.

A retained compositor in the engine was also built and tried: scroll
layers, which shift a scroll container's previous pixels instead of
redrawing them. It works, but this canvas pans by moving tiles, not by
scrolling a container, and once tiles sat on whole pixels pan already
held 60 fps, so the canvas doesn't use it.

Paused, a frame costs 0.7–1.1 ms. The render worker gets 53–58
snapshots a second with the GPU. It was checked by hand in a desktop
Chrome as well: 60 fps at every zoom with the circuit running at about
500 Hz. What the bench found, beyond Phase 0:

- **A third level of detail.** Between 2.5 and 6 px a unit, gate
  symbols keep their shape and the body fills with the output's value,
  while wires go unlit into the static layer. Full detail at mid zoom
  re-stroked about 4,300 wires every frame. Wires carry colour from 6 px
  a unit.
- **A grid change is spread over frames.** Crossing a zoom octave used
  to replace every tile in one frame, up to 216 ms. The old grid now
  stays on screen while the new one comes in four tiles a frame.
- **Tile size matters twice.** A hysteresis wide enough to hold a
  coarser grid left mid zoom on 12 tiles of 512 px, and its frame went
  from 16 ms to 48 in software rendering: every live layer is redrawn
  every frame, including the part hanging off screen. The grid keeps
  its octave only across [0.9, 1.9).
- **Publishing is checked inside a slice.** Nested `setTimeout(0)` is
  clamped to 4 ms, so publishes that could land only at a slice's end
  came 38 times a second. A `MessageChannel` avoids the clamp, and was
  tried, but its next slice queued ahead of every command and `pause`
  never arrived.
- **A still, paused scene produces no frames.** Gesso draws only on
  change, so the bench keeps a hidden binding moving to get frames to
  measure.
- **Loading the scene is a one-time hitch** of 1.3–2.4 s: 10,000
  components crossing the channel, and the index built. Phase 6's.

Still open: **zooming at fit-all in software rendering**, at about 55
fps. **The bench scene is a glitch storm**, about 52,700 evaluations a cycle from random
XOR-heavy logic, so it runs at about 550 Hz. That's a harsh load for the
application worker and says nothing about the CPU's speed.

## Phase 4 — Editing

Place from a palette (click or drag). Drag to move, with wires
following. Draw a wire by dragging from a pin; the route is
auto-orthogonal and snaps to the grid. Marquee and shift-click
selection, delete, rotate, duplicate, copy and paste between tabs.
Undo and redo in the app worker, coalesced per gesture. Keyboard: the
usual shortcuts, plus a key per gate type.

**Exit:** a circuit built by hand in the browser — a full adder from
scratch — in under a minute, then undone to empty and redone.

**Done.** A full adder was built by hand in a desktop Chrome, all with
real input: three switches, two XORs, two ANDs, an OR, two LEDs and
eleven wires, dragged pin to pin. Flipping the switches added correctly,
twenty-five Ctrl+Z took it to an empty canvas, and Ctrl+Shift+Z rebuilt
it. Move with wires following, rotate, duplicate, delete, marquee, and
copy and paste through the system clipboard were each checked the same
way. `Editor.spec.ts` holds the gestures to it headlessly: 70 specs in
all. How it's built:

- **The render worker owns selection and every gesture**
  (`src/canvas/Editor.ts`). The document changes only through commands:
  `place`, `connect`, `moveBy`, `rotate`, `remove`, `insert`, `undo`,
  `redo`. Commands that create something carry the id to give it, made
  in the render worker, so a new part is selected without a round trip.
- **Undo lives in the application worker.** A drag's moves carry one
  gesture id and fold into one step, and an edit that changes nothing
  records nothing. Documents share structure, so a step costs what it
  changed.
- **A move or a rotation keeps the netlist and the running simulator.**
  Connectivity is unchanged, so only geometry is published: dragging
  through a running circuit doesn't recompile it per pointer event.
- **An edit redraws only the tiles it touched.** Tiles outlive edits.
  The scene index diffs the old geometry against the new (components
  moved, turned, added or removed, and wires whose routes changed), and
  only tiles meeting those areas redraw their static layers. Every live
  layer refreshes once, because a recompile renumbers nets.
- **Keys:** Delete, R to rotate, arrows to nudge (shift for 4),
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Ctrl+A, Ctrl+C / X / V / D, Escape.
  A key per part: A, O, N and X for AND, OR, NOT and XOR, shift for
  NAND, NOR and XNOR, I for a switch, L for an LED, C for a clock and
  K for a constant. Middle or right drag pans, and so does a drag with
  space held.
- **A switch is flipped by clicking it once it's selected.** The first
  click selects it so it can be moved; Phase 5 may want a dedicated
  handle.
- **The canvas opens empty.** The bench loads its scene with the new
  `loadScene` command, and so does a readout button. Tiles now cover
  the whole view, not the scene's bounds, so a gate can be dropped
  anywhere; empty ground costs nothing. The view frames itself when a
  document is opened (`DocumentSummary.opened`), never on an edit:
  framing on the first part placed fitted one switch to the window.
- **A release far from its press finishes a drag**, even with no move
  reported between them: a fast flick can arrive as down then up.

Not done: dragging from the palette (clicking a part then the canvas
works), and routing that avoids other components (wires still take the
three-segment route). The readout's "worst gap" also counts idle time,
since Gesso draws only on change.

## Phase 5 — Things you can touch

Switch, push button, clock (with a rate), LED, probe (shows a value on
any wire), hex and 7-segment displays. Inputs work while the circuit
runs. A truth-table panel for any selection with ≤ 8 inputs: sweep the
inputs, show the outputs.

**Exit:** a 4-bit counter driving a 7-segment display, clocked at 2 Hz,
visibly counting.

**Done.** The **Counter** button loads the exit circuit (`counterScene`
in `src/app/Scenes.ts`, 110 gates): four D flip-flops counting through
XORs, a 4-to-16 decoder, and a seven-segment display beside a hex
display and four LEDs showing the same count. Run it and it counts at
2 Hz. A spec runs it through twenty digits and checks every segment,
and it was watched counting in Chrome.

- **New parts:** push button (B), probe (P), hex display (H) and
  seven-segment display (7). The displays read four and seven nets, so
  the scene index keeps each display's nets, and they're drawn in the
  live layer at the gates level as well as full detail. A 5 × 8 display
  is readable at 2.5 px/u.
- **A push button is held**, for as long as the press lasts, once
  it's selected, the same rule as a switch. Dragging a held button
  lets it go and moves it.
- **A probe dropped on a wire clips onto it.** It's placed just above
  the wire and connected to the pin that drives it. Dropped on empty
  ground, it's a part to wire by hand. At 10 px/u and up it prints
  0, 1 or ?.
- **The clock's rate is on the document** (`Component.rate`). There's
  one rate for every clock, because the simulator has one clock domain.
  Loading a document takes its rate; changing the rate writes it back
  onto the clocks, outside the undo history. 2 Hz is now one of the
  rates.
- **Inputs work while running**, and now a cycle settles any input set
  since the last one before it raises the clock (`Simulator.cycle`).
  Without that, releasing `reset` in the same tick as the edge was a
  setup-time violation, and the counter's first count was a race.
- **The truth table** (T, or the readout button) sweeps the selection
  (`src/app/TruthTable.ts`). It works on nets, not wires:
  - inputs are the selection's switches and buttons, plus every net a
    selected gate reads that no selected gate drives;
  - outputs are what the selection drives outward or shows on its own
    LEDs.

  The selected gates are copied into a circuit of their own and swept
  up to 8 inputs. The table follows edits while it's open. A row that
  rings shows `~`. A latch shows what it settles to from the row
  before.
- **`layOut`** places a circuit made in code in columns, by distance
  from a source. That's enough until Phase 6 opens circuits drawn by
  hand.

Not done: a clock rate per clock (it needs several clock domains), and
a one-click way to work a switch that isn't selected. Power-on leaves
the counter's flip-flops wherever the latches fell, so it can start on
any digit; `reset` clears it.

## Phase 6 — Files

A JSON circuit format with a version field. Save to and open from the
file system, autosave to OPFS, a library of recent files. Drag a file
onto the canvas to open it.

**Exit:** save, reload the tab, and the circuit comes back running from
reset, with nothing lost that was on screen.

## Phase 7 — The proof surface

`/proof`, built the way the sheet's is: a DOM strip on the main thread
with a rAF pulse, the render worker's frame readout, a "Block the main
thread for 5 s" button, and a "run at full speed" toggle. `pnpm proof`
drives the built app in headless Chrome and fails on budgets — the one
that matters: *a frame with the simulator at full speed may cost no more
than 4 ms over a frame with it paused.* Start by copying
`gessosheet/src/shell/ProofPanel` and `scripts/frame-budget.ts`; if the
copy works unchanged, it belongs in `gesso-devtools`, and that is worth
proposing.

**Exit:** `pnpm proof` green in CI on the Phase 3 scene at full speed.

**From Phase 3: the budget as written can't hold on a live canvas.** At
mid zoom with the GPU a running frame costs about 8 ms more than a
paused one. That isn't the simulator reaching the render thread; it's
the cost of drawing values that change. The comparison that isolates
the claim is full speed against a slow clock with the same picture
changing, or the render worker's cost while the application worker is
saturated against while it idles. Decide which before building the
gate.

---

# Part two — chips

Ten thousand gates on one flat canvas is unreadable and undrawable.
Hierarchy is what makes the showpiece possible to build and possible to
look at.

## Phase 8 — Subcircuits

Select gates and "make chip": the selection's boundary crossings become
pins, and the chip gets a name and a body. Chips are placed like gates,
and a chip file is a circuit file. Double-click to open a chip in
place: its insides, live, with a breadcrumb back out. The netlist
compiler flattens the hierarchy; the renderer never does.

**Exit:** a full adder made into a chip, eight of them chained into an
8-bit adder, that into a chip, and the inside of the third full adder
showing live values while the outside adds.

## Phase 9 — Buses

Multi-bit wires drawn thicker with their width labelled, splitters and
joiners, and multi-bit pins on chips. A bus value shows as hex on hover
and on a probe.

**Exit:** the 8-bit adder rebuilt with bus pins, feeding a hex display.

## Phase 10 — The standard library

The parts the CPU is built from, each a chip made of gates, each with a
spec in `src/sim` that exhausts or samples its truth table: half and
full adder, 8-bit adder/subtractor, 2- and 4-way mux, 3 → 8 decoder, D
latch, D flip-flop, 8-bit register with load, 8-bit counter. Shown in
the palette under "Library", openable like anything else.

**Exit:** every library part passes its spec, and the palette places
them.

## Phase 11 — The logic analyser

A waveform panel. The app worker keeps a ring buffer of every probed
net for the last N cycles; the panel asks for the window it shows, as
the sheet's grid asks for its viewport. Scrub, zoom in time, place a
cursor, read values. Trigger on a condition to pause.

**Exit:** a counter's four bits shown as a staircase over 1,000 cycles,
scrubbed at 60 fps while the circuit runs.

## Phase 12 — Speed

The kernel from Phase 1 made fast on the real CPU-shaped workload:
struct-of-arrays layout, fan-out lists packed contiguously, gates of the
same type processed together, the RAM read tree evaluated as a known
structure if the profile says so. Recompile incrementally on edit, so
rewiring a running CPU does not re-flatten ten thousand gates. Consider
WebAssembly only if JavaScript misses the target.

**Exit:** ≥ 100 kHz simulated clock on a 10,000-gate benchmark circuit,
with an edit applied mid-run in under one frame. Phase 0's baseline is
16–20 kHz at about 3,650 evaluations per cycle, so this is roughly a
6× improvement. Evaluations per cycle (clock fan-out into flip-flops
whose D has not moved, the control plane) are probably worth more than
evaluations per second.

---

# Part three — the CPU

## Phase 13 — The ISA, an emulator, an assembler

Freeze the ISA sketched above as `ISA.md`: every opcode, its encoding,
its cycles and its flag effects. Then two tools in TypeScript, headless:

- **A reference emulator** — the ISA at instruction level, a few hundred
  lines. It is the truth the gate-level CPU is tested against.
- **An assembler** — labels, constants, `.byte` data, and error messages
  with line numbers. It writes ROM images.

**Exit:** a test program suite (arithmetic, flags, every branch, indexed
addressing, `CALL` / `RET`, I/O) that passes on the emulator.

## Phase 14 — The generators

Scripts that write circuit files: an N-byte RAM chip (latch grid,
decoder, read tree) and the register file, with a regular layout, so
opening them in the editor shows something that looks designed. A spec
for each generated chip, at the size the CPU uses.

**Exit:** a 128-byte RAM chip that the editor opens, and that passes a
write-then-read-every-address spec.

## Phase 15 — The datapath

ALU, registers, PC with incrementer and branch mux, and the buses
between them, assembled in the editor from library parts. Driven by
hand from switches standing in for the control unit.

**Exit:** loading two registers and adding them by flipping switches,
the result visible on a hex display.

## Phase 16 — The control unit

Hardwired: opcode decode crossed with a cycle counter, producing the
datapath's control lines. One truth-table row per instruction per
cycle, checked against `ISA.md`.

**Exit:** the CPU chip, complete, runs a three-instruction program from
the ROM and halts.

## Phase 17 — Memory and devices

RAM and framebuffer on the address bus, the ports, the 32 × 16 LED
matrix wired to the framebuffer latches, buttons on `IN 0`, a frame tick
on `IN 1`, and two 7-segment displays on the `OUT` ports.

**Exit:** a program that draws a diagonal line on the matrix, bit by
bit, visible at a slow clock.

## Phase 18 — Lockstep

Run the gate-level CPU and the reference emulator side by side on the
Phase 13 suite and compare registers, flags and memory after every
instruction. The first divergence stops both and names the instruction,
the cycle and the differing bit. This is the phase that makes the CPU
trustworthy, and it runs in CI.

**Exit:** the whole suite in lockstep with zero divergences, plus a
randomised program fuzzer that runs for a minute without one.

---

# Part four — Pong

## Phase 19 — The game

Pong in assembly: two paddles (one player, one simple AI that follows
the ball with a lag), a ball with four directions of travel, bounce off
walls and paddles, scores on the 7-segment displays, and a frame loop
paced by the tick port. Written and debugged on the reference emulator,
with a tiny emulator-only harness that draws the framebuffer, before it
ever runs on gates.

**Exit:** playable on the emulator, and the whole program under 256
instructions.

## Phase 20 — Pong on gates

The same ROM image in the gate-level CPU. Tune the clock and the
game loop until it plays at a speed a person enjoys. Lockstep one full
game against the emulator.

**Exit:** a full game played to eleven on the gate-level CPU, in the
browser, with the frame budget green.

## Phase 21 — The showpiece page

The landing experience from the top of this file: opens on Pong
running, the gate count and clock rate in the status bar, the CPU
chip one double-click away, a short guided tour ("open the ALU", "watch
the program counter", "rewire this while it runs"), and a "run this on
the main thread instead" toggle that moves the simulator onto the shell
so anyone can feel the difference in one click.

**Exit:** someone who has never seen the project opens the url, plays
Pong, opens the CPU and edits a wire while the game runs, without
reading anything.

## Phase 22 — Ship it

Deploy to Vercel as the sheet is. A README in the sheet's shape: the
claim, sixty seconds to try it, the numbers, how it works, what it is
not yet. Link it from Gesso's README beside the spreadsheet.

**Exit:** the url is public and `pnpm proof` gates the deploy.

---

## Engine changes

Changes made in `../gesso` because this project needed them. Each row
names the phase, the change, and the Gesso commit or release it
shipped in.

| Phase | Change | Shipped in |
| ----- | ------ | ---------- |
| 0b    | `overscrollBehavior="contain"` works on an app's root and on any node, not only scroll containers, so a canvas can keep the wheel (`UiWheelController`, `GessoRuntime`) | gesso `94bb672` |
| 0b    | `applyPatches` copies each container once per batch, not once per patch (`StorePatch`) | gesso `9327bcb` |
| 3     | On Canvas2D a painted node's new recording is replayed onto the frame, and rasterised into a bitmap only once it holds still (`PaintPictureCache.draw`) | gesso `d3b0040` |
| 3     | …except a picture seen for the first time or resized, which is rasterised at once rather than drawn twice | gesso `74c24c4` |
| 3     | Scroll layers: a scroll container whose offset is the frame's only change is shifted and its exposed strip redrawn, not redrawn whole. Built for this canvas, not used by it (it pans tiles, not a container), and kept for apps that scroll | gesso `62ef127` |

---

## Not in this roadmap

Worth doing later, deliberately out of scope so the showpiece ships:

- Four-state logic, tri-state buses and propagation-delay timing.
- A textual HDL or Verilog import.
- A Nand-to-Tetris-style sequence of levels that teaches the CPU from
  the ground up — the library in Phase 10 is most of the content.
- Sharing a circuit by link, and collaborative editing.
- A WebGPU renderer path for very large flat circuits.
