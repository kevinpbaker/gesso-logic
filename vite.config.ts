import { gesso } from 'gesso-vite-plugin';
import { defineConfig } from 'vite';

/**
 * An ordinary Vite project with one Gesso plugin.
 *
 * The plugin writes the three things every Gesso application would
 * otherwise write the same way by hand: the `new Worker(new URL(...))`
 * construction for the render worker, the `import.meta.hot.accept`
 * wiring that replaces the screen on a save instead of reloading the
 * page, and the error overlay that draws what the worker threw over
 * the application that was running when it threw it. The last two are
 * development only; a production build carries no reference to
 * `gesso-devtools` at all.
 *
 * None of it is required. Write `renderWorker` in `createApp` yourself
 * and the plugin leaves the construction alone; take the plugin out
 * altogether and the application still runs, with the incantations
 * back in `main.ts`.
 */
export default defineConfig({
  plugins: [gesso()]
});
