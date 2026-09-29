import { BehaviorSubject, type Observable } from 'rxjs';

import { diffProjection } from 'gesso-framework';

import { EMPTY_SIGNALS, packChunk, type Signals, type WireShape, type WireStats } from './CircuitContract';
import { buildScene, CHUNK, SceneQuery, type Scene } from './Scene';

/**
 * The application thread's half of spike 2.
 *
 * There is no simulator here. A timer flips a fixed share of all nets at
 * a fixed rate, which is the wire's worst honest case: every step
 * changes something in nearly every chunk, forever. Then it publishes a
 * snapshot of the nets the render worker can see, in whichever shape is
 * selected, and records what the differ made of it.
 *
 * `diffProjection` is imported only for the readout: it is the differ
 * `provide` is about to run over the same value, so the patch counts
 * are the real ones. Running it twice overstates this thread's cost and
 * leaves the render thread's alone.
 */
export class SignalSource {
  readonly signals: Observable<Signals>;
  readonly stats: Observable<WireStats>;

  private readonly scene: Scene = buildScene();
  private readonly query = new SceneQuery(this.scene);
  private readonly values: Uint8Array;
  private readonly signalsSubject = new BehaviorSubject<Signals>(EMPTY_SIGNALS);
  private readonly statsSubject: BehaviorSubject<WireStats>;

  private shape: WireShape = 'hex';
  private activity = 0.1;
  private hz = 60;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tick = 0;
  private random = seeded(11);

  /** What is on screen, widened by the band, and the nets and chunks it covers. */
  private viewport = { left: 0, top: 0, right: -1, bottom: -1 };
  private visibleNets = new Int32Array(0);
  private visibleChunks: number[] = [];

  private previous: Signals = EMPTY_SIGNALS;
  private publishes = 0;
  private patches = 0;
  private bytes = 0;

  constructor() {
    this.values = new Uint8Array(this.scene.netCount);
    for (let g = 0; g < this.scene.gateCount; g++) {
      this.values[this.scene.gateNet[g]] = this.random() < 0.5 ? 1 : 0;
    }
    this.signals = this.signalsSubject;
    this.statsSubject = new BehaviorSubject<WireStats>(this.statsNow(0, 0, 0, 0));
    this.stats = this.statsSubject;
    this.restart();
  }

  /**
   * The band is a quarter of the viewport on each side — the lookahead
   * gessosheet's Phase 0 found belongs on the publishing side — so a
   * pan reaches nets that were sent before it arrived.
   */
  setViewport(left: number, top: number, right: number, bottom: number): void {
    const bandX = (right - left) / 4;
    const bandY = (bottom - top) / 4;
    this.viewport = { left: left - bandX, top: top - bandY, right: right + bandX, bottom: bottom + bandY };
    const nets = new Set<number>();
    const { gateNet, wireNet } = this.scene;
    const { left: l, top: t, right: r, bottom: b } = this.viewport;
    this.query.forEach(
      l,
      t,
      r,
      b,
      g => nets.add(gateNet[g]),
      w => nets.add(wireNet[w])
    );
    this.visibleNets = Int32Array.from(nets).sort();
    this.visibleChunks = [...new Set([...nets].map(net => Math.floor(net / CHUNK)))].sort((a, b) => a - b);
    this.publish();
  }

  setShape(shape: WireShape): void {
    this.shape = shape;
    this.publish();
  }

  setActivity(fraction: number): void {
    this.activity = Math.min(1, Math.max(0, fraction));
  }

  setRate(hz: number): void {
    this.hz = Math.max(0, hz);
    this.restart();
  }

  private restart(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.hz > 0) {
      this.timer = setInterval(() => this.step(), 1000 / this.hz);
    }
  }

  private step(): void {
    const { gateCount, gateNet } = this.scene;
    const flips = Math.round(gateCount * this.activity);
    for (let i = 0; i < flips; i++) {
      this.values[gateNet[Math.floor(this.random() * gateCount)]] ^= 1;
    }
    this.tick++;
    this.publish();
  }

  private publish(): void {
    const started = performance.now();
    const chunks: Record<string, string> = {};
    const nets: Record<string, 0 | 1> = {};
    if (this.shape === 'record') {
      for (const net of this.visibleNets) {
        nets[net] = this.values[net] as 0 | 1;
      }
    } else {
      for (const chunk of this.visibleChunks) {
        chunks[chunk] = packChunk(this.values, chunk * CHUNK, this.shape);
      }
    }
    const signals: Signals = {
      shape: this.shape,
      tick: this.tick,
      sentAt: performance.timeOrigin + performance.now(),
      chunks,
      nets
    };
    const built = performance.now();
    const patches = diffProjection('signals', this.previous, signals);
    const bytes = patches.length === 0 ? 0 : JSON.stringify(patches).length;
    const diffed = performance.now();
    this.previous = signals;
    this.publishes++;
    this.patches += patches.length;
    this.bytes += bytes;
    this.signalsSubject.next(signals);
    this.statsSubject.next(this.statsNow(patches.length, bytes, built - started, diffed - built));
  }

  private statsNow(lastPatches: number, lastBytes: number, buildMs: number, diffMs: number): WireStats {
    return {
      publishes: this.publishes,
      patches: this.patches,
      bytes: this.bytes,
      lastPatches,
      lastBytes,
      lastChunks: this.shape === 'record' ? 0 : this.visibleChunks.length,
      lastNets: this.visibleNets.length,
      buildMs,
      diffMs,
      shape: this.shape,
      activity: this.activity,
      hz: this.hz
    };
  }
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
