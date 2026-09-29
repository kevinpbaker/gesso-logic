import type { WireShape } from './CircuitContract';

/**
 * The Phase 0 measurement for spikes 1 and 2, as something a machine
 * runs.
 *
 * Gessosheet's harness, reshaped for a canvas: each run sets the knobs,
 * puts the camera at a zoom, waits for the signals to cover the view,
 * then holds still, pans or zooms for a fixed time with signals
 * arriving at 60 Hz throughout, and prints one line of JSON. It runs
 * in the render worker, whose frame cost is the exit criterion, and
 * reports over `console.log`, which the harness reads from the worker's
 * own DevTools target.
 *
 * **Cost, not rate.** Headless Chrome schedules frames as it likes, so
 * the gap between frames says as much about the compositor as about the
 * app. `cost` is the work the render worker did for a frame, and that is
 * the number 16.7 ms is compared against.
 */

export type PaintMode = 'tiles' | 'single';
/**
 * `full` draws every wire in its live colour at every zoom. `blocks`,
 * below the detail zoom, draws wires once unlit and shows live values
 * on the gates instead. See `ScenePainter.liveGates`.
 */
export type Lod = 'full' | 'blocks';
/** How a tile follows a zoom: resized and redrawn, or scaled until the next octave. See `App.tileBox`. */
export type ZoomRaster = 'resize' | 'scale' | 'settle';
export type Motion = 'still' | 'pan' | 'zoom';
/** A zoom named by what it shows: every gate, a few hundred, a few dozen. */
export type ZoomPreset = 'all' | 'mid' | 'close';

export interface BenchRun {
  readonly label: string;
  readonly mode: PaintMode;
  /** Nominal tile side in screen pixels. */
  readonly tile: number;
  readonly lod: Lod;
  readonly zoomRaster: ZoomRaster;
  readonly shape: WireShape;
  readonly zoom: ZoomPreset;
  readonly motion: Motion;
  /** Share of nets flipped per 60 Hz step. */
  readonly activity: number;
}

export interface BenchKnobs {
  apply(run: BenchRun): void;
  /** Moves the camera by one frame of the run's motion, given the frame gap. */
  move(run: BenchRun, gapMs: number): void;
  report(line: string): void;
  done(): void;
}

export interface BenchSample {
  readonly gapMs: number;
  readonly durationMs: number;
  readonly phases: Readonly<Record<string, number>>;
  readonly nodes: number;
  /** Which backend drew the frame: `canvas2d`, `webgpu`, or `pending`. */
  readonly renderer: string;
  /** Cumulative `paintPictures.stats`: recordings and rasterisations. */
  readonly recorded: number;
  readonly rasterized: number;
  /** Milliseconds inside the painters this frame: the recording half of the render phase. */
  readonly recordMs: number;
  /** Share of on-screen nets with no value yet, 0..1. */
  readonly missed: number;
  /** Age of the snapshot drawn this frame, in ms, or -1 when it is not new. */
  readonly ageMs: number;
  readonly tiles: number;
  /** Cumulative counters from the application worker. */
  readonly publishes: number;
  readonly patches: number;
  readonly bytes: number;
  readonly nets: number;
  readonly chunks: number;
  readonly buildMs: number;
  readonly diffMs: number;
}

const SETTLE_FLOOR_MS = 600;
const SETTLE_CEILING_MS = 4000;
const RUN_MS = 3000;

/**
 * Seven groups, each answering one question.
 */
export function benchMatrix(): BenchRun[] {
  const base: Omit<BenchRun, 'label'> = {
    mode: 'tiles',
    tile: 256,
    lod: 'full',
    zoomRaster: 'resize',
    shape: 'hex',
    zoom: 'all',
    motion: 'still',
    activity: 0.1
  };
  const runs: BenchRun[] = [];
  const add = (label: string, overrides: Partial<BenchRun>) => runs.push({ ...base, ...overrides, label });

  // 1. The floor: nothing changing. What drawing 10,000 gates costs when
  //    nothing asks for a redraw, and when a pan does.
  add('idle-still', { activity: 0 });
  add('idle-pan-all', { activity: 0, motion: 'pan' });

  // 2. The paint question: every gate on screen, 10% of wires changing
  //    colour every frame, one Paint against tiles.
  for (const mode of ['single', 'tiles'] as PaintMode[]) {
    for (const zoom of ['all', 'mid', 'close'] as ZoomPreset[]) {
      add(`${mode}-still-${zoom}`, { mode, zoom });
    }
  }

  // 3. Pan and zoom with signals flowing, both strategies.
  for (const mode of ['single', 'tiles'] as PaintMode[]) {
    for (const motion of ['pan', 'zoom'] as Motion[]) {
      for (const zoom of ['all', 'mid'] as ZoomPreset[]) {
        add(`${mode}-${motion}-${zoom}`, { mode, motion, zoom });
      }
    }
  }

  // 4. The tile size, at the zoom and motion that hurts most.
  for (const tile of [128, 256, 512]) {
    add(`tile-${tile}-pan-all`, { tile, motion: 'pan' });
    add(`tile-${tile}-still-all`, { tile });
  }

  // 5. The wire shape, with the most nets on screen and while panning.
  //    `record` at fit-all sends ~900 patches a publish into a
  //    10,000-key object. Before Phase 0b the replica copied that object
  //    once per patch and fell minutes behind; these runs are that
  //    phase's exit criterion.
  for (const shape of ['hex', 'base64', 'record'] as WireShape[]) {
    add(`wire-${shape}-still-all`, { shape });
    add(`wire-${shape}-pan-mid`, { shape, motion: 'pan', zoom: 'mid' });
  }
  for (const shape of ['hex', 'base64', 'record'] as WireShape[]) {
    add(`wire-${shape}-still-close`, { shape, zoom: 'close' });
  }

  // 6. Activity: what the live layer costs as the share of changing
  //    wires rises. 1% is a quiet circuit, 50% is every other net.
  for (const activity of [0.01, 0.5]) {
    add(`activity-${activity * 100}-still-all`, { activity });
  }

  // 7. The level of detail, which the first full run said is the
  //    only lever that moves the fit-all numbers: at that zoom a wire is
  //    a pixel, so its colour moves to the gate.
  for (const mode of ['single', 'tiles'] as PaintMode[]) {
    add(`blocks-${mode}-still-all`, { mode, lod: 'blocks' });
    add(`blocks-${mode}-pan-all`, { mode, lod: 'blocks', motion: 'pan' });
  }

  // 8. Zoom, which group 7 left at 60 ms: a tile resized every frame
  //    records both layers every frame. Scaling instead of resizing
  //    records only at octave boundaries but rasterises at twice the
  //    size; settling scales during the gesture and redraws 1:1 after.
  for (const zoomRaster of ['resize', 'scale', 'settle'] as ZoomRaster[]) {
    add(`zoom-${zoomRaster}-all`, { lod: 'blocks', motion: 'zoom', zoomRaster });
    add(`zoom-${zoomRaster}-mid`, { lod: 'blocks', motion: 'zoom', zoom: 'mid', zoomRaster });
  }

  // 9. The exit criterion, read off last: pan and zoom over all 10,000
  //    gates with signals arriving, with the settings the groups above
  //    chose.
  const chosen: Partial<BenchRun> = { lod: 'blocks', zoomRaster: 'settle' };
  add('confirm-pan-all', { ...chosen, motion: 'pan' });
  add('confirm-zoom-all', { ...chosen, motion: 'zoom' });
  add('confirm-still-all', { ...chosen });
  add('confirm-pan-mid', { ...chosen, motion: 'pan', zoom: 'mid' });
  add('confirm-zoom-mid', { ...chosen, motion: 'zoom', zoom: 'mid' });

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
  private ages: number[] = [];
  private phaseTotals = new Map<string, number>();
  private missedFrames = 0;
  private worstMiss = 0;
  private peakNodes = 0;
  private peakTiles = 0;
  private start: BenchSample | null = null;

  constructor(
    private readonly runs: readonly BenchRun[],
    private readonly knobs: BenchKnobs
  ) {}

  frame(at: number, sample: BenchSample): void {
    if (this.finished) {
      return;
    }
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
        this.ages = [];
        this.phaseTotals = new Map();
        this.missedFrames = 0;
        this.worstMiss = 0;
        this.peakNodes = 0;
        this.peakTiles = 0;
        this.start = sample;
      }
      return;
    }

    this.knobs.move(run, sample.gapMs);
    this.gaps.push(sample.gapMs);
    this.costs.push(sample.durationMs);
    this.recordMs.push(sample.recordMs);
    if (sample.ageMs >= 0) {
      this.ages.push(sample.ageMs);
    }
    for (const [name, ms] of Object.entries(sample.phases)) {
      this.phaseTotals.set(name, (this.phaseTotals.get(name) ?? 0) + ms);
    }
    if (sample.missed > 0) {
      this.missedFrames++;
      this.worstMiss = Math.max(this.worstMiss, sample.missed);
    }
    this.peakNodes = Math.max(this.peakNodes, sample.nodes);
    this.peakTiles = Math.max(this.peakTiles, sample.tiles);
    if (at >= this.until) {
      this.finish(run, sample);
    }
  }

  private finish(run: BenchRun, sample: BenchSample): void {
    const started = this.start!;
    const frames = this.costs.length;
    const publishes = sample.publishes - started.publishes;
    const per = (value: number, count: number) => (count === 0 ? 0 : round(value / count));
    this.knobs.report(
      JSON.stringify({
        run: run.label,
        mode: run.mode,
        tile: run.tile,
        lod: run.lod,
        zoomRaster: run.zoomRaster,
        shape: run.shape,
        zoom: run.zoom,
        motion: run.motion,
        activity: run.activity,
        frames,
        renderer: sample.renderer,
        gapMs: round(mean(this.gaps)),
        gapP95Ms: round(quantile(this.gaps, 0.95)),
        costMs: round(mean(this.costs)),
        costP95Ms: round(quantile(this.costs, 0.95)),
        costWorstMs: round(Math.max(0, ...this.costs)),
        phases: Object.fromEntries([...this.phaseTotals].map(([name, total]) => [name, per(total, frames)])),
        recordedPerFrame: per(sample.recorded - started.recorded, frames),
        recordMs: round(mean(this.recordMs)),
        rasterizedPerFrame: per(sample.rasterized - started.rasterized, frames),
        missFramesPct: per(100 * this.missedFrames, frames),
        worstMissPct: round(100 * this.worstMiss),
        ageMs: round(mean(this.ages)),
        ageP95Ms: round(quantile(this.ages, 0.95)),
        peakNodes: this.peakNodes,
        peakTiles: this.peakTiles,
        publishesPerSecond: round((publishes * 1000) / RUN_MS),
        nets: sample.nets,
        chunks: sample.chunks,
        patchesPerPublish: per(sample.patches - started.patches, publishes),
        bytesPerPublish: Math.round(per(sample.bytes - started.bytes, publishes)),
        buildMs: round(sample.buildMs),
        diffMs: round(sample.diffMs)
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
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The bench runs when the page url carries `?bench`, handed to the worker as its name. */
export function isBench(): boolean {
  return workerName().startsWith('bench');
}

/** `?bench&only=regex` arrives as the name `bench:regex`, and keeps only the matching runs. */
export function benchFilter(runs: readonly BenchRun[]): BenchRun[] {
  const colon = workerName().indexOf(':');
  if (colon < 0) {
    return [...runs];
  }
  const only = new RegExp(workerName().slice(colon + 1));
  return runs.filter(run => only.test(run.label));
}

function workerName(): string {
  return typeof self !== 'undefined' ? ((self as { name?: string }).name ?? '') : '';
}

export const BENCH_PREFIX = 'PHASE0 ';
export const BENCH_DONE = 'PHASE0-DONE';
