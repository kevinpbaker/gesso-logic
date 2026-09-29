/**
 * The main thread's entire job.
 *
 * It finds a host element, creates the app and mounts. Everything a
 * person sees is built, laid out, painted and hit-tested in the worker;
 * the page forwards input events and does nothing else, so work on this
 * thread cannot delay a frame.
 *
 * The worker is not named here. `gesso-vite-plugin`, in
 * `vite.config.ts`, finds `worker.ts` beside this file and writes the
 * `new Worker(new URL(...))` construction, which is the only form a
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
import { createApp } from 'gesso-framework';

const host = document.querySelector<HTMLElement>('#app');
if (host === null) {
  throw new Error('index.html has no #app element to mount into.');
}

const app = createApp();

app.mount(host);
