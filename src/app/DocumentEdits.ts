import type { Circuit, Component, PinRef, Rotation, Wire } from '../sim/Circuit';
import type { Kind } from '../sim/Primitives';

/**
 * Edits to a circuit document, as functions from one document to the
 * next.
 *
 * Nothing is mutated: the service keeps previous documents to undo to.
 * Each edit returns the document unchanged — the same object — when
 * there is nothing to do, so the service can tell an edit that changed
 * nothing from one that did, and does not put a no-op on the undo stack.
 *
 * These do not validate the circuit. A wire to a pin that does not
 * exist, or two outputs joined, is a document someone may be halfway
 * through drawing; the compiler says what is wrong with it, and the
 * editor shows that, rather than refusing the edit.
 */

/** A piece of a circuit on its own: what copy puts on the clipboard, and paste and duplicate insert. */
export interface Fragment {
  readonly components: readonly Component[];
  readonly wires: readonly Wire[];
}

export function place(circuit: Circuit, id: string, kind: Kind, x: number, y: number, rotation: Rotation = 0): Circuit {
  if (hasId(circuit, id)) {
    return circuit;
  }
  const component: Component = rotation === 0 ? { id, kind, x, y } : { id, kind, x, y, rotation };
  return { ...circuit, components: [...circuit.components, component] };
}

export function move(circuit: Circuit, id: string, x: number, y: number): Circuit {
  const current = circuit.components.find(c => c.id === id);
  return current === undefined ? circuit : moveBy(circuit, [id], x - current.x, y - current.y);
}

/** Moves every listed component by the same offset: a selection dragged. */
export function moveBy(circuit: Circuit, ids: readonly string[], dx: number, dy: number): Circuit {
  if (dx === 0 && dy === 0) {
    return circuit;
  }
  const moving = new Set(ids);
  let changed = false;
  const components = circuit.components.map(c => {
    if (!moving.has(c.id)) return c;
    changed = true;
    return { ...c, x: c.x + dx, y: c.y + dy };
  });
  return changed ? { ...circuit, components } : circuit;
}

/** Turns every listed component a quarter turn clockwise, each about its own box. */
export function rotate(circuit: Circuit, ids: readonly string[]): Circuit {
  const turning = new Set(ids);
  let changed = false;
  const components = circuit.components.map(c => {
    if (!turning.has(c.id)) return c;
    changed = true;
    const rotation = (((c.rotation ?? 0) + 90) % 360) as Rotation;
    const { rotation: _dropped, ...rest } = c;
    return rotation === 0 ? rest : { ...rest, rotation };
  });
  return changed ? { ...circuit, components } : circuit;
}

export function connect(circuit: Circuit, id: string, from: PinRef, to: PinRef): Circuit {
  if (hasId(circuit, id)) {
    return circuit;
  }
  // A wire joining two pins already joined by a wire adds nothing.
  const same = (a: PinRef, b: PinRef) => a.component === b.component && a.pin === b.pin;
  if (circuit.wires.some(w => (same(w.from, from) && same(w.to, to)) || (same(w.from, to) && same(w.to, from)))) {
    return circuit;
  }
  return { ...circuit, wires: [...circuit.wires, { id, from: { ...from }, to: { ...to } }] };
}

/**
 * Removes components and wires by id. A wire left with an end on a
 * removed component goes too: a wire to nothing is not something anyone
 * drew.
 */
export function remove(circuit: Circuit, ids: readonly string[]): Circuit {
  const gone = new Set(ids);
  const components = circuit.components.filter(c => !gone.has(c.id));
  const wires = circuit.wires.filter(
    w => !gone.has(w.id) && !gone.has(w.from.component) && !gone.has(w.to.component)
  );
  if (components.length === circuit.components.length && wires.length === circuit.wires.length) {
    return circuit;
  }
  return { ...circuit, components, wires };
}

/**
 * Adds a fragment whose ids are already fresh, as paste and duplicate
 * make them. A fragment that would collide with an id in use is refused
 * whole, rather than half-inserted.
 */
export function insert(circuit: Circuit, fragment: Fragment): Circuit {
  if (fragment.components.length === 0 && fragment.wires.length === 0) {
    return circuit;
  }
  const used = ids(circuit);
  const incoming = [...fragment.components.map(c => c.id), ...fragment.wires.map(w => w.id)];
  if (incoming.some(id => used.has(id)) || new Set(incoming).size !== incoming.length) {
    return circuit;
  }
  return {
    ...circuit,
    components: [...circuit.components, ...fragment.components],
    wires: [...circuit.wires, ...fragment.wires]
  };
}

/**
 * The part of a circuit a selection covers: the selected components, and
 * the wires with both ends among them. A wire to something outside the
 * selection is left behind, as it would be on paper.
 */
export function extract(circuit: Circuit, selected: readonly string[]): Fragment {
  const chosen = new Set(selected);
  const components = circuit.components.filter(c => chosen.has(c.id));
  const kept = new Set(components.map(c => c.id));
  const wires = circuit.wires.filter(w => kept.has(w.from.component) && kept.has(w.to.component));
  return { components, wires };
}

/**
 * A fragment with every id replaced by a fresh one, and moved. Wires
 * follow their components' new ids. `fresh` makes an id from a prefix;
 * the caller decides what is fresh, because only the caller knows what
 * it has handed out and not yet seen come back.
 */
export function relabel(fragment: Fragment, dx: number, dy: number, fresh: (prefix: string) => string): Fragment {
  const renamed = new Map<string, string>();
  const components = fragment.components.map(c => {
    const id = fresh(c.kind);
    renamed.set(c.id, id);
    return { ...c, id, x: c.x + dx, y: c.y + dy };
  });
  const wires = fragment.wires.flatMap(w => {
    const from = renamed.get(w.from.component);
    const to = renamed.get(w.to.component);
    if (from === undefined || to === undefined) return [];
    return [{ id: fresh('w'), from: { ...w.from, component: from }, to: { ...w.to, component: to } }];
  });
  return { components, wires };
}

/**
 * Whether two documents join the same pins: the same components of the
 * same kinds, wired the same way. A move or a rotation leaves this true,
 * and then the netlist, and the simulator's state, can be kept as they
 * are.
 */
export function sameConnectivity(a: Circuit, b: Circuit): boolean {
  if (a.components.length !== b.components.length || a.wires.length !== b.wires.length) {
    return false;
  }
  for (let i = 0; i < a.components.length; i++) {
    const x = a.components[i]!;
    const y = b.components[i]!;
    if (x.id !== y.id || x.kind !== y.kind || x.value !== y.value) return false;
  }
  for (let i = 0; i < a.wires.length; i++) {
    if (a.wires[i] !== b.wires[i]) return false;
  }
  return true;
}

/** A component id not yet used in the circuit: the prefix and the first free number. */
export function freshId(circuit: Circuit, prefix: string): string {
  const used = ids(circuit);
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) {
      return id;
    }
  }
}

function ids(circuit: Circuit): Set<string> {
  return new Set<string>([...circuit.components.map(c => c.id), ...circuit.wires.map(w => w.id)]);
}

function hasId(circuit: Circuit, id: string): boolean {
  return circuit.components.some(c => c.id === id) || circuit.wires.some(w => w.id === id);
}
