import { OpfsStorage, serveChannels, type PortHost } from 'gesso-framework';

import { CircuitService } from './CircuitService';
import { circuitChannels } from './channels';

/**
 * The circuit and its simulator, served to the render worker: from the
 * application worker, which is where they live, or — for Phase 21's
 * "run this on the main thread instead" — from the page itself, through
 * a `MessageChannel` standing in for the worker (see `main.ts`). The
 * render worker can't tell which; the person can, because on the main
 * thread the simulator's slices share a thread with every event the
 * page forwards.
 */
export function serveCircuit(host?: PortHost): void {
  const service = new CircuitService({
    store: new OpfsStorage({ directory: 'gessologic' }),
    versions: new OpfsStorage({ directory: 'gessologic-versions' })
  });
  serveChannels(circuitChannels(service), host);
}
