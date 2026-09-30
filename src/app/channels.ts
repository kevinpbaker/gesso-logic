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
        status: service.status,
        table: service.table,
        saving: service.saving,
        clipboard: service.clipboard,
        analyser: service.analyserView
      },
      commands: {
        place: (kind, x, y, id, rotation, chip, width) => service.place(kind, x, y, id, rotation, chip, width),
        connect: (from, to, id) => service.connect(from, to, id),
        move: (id, x, y) => service.move(id, x, y),
        moveBy: (ids, dx, dy, gesture) => service.moveBy(ids, dx, dy, gesture),
        rotate: ids => service.rotate(ids),
        remove: ids => service.remove(ids),
        insert: fragment => service.insert(fragment),
        undo: () => service.undo(),
        redo: () => service.redo(),
        loadScene: name => service.loadScene(name),
        loadProgram: (name, source, rate) => service.loadProgram(name, source, rate),
        setInput: (id, value) => service.setInput(id, value),
        setWidth: (ids, width) => service.setWidth(ids, width),
        run: () => service.run(),
        pause: () => service.pause(),
        step: () => service.step(),
        setClockHz: rate => service.setClockHz(rate),
        setViewport: (left, top, right, bottom) => service.setViewport(left, top, right, bottom),
        tabulate: ids => service.tabulate(ids),
        open: (text, name, handle) => service.open(text, name, handle),
        requestSave: asNew => service.requestSave(asNew),
        finishSave: (saved, message) => service.finishSave(saved, message),
        rememberCamera: (x, y, scale) => service.rememberCamera(x, y, scale),
        restore: first => void service.restore(first),
        makeChip: (ids, name) => service.makeChip(ids, name),
        openChip: id => service.openChip(id),
        closeChip: depth => service.closeChip(depth),
        renameChip: (from, to) => service.renameChip(from, to),
        importChip: (text, fileName) => service.importChip(text, fileName),
        setAnalyserView: (start, span, columns) => service.setAnalyserView(start, span, columns),
        setTrigger: (trace, value) => service.setTrigger(trace, value),
        copy: ids => service.copy(ids),
        duplicate: (ids, rename, dx, dy) => service.duplicate(ids, rename, dx, dy)
      }
    })
  ];
}
