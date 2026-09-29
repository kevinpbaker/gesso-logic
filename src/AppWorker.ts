import { serveChannels } from 'gesso-framework';

import { CircuitService } from './app/CircuitService';
import { circuitChannels } from './app/channels';
import { benchScene } from './app/Scenes';

/**
 * The application worker: the circuit, and the simulator running it.
 *
 * It opens on Phase 0's 10,000-gate bench scene, made real, because that
 * is what Phase 3 is measured on. Phase 6 opens files; Phase 21 opens on
 * Pong.
 *
 * `gesso-vite-plugin` finds this file by name and writes the
 * `appLogicWorker` construction into `createApp`, the same way it
 * writes the render worker, so `main.ts` names neither.
 */
const service = new CircuitService();
service.load(benchScene());

serveChannels(circuitChannels(service));
