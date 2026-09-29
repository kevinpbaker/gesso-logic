import { serve, serveChannels } from 'gesso-framework';

import { CircuitService } from './app/CircuitService';
import { circuitChannels } from './app/channels';
import { Circuit as Spike } from './spike/CircuitContract';
import { SignalSource } from './spike/SignalSource';

/**
 * The application worker: the circuit, and until Phase 3 the spike.
 *
 * `circuitChannels` is Phase 2's contract over the real simulator. The
 * Phase 0 spike's signal source is served beside it on its own channel,
 * because the screen is still the spike's; Phase 3 replaces that screen
 * and this second channel goes with it.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, the same way it
 * writes the render worker, so `main.ts` names neither.
 */
const service = new CircuitService();
const spike = new SignalSource();

serveChannels([
  ...circuitChannels(service),
  serve(Spike, {
    view: { signals: spike.signals, stats: spike.stats },
    commands: {
      setViewport: (left, top, right, bottom) => spike.setViewport(left, top, right, bottom),
      setShape: shape => spike.setShape(shape),
      setActivity: fraction => spike.setActivity(fraction),
      setRate: hz => spike.setRate(hz)
    }
  })
]);
