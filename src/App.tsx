import type { ComponentContext, Inputs } from 'gesso-framework';

import { isBench, isProof } from './canvas/Bench';
import { instrumentedApp } from './ui/Instruments';
import { workbench } from './ui/Workbench';

/**
 * The screen.
 *
 * Two of them, by page. `/` is the simulator a person uses: a menu bar,
 * a toolbar, the palette, the canvas and a status bar (`Workbench.tsx`).
 * `/proof` and `?bench` are the measured pages, the canvas under
 * Phase 3's instrument with the controls the proof and the bench press
 * (`Instruments.tsx`). Kept apart so neither has to be the other: the
 * frame counters are the point of a measured page and noise on the
 * simulator's.
 */
export function App(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const proof = isProof();
  return isBench() || proof ? instrumentedApp(ctx, proof) : workbench(ctx);
}
