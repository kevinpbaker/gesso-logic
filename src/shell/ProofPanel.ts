/**
 * The strip above the canvas, and the only DOM in the application.
 *
 * Everything here runs on the main thread on purpose. The claim the
 * whole project exists to make is that the main thread is not doing
 * the work, and a claim like that cannot be made from inside the
 * thread that is: numbers the render worker prints on its own canvas
 * are numbers a stranger has no reason to believe. So the readout
 * lives where the doubt lives. Block this thread and the strip stops
 * dead — the pulse freezes, the button stays pressed, the page cannot
 * be selected or scrolled — while the two threads behind it carry on,
 * because the application is not here.
 *
 * Two things are wired: the block, and the readout. The switch that
 * puts the simulator at full speed is in the render worker's own
 * readout, not here: a command reaches the application worker through
 * the render worker's channel, and this thread has no channel — which
 * is the point of it.
 *
 * Copied from gessosheet's `src/shell/ProofPanel.ts`, with its layout
 * heatmap and re-measure count taken out (a canvas of tiles measures
 * nothing a heatmap would show) and the render worker's frame cost put
 * in, which is what Phase 7's budget is written in. Everything else is
 * the sheet's, unchanged, which is the argument for it moving into
 * `gesso-devtools` once a third application wants it.
 *
 * It belongs to `/proof` and to no other url. So the markup and the
 * styles are here rather than in `index.html`: a page that is not the
 * proof route does not carry them at all.
 */
import type { FrameMetrics, WorkerApp } from 'gesso-framework';

/** How long the block button holds the thread, in milliseconds. */
const BLOCK_MS = 5_000;

/**
 * How far back the rolling readout looks, in milliseconds.
 *
 * A *time* window and not a count of frames, which is what it was, and
 * the reason is the thing the readout exists to show: an idle Gesso
 * app draws nothing at all. Frames are not produced at a steady rate
 * and then averaged — there simply are none while nothing changes. A
 * ninety-frame window therefore held frames from however long ago the
 * last interaction was, and dividing by the span between them reported
 * a scroll running at sixty as three. Worse, it took ninety fresh
 * frames to flush, which is a second and a half of continuous drawing,
 * so a short drag never read above a fraction of the truth.
 */
const RECENT_MS = 1_000;

/**
 * How long after the last frame the rate stops being a rate.
 *
 * Past this, the app is not running slowly, it is not running: there
 * is nothing on screen that wants redrawing. A number there would read
 * as a stall, so the readout says so instead.
 */
const IDLE_AFTER_MS = 400;

/** How many frames the recording keeps for a machine to read back. */
const RECORDING = 2_000;

/** One frame, as the budget check reads it. */
export interface ProofFrame {
  readonly at: number;
  readonly durationMs: number;
  readonly measured: number;
  readonly nodes: number;
  readonly inputLatencyMs: number | null;
  /**
   * Which backend drew, and where the frame's time went.
   *
   * Kept because `durationMs` alone cannot answer the question that
   * matters when frames are further apart than their own cost: a
   * worker drawing for five milliseconds every twenty-four is either
   * waiting for something or paying for something the total does not
   * name. The phase breakdown names it.
   */
  readonly renderer: string;
  readonly phases: Record<string, number>;
  readonly gpu: Record<string, number> | null;
}

/**
 * What `scripts/frame-budget.ts` drives the page through.
 *
 * Deliberately the readout's own numbers rather than a measurement
 * the check installs for itself. Every time a budget in this project
 * went in through a side door it agreed with itself and disagreed with
 * the screen — the Phase 3 bench wrote scroll offsets instead of
 * scrolling and missed both scrolling bugs a hand found. So the check
 * sends real wheel events and real clicks, and reads the same frames
 * the strip is displaying while it does.
 */
export interface ProofHandle {
  frames(): readonly ProofFrame[];
  reset(): void;
  /**
   * The last block, on the render worker's clock, so frames can be
   * counted *inside* it: a count of the whole recording also takes the
   * frames drawn a moment before and after, which is how a render
   * worker that drew nothing at all during a freeze once passed a check
   * for having drawn through it.
   */
  lastBlock(): { readonly start: number; readonly end: number } | null;
}

declare global {
  // eslint-disable-next-line no-var
  var gessologicProof: ProofHandle | undefined;
}

/**
 * Wires the strip's controls to an application.
 *
 * Returns the callbacks the application has to be *created* with —
 * `onFrame` and `onInspect` are constructor options, not something a
 * running app can be handed later — so the shell builds the panel
 * first and passes them in.
 */
export function proofPanel(host: HTMLElement): {
  readonly options: { onFrame: (metrics: FrameMetrics) => void };
  readonly attach: (app: WorkerApp) => void;
} {
  build(host);

  const pulse = element('pulse');
  const block = element<HTMLButtonElement>('block');
  const fpsOut = element('fps');
  const gapOut = element('gap');
  const costOut = element('cost');
  const mainOut = element('mainfps');

  // ---------------------------------------------------------------------
  // What the render worker did
  // ---------------------------------------------------------------------

  /**
   * Frame finish times on the render worker's clock.
   *
   * Deliberately `metrics.at` and not the time this callback ran. A
   * blocked main thread cannot receive messages, so every frame drawn
   * during the block arrives in one burst the moment it unblocks; if
   * the readout timed its own arrivals it would report a five second
   * stall that never happened, and it would report it about the wrong
   * thread. The render worker stamps each frame when it finishes, and
   * those stamps survive a queue.
   */
  const finishes: number[] = [];
  const costs: number[] = [];
  const recording: ProofFrame[] = [];
  let lastBlock: { start: number; end: number } | null = null;

  globalThis.gessologicProof = {
    frames: () => recording,
    lastBlock: () => lastBlock,
    reset: () => {
      recording.length = 0;
      finishes.length = 0;
      costs.length = 0;
    }
  };

  const onFrame = (metrics: FrameMetrics): void => {
    // Learned from every frame, not just the first: the two clocks
    // drift, and a tab that was suspended resumes on a different one.
    workerOffset = performance.now() - metrics.at;
    recording.push({
      at: metrics.at,
      durationMs: metrics.durationMs,
      measured: metrics.measured,
      nodes: metrics.nodes,
      inputLatencyMs: metrics.inputLatencyMs,
      renderer: metrics.renderer,
      phases: { ...metrics.phases },
      gpu: metrics.gpu === null ? null : { ...metrics.gpu }
    });
    if (recording.length > RECORDING) {
      recording.shift();
    }
    finishes.push(metrics.at);
    costs.push(metrics.durationMs);
    while (finishes.length > 1 && metrics.at - finishes[0] > RECENT_MS) {
      finishes.shift();
      costs.shift();
    }
  };

  // ---------------------------------------------------------------------
  // What this thread did
  // ---------------------------------------------------------------------

  let mainFrames = 0;
  let sampledAt = performance.now();

  /**
   * This thread's clock, expressed on the render worker's.
   *
   * `metrics.at` is stamped in the worker, whose `performance.now()`
   * counts from its own creation and so trails the page's by however
   * old the page was when it was spawned. Comparing a frame's stamp
   * against this thread's raw clock would make every frame look
   * hundreds of milliseconds stale and the canvas permanently idle. The
   * offset is learned from the frames themselves.
   */
  let workerOffset: number | null = null;
  const hostTimeNow = (): number => performance.now() - (workerOffset ?? 0);

  /**
   * The pulse, the main thread's frames, and the readout, all on this
   * thread's animation frame — so all three stop together when it is
   * blocked, and stop in front of a canvas that has not.
   */
  const tick = (now: number): void => {
    mainFrames++;
    pulse.style.opacity = String(0.35 + 0.65 * Math.abs(Math.sin(now / 350)));

    const since = now - sampledAt;
    if (since >= 500) {
      mainOut.textContent = String(Math.round((mainFrames / since) * 1000));
      mainFrames = 0;
      sampledAt = now;

      /**
       * The rate over the last second of frames, and the worst gap
       * inside it.
       *
       * Both are read here rather than accumulated as frames arrive,
       * because both are statements about a window that is still
       * moving: a gap that was the worst a minute ago says nothing
       * about what the canvas is doing now, and the lifetime maximum
       * the readout used to show was always whichever idle pause had
       * been longest.
       *
       * The clock is `metrics.at`, the render worker's own, so this
       * stays honest across a blocked main thread — which is the whole
       * reason the frames carry a stamp.
       */
      const last = finishes.at(-1);
      const first = finishes[0];
      const quiet = last === undefined || hostTimeNow() - last > IDLE_AFTER_MS;
      if (quiet) {
        fpsOut.textContent = 'idle';
        gapOut.textContent = '—';
      } else if (first !== undefined && last > first) {
        fpsOut.textContent = String(Math.round(((finishes.length - 1) / (last - first)) * 1000));
        let worst = 0;
        for (let index = 1; index < finishes.length; index++) {
          worst = Math.max(worst, finishes[index] - finishes[index - 1]);
        }
        gapOut.textContent = `${worst.toFixed(1)}ms`;
        const sorted = [...costs].sort((a, b) => a - b);
        costOut.textContent = `${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms`;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---------------------------------------------------------------------
  // The controls
  // ---------------------------------------------------------------------

  const attach = (app: WorkerApp): void => {
    /**
     * Five seconds of the thing every web application is told not to
     * do, done on purpose.
     *
     * A busy loop and not a `sleep`, because the point is not that
     * time passes — it is that this thread has no turn to give
     * anybody. What survives it, and what does not, is worth being
     * exact about, because the loose version of the claim is both
     * wrong and weaker than the true one:
     *
     * The application worker does not notice. Run the simulator at
     * full speed and press this, and the cycle count has gone on
     * climbing when the page comes back — it worked through the freeze.
     *
     * The render worker does not stop either. It keeps laying out and
     * drawing on its own clock, which is why the frame recording has
     * entries stamped all the way through the five seconds. What it
     * loses is the display's cadence and only that: `requestAnimationFrame`
     * exists on this thread alone, so a worker gets vsync by way of a
     * shell that is currently not answering, and its frames spread out
     * to a timer's interval until the thread comes back.
     *
     * The page, meanwhile, is gone: no events are forwarded, so nothing
     * a person does during the five seconds reaches the circuit at all.
     * That is the honest shape of it — the work is elsewhere, the input
     * is not.
     *
     * The label is repainted and the frame yielded before the loop
     * starts, or the only evidence would be a button that never looked
     * pressed.
     */
    block.addEventListener('click', () => {
      block.disabled = true;
      block.textContent = `Blocking for ${BLOCK_MS / 1000}s…`;
      pulse.classList.add('blocked');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const start = performance.now();
          const until = start + BLOCK_MS;
          while (performance.now() < until) {
            /* Holding the thread. That is the whole experiment. */
          }
          const offset = workerOffset ?? 0;
          lastBlock = { start: start - offset, end: performance.now() - offset };
          block.disabled = false;
          block.textContent = `Block the main thread for ${BLOCK_MS / 1000}s`;
          pulse.classList.remove('blocked');
        })
      );
    });

  };

  return { options: { onFrame }, attach };
}

/**
 * The strip's own styles, which used to be most of `index.html`.
 *
 * A `<style>` rather than anything cleverer because this is the one
 * part of the project that is a web page, and a web page's styles are
 * a stylesheet. It is appended on the proof route and nowhere else.
 */
const STYLES = `
  #proof {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 10px;
    background: #22242a;
    color: #d7d9e0;
    border-bottom: 1px solid #000;
  }
  #proof button {
    font: inherit;
    padding: 4px 9px;
    border-radius: 5px;
    border: 1px solid #4a4d57;
    background: #32353e;
    color: #e8eaf0;
    cursor: pointer;
  }
  #proof button:hover {
    background: #3d414c;
  }
  #proof label {
    display: flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }
  #proof .stat {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  #proof .stat b {
    color: #fff;
    font-weight: 600;
  }
  #proof .sep {
    width: 1px;
    align-self: stretch;
    background: #4a4d57;
  }
  /*
    The one animation on the page, and the only honest way to show a
    thread is alive: it is driven by the main thread's own
    requestAnimationFrame, so it stops dead the moment that thread is
    busy — while the circuit, which is not on it, keeps running.
  */
  #pulse {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #5ec26a;
  }
  #pulse.blocked {
    background: #d4564f;
  }
  /*
    The strip takes its height from the page and the canvas the rest:
    the app is sized to its host, so the host has to shrink.
  */
  body {
    display: flex;
    flex-direction: column;
    font: 13px system-ui, sans-serif;
  }
  #app {
    flex: 1;
    height: auto !important;
    min-height: 0;
  }
`;

/** The strip itself, in the order a person reads it. */
const MARKUP = `
  <span id="pulse" title="The main thread’s own animation frame"></span>
  <button id="block" type="button">Block the main thread for 5s</button>
  <span class="sep"></span>
  <span class="stat">render worker <b id="fps">—</b> fps</span>
  <span class="stat">worst frame gap <b id="gap">—</b></span>
  <span class="stat">frame work <b id="cost">—</b> median</span>
  <span class="stat">main thread <b id="mainfps">—</b> fps</span>
`;

/**
 * Puts the strip on the page, above the canvas it is a claim about.
 *
 * Before the host rather than at the end of the body, because the
 * body is a column and the strip goes at the top of it — and because
 * the canvas is sized to its host, so a strip inserted after mounting
 * would resize the canvas a frame later. It is inserted before
 * `createApp`, and the host still has its full height when the canvas
 * measures it.
 */
function build(host: HTMLElement): void {
  const styles = document.createElement('style');
  styles.textContent = STYLES;
  document.head.append(styles);

  const strip = document.createElement('div');
  strip.id = 'proof';
  strip.innerHTML = MARKUP;
  host.before(strip);

}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The proof strip has no #${id} element.`);
  }
  return found as T;
}
