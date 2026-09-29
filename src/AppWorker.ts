import { serve, serveChannels } from 'gesso-framework';

import { Circuit } from './spike/CircuitContract';
import { SignalSource } from './spike/SignalSource';

/**
 * The application worker, for the Phase 0 spike: a source of signal
 * snapshots and nothing else.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, the same way it
 * writes the render worker, so `main.ts` names neither.
 */
const source = new SignalSource();

serveChannels([
  serve(Circuit, {
    view: { signals: source.signals, stats: source.stats },
    commands: {
      setViewport: (left, top, right, bottom) => source.setViewport(left, top, right, bottom),
      setShape: shape => source.setShape(shape),
      setActivity: fraction => source.setActivity(fraction),
      setRate: hz => source.setRate(hz)
    }
  })
]);
