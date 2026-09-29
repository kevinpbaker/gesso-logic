import { serveChannels } from 'gesso-framework';

import { CircuitService } from './app/CircuitService';
import { circuitChannels } from './app/channels';

/**
 * The application worker: the circuit, and the simulator running it.
 *
 * It opens on an empty circuit. The bench asks for Phase 0's 10,000-gate
 * scene with `loadScene`, and so can the readout's button. Phase 6 opens
 * files; Phase 21 opens on Pong.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, the same way it
 * writes the render worker, so `main.ts` names neither.
 */
const service = new CircuitService();

serveChannels(circuitChannels(service));
