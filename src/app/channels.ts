import { serve, type ServedChannel } from 'gesso-framework';

import { Circuit } from './CircuitContract';
import type { CircuitService } from './CircuitService';

/**
 * The circuit channel, as the application worker serves it.
 *
 * A function rather than lines in `AppWorker.ts` so the exit spec can
 * serve exactly the same thing through `gesso-testing`'s `serveForTest`:
 * the spec then checks the wiring the worker ships, not a copy of it.
 */
export function circuitChannels(service: CircuitService): ServedChannel[] {
  return [
    serve(Circuit, {
      view: {
        document: service.document,
        geometry: service.geometry,
        signals: service.signals,
        status: service.status
      },
      commands: {
        place: (kind, x, y, id) => service.place(kind, x, y, id),
        connect: (from, to) => service.connect(from, to),
        move: (id, x, y) => service.move(id, x, y),
        setInput: (id, value) => service.setInput(id, value),
        run: () => service.run(),
        pause: () => service.pause(),
        step: () => service.step(),
        setClockHz: rate => service.setClockHz(rate),
        setViewport: (left, top, right, bottom) => service.setViewport(left, top, right, bottom)
      }
    })
  ];
}
