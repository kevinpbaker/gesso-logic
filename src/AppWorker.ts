import { OpfsStorage, serveChannels } from 'gesso-framework';

import { CircuitService } from './app/CircuitService';
import { circuitChannels } from './app/channels';

/**
 * The application worker: the circuit, and the simulator running it.
 *
 * It opens on an empty circuit, and the render worker asks it to
 * `restore` whatever was open last, from the autosave in the origin's
 * private file system — written here, on the thread that owns the
 * document, so nothing crosses the barrier to be remembered. The bench
 * never asks, and so never touches it; it loads Phase 0's scene with
 * `loadScene`. Phase 21 opens on Pong.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, the same way it
 * writes the render worker, so `main.ts` names neither.
 */
const service = new CircuitService({ store: new OpfsStorage({ directory: 'gessologic' }) });

serveChannels(circuitChannels(service));
