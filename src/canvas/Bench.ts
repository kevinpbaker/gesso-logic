import type { ZoomPreset } from './CircuitCanvas';

/**
 * Phase 3's exit, as something a machine runs: the real canvas over the
 * real contract, with the simulator running.
 *
 * Phase 0's driver cut down to the question now asked: does a frame stay
 * under 16.7 ms while the 10,000-gate bench scene pans and zooms with
 * the application worker running the circuit flat out. Each run puts the
 * camera at a zoom, waits for signals to cover the view, then holds
 * still, pans or zooms for a fixed time and prints one line of JSON,
 * which `scripts/bench.ts` reads from the render worker's console.
 *
 * **Cost, not rate**: headless Chrome schedules frames as it likes, so
 * the work the render worker did for a frame is what 16.7 ms is
 * compared against. The gap is printed beside it.
 */

export type Motion = 'still' | 'pan' | 'zoom';

export interface BenchRun {
  readonly label: string;
  readonly zoom: ZoomPreset;
  readonly motion: Motion;
  /** Whether the simulator runs, at `max`, during the run. */
  readonly running: boolean;
}

export interface BenchKnobs {
  apply(run: BenchRun): void;
  move(run: BenchRun, gapMs: number): void;
  report(line: string): void;
  done(): void;
}

export interface BenchSample {
  readonly gapMs: number;
  readonly durationMs: number;
  readonly phases: Readonly<Record<string, number>>;
  readonly nodes: number;
  readonly renderer: string;
  readonly recorded: number;
  readonly recordMs: number;
  readonly missed: number;
  readonly tiles: number;
  /** Cumulative tiles made. */
  readonly tilesMade: number;
  /** Share of the view's tiles with nothing drawn yet, 0..1. */
  readonly blank: number;
  /** Cumulative signal snapshots received, and the simulator's own report. */
  readonly snapshots: number;
  readonly cycles: number;
  readonly achievedHz: number;
}

const SETTLE_FLOOR_MS = 800;
const SETTLE_CEILING_MS = 5000;
const RUN_MS = 3000;

export function benchMatrix(): BenchRun[] {
  const runs: BenchRun[] = [
    // The floor: the circuit paused, nothing arriving.
    { label: 'paused-still-all', zoom: 'all', motion: 'still', running: false },
    { label: 'paused-pan-all', zoom: 'all', motion: 'pan', running: false },
    // Paused motion at mid zoom: every layer a cached bitmap, so what a
    // frame costs here is compositing alone — the baseline a running
    // frame's live drawing is priced against.
    { label: 'paused-zoom-all', zoom: 'all', motion: 'zoom', running: false },
    { label: 'paused-pan-mid', zoom: 'mid', motion: 'pan', running: false },
    { label: 'paused-zoom-mid', zoom: 'mid', motion: 'zoom', running: false }
  ];
  // The exit: running flat out, at every zoom, still and moving.
  for (const zoom of ['all', 'mid', 'close'] as ZoomPreset[]) {
    for (const motion of ['still', 'pan', 'zoom'] as Motion[]) {
      runs.push({ label: `running-${motion}-${zoom}`, zoom, motion, running: true });
    }
  }
  return runs;
}

type Phase = 'apply' | 'settle' | 'run';

export class BenchDriver {
  private index = 0;
  private phase: Phase = 'apply';
  private until = 0;
  private ceiling = 0;
  private finished = false;
  private gaps: number[] = [];
  private costs: number[] = [];
  private recordMs: number[] = [];
  private phaseTotals = new Map<string, number>();
  private missedFrames = 0;
  private peakTiles = 0;
  private start: BenchSample | null = null;
  /** Per frame: whether the frame before it made tiles, and this frame's gap. */
  private afterMaking: number[] = [];
  private afterNot: number[] = [];
  private lastMade = 0;
  private madeLast = false;
  private blanks: number[] = [];

  constructor(
    private readonly runs: readonly BenchRun[],
    private readonly knobs: BenchKnobs
  ) {}

  frame(at: number, sample: BenchSample): void {
    if (this.finished) return;
    const run = this.runs[this.index];
    if (run === undefined) {
      this.finished = true;
      this.knobs.done();
      return;
    }
    if (this.phase === 'apply') {
      this.knobs.apply(run);
      this.phase = 'settle';
      this.until = at + SETTLE_FLOOR_MS;
      this.ceiling = at + SETTLE_CEILING_MS;
      return;
    }
    if (this.phase === 'settle') {
      if (at >= this.until && (sample.missed === 0 || at >= this.ceiling)) {
        this.phase = 'run';
        this.until = at + RUN_MS;
        this.gaps = [];
        this.costs = [];
        this.recordMs = [];
        this.phaseTotals = new Map();
        this.missedFrames = 0;
        this.peakTiles = 0;
        this.start = sample;
        this.afterMaking = [];
        this.afterNot = [];
        this.blanks = [];
        this.lastMade = sample.tilesMade;
      }
      return;
    }
    this.knobs.move(run, sample.gapMs);
    // The gap a frame reports is what the frame before it cost, commit
    // and all, so it is filed under whether that frame made tiles.
    (this.madeLast ? this.afterMaking : this.afterNot).push(sample.gapMs);
    this.madeLast = sample.tilesMade > this.lastMade;
    this.blanks.push(sample.blank);
    this.lastMade = sample.tilesMade;
    this.gaps.push(sample.gapMs);
    this.costs.push(sample.durationMs);
    this.recordMs.push(sample.recordMs);
    for (const [name, ms] of Object.entries(sample.phases)) {
      this.phaseTotals.set(name, (this.phaseTotals.get(name) ?? 0) + ms);
    }
    if (sample.missed > 0) this.missedFrames++;
    this.peakTiles = Math.max(this.peakTiles, sample.tiles);
    if (at >= this.until) {
      this.finish(run, sample);
    }
  }

  private finish(run: BenchRun, sample: BenchSample): void {
    const started = this.start!;
    const frames = this.costs.length;
    const per = (value: number) => (frames === 0 ? 0 : round(value / frames));
    this.knobs.report(
      JSON.stringify({
        run: run.label,
        renderer: sample.renderer,
        frames,
        costMs: round(mean(this.costs)),
        costP95Ms: round(quantile(this.costs, 0.95)),
        costWorstMs: round(Math.max(0, ...this.costs)),
        gapMs: round(mean(this.gaps)),
        gapP95Ms: round(quantile(this.gaps, 0.95)),
        recordedPerFrame: per(sample.recorded - started.recorded),
        recordMs: round(mean(this.recordMs)),
        peakTiles: this.peakTiles,
        tilesMade: sample.tilesMade - started.tilesMade,
        gapAfterMakingMs: round(mean(this.afterMaking)),
        gapAfterMakingCount: this.afterMaking.length,
        gapAfterNotMs: round(mean(this.afterNot)),
        blankFramesPct: round((100 * this.blanks.filter(b => b > 0).length) / Math.max(1, this.blanks.length)),
        blankMeanPct: round(100 * mean(this.blanks)),
        blankWorstPct: round(100 * Math.max(0, ...this.blanks)),
        missFramesPct: per(100 * this.missedFrames),
        snapshotsPerSecond: round(((sample.snapshots - started.snapshots) * 1000) / RUN_MS),
        simCyclesPerSecond: round(((sample.cycles - started.cycles) * 1000) / RUN_MS),
        achievedHz: sample.achievedHz,
        phases: Object.fromEntries([...this.phaseTotals].map(([name, total]) => [name, per(total)]))
      })
    );
    this.index++;
    this.phase = 'apply';
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `?bench` arrives as the render worker's name, `bench` or `bench:<regex>`. */
function workerName(): string {
  return typeof self !== 'undefined' ? ((self as { name?: string }).name ?? '') : '';
}

export function isBench(): boolean {
  return workerName().startsWith('bench');
}

/** `?bench&only=regex` keeps only the runs whose label matches. */
export function benchFilter(runs: readonly BenchRun[]): BenchRun[] {
  const colon = workerName().indexOf(':');
  if (colon < 0) return [...runs];
  const only = new RegExp(workerName().slice(colon + 1));
  return runs.filter(run => only.test(run.label));
}

export const BENCH_PREFIX = 'BENCH ';
export const BENCH_DONE = 'BENCH-DONE';
