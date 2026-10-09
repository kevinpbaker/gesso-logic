/**
 * Where the live site's error reports land: see `src/ErrorReports.ts`.
 *
 * Each report is checked, trimmed and written to the function's log as
 * one JSON line marked `gessologic-error`, which Vercel's Logs page
 * shows and searches. That log is kept only briefly, so when a Redis
 * store is connected to the project — Upstash, from Vercel's
 * marketplace, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` —
 * the last `KEPT` reports are kept there too, and
 * `GET /api/errors?token=…` lists them, given the token in
 * `ERRORS_READ_TOKEN`. Without a store, or without that token, nothing
 * can be read back from here: a report is a thing sent, not served.
 *
 * Nothing in a report identifies a person beyond their browser's user
 * agent, and the page sends no circuit.
 */

/** Reports kept in the store, newest first. */
const KEPT = 500;
const KEY = 'gessologic:errors';
/** The largest report taken, in bytes: a message and a stack, trimmed by the page to 4,000 characters each. */
const MAX_BODY = 12_000;

const THREADS = new Set(['page', 'render', 'app']);

interface Stored {
  readonly at: string;
  readonly thread: string;
  readonly kind: string;
  readonly message: string;
  readonly stack?: string;
  readonly path: string;
  readonly build: string;
  readonly agent: string;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

/** A report as the page sends it, or null for anything else. */
export function readReport(raw: unknown, at: Date): Stored | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const thread = text(r.thread, 16);
  const kind = text(r.kind, 32);
  const message = text(r.message, 4000);
  if (thread === null || !THREADS.has(thread) || kind === null || message === null || message === '') return null;
  const stack = text(r.stack, 4000);
  return {
    at: at.toISOString(),
    thread,
    kind,
    message,
    ...(stack === null ? {} : { stack }),
    path: text(r.path, 200) ?? '',
    build: text(r.build, 40) ?? '',
    agent: text(r.agent, 300) ?? ''
  };
}

function store(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url === undefined || token === undefined ? null : { url, token };
}

async function redis(commands: readonly (readonly string[])[]): Promise<unknown[]> {
  const kv = store()!;
  const response = await fetch(`${kv.url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${kv.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error(`the store answered ${response.status}`);
  return (await response.json()) as unknown[];
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  if (body.length > MAX_BODY) return new Response('too large', { status: 413 });
  let report: Stored | null;
  try {
    report = readReport(JSON.parse(body), new Date());
  } catch {
    report = null;
  }
  if (report === null) return new Response('not a report', { status: 400 });
  console.error(JSON.stringify({ type: 'gessologic-error', ...report }));
  if (store() !== null) {
    try {
      await redis([
        ['LPUSH', KEY, JSON.stringify(report)],
        ['LTRIM', KEY, '0', String(KEPT - 1)]
      ]);
    } catch (error) {
      console.error(`gessologic-error: could not keep the report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return new Response(null, { status: 204 });
}

export async function GET(request: Request): Promise<Response> {
  const wanted = process.env.ERRORS_READ_TOKEN;
  const given = new URL(request.url).searchParams.get('token');
  if (wanted === undefined || wanted === '' || given !== wanted) return new Response('not found', { status: 404 });
  if (store() === null) return Response.json({ error: 'no store is connected: reports are in the function logs only' }, { status: 503 });
  const [range] = (await redis([['LRANGE', KEY, '0', '99']])) as [{ result?: string[] }];
  return Response.json((range.result ?? []).map(line => JSON.parse(line) as Stored));
}
