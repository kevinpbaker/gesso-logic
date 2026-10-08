/**
 * The main thread's entire job.
 *
 * It finds a host element, creates the app and mounts. Everything a
 * person sees is built, laid out, painted and hit-tested in the worker;
 * the page forwards input events and does nothing else, so work on this
 * thread cannot delay a frame.
 *
 * The workers are not named here. `gesso-vite-plugin`, in
 * `vite.config.ts`, finds `worker.ts` beside this file for the render
 * worker and `AppWorker.ts` for the application worker, and writes the
 * `new Worker(new URL(...))` construction for each, which is the only form a
 * bundler emits a chunk for. It also draws the error overlay over the
 * app when the worker throws, and gives the worker its hot-replacement
 * wiring, so saving `App.tsx` redraws the screen without reloading the
 * page. If you would rather say it out loud, write it and the plugin
 * leaves it alone:
 *
 *   createApp({
 *     renderWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
 *   });
 */
import { proofPanel } from 'gesso-devtools';
import { createApp, OpfsStorage, type PortHost } from 'gesso-framework';

import { INCOMING_LINK, isProofPath, LINK_STORE } from './route';

const host = document.querySelector<HTMLElement>('#app');
if (host === null) {
  throw new Error('index.html has no #app element to mount into.');
}

// A worker has no page url, so a flag only the url carries is handed to
// it as its name. `?bench` makes the render worker run the Phase 0
// measurement unattended, and `&only=` narrows it to the runs whose
// label matches; the idiom is Gesso's own `?still`. `/proof` is Phase
// 7's page, and the strip it adds is built here, before the app, so
// its frame callback can be given to `createApp`.
const params = new URLSearchParams(location.search);
const proof = isProofPath(location.pathname);
const panel = proof ? proofPanel(host, { global: 'gessologicProof' }) : null;

// `?main`: the circuit and its simulator run here, on the page's own
// thread, rather than in the application worker — Phase 21's toggle, so
// anyone can feel what the worker is for. A `MessageChannel` stands in
// for the worker: one end goes to `createApp` as the application
// endpoint, the other is served here. The simulator's code is imported
// only in this mode, and the port holds what arrives until it is.
const mainThread = params.has('main');
let appLogic: MessagePort | undefined;
if (mainThread) {
  const { port1, port2 } = new MessageChannel();
  appLogic = port1;
  void import('./app/serveCircuit').then(({ serveCircuit }) => {
    const hostPort: PortHost = { onmessage: null };
    port2.onmessage = event => hostPort.onmessage?.({ data: event.data, ports: event.ports });
    port2.start();
    serveCircuit(hostPort);
  });
}
const plainName = params.has('bench') ? `bench${params.has('only') ? `:${params.get('only')}` : ''}` : proof ? 'proof' : undefined;

// A shared link, `#c=…`: the circuit is in the part of the url after
// `#`, which the shell does not pass on, and is far too long for a
// worker's name. It is put where the render worker can read it, the
// origin's private storage, before the worker starts; the name says
// only that one is waiting. It leaves the address bar, so a reload
// does not open it again over what has been done with it since.
const shared = !params.has('bench') && !proof && location.hash.startsWith('#c=') ? location.hash.slice(1) : null;
const workerName = shared !== null ? 'link' : plainName;
if (shared !== null) history.replaceState(null, '', `${location.pathname}${location.search}`);
// A link pasted into a tab already on the app differs from it only after
// `#`, which a browser follows without loading the page again: load it
// again, so the link is read as one opened afresh is.
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#c=')) location.reload();
});
const start = (): void => {
  const app = createApp({
    ...(panel?.options ?? {}),
    // The render worker is told the mode in its name, as it is `/proof`'s.
    workerName: mainThread && !params.has('bench') ? (workerName === undefined ? 'main' : `${workerName}+main`) : workerName,
    ...(appLogic === undefined ? {} : { appLogicWorker: appLogic }),
    // The toggle asks for this page with `?main` added or taken away; that
    // is navigated here, in place. Any other url opens in a new tab.
    onOpenUrl: url => {
      const target = new URL(url, location.href);
      if (target.origin === location.origin && target.pathname === location.pathname) {
        location.assign(`${target.pathname}${target.search === '?' ? '' : target.search}${target.hash}`);
      }
      else window.open(target.href, '_blank', 'noopener,noreferrer');
    },
    // Save, Open and Duplicate are the circuit's, not the page's, and so
    // is F10, which goes to the menu bar. The shell has to say so before
    // the render worker has heard of the key, or Chrome's "Save page as"
    // opens over the canvas, and Ctrl+D bookmarks the page.
    interceptKey: event =>
      event.key === 'F10' ||
      ((event.ctrlKey || event.metaKey) && !event.altKey && ['s', 'o', 'd'].includes(event.key.toLowerCase()))
  });
  panel?.attach(app);

  app.mount(host);
};

// The app starts once the link is stored, or at once without one: a
// link that could not be stored is a page that opens as if there were
// none, which is better than one that does not open.
void (shared === null ? Promise.resolve() : new OpfsStorage({ directory: LINK_STORE }).write(INCOMING_LINK, shared)).then(start, start);
