/**
 * Phase 0, spike 3: how fast can a gate be evaluated.
 *
 * Builds the synthetic CPU-shaped circuit, checks that it really clocks
 * (the program counter has to count), says where one cycle's
 * evaluations go, then runs each kernel flat out for a fixed wall time
 * and prints evaluations per second, clock cycles per second and what
 * one cycle costs. Twice: once with a control block shaped like a
 * control unit, once with a random one, because the first run showed
 * the control block's logic style moves the answer by a factor of four.
 *
 *   node scripts/phase0-sim.ts [gates]
 *
 * Runs in Node rather than in the browser because the question is the
 * kernel's and V8 is the same engine in both.
 */
import { EventKernel, SweepKernel, runCycle, type Kernel } from '../src/spike/sim/Kernel.ts';
import { syntheticCpu, type ControlStyle, type SyntheticCpu } from '../src/spike/sim/Synthetic.ts';

const target = Number(process.argv[2] ?? 10_000);
const WARMUP_MS = 500;
const RUN_MS = 3000;

const summary: Record<string, unknown>[] = [];

for (const style of ['pla', 'random'] as ControlStyle[]) {
  const cpu = syntheticCpu(target, style);
  const { netlist } = cpu;
  console.log(`\n=== control: ${style} — ${netlist.gateCount} gates, ${netlist.netCount} nets, ${netlist.fanGate.length} fan-out edges\n`);
  sanity(cpu);
  profile(cpu);
  const results = [measure(cpu, 'event-driven', new EventKernel(netlist)), measure(cpu, 'sweep', new SweepKernel(netlist))];
  table(results.map(r => ({ control: style, ...r })));
  summary.push(...results.map(r => ({ control: style, ...r })));
}
console.log(`\nPHASE0-SIM ${JSON.stringify(summary)}`);

/**
 * The circuit has to be a circuit: 300 cycles, and the program counter
 * must have counted every one of them, on both kernels.
 */
function sanity(cpu: SyntheticCpu): void {
  const read = (kernel: Kernel) => cpu.pc.reduce((sum, net, i) => sum | (kernel.value[net] << i), 0);
  for (const kernel of [new EventKernel(cpu.netlist), new SweepKernel(cpu.netlist)] as Kernel[]) {
    const start = read(kernel);
    for (let cycle = 1; cycle <= 300; cycle++) {
      runCycle(kernel, cpu.clock);
      const pc = read(kernel);
      if (pc !== (start + cycle) % 128) {
        throw new Error(`${kernel.constructor.name}: after ${cycle} cycles the PC reads ${pc}, not ${(start + cycle) % 128}.`);
      }
    }
  }
  console.log('sanity: the PC counts 300 cycles on both kernels\n');
}

/**
 * Where one cycle's evaluations go, block by block, averaged over 1,000
 * cycles. "Changes" is how many of those evaluations moved the gate's
 * output; the rest woke a gate to find its answer the same.
 */
function profile(cpu: SyntheticCpu): void {
  const kernel = new EventKernel(cpu.netlist, true);
  const cycles = 1000;
  for (let i = 0; i < cycles; i++) {
    runCycle(kernel, cpu.clock);
  }
  const { evaluated, changed } = kernel.profile!;
  const byBlock = new Map<string, { gates: number; evaluated: number; changed: number }>();
  for (const { name, start, end } of cpu.ranges) {
    const entry = byBlock.get(name) ?? { gates: 0, evaluated: 0, changed: 0 };
    entry.gates += end - start;
    for (let g = start; g < end; g++) {
      entry.evaluated += evaluated[g];
      entry.changed += changed[g];
    }
    byBlock.set(name, entry);
  }
  const total = [...byBlock.values()].reduce((sum, e) => sum + e.evaluated, 0);
  table(
    [...byBlock].map(([block, e]) => ({
      block,
      gates: e.gates,
      'evals/cycle': Math.round(e.evaluated / cycles),
      share: `${((100 * e.evaluated) / total).toFixed(1)}%`,
      'changes/cycle': Math.round(e.changed / cycles)
    }))
  );
  console.log();
}

function measure(cpu: SyntheticCpu, kernelName: string, kernel: Kernel): Record<string, string | number> {
  let until = performance.now() + WARMUP_MS;
  while (performance.now() < until) {
    runCycle(kernel, cpu.clock);
  }
  const evaluationsBefore = kernel.evaluations;
  let cycles = 0;
  let ticks = 0;
  const start = performance.now();
  until = start + RUN_MS;
  let now = start;
  while (now < until) {
    // The clock is read every 16 cycles, not every cycle: at a few
    // thousand cycles a second `performance.now` would otherwise be a
    // measurable share of what is being measured.
    for (let i = 0; i < 16; i++) {
      ticks += runCycle(kernel, cpu.clock);
    }
    cycles += 16;
    now = performance.now();
  }
  const ms = now - start;
  const evaluations = kernel.evaluations - evaluationsBefore;
  return {
    kernel: kernelName,
    'M evals/s': Number(((evaluations / ms) * 1000 / 1e6).toFixed(1)),
    'k cycles/s': Number(((cycles / ms) * 1000 / 1e3).toFixed(2)),
    'evals/cycle': Math.round(evaluations / cycles),
    'ticks/cycle': Number((ticks / cycles).toFixed(1)),
    'µs/cycle': Number(((ms * 1000) / cycles).toFixed(1))
  };
}

function table(rows: Record<string, unknown>[]): void {
  const columns = Object.keys(rows[0]);
  const widths = columns.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  console.log(columns.map((c, i) => c.padStart(widths[i])).join('  '));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(columns.map((c, i) => String(row[c]).padStart(widths[i])).join('  '));
  }
}
