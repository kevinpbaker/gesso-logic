import { defineConfig } from 'vitest/config';

/**
 * The simulator runs in node, with no browser and no framework.
 *
 * That is the point of Phase 1: everything under `src/sim` is plain
 * TypeScript, so its specs need no DOM, no canvas and no worker, and
 * they run in milliseconds. `src/app` is the application worker's side
 * of the barrier, which runs in node too, and so do the parts of
 * `src/canvas` that are logic rather than drawing: the scene index and
 * the editor, and in `src/ui` the command table and what the status bar
 * makes of a problem. The Phase 0 spike in `src/spike` is left out rather than
 * configured; it has no specs.
 */
export default defineConfig({
  test: {
    include: ['src/sim/**/*.spec.ts', 'src/cpu/**/*.spec.ts', 'src/app/**/*.spec.ts', 'src/canvas/**/*.spec.ts', 'src/ui/**/*.spec.ts'],
    environment: 'node'
  }
});
