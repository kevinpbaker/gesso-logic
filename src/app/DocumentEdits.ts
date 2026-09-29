import type { Circuit, Component, PinRef } from '../sim/Circuit';
import type { Kind } from '../sim/Primitives';

/**
 * Edits to a circuit document, as functions from one document to the
 * next.
 *
 * Nothing is mutated: the service keeps the previous document to diff
 * against and, from Phase 4, to undo to. Each edit returns the document
 * unchanged — the same object — when there is nothing to do, so the
 * service can tell an edit that changed nothing from one that did.
 *
 * These do not validate the circuit. A wire to a pin that does not exist,
 * or two outputs joined, is a document someone may be halfway through
 * drawing; the compiler says what is wrong with it, and the editor shows
 * that, rather than refusing the edit.
 */

export function place(circuit: Circuit, id: string, kind: Kind, x: number, y: number): Circuit {
  if (circuit.components.some(c => c.id === id)) {
    return circuit;
  }
  const component: Component = { id, kind, x, y };
  return { ...circuit, components: [...circuit.components, component] };
}

export function move(circuit: Circuit, id: string, x: number, y: number): Circuit {
  const at = circuit.components.findIndex(c => c.id === id);
  const current = circuit.components[at];
  if (current === undefined || (current.x === x && current.y === y)) {
    return circuit;
  }
  const components = circuit.components.slice();
  components[at] = { ...current, x, y };
  return { ...circuit, components };
}

export function connect(circuit: Circuit, id: string, from: PinRef, to: PinRef): Circuit {
  if (circuit.wires.some(w => w.id === id)) {
    return circuit;
  }
  return { ...circuit, wires: [...circuit.wires, { id, from: { ...from }, to: { ...to } }] };
}

/** A component id not yet used in the circuit: the kind and the first free number. */
export function freshId(circuit: Circuit, prefix: string): string {
  const used = new Set<string>([...circuit.components.map(c => c.id), ...circuit.wires.map(w => w.id)]);
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) {
      return id;
    }
  }
}
