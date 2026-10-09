/**
 * What goes wrong on the live site, sent home: an error nobody saw is an
 * error nobody fixes, and a crash in a worker says nothing to the person
 * whose circuit stopped.
 *
 * Every thread reports for itself — the page, the render worker's errors
 * through `createApp`'s `onError`, the application worker its own — to
 * `/api/errors`, a function beside the site (`api/errors.ts`). A report
 * is the message, the stack, which thread and what kind, the page's path
 * and the build: never the circuit, and never the url after `#`, which
 * is where a shared circuit is.
 *
 * Only from a built site on a real host: a dev server's errors are on
 * the screen already, in its overlay. Each distinct error is sent once a
 * session, and at most `MAX_REPORTS` in all, so a loop that throws every
 * frame is one report, not sixty a second.
 */

export interface ErrorReport {
  /** Which thread: the page, the render worker, or the application worker. */
  readonly thread: 'page' | 'render' | 'app';
  /** What kind: uncaught, a rejected promise, or the render worker's `RuntimeErrorSource`. */
  readonly kind: string;
  readonly message: string;
  readonly stack?: string;
}

/** The most reports one page or worker sends in its life. */
export const MAX_REPORTS = 10;
/** The longest message or stack sent, in characters. */
export const MAX_REPORT_TEXT = 4000;
export const REPORT_PATH = '/api/errors';

declare const __COMMIT__: string;

const sent = new Set<string>();

/** Whether this is a built site somewhere other than this machine, which is where reports are wanted. */
function reporting(): boolean {
  if (!import.meta.env.PROD) return false;
  const host = self.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && !host.endsWith('.localhost');
}

/** The report as sent: trimmed, with where and when it happened. */
export function reportBody(report: ErrorReport, path: string, build: string): string {
  return JSON.stringify({
    thread: report.thread,
    kind: report.kind,
    message: report.message.slice(0, MAX_REPORT_TEXT),
    ...(report.stack === undefined ? {} : { stack: report.stack.slice(0, MAX_REPORT_TEXT) }),
    path,
    build,
    agent: typeof navigator === 'undefined' ? '' : navigator.userAgent
  });
}

export function sendErrorReport(report: ErrorReport): void {
  if (!reporting()) return;
  const key = `${report.thread}|${report.kind}|${report.message}`;
  if (sent.has(key) || sent.size >= MAX_REPORTS) return;
  sent.add(key);
  // The path only: after `#` is a shared circuit, and the query is ours.
  const body = reportBody(report, self.location.pathname, typeof __COMMIT__ === 'string' ? __COMMIT__ : 'unknown');
  try {
    // A beacon outlives a page closing; a worker has none, and a fetch it keeps alive will do.
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator && navigator.sendBeacon(REPORT_PATH, new Blob([body], { type: 'application/json' }))) return;
    void fetch(REPORT_PATH, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {
    // Reporting must never be the second error.
  }
}

/** Sends this thread's uncaught errors and unhandled rejections. */
export function reportUncaught(thread: ErrorReport['thread']): void {
  self.addEventListener('error', event => {
    const error = (event as ErrorEvent).error as unknown;
    sendErrorReport({
      thread,
      kind: 'uncaught',
      message: (event as ErrorEvent).message || String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
    });
  });
  self.addEventListener('unhandledrejection', event => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    sendErrorReport({
      thread,
      kind: 'rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack !== undefined ? { stack: reason.stack } : {})
    });
  });
}
