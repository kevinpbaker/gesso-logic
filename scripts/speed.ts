/**
 * Phase 12's measurement: how fast the simulator clocks a CPU-shaped
 * 10,000-gate circuit, and how long an edit to it takes to apply.
 *
 * Builds `benchmarkCpu`, seeds its RAM, checks it really clocks (the
 * program counter counts), then runs flat out for a fixed wall time and
 * prints cycles a second, evaluations and ticks a cycle, and evaluations
 * a second. Then times edits applied mid-run, on each of the two
 * threads an edit crosses: the application worker's service and channel,
 * and the render worker's scene. The exit is 100 kHz, and an edit inside
 * a frame, 16 ms, on each.
 *
 *   pnpm speed
 *
 * In Node rather than a browser because the question is the kernel's,
 * and V8 is the same engine in both.
 */
import { diffProjection } from 'gesso-framework';

import type { Geometry } from '../src/app/CircuitContract.ts';
import { CircuitService } from '../src/app/CircuitService.ts';
import { SceneIndex } from '../src/canvas/SceneIndex.ts';
import { benchmarkCpu, seedRam } from '../src/sim/Benchmark.ts';
import { compile } from '../src/sim/Netlist.ts';
import { Simulator } from '../src/sim/Simulator.ts';

const WARMUP_MS = 1000;
const RUN_MS = 3000;

const circuit = benchmarkCpu();
let started = performance.now();
const netlist = compile(circuit);
const compileMs = performance.now() - started;
const sim = new Simulator(netlist);
seedRam(sim);
sim.settle();

// It has to be a circuit: the program counter counts every cycle.
const pc = () => [0, 1, 2, 3, 4, 5, 6].reduce((n, i) => n | (sim.read(`pc${i}.slave.q`) << i), 0);
const before = pc();
for (let i = 0; i < 300; i++) {
  if (!sim.cycle().settled) throw new Error(`cycle ${i} did not settle`);
}
if (pc() !== (before + 300) % 128) throw new Error(`the program counter went from ${before} to ${pc()} in 300 cycles`);

const run = (ms: number) => {
  const evaluations0 = sim.evaluations;
  const ticks0 = sim.ticks;
  const cycles0 = sim.cycles;
  const start = performance.now();
  let now = start;
  while (now - start < ms) {
    for (let i = 0; i < 64; i++) sim.cycle();
    now = performance.now();
  }
  const cycles = sim.cycles - cycles0;
  return {
    kHz: cycles / (now - start),
    evaluationsPerCycle: (sim.evaluations - evaluations0) / cycles,
    ticksPerCycle: (sim.ticks - ticks0) / cycles,
    mEvaluationsPerSecond: (sim.evaluations - evaluations0) / (now - start) / 1000
  };
};
run(WARMUP_MS);
const result = run(RUN_MS);

// An edit mid-run, as the app applies one. The application worker: the
// service takes the edit — recompiles against the netlist before, moves
// the running state across, patches the geometry — and the channel
// diffs the geometry it publishes. The render worker: the scene is
// rebuilt from the patched geometry, and says where the drawing changed.
// Each has a frame; they run on different threads.
let slice: (() => void) | null = null;
const service = new CircuitService({ schedule: run => (slice = run), now: () => performance.now() });
service.load(circuit);
service.setClockHz('max');
service.run();
let geometry!: Geometry;
let published: Geometry | undefined;
let diffMs = 0;
service.geometry.subscribe(g => {
  const t = performance.now();
  diffProjection('geometry', published, g);
  diffMs = performance.now() - t;
  published = g;
  geometry = g;
});
let scene = new SceneIndex(geometry);
const lastWire = circuit.wires[circuit.wires.length - 1]!;
const edits: Record<string, () => void> = {
  'remove a wire': () => service.remove([lastWire.id]),
  undo: () => service.undo(),
  'move a gate': () => service.moveBy(['pc0.d'], 1, 0)
};
const timings: Record<string, { app: number[]; render: number[] }> = {};
for (let round = 0; round < 40; round++) {
  for (const [name, edit] of Object.entries(edits)) {
    // Mid-run: a slice of running between edits.
    const next = slice;
    slice = null;
    next?.();
    const t = performance.now();
    edit();
    const app = performance.now() - t + diffMs;
    const r = performance.now();
    scene = new SceneIndex(geometry, scene);
    const render = performance.now() - r;
    if (round < 10) continue; // warming up
    (timings[name] ??= { app: [], render: [] }).app.push(app);
    timings[name].render.push(render);
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const worst = (xs: number[]) => Math.max(...xs);
const editRows = Object.entries(timings).map(([edit, { app, render }]) => ({
  edit,
  appMs: Number(median(app).toFixed(1)),
  appWorstMs: Number(worst(app).toFixed(1)),
  renderMs: Number(median(render).toFixed(1)),
  renderWorstMs: Number(worst(render).toFixed(1))
}));

const row = {
  gates: netlist.gateCount,
  nets: netlist.netCount,
  kHz: Number(result.kHz.toFixed(1)),
  evaluationsPerCycle: Math.round(result.evaluationsPerCycle),
  ticksPerCycle: Number(result.ticksPerCycle.toFixed(1)),
  mEvaluationsPerSecond: Number(result.mEvaluationsPerSecond.toFixed(1)),
  compileMs: Number(compileMs.toFixed(1)),
  editAppMs: Math.max(...editRows.map(r => r.appMs)),
  editRenderMs: Math.max(...editRows.map(r => r.renderMs))
};
console.table([row]);
console.table(editRows);
console.log(`SPEED ${JSON.stringify({ ...row, edits: editRows })}`);
