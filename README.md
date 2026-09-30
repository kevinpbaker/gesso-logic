<div align="center">

# gessologic

**An 8-bit CPU made of 8,559 logic gates, playing Pong, that you can rewire while it plays.**

Built on [Gesso](https://github.com/kevinpbaker/gesso), a UI framework that lays out, paints and hit-tests the whole interface in a worker, and lets the page's own thread do nothing at all.

TypeScript · Canvas · a hand-assembled WebAssembly kernel · three threads · every gate evaluated on every clock · a frame budget that fails the build

[Sixty seconds](#sixty-seconds) · [What it does](#what-it-does-today) · [The numbers](#the-numbers) · [How](#how-it-works) · [The machine](#the-machine) · [Not yet](#what-it-is-not-yet) · [Under the hood](#under-the-hood)

</div>

---

Every logic simulator makes you choose. Either the circuit runs, or you
edit it. Drag a gate while a clock is ticking and the editor stutters,
because the simulation and the interface are sharing the one thread the
browser also uses for everything else. So you press pause, make your
change, and press play.

This one does not pause. The circuit is simulated in an **application
worker**. The canvas is drawn by a **render worker**. The main thread
creates a canvas, forwards input, and is otherwise idle. The page opens
on the proof:

> **Pong is already playing** on a 32 × 16 LED matrix, driven by an
> 8-bit CPU built entirely from gates: the ALU, the registers, the
> control unit and every bit of the RAM. The arrow keys move your
> paddle. Double-click the CPU and you are inside it, every wire lit
> with its live value. Open the ALU. Scrub the program counter's
> waveform. Delete a wire. **The game does not drop a frame, and
> neither does the editor.**

The claim is harder to fake than it sounds: *a circuit simulating as
fast as the machine allows cannot make the editor hesitate.* The rest
of this repository exists to make that checkable by a stranger with a
browser.

## Sixty seconds

[Gesso](https://github.com/kevinpbaker/gesso) comes from npm with
everything else:

```bash
pnpm install
pnpm dev
```

Open the address Vite prints. A first visit lands on Pong, running, and
a five-step tour in the corner:

1. **Play.** Hold ↑ or ↓. The CPU is on the right, and it is not
   easy to beat.
2. **Look inside the CPU.** Double-click it. The breadcrumb reads
   *Top › CPU*.
3. **Open the ALU.** *Top › CPU › datapath › ALU*. Every wire is
   drawn in its live colour, at 18 kHz.
4. **Watch the program counter** in the logic analyser along the
   bottom. Drag across it to scrub.
5. **Rewire it while it plays.** Select a wire and delete it. The
   game carries on (or breaks, depending on the wire) and the frame
   rate doesn't move. **Edit → Reset** puts the chip back.

Then, three things to try:

- **Reprogram it.** Double-click the ROM. Pong's source opens, with its
  comments. Change `WIN = 0x11` to `WIN = 0x03`, press Ctrl+Enter, and
  play a game to 3, on the gates. A typo names its line and leaves the
  running game alone. Undo brings the old program back.
- **Feel the difference.** The toolbar's **Worker** button reloads the
  page with the simulator on the main thread, and the game carries on
  from the autosave. Set the clock to *As fast as it goes*, then try
  to use the menus. Press it again to go back.
- **Add `/proof` to the url.** The black strip along the top is the
  instrument panel, and it is the only DOM on the page. It lives on the
  main thread on purpose, because a thread's idleness can't be measured
  from inside it. Run the 10,000-gate bench at full speed and pan
  around. Then press **Block the main thread for 5 s**. The page
  freezes, and the circuit keeps running and drawing behind it.

`pnpm proof` does all of that in headless Chrome, with real wheel
events and real clicks, and fails the build when a budget is missed.

## What it does today

A logic simulator you could learn digital design on. The CPU is the
biggest thing built with it, not the only thing it can do.

- **Editing.** Place gates, drag wires pin to pin, and move, rotate,
  duplicate, cut, copy and paste, through the system clipboard. Marquee
  selection. Undo and redo for every edit, kept in the application
  worker, so a drag is one step. Wires overlapping? Click again for the
  next one, or press Tab. While a wire is being drawn, every pin it
  could land on is named.
- **Things you can touch.** Switches, push buttons, clocks, constants,
  LEDs, probes, hex and seven-segment displays, and a 32 × 16 LED
  matrix. With nothing selected, the arrow keys hold buttons named
  `up`, `down`, `left` and `right`, so any circuit with those buttons
  plays from the keyboard.
- **Chips.** Select some parts and **Make chip**. A chip is a circuit:
  its switches are its input pins and its LEDs are its outputs. Chips
  nest to any depth, and you open one by double-clicking. An edit inside
  changes every instance of it, and **Reset** puts it back the way it
  was opened.
- **Buses.** Pins and wires up to 32 bits wide, with splits and joins.
  Hover a bus to read its value in hex.
- **A standard library** of twelve parts, each built from gates and
  each with a spec: half and full adders, `add/sub 8`, muxes, a
  decoder, latches, flip-flops, registers, counters.
- **A logic analyser.** It traces every probe and LED on the level you
  are looking at. Scrub it, put a cursor on it, or set a trigger that
  pauses the circuit ("Triggered at cycle 32,329: bit3 = 1").
- **A truth table** for any combinational selection.
- **Files.** Save and open circuit files through the File System
  Access API, drop one onto the page, or pick one from the recent-files
  list. Everything autosaves to OPFS and is still there after a reload.
  The format writes one part per line, so moving a gate is a one-line
  diff.
- **A program editor** for the ROM, with syntax colouring, a gutter of
  line numbers and ROM addresses, the program counter's line marked
  while it runs, and errors listed line by line.
- **Examples.** Pong, a counter, an 8-bit adder built out of eight full
  adders, a bus adder, the 128-byte RAM, the datapath, the computer,
  and seven test programs for the CPU.
- **Light and dark.** Shift+D, or the sun/moon at the end of the
  toolbar. The cached canvas tiles repaint mid-game.

## The numbers

Measured on one Linux machine: an AMD Ryzen 5 5600X, in Chrome. What
matters is the shape more than the third digit.

**The simulator.** `pnpm speed` builds a CPU-shaped benchmark of
exactly 10,000 gates and runs it flat out:

| | |
| --- | ---: |
| simulated clock | **111 kHz** |
| gate evaluations a second | **438 million** |
| evaluations per clock cycle | 3,915 |
| where it started, in plain JavaScript | 17 kHz, 64 million |
| an edit applied mid-run (remove a wire, median) | 8.4 ms in the app worker, 9.0 ms in the render worker |

Every edit lands inside a 16 ms frame on both threads, while the
circuit keeps running.

**The canvas.** A 10,000-gate scene, running flat out:

| zoom | GPU cost, still / pan / zoom |
| ---- | ---------------------------- |
| fit all | 2.7 / 2.9 / 2.6 ms |
| mid | 1.5 / 1.5 / 1.8 ms |
| close | 1.5 / 1.6 / 1.3 ms |

It holds 60 fps under software rendering too, which took two engine
changes to Gesso (listed in [ROADMAP.md](ROADMAP.md#engine-changes)).

**The proof.** CI compares a frame with the simulator saturated
against a frame with it on a 100 Hz clock. The render worker draws the
same thing both times, so any difference would be the simulator
leaking into the render thread. The budget is 4 ms. On the runner the
difference is **0.0–0.6 ms**.

**Pong on gates**, at 30 kHz, before it was slowed down to be
playable: the render worker at 163–165 fps, a median frame of 1.1 ms,
the worst gap between frames 14.5 ms, and a whole game to 11 played in
the browser with the strip green.

**The suite** is 272 specs in 39 files, and it runs headless in node in
about 13 seconds. It includes one that checks every one of the 65,536
possible ROM words disassembles and reassembles to itself.

## How it works

| Thread             | Owns                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Main (the shell)   | the canvas, input forwarding, file open and save, the `/proof` strip                             |
| Application worker | the circuit document, undo history, the compiled netlist, the simulator, the waveform recorder |
| Render worker      | the canvas scene, pan and zoom, selection, every gesture, every panel                            |

**The render worker never sees the netlist.** It gets geometry (where
things are) and a snapshot of the signal values for what's on screen,
at most once a frame. They are separate view keys, because geometry
changes on an edit and signals change on every frame, and a frame of
simulation should not make Gesso's structural differ walk ten thousand
gate positions to find nothing changed.

**Signals travel as packed hex strings**, 256 nets to a chunk, keyed by
chunk id, and only for the nets in view plus a band around it. Net ids
are laid out in 16 × 16-gate blocks, so a chunk is a patch of the
canvas. With all 10,000 gates on screen at 60 Hz, that's 51 patches and
6.7 KiB a publish, built in 0.1 ms and diffed in 0.1 ms. Phase 0
measured it before anything was built on it ([PHASE0.md](PHASE0.md)).

**Commands are small and semantic**: `place`, `connect`, `moveBy`,
`setInput`, `run`, `step`, `setClockHz`, `setViewport`. A command that
creates something carries the id to give it, minted in the render
worker, so the new part is selected without waiting for a round trip.

**The simulator runs in time slices** and yields between them, so an
edit or a paddle press is handled within a slice. An edit recompiles
only when connectivity changed; a move doesn't.

**The canvas is tiled into layers.** Gates, and anything else that
changes only on an edit, are painted once into 256 px tiles and moved
by offset when you pan, which costs nothing. Live wires go in their own
layer. Zoom out far enough and the gates are drawn as blocks.

**The kernel is WebAssembly, with no toolchain.** `src/sim/Kernel.ts`
assembles a module of a few hundred bytes from opcodes written out in
TypeScript, once per process. Two-state logic, a unit delay per gate,
event-driven: every edge of every net that changed on the last tick is
evaluated against the values as they were when the tick began, then the
changes are applied. That delay is what lets an SR latch built from two
NANDs behave, and a CPU made of gates needs that. A loop that never
settles is shown as an oscillation, not waited on. The same loop in
JavaScript peaked at 130 million evaluations a second. Most of the cost
was bounds checks and tagged integers.

**Main-thread mode needed no engine change.** `?main` makes `main.ts`
open a `MessageChannel`, serve the circuit through one end with the
same `serveCircuit` the worker uses, and hand the other end to
`createApp` as the application endpoint. The render worker can't tell.

## The machine

A Harvard 8-bit CPU, specified in full in [ISA.md](ISA.md):

- **Registers:** A, B, X, PC, a 16-bit IR, a link register L for one
  level of `CALL`/`RET`, and the flags Z, C and N.
- **32 instructions in 49 opcodes**, each exactly two clock cycles, fetch then
  execute: loads and stores (immediate, absolute and indexed), an ALU
  (`ADD SUB AND OR XOR CMP SHL SHR`), branches on every flag, `IN`,
  `OUT`, and `LDT`, which reads a byte out of a table in the ROM.
- **Memory:** a 256 × 16-bit program ROM; 64 bytes of RAM; and 64
  bytes of framebuffer, which is ordinary RAM to the CPU. The LED
  matrix is wired straight to those latches, so zoom into the RAM and
  you can watch the ball move through the bits.
- **Ports:** the buttons and a frame tick in; two score displays out.

Where the gates go:

| Block | Gates |
| ----- | ----: |
| CPU: datapath, ALU, registers, control unit | 1,666 |
| Memory and ports: 128 bytes, decode, read tree | 6,883 |
| Power-on reset | 10 |
| **The computer** | **8,559** |

**What counts as a gate**, so the number is honest: NOT, AND, OR, NAND,
NOR, XOR and XNOR, every latch and flip-flop (built from those), and
the RAM, bit by bit. What isn't counted, and is labelled as not
counted: the program ROM (a lookup primitive, as in Logisim), the clock
source, and the switches, buttons and displays. Everything that
*computes or remembers* is gates.

**It is held to a reference.** `src/cpu/Emulator.ts` implements the ISA
in 245 lines. `pnpm lockstep` runs the gate-level computer and
the emulator side by side and compares PC, A, B, X, the flags, all 128
bytes of RAM (read off the latches) and both ports after every
instruction. It plays a whole game of Pong to 11 (about 855,000
instructions, with no divergence), then fuzzes random programs with random button presses
for as long as you give it. CI runs a minute of that on every push.
When something does diverge, it says exactly where:

> Diverged at instruction 3, cycle 7: ADD #0x01 at 0x02 left RAM[0x45]
> 0x05 on gates and 0x01 in the emulator, first in bit 2.

**Pong** is 223 words of assembly: [`src/cpu/games/pong.asm`](src/cpu/games/pong.asm).
The opponent heads for the middle while the ball is going away, and
goes for it once it's coming and within four columns. That returns 93%
of balls, which a person can beat. To play it in a terminal on the
emulator, before you trust the gates:

```bash
pnpm pong            # ↑/↓ or w/s, q to quit
```

## What it is not yet

Said plainly, so nobody finds out the hard way:

- **Not deployed.** `vercel.json` is ready. The public url, and
  `pnpm proof` gating the deploy, are Phase 22 of the
  [roadmap](ROADMAP.md) and aren't done.
- **Two-state logic only.** No X, no Z, no tri-state buses, and no
  propagation-delay timing. Every gate takes one tick. The CPU is built
  with muxes, so it doesn't need them.
- **Two-input gates.** A wider gate is counted, and built, as 2-input
  equivalents, so a flip-flop is 9 gates, not the textbook 6.
- **One level of `CALL`.** L is a register, not a stack.
- **No HDL.** Every chip, from a half adder to the CPU, is a circuit
  file the editor opens. The shapes too regular to draw by hand (1,024
  RAM bits, the read tree, the datapath) are written by generators in
  `src/app/Generators.ts` into that same format. There's no second
  language and no second code path to trust.
- **Not collaborative**, and a circuit can't be shared by link yet.

## Under the hood

Everything below is for someone working on the code.

```bash
pnpm dev             # the simulator, with hot replacement of the screen
pnpm build           # a production bundle
pnpm preview         # serve it
pnpm typecheck       # tsc, no emit
pnpm test            # vitest, headless: 272 specs, ~13 s

pnpm proof           # build, serve, drive /proof in headless Chrome, check the budgets
pnpm bench           # the canvas matrix, in headless Chrome (--gpu, --only=, --shot=)
pnpm speed           # the simulator flat out on 10,000 gates, and edits mid-run
pnpm lockstep [s]    # the gates against the emulator: Pong to 11, then s seconds of fuzzing
pnpm asm file.asm    # assemble a program into a ROM image
pnpm generate        # rewrite circuits/ from the generators (a spec fails if stale)
pnpm pong [hz]       # Pong on the emulator, in a terminal
pnpm phase0:sim      # Phase 0's kernel spike, kept as Phase 12's baseline
```

`pnpm proof` and `pnpm bench` need Chrome on the path, or `CHROME_BIN`.

### Where things are

| Path | What |
| ---- | ---- |
| `src/sim/` | The simulator: the document (`Circuit.ts`), the compiler (`Netlist.ts`), the WebAssembly kernel, the primitives, the standard library, the file format. It imports nothing from outside itself, and `boundaries.spec.ts` enforces that. |
| `src/cpu/` | The ISA, the emulator, the assembler, the syntax highlighter, the test programs and the games. The same boundary holds. |
| `src/app/` | The contract between the workers, the circuit service, undo, layout, scenes, the generators, lockstep, the truth table and the analyser. |
| `src/canvas/` | The render side: the scene index, the painters, the editor's gestures, the waveform. |
| `src/ui/` | The workbench: menus, palette, inspector, dialogs, the program editor, the tour, the proof instruments. |
| `circuits/` | The generated parts as circuit files: the CPU, the datapath, memory and ports, RAM 128, the register file. |
| `scripts/` | Everything `pnpm` runs that isn't Vite or Vitest. |

### The pages

`/` is the simulator. `/proof` is the same simulator with Phase 7's
instruments: the strip along the top, on the main thread, and the
10,000-gate bench with a full-speed switch and a Pong button. `?main`
moves the simulator onto the main thread. `?bench` is what `pnpm bench`
drives. The strip has to be decided before any worker starts, so
`src/route.ts` is read by both threads.

### Building against Gesso

Gesso is developed alongside this project, and changes to the engine
are made in the engine when they'd help any app (see
[ROADMAP.md § Engine changes](ROADMAP.md#engine-changes)). The six
`gesso-*` packages are installed from npm like any other dependency,
so a change made there reaches this project when it is released and
the version here is bumped.

### The three files

| File            | What it is                                               |
| --------------- | -------------------------------------------------------- |
| `src/main.ts`   | The main thread: create the app and mount it into `#app` |
| `src/worker.ts` | The render worker: name the root component               |
| `src/AppWorker.ts` | The application worker: serve the `circuit` channel   |

`main.ts` names no worker. `gesso-vite-plugin` finds `worker.ts` beside
it and writes the construction out, and while the dev server runs it
swaps the screen in place when a component is saved, keeping the
keyboard focus where it was.

### CI

`.github/workflows/ci.yml`, on every push to `main` and every pull
request: install, typecheck, the specs, a
minute of lockstep, then the frame budget.

### Reading further

- [ROADMAP.md](ROADMAP.md): all 23 phases, from a blank canvas to Pong
  on gates. Each one has its exit criterion and what was measured when
  it was met, including the cases where the plan turned out wrong.
- [PHASE0.md](PHASE0.md): the three risks, burnt down before anything
  was built on them.
- [ISA.md](ISA.md): the instruction set, frozen. The opcode table there
  is checked against `src/cpu/Isa.ts` by a spec, so the two can't
  drift.
