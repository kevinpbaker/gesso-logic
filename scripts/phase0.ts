/**
 * The Phase 0 measurement for spikes 1 and 2, unattended.
 *
 * Builds the spike, serves it, opens it in headless Chrome with
 * `?bench`, and prints the table of runs the render worker logs.
 * Copied from gessosheet's, which is where the shape of it was worked
 * out; what changed is the table and the two flags.
 *
 *   node scripts/phase0.ts                 the matrix
 *   node scripts/phase0.ts --shot=out.png  a screenshot of the page after
 *                                          three seconds, for looking at
 *   node scripts/phase0.ts --shot=… --input  the same after a real drag and
 *                                          three notches of ctrl-wheel
 *   node scripts/phase0.ts --gpu           either, without forcing
 *                                          software rendering
 *
 * Two things are worth knowing about what it reports.
 *
 *   - **Cost, not frame rate.** Headless Chrome schedules frames
 *     however it likes, so the gap between them says more about the
 *     compositor than about the application. `cost` is what the render
 *     worker spent building, laying out and painting the frame, and
 *     that is the number 16.7 ms has to be compared against.
 *   - **The console comes from a worker.** The render worker's console
 *     is its own DevTools target, so this attaches to every target the
 *     page spawns rather than reading the page's log.
 *
 * It needs Chrome on the path, or `CHROME_BIN`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4183;
const DEVTOOLS_PORT = 9343;
const SHOT = process.argv.find(arg => arg.startsWith('--shot='))?.slice('--shot='.length);
const GPU = process.argv.includes('--gpu');
/** With `--shot`: drag and ctrl-wheel the canvas through real input events before the shot. */
const INPUT = process.argv.includes('--input');
/** `--only=regex`: run just the matching runs, by label. */
const ONLY = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
/** Each run is appended here as it finishes, so a timeout loses nothing. */
const RESULTS = 'phase0-results.jsonl';
const CHROME_CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome'];
const BENCH_PREFIX = 'PHASE0 ';
const BENCH_DONE = 'PHASE0-DONE';

function findChrome(): string {
  for (const candidate of process.env.CHROME_BIN ? [process.env.CHROME_BIN] : CHROME_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* next */
    }
  }
  throw new Error(`No Chrome found. Tried ${CHROME_CANDIDATES.join(', ')}. Set CHROME_BIN.`);
}

/**
 * A DevTools client flat enough to reach a worker.
 *
 * `flatten: true` puts every attached target's traffic on this one
 * socket tagged with a session id, which is the only reason this is
 * sixty lines instead of a socket per target.
 */
class Client {
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();
  readonly lines: string[] = [];
  private doneResolve: (() => void) | null = null;

  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        sessionId?: string;
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message.error !== undefined ? new Error(message.error.message) : message.result);
        return;
      }
      if (message.method === 'Target.attachedToTarget') {
        const session = (message.params as { sessionId: string }).sessionId;
        void this.send('Runtime.enable', {}, session);
        void this.send('Target.setAutoAttach', AUTO_ATTACH, session);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = (message.params as { exceptionDetails: { text: string; exception?: { description?: string } } })
          .exceptionDetails;
        process.stderr.write(`\n[exception] ${details.exception?.description ?? details.text}\n`);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const params = message.params as { type: string; args: { value?: unknown; description?: string }[] };
        const args = params.args;
        const text = args.map(arg => String(arg.value ?? arg.description ?? '')).join(' ');
        if (params.type === 'error' || params.type === 'warning') {
          process.stderr.write(`\n[${params.type}] ${text}\n`);
        }
        if (text.startsWith(BENCH_PREFIX)) {
          const line = text.slice(BENCH_PREFIX.length);
          this.lines.push(line);
          appendFileSync(RESULTS, line + '\n');
          process.stderr.write(`${(JSON.parse(line) as { run: string }).run} `);
        } else if (text.startsWith(BENCH_DONE)) {
          this.doneResolve?.();
        }
      }
    });
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new Client(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  finished(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.doneResolve = resolve;
      // Unref'd, so a bench that finished does not hold the process open
      // for the rest of the timeout.
      setTimeout(() => reject(new Error(`The bench did not finish within ${timeoutMs / 1000}s.`)), timeoutMs).unref();
    });
  }

  close(): void {
    this.socket.close();
  }
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

async function waitForTarget(): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://localhost:${DEVTOOLS_PORT}/json`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = targets.find(t => t.type === 'page' && t.url.includes(String(PORT)));
      if (page !== undefined) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome never opened the page.');
}

async function main(): Promise<void> {
  const chrome = findChrome();
  console.error(`building…`);
  execFileSync('node_modules/.bin/vite', ['build', '--logLevel', 'warn'], { stdio: 'inherit' });

  const preview = spawn('node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'gessologic-phase0-'));
  let browser: ChildProcess | undefined;
  let client: Client | undefined;
  try {
    await sleep(1500);
    console.error(SHOT ? 'opening the page…' : 'running the matrix (one dot per run)…');
    browser = spawn(
      chrome,
      [
        '--headless=new',
        ...(GPU ? ['--enable-gpu', '--use-angle=default'] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1400,900',
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${DEVTOOLS_PORT}`,
        `http://localhost:${PORT}/${SHOT ? '' : `?bench${ONLY ? `&only=${encodeURIComponent(ONLY)}` : ''}`}`
      ],
      { stdio: 'ignore' }
    );
    client = await Client.connect(await waitForTarget());
    await client.send('Runtime.enable');
    await client.send('Target.setAutoAttach', AUTO_ATTACH);
    if (SHOT) {
      await sleep(3000);
      if (INPUT) {
        // Real input rather than the bench's side door: a drag from the
        // middle of the canvas, then three notches of ctrl-wheel zoom in
        // under the same point. The HUD's zoom readout in the shot says
        // whether the wheel was heard; the gates' position says whether
        // the drag was.
        const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
          client!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
        await mouse('mousePressed', 700, 500, { buttons: 1, clickCount: 1 });
        for (let step = 1; step <= 10; step++) {
          await mouse('mouseMoved', 700 - step * 30, 500 - step * 10, { buttons: 1 });
          await sleep(16);
        }
        await mouse('mouseReleased', 400, 400, { buttons: 0, clickCount: 1 });
        for (let notch = 0; notch < 3; notch++) {
          await client.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 700,
            y: 450,
            deltaX: 0,
            deltaY: -300,
            modifiers: 2
          });
          await sleep(100);
        }
        await sleep(800);
      }
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(SHOT, Buffer.from(data as string, 'base64'));
      console.error(`wrote ${SHOT}`);
      return;
    }
    writeFileSync(RESULTS, '');
    try {
      await client.finished(1_800_000);
    } finally {
      process.stderr.write('\n');
      report(client.lines.map(line => JSON.parse(line) as Record<string, unknown>));
      console.error(`\nraw runs in ${RESULTS}`);
    }
  } finally {
    client?.close();
    browser?.kill();
    preview.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** The table, in the order the runs were declared. */
function report(runs: Record<string, unknown>[]): void {
  const columns = [
    'run',
    'renderer',
    'costMs',
    'costP95Ms',
    'costWorstMs',
    'gapMs',
    'gapP95Ms',
    'recordedPerFrame',
    'recordMs',
    'peakTiles',
    'peakNodes',
    'missFramesPct',
    'ageMs',
    'ageP95Ms',
    'publishesPerSecond',
    'nets',
    'chunks',
    'patchesPerPublish',
    'bytesPerPublish',
    'buildMs',
    'diffMs'
  ];
  const phases = ['patches', 'layout', 'render'];
  const all = [...columns, ...phases];
  const rows = runs.map(run =>
    all.map(column =>
      phases.includes(column) ? format((run.phases as Record<string, unknown>)?.[column]) : format(run[column])
    )
  );
  const heading = (column: string) => column.replace(/PerPublish$/, '/pub').replace(/PerFrame$/, '/f').replace(/PerSecond$/, '/s');
  const widths = all.map((column, index) => Math.max(heading(column).length, ...rows.map(row => row[index]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padStart(widths[index])).join('  ');
  console.log(line(all.map(heading)));
  console.log(widths.map(width => '─'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(line(row));
  }
}

function format(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join('/');
  }
  return String(value ?? '');
}

await main();
