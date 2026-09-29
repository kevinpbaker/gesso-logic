/**
 * Phase 7's frame budget, in CI.
 *
 * The claim: the simulator can run a 10,000-gate circuit flat out and
 * the canvas does not notice. This script is that sentence with numbers
 * attached, and it fails the build when one of them regresses.
 *
 * It drives the built application's `/proof` page in headless Chrome,
 * pans by *panning* — real wheel events through the shell's listener,
 * across the barrier, into the render worker — and presses the canvas's
 * own buttons by clicking where they are. The frames it reads back are
 * the ones the proof strip is showing whoever watches.
 *
 * **What is compared.** The roadmap's budget was "a frame with the
 * simulator at full speed costs no more than 4 ms over one with it
 * paused", and Phase 3 found it cannot hold as written: a paused circuit
 * draws no changing values, and drawing values that change is real work
 * that has nothing to do with the simulator. So the comparison is full
 * speed against a 100 Hz clock. At 100 Hz the picture still changes on
 * every frame — the application worker publishes at most once a frame
 * either way — so the render worker draws the same thing in both runs.
 * What differs is that at full speed the application worker is
 * saturated, running five times as many cycles. If any of that reached
 * the render thread, it would show as the difference.
 *
 * **The freeze runs twice.** Blocking the main thread for five seconds
 * must leave the render worker drawing: once in the software browser the
 * budgets use, and once in a second browser with SwiftShader, a GPU
 * process on any machine, since the two composite differently. The
 * software run is the one that found a bug: Gesso's picture cache
 * rasterised a live layer on every frame it happened not to change,
 * each a fresh canvas, and allocating a canvas's pixels in software
 * compositing can wait on the page's main thread — so a blocked page
 * stalled the render worker outright. Gesso now lets a picture settle
 * for a few frames before rasterising it. The other thing it found was
 * this script's: Chrome's `--disable-frame-rate-limit`, which the
 * launcher had, stops a software-composited worker's animation frames
 * whenever the page's main thread is blocked, which no real browser
 * does. `PROOF_GPU=1` uses the real GPU for the second browser instead
 * of SwiftShader.
 *
 *   pnpm proof
 *   SKIP_BUILD=1 pnpm proof     # against an existing dist/
 *   PROOF_KEEP=1 pnpm proof     # leave the browser up
 *   PROOF_GPU=1 pnpm proof      # the freeze on the machine's GPU, not SwiftShader
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { PROOF_PATH } from '../src/route.ts';
import { DevTools, findChrome, openPage, waitFor } from './lib/devtools.ts';

/** Wheel notches per panning run, and frames of a still run. */
const NOTCHES = 150;
const STILL_MS = 2_500;

/**
 * The budgets, in the render worker's own work per frame — not the gap
 * between frames, which a headless browser on a shared CI machine does
 * not control.
 */
const BUDGET = {
  /** The claim: what running flat out may add to a frame, against a slow clock drawing the same. */
  costOfFullSpeed: 4,
  medianFrameMs: 12,
  p95FrameMs: 30,
  /** Full speed has to be full speed, or the comparison compared nothing. CI's runners manage about 3×. */
  fullSpeedOverSlow: 2,
  /** The freeze: how long it must hold the page, and what must go on behind it. */
  frozenMs: 4_500,
  /**
   * The worker must not go quiet during the freeze: no stretch of the
   * block, edges included, longer than this without a frame, and a
   * few frames at least. Stated as a gap and not a count because the
   * count is the machine's — SwiftShader on a CI runner, with the
   * simulator taking a core, draws about one frame a second, and this
   * machine forty in the five — while a worker that has stopped shows
   * the same five-second gap anywhere.
   */
  quietestFreezeMs: 1_500,
  framesDuringFreeze: 3,
  cyclesDuringFreeze: 500
};

const PORT = Number(process.env.PROOF_PORT ?? '4320');
const DEVTOOLS_PORT = Number(process.env.PROOF_DEVTOOLS_PORT ?? '9320');
const SIZE: readonly [number, number] = [1400, 900];

interface ProofFrame {
  readonly at: number;
  readonly durationMs: number;
}

interface Stats {
  readonly median: number;
  readonly p95: number;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  let preview: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let devtools: DevTools | undefined;
  const profile = mkdtempSync(join(tmpdir(), 'gessologic-proof-'));
  const secondProfile = mkdtempSync(join(tmpdir(), 'gessologic-proof-'));

  try {
    if (process.env.SKIP_BUILD === undefined) {
      await run('node_modules/.bin/vite', ['build']);
    }
    // `detached`, so the whole group can be signalled at the end.
    preview = spawn('node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], {
      stdio: 'ignore',
      detached: true
    });
    const url = `http://localhost:${PORT}${PROOF_PATH}`;
    await waitFor('the preview server', async () => ((await fetch(url)).ok ? true : undefined), 30_000);

    // The budgets, in software rendering: what a machine without a GPU
    // draws with, and the stricter test.
    ({ browser, devtools } = await openProof(url, profile, []));
    const page = devtools;

    const paused = report('paused, panning', await panRun(page), failures);

    await press(page, '100 Hz');
    const slowHz = await settleClock(page, hz => hz >= 50);
    const slowStill = report(`100 Hz (${slowHz} Hz), still`, await stillRun(page), failures);
    const slowPan = report(`100 Hz, panning`, await panRun(page), failures);

    await press(page, 'Full speed');
    const fastHz = await settleClock(page, hz => hz > slowHz * BUDGET.fullSpeedOverSlow);
    const fastStill = report(`full speed (${fastHz} Hz), still`, await stillRun(page), failures);
    const fastPan = report(`full speed, panning`, await panRun(page), failures);

    // The claim itself.
    for (const [what, fast, slow] of [
      ['still', fastStill, slowStill],
      ['panning', fastPan, slowPan]
    ] as const) {
      check(
        failures,
        `${what}: median frame ${fast.median.toFixed(2)}ms at full speed against ${slow.median.toFixed(2)}ms at 100 Hz`,
        fast.median - slow.median <= BUDGET.costOfFullSpeed,
        BUDGET.costOfFullSpeed
      );
    }
    check(
      failures,
      `full speed ran at ${fastHz} Hz, against ${slowHz} Hz`,
      fastHz > slowHz * BUDGET.fullSpeedOverSlow,
      BUDGET.fullSpeedOverSlow
    );
    console.log(
      `\n  full speed costs ${(fastStill.median - slowStill.median).toFixed(2)}ms still and ` +
        `${(fastPan.median - slowPan.median).toFixed(2)}ms panning, running ${(fastHz / slowHz).toFixed(1)}× the cycles` +
        ` (paused panning: ${paused.median.toFixed(2)}ms)\n`
    );

    // --------------------------------------------------------------
    // Five seconds with no main thread at all, at full speed
    // --------------------------------------------------------------
    //
    // The page is frozen solid: it cannot answer an evaluation, repaint
    // its strip or forward an event. The application worker goes on
    // simulating and the render worker goes on drawing; what the render
    // worker loses is the display's cadence, since vsync reaches it by
    // way of the shell's requestAnimationFrame, so its frames spread
    // out to its own timer. It draws the whole time.
    //
    // Twice: first in this browser, in software rendering, then in a
    // second browser with a GPU process. See the top of the file.
    await freeze(page, 'software rendering', failures);
    await closeBrowser(devtools, browser);
    ({ browser, devtools } = await openProof(url, secondProfile, FREEZE_ARGS));
    const frozenPage = devtools;
    await press(frozenPage, 'Full speed');
    await settleClock(frozenPage, hz => hz > 0);
    await freeze(frozenPage, 'a GPU process', failures);
  } finally {
    if (process.env.PROOF_KEEP === undefined) {
      await closeBrowser(devtools, browser);
      endGroup(preview);
      for (const dir of [profile, secondProfile]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // A leftover profile in the temp directory is not a failure.
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAIL\n${failures.map(line => `  - ${line}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  console.log('OK — the canvas held its budget with 10,000 gates simulating flat out behind it.\n');
}

/**
 * Five seconds with no main thread at all, at full speed, and what
 * went on behind it: frames drawn inside the block, by the block's own
 * window on the render worker's clock, and cycles run.
 */
async function freeze(page: DevTools, what: string, failures: string[]): Promise<void> {
  const before = (await readout(page)).cycles;
  await page.evaluate('globalThis.gessologicProof.reset()');
  const block = await page.evaluate<{ x: number; y: number }>(
    `(() => { const b = document.getElementById('gesso-proof-block').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`
  );
  await page.click(block.x, block.y);
  let frozenMs = 0;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && frozenMs < BUDGET.frozenMs) {
    const askedAt = Date.now();
    await page.evaluate('1');
    frozenMs = Math.max(frozenMs, Date.now() - askedAt);
  }
  await sleep(500);
  const recorded = await page.evaluate<ProofFrame[]>('globalThis.gessologicProof.frames()');
  const window = await page.evaluate<{ start: number; end: number } | null>('globalThis.gessologicProof.lastBlock()');
  if (window === null) throw new Error('The block button did not record a block.');
  // Inside the block, and clear of its edges by a frame's worth, so
  // the frames drawn as it began and ended do not count.
  const inside = recorded.filter(f => f.at > window.start + 50 && f.at < window.end - 50);
  const after = await settleReadout(page, r => r.cycles > before);
  // Gaps from the block's start, through each frame, to its end.
  const stamps = [window.start, ...inside.map(f => f.at), window.end];
  let worstGap = 0;
  for (let i = 1; i < stamps.length; i++) worstGap = Math.max(worstGap, stamps[i]! - stamps[i - 1]!);
  console.log(
    `  blocking the main thread for five seconds, in ${what}…\n` +
      `    frozen for ${frozenMs}ms · ${inside.length} frames drawn inside it · quietest ${worstGap.toFixed(0)}ms` +
      ` · ${(after.cycles - before).toLocaleString('en')} cycles run`
  );
  check(failures, `${what}: the block froze the page for only ${frozenMs}ms`, frozenMs >= BUDGET.frozenMs, BUDGET.frozenMs);
  check(
    failures,
    `${what}: only ${inside.length} frames were drawn while the main thread was blocked`,
    inside.length >= BUDGET.framesDuringFreeze,
    BUDGET.framesDuringFreeze
  );
  check(
    failures,
    `${what}: the render worker went ${worstGap.toFixed(0)}ms without a frame while the main thread was blocked`,
    worstGap <= BUDGET.quietestFreezeMs,
    BUDGET.quietestFreezeMs
  );
  check(
    failures,
    `${what}: only ${after.cycles - before} cycles ran across the freeze`,
    after.cycles - before >= BUDGET.cyclesDuringFreeze,
    BUDGET.cyclesDuringFreeze
  );
}

/** The freeze's browser: SwiftShader, a GPU process on any machine, or with `PROOF_GPU` the real one. */
const FREEZE_ARGS =
  process.env.PROOF_GPU === undefined
    ? ['--enable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--use-angle=default'];

/** Opens `/proof` in a fresh Chrome and waits for the scene, framed at mid zoom. */
async function openProof(
  url: string,
  profileDir: string,
  args: readonly string[]
): Promise<{ browser: ChildProcess; devtools: DevTools }> {
  const opened = await openPage(findChrome(), { url, devtoolsPort: DEVTOOLS_PORT, windowSize: SIZE, profileDir, args });
  const page = opened.devtools;
  await waitFor(
    'the first frame',
    async () => ((await page.evaluate<number>('globalThis.gessologicProof?.frames().length ?? 0')) > 0 ? true : undefined),
    30_000
  );
  // The scene is ten thousand gates; wait until the readout has one.
  await waitFor('the bench scene', async () => ((await readout(page)).cycles >= 0 && (await buttonAt(page, 'Mid')) !== null ? true : undefined), 30_000);
  await sleep(1_500);
  await press(page, 'Mid');
  await sleep(1_500);
  return opened;
}

async function closeBrowser(devtools: DevTools | undefined, browser: ChildProcess | undefined): Promise<void> {
  devtools?.close();
  if (browser !== undefined && browser.exitCode === null) {
    const ended = new Promise<void>(resolve => browser.once('exit', () => resolve()));
    endGroup(browser);
    await Promise.race([ended, sleep(3_000)]);
  }
}

/** What the canvas's live readouts say: the achieved clock, 0 when paused, and the cycle count. */
async function readout(page: DevTools): Promise<{ hz: number; cycles: number }> {
  const texts = await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-live]')].map(el => el.textContent ?? '')`);
  const number = (prefix: string) => {
    const found = texts.find(t => t.startsWith(prefix));
    const digits = found === undefined ? null : /([\d,]+)/.exec(found.slice(prefix.length));
    return digits === null ? -1 : Number(digits[1]!.replace(/,/g, ''));
  };
  return { hz: Math.max(0, number('Clock ')), cycles: number('Cycles ') };
}

async function settleReadout(page: DevTools, ok: (r: { hz: number; cycles: number }) => boolean) {
  return waitFor('the readout', async () => {
    const r = await readout(page);
    return ok(r) ? r : undefined;
  }, 15_000);
}

/** Waits for the achieved rate to settle where it should be, and returns it. */
async function settleClock(page: DevTools, ok: (hz: number) => boolean): Promise<number> {
  await sleep(1_500);
  return (await settleReadout(page, r => ok(r.hz))).hz;
}

async function buttonAt(page: DevTools, label: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate<{ x: number; y: number } | null>(
    `(() => {
       const el = [...document.querySelectorAll('button, [role="button"]')]
         .find(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === ${JSON.stringify(label)});
       if (!el) return null;
       const b = el.getBoundingClientRect();
       return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
     })()`
  );
}

async function press(page: DevTools, label: string): Promise<void> {
  const at = await buttonAt(page, label);
  if (at === null) throw new Error(`No button called ${label} is in the accessibility tree.`);
  await page.click(at.x, at.y);
  await sleep(100);
}

/** Pans right then back by wheel, a notch a frame, and returns the frames drawn. */
async function panRun(page: DevTools): Promise<ProofFrame[]> {
  await page.evaluate('globalThis.gessologicProof.reset()');
  for (let notch = 0; notch < NOTCHES; notch++) {
    await page.wheel(SIZE[0] / 2, SIZE[1] / 2, notch < NOTCHES / 2 ? 40 : -40, 0);
    await sleep(16);
  }
  await sleep(200);
  return page.evaluate<ProofFrame[]>('globalThis.gessologicProof.frames()');
}

/** Holds still and returns the frames drawn: with the circuit running, one per publish. */
async function stillRun(page: DevTools): Promise<ProofFrame[]> {
  await page.evaluate('globalThis.gessologicProof.reset()');
  await sleep(STILL_MS);
  return page.evaluate<ProofFrame[]>('globalThis.gessologicProof.frames()');
}

function report(what: string, frames: readonly ProofFrame[], failures: string[]): Stats {
  if (frames.length < 30) {
    failures.push(`${what}: only ${frames.length} frames — nothing was drawn`);
    return { median: 0, p95: 0 };
  }
  const sorted = frames.map(f => f.durationMs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`  ${what}: ${frames.length} frames · median ${median.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms`);
  check(failures, `${what}: median frame ${median.toFixed(2)}ms`, median <= BUDGET.medianFrameMs, BUDGET.medianFrameMs);
  check(failures, `${what}: p95 frame ${p95.toFixed(2)}ms`, p95 <= BUDGET.p95FrameMs, BUDGET.p95FrameMs);
  return { median, p95 };
}

function check(failures: string[], described: string, ok: boolean, budget: number): void {
  if (!ok) failures.push(`${described}, against a budget of ${budget}`);
}

/** Ends a child and everything it started: `vite` and Chrome both leave children behind a bare kill. */
function endGroup(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`))));
  });
}

await main();
