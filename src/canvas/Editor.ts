import type { PaintSurface } from 'gesso-core';

import type { CircuitCommands } from '../app/CircuitContract';
import { relabel, type Fragment } from '../app/DocumentEdits';
import { pinAt, route, sizeOf, slotOf, type Box, type KindLayout, type Point, type Shape } from '../app/Layout';
import type { PinRef } from '../sim/Circuit';
import { PINS, type Kind } from '../sim/Primitives';
import type { SceneIndex } from './SceneIndex';

/**
 * Editing, as a state machine the canvas feeds with pointer and key
 * events and draws the overlay of.
 *
 * The render worker owns selection and every in-progress gesture — a
 * wire being drawn, a marquee, a gate held over the canvas before it is
 * dropped. The document is the application worker's, and changes only
 * through commands: nothing here edits a circuit, it asks for edits and
 * sees them come back as geometry. Commands that create something carry
 * the id to give it, made here, so what was just placed can be selected
 * without waiting to learn its name.
 *
 * Coordinates arrive in screen pixels and are turned into grid units by
 * the camera the canvas passes in. Components snap to whole grid units,
 * which is also where every pin is (`Layout.ts`).
 */

export interface EditorDeps {
  scene(): SceneIndex;
  /** Screen pixels to grid units. */
  toWorld(screen: Point): Point;
  /** Screen pixels per grid unit. */
  scale(): number;
  send: Pick<
    CircuitCommands,
    | 'place'
    | 'connect'
    | 'moveBy'
    | 'rotate'
    | 'remove'
    | 'insert'
    | 'undo'
    | 'redo'
    | 'setInput'
    | 'tabulate'
    | 'makeChip'
    | 'openChip'
    | 'copy'
    | 'duplicate'
  >;
  /** A chip definition's body, by name, for placing one from the palette; undefined for a name the document lacks. */
  chipShape(name: string): KindLayout | undefined;
  panBy(dx: number, dy: number): void;
  /** A net's value as last published: 0, 1, or -1 when it has not arrived. */
  value(net: number): -1 | 0 | 1;
  /** Called whenever the overlay has something new to draw. */
  changed(): void;
  /** The clock a double click is timed on; a spec passes its own. */
  now?(): number;
}

type Hit =
  | { readonly kind: 'pin'; readonly pin: PinRef; readonly at: Point }
  | { readonly kind: 'component'; readonly id: string }
  | { readonly kind: 'wire'; readonly id: string }
  | { readonly kind: 'empty' };

type Mode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'placing'; readonly what: Kind; readonly again: boolean; readonly chip?: string }
  | { readonly kind: 'pressing'; readonly screen: Point; readonly hit: Hit; readonly additive: boolean; readonly holding?: string }
  | { readonly kind: 'moving'; readonly gesture: string; last: Point }
  | { readonly kind: 'wiring'; readonly from: PinRef; readonly fromAt: Point }
  | { readonly kind: 'marquee'; readonly from: Point; readonly additive: boolean }
  | { readonly kind: 'panning'; last: Point };

/** Two clicks on one chip within this many milliseconds open it. */
const DOUBLE_CLICK_MS = 400;

/** How far a press may wander, in screen pixels, and still be a click. */
const DRAG_THRESHOLD = 4;
/** How near a pin or a wire a press must land, in screen pixels. */
const PIN_REACH = 8;
const WIRE_REACH = 5;

/** A key per part. Shift gives the inverted gate. */
const PART_KEYS: Readonly<Record<string, Kind>> = {
  a: 'and',
  o: 'or',
  n: 'not',
  x: 'xor',
  A: 'nand',
  O: 'nor',
  X: 'xnor',
  i: 'input',
  l: 'output',
  c: 'clock',
  k: 'constant',
  b: 'button',
  p: 'probe',
  h: 'hex',
  '7': 'seg7'
};

/** What copy puts on the clipboard: marked, so a paste can tell a circuit from any other text. */
interface Clipped extends Fragment {
  readonly gessologic: 1;
}

export class Editor {
  /** Selected component and wire ids. */
  readonly selection = new Set<string>();
  private mode: Mode = { kind: 'idle' };
  private pointer: Point = { x: 0, y: 0 };
  private hover: Hit = { kind: 'empty' };
  /** Ids this editor has handed out and may not have seen come back yet. */
  private readonly issued = new Set<string>();
  private gestures = 0;
  /** The last click on a component, for telling a double click. */
  private lastClick: { id: string; at: number } | null = null;
  private readonly now: () => number;
  /** Whether the space bar is held, which turns a left drag into a pan. */
  private spaceHeld = false;

  constructor(private readonly deps: EditorDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** A label for what the editor is doing, for the readout. */
  get status(): string {
    switch (this.mode.kind) {
      case 'placing':
        return `placing ${this.mode.chip ?? this.mode.what} — click to drop, Esc to stop`;
      case 'wiring':
        return 'drawing a wire — release on a pin';
      case 'moving':
        return 'moving';
      case 'marquee':
        return 'selecting';
      default:
        return this.selection.size === 0 ? '' : `${this.selection.size} selected`;
    }
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  pointerDown(screen: Point, buttons: number, shift: boolean): void {
    this.pointer = this.deps.toWorld(screen);
    if ((buttons & 6) !== 0 || this.spaceHeld) {
      this.mode = { kind: 'panning', last: screen };
      return;
    }
    if (this.mode.kind === 'placing') {
      const what = this.mode.what;
      const chip = this.mode.chip;
      const id = what === 'probe' ? this.probeAt(this.pointer) : this.placeAt(what, this.pointer, chip);
      this.select([id], false);
      this.mode = shift || this.mode.again ? { kind: 'placing', what, again: this.mode.again, ...(chip === undefined ? {} : { chip }) } : { kind: 'idle' };
      this.deps.changed();
      return;
    }
    const hit = this.hitAt(this.pointer);
    // A selected push button is held down for as long as the press lasts.
    const scene = this.deps.scene();
    const c = hit.kind === 'component' ? scene.indexOf.get(hit.id) : undefined;
    const holding =
      hit.kind === 'component' && c !== undefined && scene.kindOf(c) === 'button' && !shift && this.selection.has(hit.id)
        ? hit.id
        : undefined;
    if (holding !== undefined) {
      this.deps.send.setInput(holding, 1);
    }
    this.mode = { kind: 'pressing', screen, hit, additive: shift, ...(holding !== undefined ? { holding } : {}) };
  }

  pointerMove(screen: Point): void {
    const world = this.deps.toWorld(screen);
    this.pointer = world;
    const mode = this.mode;
    switch (mode.kind) {
      case 'panning':
        this.deps.panBy(mode.last.x - screen.x, mode.last.y - screen.y);
        mode.last = screen;
        return;
      case 'pressing': {
        if (Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) < DRAG_THRESHOLD) {
          return;
        }
        const hit = mode.hit;
        // A held button dragged is a button being moved: let it go.
        if (mode.holding !== undefined) {
          this.deps.send.setInput(mode.holding, 0);
        }
        if (hit.kind === 'pin') {
          this.mode = { kind: 'wiring', from: hit.pin, fromAt: hit.at };
        } else if (hit.kind === 'component') {
          if (!this.selection.has(hit.id)) {
            this.select([hit.id], mode.additive);
          }
          this.mode = { kind: 'moving', gesture: `drag-${++this.gestures}`, last: snap(this.deps.toWorld(mode.screen)) };
          this.pointerMove(screen);
          return;
        } else {
          this.mode = { kind: 'marquee', from: this.deps.toWorld(mode.screen), additive: mode.additive };
        }
        break;
      }
      case 'moving': {
        const at = snap(world);
        const dx = at.x - mode.last.x;
        const dy = at.y - mode.last.y;
        if (dx !== 0 || dy !== 0) {
          const ids = this.selectedComponents();
          if (ids.length > 0) {
            this.deps.send.moveBy(ids, dx, dy, mode.gesture);
          }
          mode.last = at;
        }
        break;
      }
      default:
        break;
    }
    this.hover = this.hitAt(world);
    this.deps.changed();
  }

  pointerUp(screen: Point): void {
    const world = this.deps.toWorld(screen);
    // A press released far from where it began was a drag, even with no
    // move reported between: a fast flick, or a pointer that jumps, can
    // arrive as down then up. Played as the move it must have been, so
    // it ends as the drag it was rather than as a click.
    if (
      this.mode.kind === 'pressing' &&
      Math.hypot(screen.x - this.mode.screen.x, screen.y - this.mode.screen.y) >= DRAG_THRESHOLD
    ) {
      this.pointerMove(screen);
    }
    const mode = this.mode;
    this.mode = { kind: 'idle' };
    switch (mode.kind) {
      case 'pressing': {
        const hit = mode.hit;
        if (mode.holding !== undefined) {
          this.deps.send.setInput(mode.holding, 0);
        } else if (hit.kind === 'component') {
          this.clickComponent(hit.id, mode.additive);
        } else if (hit.kind === 'wire') {
          this.select([hit.id], mode.additive);
        } else if (hit.kind === 'empty' && !mode.additive) {
          this.selection.clear();
        }
        break;
      }
      case 'wiring': {
        const target = this.deps.scene().pinNear(world, PIN_REACH / this.deps.scale());
        if (target !== null && !(target.component === mode.from.component && target.pin === mode.from.pin)) {
          this.deps.send.connect(mode.from, target, this.fresh('w'));
        }
        break;
      }
      case 'marquee': {
        const area = rect(mode.from, world);
        const scene = this.deps.scene();
        const ids = scene.componentsIn(area).map(c => scene.ids[c]!);
        this.select(ids, mode.additive);
        break;
      }
      default:
        break;
    }
    this.deps.changed();
  }

  // -------------------------------------------------------------------------
  // Keys and the clipboard
  // -------------------------------------------------------------------------

  /** Returns whether the key was an editing key, so the caller can keep it from anything else. */
  keyDown(key: string, ctrl: boolean, shift: boolean): boolean {
    if (key === ' ') {
      this.spaceHeld = true;
      return true;
    }
    if (ctrl) {
      switch (key.toLowerCase()) {
        case 'z':
          shift ? this.deps.send.redo() : this.deps.send.undo();
          return true;
        case 'y':
          this.deps.send.redo();
          return true;
        case 'a':
          this.select(this.deps.scene().ids, false);
          this.deps.changed();
          return true;
        case 'c':
          this.copy();
          return true;
        case 'x':
          this.copy();
          this.deleteSelection();
          return true;
        case 'd':
          this.duplicate();
          return true;
        default:
          return false;
      }
    }
    switch (key) {
      case 'Escape':
        this.mode = { kind: 'idle' };
        this.selection.clear();
        this.deps.changed();
        return true;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        return true;
      case 'm': {
        // The selection made into a chip, in place.
        const ids = this.selectedComponents();
        if (ids.length > 0) {
          this.deps.send.makeChip(ids);
          // The selected parts are inside the chip now.
          this.selection.clear();
          this.deps.changed();
        }
        return true;
      }
      case 't': {
        // The truth table of the selection; with nothing selected, none.
        this.deps.send.tabulate(this.selectedComponents());
        return true;
      }
      case 'r':
      case 'R': {
        const ids = this.selectedComponents();
        if (ids.length > 0) this.deps.send.rotate(ids);
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const ids = this.selectedComponents();
        if (ids.length === 0) return false;
        const step = shift ? 4 : 1;
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
        this.deps.send.moveBy(ids, dx, dy);
        return true;
      }
      default: {
        const part = PART_KEYS[key];
        if (part !== undefined) {
          this.startPlacing(part);
          return true;
        }
        return false;
      }
    }
  }

  keyUp(key: string): void {
    if (key === ' ') {
      this.spaceHeld = false;
    }
  }

  /** Puts a part on the pointer, to be dropped by the next click. `again` keeps it there after each drop. */
  startPlacing(what: Kind, again = false, chip?: string): void {
    this.mode = { kind: 'placing', what, again, ...(chip === undefined ? {} : { chip }) };
    this.deps.changed();
  }

  /** Pastes a circuit copied from here or from another tab, with its top-left at the pointer. */
  paste(text: string): boolean {
    let clipped: Clipped;
    try {
      clipped = JSON.parse(text) as Clipped;
    } catch {
      return false;
    }
    if (clipped?.gessologic !== 1 || !Array.isArray(clipped.components) || !Array.isArray(clipped.wires)) {
      return false;
    }
    const left = Math.min(...clipped.components.map(c => c.x));
    const top = Math.min(...clipped.components.map(c => c.y));
    const at = snap(this.pointer);
    this.insertFragment(relabel(clipped, at.x - left, at.y - top, prefix => this.fresh(prefix)));
    return true;
  }

  // -------------------------------------------------------------------------
  // The overlay
  // -------------------------------------------------------------------------

  /**
   * Draws selection, the gesture under way and the hovered pin, in grid
   * units, onto a surface the caller has already moved and scaled to the
   * camera. Draws nothing — and so costs nothing — when there is nothing
   * to show.
   */
  drawOverlay(surface: PaintSurface): void {
    const scene = this.deps.scene();
    const px = 1 / this.deps.scale();

    if (this.selection.size > 0) {
      surface.beginPath();
      for (const id of this.selection) {
        const c = scene.indexOf.get(id);
        if (c !== undefined) {
          surface.rect(scene.x[c]! - 3 * px, scene.y[c]! - 3 * px, scene.width(c) + 6 * px, scene.height(c) + 6 * px);
        }
      }
      surface.strokeColor('primary');
      surface.lineWidth(2 * px);
      surface.stroke();
      const wires = scene.wireIds.map((id, w) => (this.selection.has(id) ? w : -1)).filter(w => w >= 0);
      if (wires.length > 0) {
        surface.beginPath();
        for (const w of wires) {
          const p = scene.wirePoints;
          surface.moveTo(p[scene.wireStart[w]!]!, p[scene.wireStart[w]! + 1]!);
          for (let i = scene.wireStart[w]! + 2; i < scene.wireStart[w + 1]!; i += 2) {
            surface.lineTo(p[i]!, p[i + 1]!);
          }
        }
        surface.lineWidth(4 * px);
        surface.stroke();
      }
    }

    const mode = this.mode;
    if (mode.kind === 'wiring') {
      const target = scene.pinNear(this.pointer, PIN_REACH / this.deps.scale());
      const end = target === null ? this.pointer : pinOf(scene, target);
      const path = route(mode.fromAt, end, target === null ? 0 : slotOf(target.pin));
      surface.beginPath();
      surface.moveTo(path[0]!.x, path[0]!.y);
      for (const p of path.slice(1)) surface.lineTo(p.x, p.y);
      surface.strokeColor('primary');
      surface.lineWidth(2 * px);
      surface.lineDash([4 * px, 3 * px]);
      surface.stroke();
      surface.lineDash([]);
    } else if (mode.kind === 'marquee') {
      const area = rect(mode.from, this.pointer);
      surface.beginPath();
      surface.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      surface.alpha(0.12);
      surface.fillColor('primary');
      surface.fill();
      surface.alpha(1 / 0.12);
      surface.strokeColor('primary');
      surface.lineWidth(px);
      surface.stroke();
    } else if (mode.kind === 'placing') {
      const shape = this.shapeFor(mode.what, mode.chip);
      const size = sizeOf(shape);
      const at = placement(shape, this.pointer);
      surface.beginPath();
      surface.roundRect(at.x, at.y, size.width, size.height, 0.4);
      surface.strokeColor('primary');
      surface.lineWidth(2 * px);
      surface.lineDash([4 * px, 3 * px]);
      surface.stroke();
      surface.lineDash([]);
      surface.fillColor('primary');
      surface.text((mode.chip ?? mode.what).toUpperCase(), at.x + size.width / 2, at.y - 0.4, { fontSize: 12 * px, align: 'center' });
    }

    // The pin under the pointer, so drawing a wire has somewhere to aim.
    const hovered = mode.kind === 'wiring' ? scene.pinNear(this.pointer, PIN_REACH / this.deps.scale()) : this.hover.kind === 'pin' ? this.hover.pin : null;
    if (hovered !== null && mode.kind !== 'placing') {
      const at = pinOf(scene, hovered);
      surface.beginPath();
      surface.arc(at.x, at.y, 5 * px, 0, Math.PI * 2);
      surface.strokeColor('primary');
      surface.lineWidth(2 * px);
      surface.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private hitAt(world: Point): Hit {
    const scene = this.deps.scene();
    const scale = this.deps.scale();
    const pin = scene.pinNear(world, PIN_REACH / scale);
    if (pin !== null) {
      return { kind: 'pin', pin, at: pinOf(scene, pin) };
    }
    const c = scene.componentAt(world);
    if (c >= 0) {
      return { kind: 'component', id: scene.ids[c]! };
    }
    const w = scene.wireNear(world, WIRE_REACH / scale);
    if (w >= 0) {
      return { kind: 'wire', id: scene.wireIds[w]! };
    }
    return { kind: 'empty' };
  }

  /** A click on a component: a switch toggles, a chip clicked twice opens, anything else is selected. */
  private clickComponent(id: string, additive: boolean): void {
    const scene = this.deps.scene();
    const c = scene.indexOf.get(id);
    const now = this.now();
    const twice = this.lastClick !== null && this.lastClick.id === id && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { id, at: now };
    if (twice && c !== undefined && scene.kindOf(c) === 'chip' && !additive) {
      this.lastClick = null;
      this.selection.clear();
      this.deps.send.openChip(id);
      return;
    }
    if (c !== undefined && scene.kindOf(c) === 'input' && !additive && this.selection.has(id)) {
      // A second click on a selected switch flips it: the first selects it
      // so it can be moved, the second uses it.
      this.deps.send.setInput(id, this.deps.value(scene.valueNet[c]!) === 1 ? 0 : 1);
      return;
    }
    if (additive && this.selection.has(id)) {
      this.selection.delete(id);
    } else {
      this.select([id], additive);
    }
  }

  private select(ids: readonly string[], additive: boolean): void {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
  }

  private selectedComponents(): string[] {
    const scene = this.deps.scene();
    return [...this.selection].filter(id => scene.indexOf.has(id));
  }

  private deleteSelection(): void {
    if (this.selection.size === 0) return;
    this.deps.send.remove([...this.selection]);
    this.selection.clear();
    this.deps.changed();
  }

  /**
   * Copy is the application worker's: only it has whole parts — labels,
   * values, rates, which chip a chip is, and the definitions a chip
   * needs — and it publishes the text for the canvas to hand the shell.
   */
  private copy(): void {
    const ids = this.selectedComponents();
    if (ids.length > 0) this.deps.send.copy(ids);
  }

  /**
   * Duplicate, likewise, is copied by the application worker, under ids
   * picked here so the copies can be selected the moment they are asked
   * for: each selected part, and each wire between two of them.
   */
  private duplicate(): void {
    const ids = this.selectedComponents();
    if (ids.length === 0) return;
    const scene = this.deps.scene();
    const kept = new Set(ids);
    const rename: Record<string, string> = {};
    for (const id of ids) {
      const c = scene.indexOf.get(id);
      rename[id] = this.fresh(c === undefined ? 'part' : scene.kindOf(c));
    }
    scene.wireIds.forEach((id, w) => {
      const ends = scene.wireEnds[w]!;
      if (kept.has(ends.from.component) && kept.has(ends.to.component)) rename[id] = this.fresh('w');
    });
    this.deps.send.duplicate(ids, rename, 2, 2);
    this.select(
      ids.map(id => rename[id]!),
      false
    );
    this.deps.changed();
  }

  private insertFragment(fragment: Fragment): void {
    this.deps.send.insert(fragment);
    this.select(
      fragment.components.map(c => c.id),
      false
    );
    this.deps.changed();
  }



  /**
   * A probe dropped on a wire clips onto it: placed just above the
   * point, and wired to the pin that drives the wire, so it shows that
   * wire's value. Dropped anywhere else it is placed as any part is,
   * to be wired by hand.
   */
  private probeAt(world: Point): string {
    const scene = this.deps.scene();
    const w = scene.wireNear(world, WIRE_REACH / this.deps.scale());
    const id = this.fresh('probe');
    const at = w < 0 ? placement('probe', world) : { x: Math.round(world.x) + 1, y: Math.round(world.y) - 3 };
    this.deps.send.place('probe', at.x, at.y, id);
    if (w >= 0) {
      const ends = scene.wireEnds[w]!;
      const from = scene.indexOf.get(ends.from.component);
      const driver = from !== undefined && scene.drives(from, ends.from.pin) ? ends.from : ends.to;
      this.deps.send.connect(driver, { component: id, pin: 'in' }, this.fresh('w'));
    }
    return id;
  }

  /** What a part being placed is laid out as: its kind, or a chip's body from the palette. */
  private shapeFor(what: Kind, chip: string | undefined): Shape {
    return (chip === undefined ? undefined : this.deps.chipShape(chip)) ?? what;
  }

  private placeAt(what: Kind, world: Point, chip?: string): string {
    const id = this.fresh(what);
    const at = placement(this.shapeFor(what, chip), world);
    this.deps.send.place(what, at.x, at.y, id, undefined, chip);
    return id;
  }

  /** An id no component or wire has, counting ones handed out and not yet seen in geometry. */
  private fresh(prefix: string): string {
    const scene = this.deps.scene();
    const wires = new Set(scene.wireIds);
    for (let n = 1; ; n++) {
      const id = `${prefix}${n}`;
      if (!this.issued.has(id) && !scene.indexOf.has(id) && !wires.has(id)) {
        this.issued.add(id);
        return id;
      }
    }
  }
}

/** Where a part dropped at a point goes: centred on it, on the grid. */
function placement(what: Shape, world: Point): Point {
  const size = sizeOf(what);
  return { x: Math.round(world.x - size.width / 2), y: Math.round(world.y - size.height / 2) };
}

function snap(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function rect(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

function pinOf(scene: SceneIndex, ref: PinRef): Point {
  const c = scene.indexOf.get(ref.component);
  if (c === undefined) return { x: 0, y: 0 };
  return pinAt(scene.kindOf(c), scene.x[c]!, scene.y[c]!, ref.pin, scene.rotationOf(c));
}

