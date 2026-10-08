import type { Circuit, Component, PinRef, Rotation, Wire } from '../sim/Circuit';
import type { Kind } from '../sim/Primitives';
import { DEFAULT_BUS_WIDTH, pinsOf } from '../sim/Chips';
import { MAX_WIDTH, widthOf } from '../sim/Primitives';

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
  /** The chip definitions its chips use, and theirs, so it can be pasted into a document that lacks them. */
  readonly chips?: Readonly<Record<string, Circuit>>;
}

export function place(
  circuit: Circuit,
  id: string,
  kind: Kind,
  x: number,
  y: number,
  rotation: Rotation = 0,
  chip?: string,
  width?: number
): Circuit {
  if (hasId(circuit, id) || (kind === 'chip' && (chip === undefined || circuit.chips?.[chip] === undefined))) {
    return circuit;
  }
  const component: Component = {
    id,
    kind,
    x,
    y,
    ...(rotation === 0 ? {} : { rotation }),
    ...(kind === 'chip' ? { chip } : {}),
    ...(width !== undefined && width > 1 && WIDENABLE.has(kind) ? { width } : {})
  };
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
  if (!changed) return circuit;
  // A bent wire whose ends both move goes with them; one with an end
  // left behind keeps its corners, and stretches to the end that moved.
  const carried = circuit.wires.some(w => w.via !== undefined && moving.has(w.from.component) && moving.has(w.to.component));
  const wires = carried
    ? circuit.wires.map(w => (w.via !== undefined && moving.has(w.from.component) && moving.has(w.to.component) ? shiftVia(w, dx, dy) : w))
    : circuit.wires;
  return { ...circuit, components, wires };
}

/** A wire with its corners moved by an offset; the wire itself when it has none. */
function shiftVia<W extends Wire>(wire: W, dx: number, dy: number): W {
  return wire.via === undefined || (dx === 0 && dy === 0) ? wire : { ...wire, via: wire.via.map(p => ({ x: p.x + dx, y: p.y + dy })) };
}

/**
 * Bends a wire through corners, or with none straightens it back to
 * routing itself. The circuit as it was when there is no such wire or
 * nothing would change.
 */
export function setVia(circuit: Circuit, id: string, via: readonly { readonly x: number; readonly y: number }[] | null): Circuit {
  const index = circuit.wires.findIndex(w => w.id === id);
  const wire = circuit.wires[index];
  if (wire === undefined) return circuit;
  const next = via === null || via.length === 0 ? null : via.map(p => ({ x: p.x, y: p.y }));
  if (next === null && wire.via === undefined) return circuit;
  if (next !== null && wire.via !== undefined && next.length === wire.via.length && next.every((p, i) => p.x === wire.via![i]!.x && p.y === wire.via![i]!.y)) return circuit;
  const { via: _, ...rest } = wire;
  const wires = [...circuit.wires];
  wires[index] = next === null ? rest : { ...rest, via: next };
  return { ...circuit, wires };
}

/**
 * Straightens wires back to routing themselves: the wires listed, and
 * every wire to or from a part listed; every wire, when the list is
 * empty. The circuit as it was when none was bent.
 */
export function straighten(circuit: Circuit, ids: readonly string[]): Circuit {
  const chosen = new Set(ids);
  const touched = (w: Wire) => chosen.size === 0 || chosen.has(w.id) || chosen.has(w.from.component) || chosen.has(w.to.component);
  if (!circuit.wires.some(w => w.via !== undefined && touched(w))) return circuit;
  return {
    ...circuit,
    wires: circuit.wires.map(w => {
      if (w.via === undefined || !touched(w)) return w;
      const { via: _, ...rest } = w;
      return rest;
    })
  };
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
  // A wire is as wide as its pins, so pins of different widths are not
  // joined: a bus goes to a bus of its width, or through a split.
  if (pinWidth(circuit, from) !== pinWidth(circuit, to)) {
    return circuit;
  }
  return { ...circuit, wires: [...circuit.wires, { id, from: { ...from }, to: { ...to } }] };
}

/** A pin's width, by its component's kind, width and — for a chip — definition; 1 for a pin not found. */
export function pinWidth(circuit: Circuit, ref: PinRef): number {
  const component = circuit.components.find(c => c.id === ref.component);
  return component === undefined ? 1 : widthOf(pinsOf(component, circuit.chips), ref.pin);
}

/** The kinds a width means something for. */
export const WIDENABLE: ReadonlySet<Kind> = new Set(['input', 'constant', 'output', 'probe', 'hex', 'split', 'join']);

/**
 * Makes components a given number of bits wide: switches, constants,
 * LEDs, probes and hex displays, and the bus a split takes or a join
 * gives. A wire the new width leaves joining pins of different widths,
 * or ending on a pin that is no longer there, goes, as a wire to a
 * removed component does; a switch's or constant's value keeps only the
 * bits that still fit. Unchanged for a width out of range or nothing to
 * change.
 */
/**
 * Names a part on a level: the top when `chip` is null, or that chip's
 * definition. Blank text takes the name away, and the part goes by its
 * id. A switch or LED in a chip is one of its pins, named by its label,
 * so the pin is renamed too: every wire to it, on every instance of the
 * chip, at every level, follows. A name another of the chip's pins has
 * is refused, as is a level or part that is not there: the document
 * comes back unchanged.
 */
export function setLabel(document: Circuit, chip: string | null, id: string, label: string): Circuit {
  const level = chip === null ? document : document.chips?.[chip];
  const part = level?.components.find(c => c.id === id);
  if (level === undefined || part === undefined) return document;
  const text = label.trim();
  if ((part.label ?? '') === text) return document;
  const { label: _, ...rest } = part;
  const renamed: Component = text === '' ? rest : { ...rest, label: text };
  const relabelled: Circuit = { ...level, components: level.components.map(c => (c === part ? renamed : c)) };
  const isPin = chip !== null && (part.kind === 'input' || part.kind === 'output');
  if (!isPin) {
    return chip === null ? { ...relabelled, chips: document.chips } : { ...document, chips: { ...document.chips, [chip]: relabelled } };
  }
  const from = part.label ?? part.id;
  const to = text === '' ? part.id : text;
  const clash = level.components.some(c => c !== part && (c.kind === 'input' || c.kind === 'output') && (c.label ?? c.id) === to);
  if (clash) return document;
  if (from === to) return { ...document, chips: { ...document.chips, [chip]: relabelled } };
  // Every wire to the pin, on any instance of the chip, wherever it is.
  const retarget = (circuit: Circuit): Circuit => {
    const instances = new Set(circuit.components.filter(c => c.kind === 'chip' && c.chip === chip).map(c => c.id));
    if (instances.size === 0) return circuit;
    const moves = (ref: PinRef) => instances.has(ref.component) && ref.pin === from;
    const end = (ref: PinRef): PinRef => (moves(ref) ? { component: ref.component, pin: to } : ref);
    return { ...circuit, wires: circuit.wires.map(w => (moves(w.from) || moves(w.to) ? { ...w, from: end(w.from), to: end(w.to) } : w)) };
  };
  const chips: Record<string, Circuit> = {};
  for (const [name, definition] of Object.entries(document.chips ?? {})) chips[name] = retarget(name === chip ? relabelled : definition);
  return { ...retarget(document), chips };
}

/**
 * Says what a switch or LED is for — what hovering it as a chip's pin
 * shows — or, given blank text, stops saying. Unchanged for any other
 * kind of part, or no change.
 */
export function setNote(circuit: Circuit, id: string, note: string): Circuit {
  const text = note.trim();
  let changed = false;
  const components = circuit.components.map(c => {
    if (c.id !== id || (c.kind !== 'input' && c.kind !== 'output') || (c.note ?? '') === text) return c;
    changed = true;
    const { note: _, ...rest } = c;
    return text === '' ? rest : { ...rest, note: text };
  });
  return changed ? { ...circuit, components } : circuit;
}

export function setWidth(circuit: Circuit, ids: readonly string[], width: number): Circuit {
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
    return circuit;
  }
  const chosen = new Set(ids);
  let changed = false;
  const components = circuit.components.map(c => {
    if (!chosen.has(c.id) || !WIDENABLE.has(c.kind)) return c;
    const bus = c.kind === 'split' || c.kind === 'join';
    if (bus && width < 2) return c;
    const current = c.width ?? (bus ? DEFAULT_BUS_WIDTH : c.kind === 'hex' ? undefined : 1);
    if (current === width) return c;
    changed = true;
    const { width: _, value, ...rest } = c;
    const next: Component = { ...rest, ...(width === 1 && !bus && c.kind !== 'hex' ? {} : { width }) };
    return value === undefined ? next : { ...next, value: value & (2 ** width - 1) };
  });
  if (!changed) {
    return circuit;
  }
  const resized: Circuit = { ...circuit, components };
  const fits = (ref: PinRef) => {
    const component = components.find(c => c.id === ref.component);
    if (component === undefined) return false;
    const spec = pinsOf(component, circuit.chips);
    return spec.inputs.includes(ref.pin) || spec.outputs.includes(ref.pin);
  };
  const wires = circuit.wires.filter(
    w => (!chosen.has(w.from.component) && !chosen.has(w.to.component)) || (fits(w.from) && fits(w.to) && pinWidth(resized, w.from) === pinWidth(resized, w.to))
  );
  return { ...resized, wires };
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
  const merged = mergeChips(circuit, fragment);
  return {
    ...circuit,
    components: [...circuit.components, ...merged.components],
    wires: [...circuit.wires, ...fragment.wires],
    ...(merged.chips === undefined ? {} : { chips: merged.chips })
  };
}

/**
 * The chips a fragment brings, merged into a document's: a name the
 * document lacks is added; one it has with the same definition is the
 * same chip; one it has with a different definition is the fragment's
 * own and is renamed, `name 2`, `name 3`, …, with every reference in the
 * fragment and its definitions following. Returns the fragment's
 * components retargeted, and the document's chips as they would be.
 */
function mergeChips(circuit: Circuit, fragment: Fragment): { components: readonly Component[]; chips: Circuit['chips'] } {
  const incoming = fragment.chips;
  if (incoming === undefined || Object.keys(incoming).length === 0) {
    return { components: fragment.components, chips: circuit.chips };
  }
  const chips: Record<string, Circuit> = { ...circuit.chips };
  const rename = new Map<string, string>();
  for (const name of Object.keys(incoming)) {
    const theirs = chips[name];
    if (theirs === undefined || sameDefinition(theirs, incoming[name]!)) {
      continue;
    }
    let n = 2;
    while (chips[`${name} ${n}`] !== undefined || incoming[`${name} ${n}`] !== undefined) n++;
    rename.set(name, `${name} ${n}`);
  }
  const retarget = (components: readonly Component[]) =>
    components.map(c => (c.kind === 'chip' && c.chip !== undefined && rename.has(c.chip) ? { ...c, chip: rename.get(c.chip)! } : c));
  for (const [name, definition] of Object.entries(incoming)) {
    const target = rename.get(name) ?? name;
    if (chips[target] === undefined) {
      const { chips: _, ...body } = definition;
      chips[target] = { ...body, components: retarget(definition.components) };
    }
  }
  return { components: retarget(fragment.components), chips };
}

/**
 * A circuit added to a document as a chip, under `name`: its switches
 * and LEDs are the chip's pins, and the chips it uses come with it,
 * merged as a paste merges them. A name the document already has for a
 * different chip gets a number. Returns the document and the name the
 * chip ended up with; the document unchanged, and null, when the circuit
 * is the chip it is being added to or has no parts.
 */
export function importChip(circuit: Circuit, file: Circuit, name: string): { circuit: Circuit; name: string | null } {
  const wanted = name.trim() === '' ? 'imported' : name.trim();
  if (file.components.length === 0) {
    return { circuit, name: null };
  }
  const { chips: dependencies, ...definition } = file;
  const merged = mergeChips(circuit, { components: [{ id: '', kind: 'chip', chip: wanted, x: 0, y: 0 }], wires: [], chips: { ...dependencies, [wanted]: definition } });
  const landed = merged.components[0]!.chip!;
  return { circuit: { ...circuit, chips: merged.chips }, name: landed };
}

/** Whether two definitions are the same circuit, part for part and wire for wire. */
function sameDefinition(a: Circuit, b: Circuit): boolean {
  const strip = ({ chips: _, ...body }: Circuit) => body;
  return a === b || JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** The definitions a set of components uses, and the ones those use, by name. */
export function chipsUsedBy(components: readonly Component[], chips: Circuit['chips']): Record<string, Circuit> {
  const used: Record<string, Circuit> = {};
  const visit = (list: readonly Component[]) => {
    for (const c of list) {
      if (c.kind !== 'chip' || c.chip === undefined || used[c.chip] !== undefined) continue;
      const definition = chips?.[c.chip];
      if (definition === undefined) continue;
      used[c.chip] = definition;
      visit(definition.components);
    }
  };
  visit(components);
  return used;
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
  const chips = chipsUsedBy(components, circuit.chips);
  return Object.keys(chips).length === 0 ? { components, wires } : { components, wires, chips };
}

/**
 * A fragment with every id replaced by a fresh one, and moved. Wires
 * follow their components' new ids. `fresh` makes an id from a prefix;
 * the caller decides what is fresh, because only the caller knows what
 * it has handed out and not yet seen come back.
 */
export function relabel(fragment: Fragment, dx: number, dy: number, fresh: (prefix: string, old: string) => string): Fragment {
  const renamed = new Map<string, string>();
  const components = fragment.components.map(c => {
    const id = fresh(c.kind, c.id);
    renamed.set(c.id, id);
    return { ...c, id, x: c.x + dx, y: c.y + dy };
  });
  const wires = fragment.wires.flatMap(w => {
    const from = renamed.get(w.from.component);
    const to = renamed.get(w.to.component);
    if (from === undefined || to === undefined) return [];
    return [shiftVia({ ...w, id: fresh('w', w.id), from: { ...w.from, component: from }, to: { ...w.to, component: to } }, dx, dy)];
  });
  return fragment.chips === undefined ? { components, wires } : { components, wires, chips: fragment.chips };
}

/**
 * Whether two documents join the same pins: the same components of the
 * same kinds, wired the same way. A move or a rotation leaves this true,
 * and then the netlist, and the simulator's state, can be kept as they
 * are.
 */
export function sameConnectivity(a: Circuit, b: Circuit): boolean {
  if (a.chips !== b.chips) {
    // A move inside a chip replaces its definition, and with it the
    // table; that is still a move.
    const names = Object.keys(a.chips ?? {});
    if (names.length !== Object.keys(b.chips ?? {}).length) return false;
    for (const name of names) {
      const x = a.chips?.[name];
      const y = b.chips?.[name];
      if (x === undefined || y === undefined || (x !== y && !sameConnectivity(x, y))) return false;
    }
  }
  if (a.components.length !== b.components.length || a.wires.length !== b.wires.length) {
    return false;
  }
  for (let i = 0; i < a.components.length; i++) {
    const x = a.components[i]!;
    const y = b.components[i]!;
    // A ROM's words are the netlist's too: a new program is not a move.
    if (x.id !== y.id || x.kind !== y.kind || x.value !== y.value || x.chip !== y.chip || x.rom !== y.rom) return false;
  }
  for (let i = 0; i < a.wires.length; i++) {
    const x = a.wires[i]!;
    const y = b.wires[i]!;
    // A wire bent is a wire moved: the same pins, joined the same way.
    if (x !== y && (x.id !== y.id || x.from.component !== y.from.component || x.from.pin !== y.from.pin || x.to.component !== y.to.component || x.to.pin !== y.to.pin)) {
      return false;
    }
  }
  return true;
}

/**
 * Gives a ROM new words and the source they were assembled from. The
 * circuit as it was when the id is no ROM, or nothing would change.
 */
export function setProgram(circuit: Circuit, id: string, words: readonly number[], source: string): Circuit {
  const index = circuit.components.findIndex(c => c.id === id && c.kind === 'rom');
  const rom = circuit.components[index];
  if (rom === undefined) return circuit;
  const same = rom.source === source && rom.rom !== undefined && rom.rom.length === words.length && rom.rom.every((w, i) => w === words[i]);
  if (same) return circuit;
  const components = [...circuit.components];
  components[index] = { ...rom, rom: [...words], source };
  return { ...circuit, components };
}

/**
 * Whether a ROM in both documents holds different words in the second:
 * a program loaded, or one undone. The circuit then starts again from
 * power-on, since the state of the old program — its program counter
 * above all — means nothing to the new one.
 */
export function programChanged(a: Circuit, b: Circuit): boolean {
  const differs = (x: Circuit, y: Circuit) =>
    x !== y && y.components.some(r => r.kind === 'rom' && x.components.some(c => c.id === r.id && c.kind === 'rom' && c.rom !== r.rom));
  if (differs(a, b)) return true;
  if (a.chips === b.chips) return false;
  return Object.entries(b.chips ?? {}).some(([name, definition]) => {
    const before = a.chips?.[name];
    return before !== undefined && differs(before, definition);
  });
}

/**
 * Makes a selection into a chip: its parts become a definition, and one
 * instance of it takes their place, wired where they were.
 *
 * The selection's boundary crossings become the chip's pins, by which
 * side drives them: a wire from a selected part's output to something
 * outside is an output pin, one from outside into the selection an
 * input pin. Several wires from one outside driver into the selection
 * are one input pin, and several from one inside output to the outside
 * are one output pin. Selected switches and LEDs are pins already — a
 * definition's interface is its switches and LEDs — so a full adder
 * drawn with its own switches and LEDs and selected whole is a chip with
 * those pins and no others.
 *
 * The definition keeps the selection's layout, moved to start at the
 * origin, with the new pins' switches down its left and LEDs down its
 * right. The instance takes the selection's top-left corner. Returns the
 * circuit unchanged when nothing is selected or the name is taken.
 */
export function makeChip(circuit: Circuit, selected: readonly string[], name: string, chipId: string): Circuit {
  const chosen = new Set(selected);
  const inside = circuit.components.filter(c => chosen.has(c.id));
  if (inside.length === 0 || circuit.chips?.[name] !== undefined || hasId(circuit, chipId)) {
    return circuit;
  }
  const byId = new Map(circuit.components.map(c => [c.id, c]));
  const drives = (ref: PinRef) => {
    const component = byId.get(ref.component);
    return component !== undefined && pinsOf(component, circuit.chips).outputs.includes(ref.pin);
  };
  const left = Math.min(...inside.map(c => c.x));
  const top = Math.min(...inside.map(c => c.y));
  const right = Math.max(...inside.map(c => c.x));

  // The crossings, grouped: an input pin per outside driver, an output
  // pin per inside driver.
  const inputs = new Map<string, { outer: PinRef; inner: PinRef[] }>();
  const outputs = new Map<string, { inner: PinRef; outer: PinRef[] }>();
  for (const wire of circuit.wires) {
    const fromInside = chosen.has(wire.from.component);
    if (fromInside === chosen.has(wire.to.component)) continue;
    const [inner, outer] = fromInside ? [wire.from, wire.to] : [wire.to, wire.from];
    if (drives(inner)) {
      const key = `${inner.component}.${inner.pin}`;
      const group = outputs.get(key) ?? { inner, outer: [] };
      group.outer.push(outer);
      outputs.set(key, group);
    } else {
      const key = `${outer.component}.${outer.pin}`;
      const group = inputs.get(key) ?? { outer, inner: [] };
      group.inner.push(inner);
      inputs.set(key, group);
    }
  }

  const used = new Set(inside.map(c => c.id));
  const fresh = (prefix: string) => {
    for (let n = 1; ; n++) {
      if (!used.has(`${prefix}${n}`)) {
        used.add(`${prefix}${n}`);
        return `${prefix}${n}`;
      }
    }
  };
  const definitionComponents: Component[] = inside.map(c => ({ ...c, x: c.x - left, y: c.y - top }));
  const definitionWires: Wire[] = circuit.wires.filter(w => chosen.has(w.from.component) && chosen.has(w.to.component)).map(w => shiftVia(w, -left, -top));
  const outerWires: Wire[] = [];
  const rootIds = ids(circuit);
  rootIds.add(chipId);
  const freshWire = () => {
    for (let n = 1; ; n++) {
      if (!rootIds.has(`w${n}`)) {
        rootIds.add(`w${n}`);
        return `w${n}`;
      }
    }
  };
  [...inputs.values()].forEach((group, i) => {
    const pin = fresh('in');
    definitionComponents.push({ id: pin, kind: 'input', x: -4, y: 2 * i });
    for (const inner of group.inner) {
      definitionWires.push({ id: fresh('w'), from: { component: pin, pin: 'out' }, to: inner });
    }
    outerWires.push({ id: freshWire(), from: group.outer, to: { component: chipId, pin } });
  });
  [...outputs.values()].forEach((group, i) => {
    const pin = fresh('out');
    definitionComponents.push({ id: pin, kind: 'output', x: right - left + 6, y: 2 * i });
    definitionWires.push({ id: fresh('w'), from: group.inner, to: { component: pin, pin: 'in' } });
    for (const outer of group.outer) {
      outerWires.push({ id: freshWire(), from: { component: chipId, pin }, to: outer });
    }
  });

  const definition: Circuit = { version: circuit.version, components: definitionComponents, wires: definitionWires };
  return {
    ...circuit,
    components: [...circuit.components.filter(c => !chosen.has(c.id)), { id: chipId, kind: 'chip', chip: name, x: left, y: top }],
    wires: [...circuit.wires.filter(w => !chosen.has(w.from.component) && !chosen.has(w.to.component)), ...outerWires],
    chips: { ...circuit.chips, [name]: definition }
  };
}

/**
 * Renames a chip: the definition's key, and every instance that names
 * it, at the top and inside every definition. Unchanged when there is no
 * such chip, when the new name is blank or taken, or when it is the same.
 */
export function renameChip(circuit: Circuit, from: string, to: string): Circuit {
  const name = to.trim();
  const chips = circuit.chips;
  if (chips?.[from] === undefined || name === '' || name === from || chips[name] !== undefined) {
    return circuit;
  }
  const retarget = (level: Circuit): Circuit =>
    level.components.some(c => c.kind === 'chip' && c.chip === from)
      ? { ...level, components: level.components.map(c => (c.kind === 'chip' && c.chip === from ? { ...c, chip: name } : c)) }
      : level;
  const renamed: Record<string, Circuit> = {};
  for (const [key, definition] of Object.entries(chips)) {
    renamed[key === from ? name : key] = retarget(definition);
  }
  return { ...retarget(circuit), chips: renamed };
}

/** A chip name not yet used in the document: `chip 1`, `chip 2`, … */
export function freshChipName(circuit: Circuit): string {
  for (let n = 1; ; n++) {
    if (circuit.chips?.[`chip ${n}`] === undefined) return `chip ${n}`;
  }
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
