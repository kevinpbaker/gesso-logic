import type { PaintSurface } from 'gesso-core';

import type { CircuitCommands } from '../app/CircuitContract';
import { kindName, primitivePinNote } from '../app/Describe';
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
    | 'openProgram'
    | 'copy'
    | 'duplicate'
    | 'watch'
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
  /** What a chip definition's pin is for, from the document; null when it does not say. */
  pinNote?(chip: string, pin: string): string | null;
  /** The canvas's size in screen pixels, so a tooltip near an edge can open away from it. */
  viewSize?(): { readonly width: number; readonly height: number };
  /** Something was just sent to the analyser to trace: the page opens it. */
  traced?(): void;
}

/** What Alt is called on the keyboard in hand: Option, on a Mac. */
const ALT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌥' : 'Alt';

/**
 * What the pointer is over, in words: a pin's name, what part it is on
 * and which way it points, what it is for, and its value now. A bus has
 * only a value.
 */
export interface HoverCard {
  /** The pin as a person reads it, `alu.Y`; null for a bus. */
  readonly title: string | null;
  /** The part and the pin's direction and width: `ALU · output · 8 bits`. */
  readonly about: string | null;
  /** What it is for: the chip's note on it, or a built-in part's. */
  readonly note: string | null;
  /** Its value: `1`, `0x3C · 60 · 0011 1100`, `?` before one has arrived, `—` while nothing compiles. */
  readonly value: string;
}

/**
 * What the analyser's hovered row points at on this level: a pin, its
 * net lit; or the chip on this level that its pin is somewhere inside.
 */
export type Highlight = { readonly kind: 'pin'; readonly pin: PinRef } | { readonly kind: 'chip'; readonly id: string };

/** What is at a point on the canvas: a pin, a part, a wire, or nothing. */
export type Hit =
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
/** How far a wire being drawn reaches for a pin to end on, in pixels; see `dropTarget`. */
const DROP_REACH = 16;
/** How near a part's edge a wire being drawn counts as over the part, in pixels. */
const PART_REACH = 24;
const WIRE_REACH = 5;
/** How near a click must be to the last one, in pixels, to pick the next of the wires there. */
const CYCLE_REACH = 5;

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
  '7': 'seg7',
  s: 'split',
  j: 'join'
};

/** What copy puts on the clipboard: marked, so a paste can tell a circuit from any other text. */
interface Clipped extends Fragment {
  readonly gessologic: 1;
}

/** The buttons arrow keys press, by key. */
const ARROW_BUTTONS: Readonly<Record<string, string>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export class Editor {
  /** Selected component and wire ids. */
  readonly selection = new Set<string>();
  private mode: Mode = { kind: 'idle' };
  private pointer: Point = { x: 0, y: 0 };
  private hover: Hit = { kind: 'empty' };
  /** Where the pointer is on the canvas, in screen pixels; null once it has left. */
  private screenPointer: Point | null = null;
  /** Ids this editor has handed out and may not have seen come back yet. */
  private readonly issued = new Set<string>();
  private gestures = 0;
  /** The last click on a component, for telling a double click. */
  private lastClick: { id: string; at: number } | null = null;
  private readonly now: () => number;
  /** Whether the space bar is held, which turns a left drag into a pan. */
  private spaceHeld = false;
  /** The wires under the last wire click, and which of them is selected: see `clickWire`. */
  private wireCycle: { readonly screen: Point; readonly ids: readonly string[]; readonly at: number } | null = null;
  /** Arrow keys holding a button down: see `pressArrowButton`. */
  private readonly arrowsHeld = new Set<string>();
  /** Whether an arrow key has held a button yet: the tour's first step. */
  playedWithArrows = false;
  private highlight: Highlight | null = null;

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

  /** The part on the pointer, while one is being placed; null otherwise. */
  get placing(): { readonly what: Kind; readonly chip: string | null } | null {
    return this.mode.kind === 'placing' ? { what: this.mode.what, chip: this.mode.chip ?? null } : null;
  }

  /** Nothing is selected and nothing is under way: the status bar may say something of its own. */
  get idle(): boolean {
    return this.mode.kind === 'idle' && this.selection.size === 0;
  }

  /**
   * What can be done from here, for the status bar: the keys that act
   * on what is selected, or on nothing, so that none of them has to be
   * found by accident.
   */
  get hint(): string {
    switch (this.mode.kind) {
      case 'placing':
        return `Placing ${this.mode.chip ?? this.mode.what}: click to drop it · Esc stops`;
      case 'wiring':
        return 'Release on a pin to connect · Esc cancels';
      case 'moving':
        return 'Arrow keys nudge a selection · Shift+arrows nudge by 4';
      case 'marquee':
        return 'Shift adds to the selection';
      default:
        break;
    }
    const scene = this.deps.scene();
    const ids = this.selectedComponents();
    const cycle = this.wireCycle;
    if (cycle !== null && this.selection.size === 1 && this.selection.has(cycle.ids[cycle.at]!) && cycle.ids.length > 1) {
      const w = scene.wireIds.indexOf(cycle.ids[cycle.at]!);
      const ends = w < 0 ? null : scene.wireEnds[w]!;
      const what = ends === null ? '' : `: ${this.pinTitle(ends.from)} → ${this.pinTitle(ends.to)}`;
      return `Wire ${cycle.at + 1} of ${cycle.ids.length} here${what} · click again or Tab for the next · Del deletes it`;
    }
    if (ids.length === 0 && this.selection.size > 0) return 'Wire selected · Shift+W traces it · Del deletes it';
    if (ids.length === 0) {
      return scene.componentCount === 0
        ? 'Pick a part on the left, or press its key · Drag from a pin to wire · ? shows every shortcut'
        : `Drag from a pin to wire · ${ALT}+click a pin or wire to trace it · Drag empty space to select · Space+drag or right-drag pans · Ctrl+wheel zooms · ? for shortcuts`;
    }
    if (ids.length === 1) {
      const c = scene.indexOf.get(ids[0]!);
      const kind = c === undefined ? null : scene.kindOf(c);
      if (kind === 'chip') return 'Double-click to open · R rotate · Ctrl+D duplicate · Del delete';
      if (kind === 'input') return 'Click again to flip it · R rotate · Ctrl+D duplicate · Del delete';
      if (kind === 'button') return 'Hold to press · R rotate · Ctrl+D duplicate · Del delete';
    }
    return 'R rotate · M make a chip · T truth table · Ctrl+D duplicate · Ctrl+C copy · Del delete';
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  pointerDown(screen: Point, buttons: number, shift: boolean, alt = false): void {
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
    // What is under a press is what is hovered, though no move came first:
    // a touch, or a pointer that jumps, would leave the tooltip of
    // wherever it was last drawn at the press.
    this.hover = hit;
    // Alt and a pin or a wire: trace it in the analyser, and nothing else.
    if (alt && (hit.kind === 'pin' || hit.kind === 'wire')) {
      const pin = hit.kind === 'pin' ? hit.pin : this.driverOf(hit.id);
      if (pin !== null) this.trace([pin]);
      return;
    }
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

  pointerMove(screen: Point, buttons?: number): void {
    this.screenPointer = screen;
    const world = this.deps.toWorld(screen);
    this.pointer = world;
    // A right or middle press never reports its release — the surface
    // takes a secondary press for a context menu and holds no press to
    // release — so a pan ends when a move finds no button still down.
    if (this.mode.kind === 'panning' && buttons === 0) {
      this.mode = { kind: 'idle' };
    }
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

  /**
   * What is under a point in screen pixels — what a right-click asks
   * about — and, for a part or a wire, made the selection unless it is
   * in it already, as a right-click on a file selects it.
   */
  contextAt(screen: Point): Hit {
    // The press was a pan's start; a menu is opening instead.
    this.mode = { kind: 'idle' };
    const hit = this.hitAt(this.deps.toWorld(screen));
    if ((hit.kind === 'component' || hit.kind === 'wire') && !this.selection.has(hit.id)) this.select([hit.id], false);
    this.deps.changed();
    return hit;
  }

  /**
   * The view moved under a pointer holding still — a pinch, a wheel, a
   * jump — so what is under it is asked again: the tooltip, and the net
   * lit, were the last thing's until the pointer next moved.
   */
  viewMoved(): void {
    if (this.screenPointer === null || this.mode.kind !== 'idle') return;
    this.pointer = this.deps.toWorld(this.screenPointer);
    const hit = this.hitAt(this.pointer);
    if (JSON.stringify(hit) === JSON.stringify(this.hover)) return;
    this.hover = hit;
    this.deps.changed();
  }

  /** The pointer has left the canvas: nothing is under it, so no tooltip. */
  pointerLeave(): void {
    this.screenPointer = null;
    if (this.hover.kind === 'empty') return;
    this.hover = { kind: 'empty' };
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
          this.clickWire(mode.screen, mode.additive);
        } else if (hit.kind === 'empty' && !mode.additive) {
          this.selection.clear();
        }
        break;
      }
      case 'wiring': {
        const target = this.dropTarget(world, mode.from);
        if (target !== null) {
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
          this.selectAll();
          return true;
        case 'c':
          this.copy();
          return true;
        case 'x':
          this.cut();
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
        this.cancel();
        return true;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        return true;
      case 'm':
        this.makeChip();
        return true;
      case 't':
        this.tabulate();
        return true;
      case 'Tab':
        return this.nextOverlappingWire();
      case 'r':
      case 'R':
        this.rotateSelection();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const ids = this.selectedComponents();
        if (ids.length === 0) return this.pressArrowButton(key, 1);
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

  // -------------------------------------------------------------------------
  // Commands, for the keys above and for the menus and toolbar
  // -------------------------------------------------------------------------

  /** Whether anything is selected: a part or a wire. */
  get hasSelection(): boolean {
    return this.selection.size > 0;
  }

  /** Whether any part — not only wires — is selected. */
  get hasSelectedParts(): boolean {
    return this.selectedComponents().length > 0;
  }

  /**
   * Another level or another document is on the canvas: what was
   * selected, hovered or under way belonged to the one before. Ids are
   * only unique within a level — `clk` and `rst` are in most — so a
   * selection kept across would land on other parts, and Delete delete
   * them.
   */
  forget(): void {
    this.mode = { kind: 'idle' };
    this.selection.clear();
    this.hover = { kind: 'empty' };
    this.wireCycle = null;
    this.lastClick = null;
    this.deps.changed();
  }

  /**
   * Traces the selection in the analyser: each wire selected, by the pin
   * that drives it, and every output of each part selected. Nothing
   * selected traces nothing.
   */
  traceSelection(): void {
    const scene = this.deps.scene();
    const pins: PinRef[] = [];
    for (const id of this.selection) {
      const c = scene.indexOf.get(id);
      if (c === undefined) {
        const pin = this.driverOf(id);
        if (pin !== null) pins.push(pin);
        continue;
      }
      for (const { pin } of scene.pins(c)) if (scene.drives(c, pin)) pins.push({ component: id, pin });
    }
    if (pins.length > 0) this.trace(pins);
  }

  /** Traces a pin, or a wire by the pin driving it, in the analyser. */
  traceHit(hit: Hit): void {
    const pin = hit.kind === 'pin' ? hit.pin : hit.kind === 'wire' ? this.driverOf(hit.id) : null;
    if (pin !== null) this.trace([pin]);
  }

  private trace(pins: readonly PinRef[]): void {
    this.deps.send.watch(pins);
    this.deps.traced?.();
  }

  /** The pin driving a wire, by the wire's id: the end it is drawn from. */
  private driverOf(wire: string): PinRef | null {
    const scene = this.deps.scene();
    const w = scene.wireIds.indexOf(wire);
    return w < 0 ? null : scene.wireEnds[w]!.from;
  }

  /** Lights what an analyser row is tracing; null lights nothing. */
  setHighlight(highlight: Highlight | null): void {
    const was = this.highlight;
    if (was === highlight || (was !== null && highlight !== null && JSON.stringify(was) === JSON.stringify(highlight))) return;
    this.highlight = highlight;
    this.deps.changed();
  }

  /** Stops whatever is under way and lets go of the selection. */
  cancel(): void {
    this.mode = { kind: 'idle' };
    this.selection.clear();
    this.deps.changed();
  }

  selectAll(): void {
    this.select(this.deps.scene().ids, false);
    this.deps.changed();
  }

  /** Selects exactly these, as a click on each would; for the status bar's problem link. */
  selectOnly(ids: readonly string[]): void {
    const scene = this.deps.scene();
    this.select(
      ids.filter(id => scene.indexOf.has(id)),
      false
    );
    this.deps.changed();
  }

  rotateSelection(): void {
    const ids = this.selectedComponents();
    if (ids.length > 0) this.deps.send.rotate(ids);
  }

  /** The selection made into a chip, in place. */
  makeChip(): void {
    const ids = this.selectedComponents();
    if (ids.length > 0) {
      this.deps.send.makeChip(ids);
      // The selected parts are inside the chip now.
      this.selection.clear();
      this.deps.changed();
    }
  }

  /** The truth table of the selection; with nothing selected, none. */
  tabulate(): void {
    this.deps.send.tabulate(this.selectedComponents());
  }

  cut(): void {
    this.copy();
    this.deleteSelection();
  }

  keyUp(key: string): void {
    if (key === ' ') {
      this.spaceHeld = false;
    }
    this.pressArrowButton(key, 0);
  }

  /**
   * With nothing selected, an arrow key held is a button held: the
   * level's button whose id is `up`, `down`, `left` or `right`. That is
   * how Pong's paddle is played from the keyboard. Returns whether there
   * was such a button.
   */
  private pressArrowButton(key: string, value: 0 | 1): boolean {
    const id = ARROW_BUTTONS[key];
    if (id === undefined) return false;
    const scene = this.deps.scene();
    const c = scene.indexOf.get(id);
    if (c === undefined || scene.kindOf(c) !== 'button') return false;
    if (value === 1 && this.arrowsHeld.has(key)) return true; // a key's repeat
    if (value === 1) this.arrowsHeld.add(key);
    else if (!this.arrowsHeld.delete(key)) return false;
    this.deps.send.setInput(id, value);
    if (!this.playedWithArrows) {
      this.playedWithArrows = true;
      this.deps.changed();
    }
    return true;
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

    if (this.highlight !== null) {
      this.drawHighlight(surface, this.highlight, px);
    } else if (this.mode.kind === 'idle') {
      // The net under the pointer, every wire of it, so one can be followed
      // across the crossings of a dense level by eye.
      const net = this.hoveredNet();
      if (net >= 0) this.drawNet(surface, net, 3 * px);
    }

    if (this.selection.size > 0) {
      surface.beginPath();
      for (const id of this.selection) {
        const c = scene.indexOf.get(id);
        if (c !== undefined) {
          surface.rect(scene.x[c]! - 3 * px, scene.y[c]! - 3 * px, scene.width(c) + 6 * px, scene.height(c) + 6 * px);
        }
      }
      // The selection is drawn in the secondary colour, not the primary:
      // primary is what a high signal is lit in, and a selected wire on a
      // live net was blue on blue, its route and its ends lost.
      surface.strokeColor('secondary');
      surface.lineWidth(2 * px);
      surface.stroke();
      const wires = scene.wireIds.map((id, w) => (this.selection.has(id) ? w : -1)).filter(w => w >= 0);
      if (wires.length > 0) {
        const p = scene.wirePoints;
        surface.beginPath();
        for (const w of wires) {
          surface.moveTo(p[scene.wireStart[w]!]!, p[scene.wireStart[w]! + 1]!);
          for (let i = scene.wireStart[w]! + 2; i < scene.wireStart[w + 1]!; i += 2) {
            surface.lineTo(p[i]!, p[i + 1]!);
          }
        }
        surface.lineWidth(4 * px);
        surface.stroke();
        // And a dot on each end: the two pins it joins.
        surface.beginPath();
        const r = Math.max(0.45, 5 * px);
        for (const w of wires) {
          for (const at of [scene.wireStart[w]!, scene.wireStart[w + 1]! - 2]) {
            surface.moveTo(p[at]! + r, p[at + 1]!);
            surface.arc(p[at]!, p[at + 1]!, r, 0, Math.PI * 2);
            surface.closePath();
          }
        }
        surface.fillColor('secondary');
        surface.fill();
        // And what it joins, named at each end: the part and the pin. A
        // few wires at most, or the names are a crowd.
        if (wires.length <= 4) {
          for (const w of wires) {
            const ends = scene.wireEnds[w]!;
            for (const end of [ends.from, ends.to]) this.drawPinPill(surface, end, this.pinTitle(end), true, px);
          }
        }
      }
    }

    const mode = this.mode;
    if (mode.kind === 'wiring') {
      const target = this.dropTarget(this.pointer, mode.from);
      const end = target === null ? this.pointer : pinOf(scene, target);
      const path = route(mode.fromAt, end, target === null ? 0 : slotOf(target.pin));
      surface.beginPath();
      surface.moveTo(path[0]!.x, path[0]!.y);
      for (const p of path.slice(1)) surface.lineTo(p.x, p.y);
      surface.strokeColor(target === null ? 'textMuted' : 'secondary');
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

    // Drawing a wire: the part it would end on, with the names of the
    // pins it could take and the one it will, at any zoom — the painter
    // writes pin names only close in, and a chip's pins are points.
    if (mode.kind === 'wiring') {
      const target = this.dropTarget(this.pointer, mode.from);
      if (target !== null) this.drawPinNames(surface, target, mode.from, px);
    }

    // The pin under the pointer, so drawing a wire has somewhere to aim.
    const hovered = mode.kind === 'wiring' ? this.dropTarget(this.pointer, mode.from) : this.hover.kind === 'pin' ? this.hover.pin : null;
    if (hovered !== null && mode.kind !== 'placing') {
      const at = pinOf(scene, hovered);
      surface.beginPath();
      surface.arc(at.x, at.y, (mode.kind === 'wiring' ? 7 : 5) * px, 0, Math.PI * 2);
      surface.strokeColor(mode.kind === 'wiring' ? 'secondary' : 'primary');
      surface.lineWidth(2 * px);
      surface.stroke();
    }

    // The pin or bus under the pointer says what it is and holds.
    if (mode.kind === 'idle') {
      const card = this.hoverCard();
      if (card !== null) this.drawCard(surface, card, px);
    }
  }

  /**
   * What an analyser row traces: its pin ringed and every wire on its net
   * drawn over, or the chip it is inside outlined, in the secondary
   * colour, under the selection.
   */
  private drawHighlight(surface: PaintSurface, highlight: Highlight, px: number): void {
    const scene = this.deps.scene();
    if (highlight.kind === 'chip') {
      const c = scene.indexOf.get(highlight.id);
      if (c === undefined) return;
      surface.beginPath();
      surface.roundRect(scene.x[c]! - 6 * px, scene.y[c]! - 6 * px, scene.width(c) + 12 * px, scene.height(c) + 12 * px, 6 * px);
      surface.strokeColor('secondary');
      surface.lineWidth(3 * px);
      surface.lineDash([6 * px, 4 * px]);
      surface.stroke();
      surface.lineDash([]);
      return;
    }
    const c = scene.indexOf.get(highlight.pin.component);
    if (c === undefined) return;
    this.drawNet(surface, netOfPin(scene, c, highlight.pin.pin), 5 * px);
    const at = pinOf(scene, highlight.pin);
    surface.beginPath();
    surface.arc(at.x, at.y, 8 * px, 0, Math.PI * 2);
    surface.strokeColor('secondary');
    surface.lineWidth(3 * px);
    surface.stroke();
  }

  /** The net of the pin or wire under the pointer; -1 for none. */
  private hoveredNet(): number {
    const scene = this.deps.scene();
    const hover = this.hover;
    if (hover.kind === 'wire') {
      const w = scene.wireIds.indexOf(hover.id);
      return w < 0 ? -1 : scene.wireNet[w]!;
    }
    if (hover.kind === 'pin') {
      const c = scene.indexOf.get(hover.pin.component);
      return c === undefined ? -1 : netOfPin(scene, c, hover.pin.pin);
    }
    return -1;
  }

  /** Every wire on a net drawn over, `width` wide, in the secondary colour. */
  private drawNet(surface: PaintSurface, net: number, width: number): void {
    if (net < 0) return;
    const scene = this.deps.scene();
    const p = scene.wirePoints;
    surface.beginPath();
    for (let w = 0; w < scene.wireCount; w++) {
      if (scene.wireNet[w] !== net) continue;
      surface.moveTo(p[scene.wireStart[w]!]!, p[scene.wireStart[w]! + 1]!);
      for (let i = scene.wireStart[w]! + 2; i < scene.wireStart[w + 1]!; i += 2) surface.lineTo(p[i]!, p[i + 1]!);
    }
    surface.strokeColor('secondary');
    surface.lineWidth(width);
    surface.stroke();
  }

  /**
   * The tooltip for what is under the pointer, or null when it is not a
   * pin or a bus, or a gesture is under way. The canvas also asks for
   * it as the signals change, and redraws the overlay when `value` does,
   * so the value is live while the pointer holds still.
   */
  hoverCard(): HoverCard | null {
    if (this.mode.kind !== 'idle') return null;
    const hover = this.hover;
    const scene = this.deps.scene();
    if (hover.kind === 'wire') {
      const w = scene.wireIds.indexOf(hover.id);
      const bits = w < 0 ? null : scene.wireBits[w];
      if (bits === null || bits === undefined) return null;
      return { title: null, about: null, note: null, value: this.valueOf(Array.from(bits)) };
    }
    if (hover.kind !== 'pin') return null;
    const { component, pin } = hover.pin;
    const c = scene.indexOf.get(component);
    if (c === undefined) return null;
    const kind = scene.kindOf(c);
    const entry = scene.entries[c]!;
    // A bus pin's nets are under `pin[i]`; a one-bit pin's under its name.
    const bits: number[] = [];
    if (entry.nets[`${pin}[0]`] !== undefined) {
      for (let i = 0; entry.nets[`${pin}[${i}]`] !== undefined; i++) bits.push(entry.nets[`${pin}[${i}]`]!);
    } else if (entry.nets[pin] !== undefined) {
      bits.push(entry.nets[pin]!);
    }
    const chip = scene.chipNames[c] ?? null;
    const part = kind === 'chip' && chip !== null ? chip : kindName(kind);
    const direction = scene.drives(c, pin) ? 'output' : 'input';
    const width = bits.length > 1 ? ` · ${bits.length} bits` : '';
    const note =
      kind === 'chip'
        ? chip === null
          ? null
          : (this.deps.pinNote?.(chip, pin) ?? null)
        : (entry.note ?? primitivePinNote(kind, pin, scene.widths[c]!));
    return { title: this.pinTitle(hover.pin), about: `${part} · ${direction}${width}`, note, value: this.valueOf(bits) };
  }

  /** A value as the tooltip shows it: a bit as itself, a bus in hex, decimal and, up to 16 bits, binary. */
  private valueOf(bits: readonly number[]): string {
    if (bits.length === 0 || bits.some(net => net < 0)) return '—';
    let value = 0;
    for (let i = 0; i < bits.length; i++) {
      const bit = this.deps.value(bits[i]!);
      if (bit < 0) return '?';
      value += bit * 2 ** i;
    }
    if (bits.length === 1) return String(value);
    const hex = `0x${value.toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0')}`;
    if (bits.length > 16) return `${hex} · ${value}`;
    const binary = value.toString(2).padStart(bits.length, '0').replace(/\B(?=(\d{4})+$)/g, ' ');
    return `${hex} · ${value} · ${binary}`;
  }

  /**
   * A tooltip beside the pointer: the pin's name in bold, what it is on,
   * what it is for wrapped to a few lines, and its value in monospace.
   * Below and right of the pointer, or above and left of it where that
   * would run off the canvas. Sizes are screen pixels; text is measured
   * by estimate, as the pin pills are, since a surface cannot measure.
   */
  private drawCard(surface: PaintSurface, card: HoverCard, px: number): void {
    const PAD = 8;
    const lines: { text: string; size: number; weight: number; mono: boolean; color: 'text' | 'textMuted'; em: number }[] = [];
    if (card.title !== null) lines.push({ text: card.title, size: 13, weight: 700, mono: false, color: 'text', em: 0.6 });
    if (card.about !== null) lines.push({ text: card.about, size: 11, weight: 400, mono: false, color: 'textMuted', em: 0.56 });
    if (card.note !== null) for (const text of wrap(card.note, NOTE_CHARS)) lines.push({ text, size: 12, weight: 400, mono: false, color: 'text', em: 0.56 });
    lines.push({ text: card.value, size: 13, weight: 600, mono: true, color: 'text', em: 0.62 });
    lines.push({ text: `${ALT}+click to trace in the analyser`, size: 10, weight: 400, mono: false, color: 'textMuted', em: 0.55 });
    const lineHeight = (size: number) => size + 5;
    const width = Math.max(...lines.map(l => l.text.length * l.em * l.size)) + PAD * 2;
    const height = lines.reduce((h, l) => h + lineHeight(l.size), 0) + PAD * 2 - 4;

    // Where it goes, in screen pixels from the pointer, flipped at the edges.
    let dx = 14;
    let dy = 16;
    const view = this.deps.viewSize?.();
    if (view !== undefined) {
      const corner = this.deps.toWorld({ x: 0, y: 0 });
      const sx = (this.pointer.x - corner.x) / px;
      const sy = (this.pointer.y - corner.y) / px;
      if (sx + dx + width > view.width - 8) dx = -10 - width;
      if (sy + dy + height > view.height - 8) dy = -10 - height;
    }
    const x = this.pointer.x + dx * px;
    let y = this.pointer.y + dy * px;
    surface.beginPath();
    surface.roundRect(x, y, width * px, height * px, 6 * px);
    surface.fillColor('surface');
    surface.fill();
    surface.strokeColor('border');
    surface.lineWidth(px);
    surface.stroke();
    y += PAD * px;
    for (const line of lines) {
      y += line.size * px;
      surface.fillColor(line.color);
      surface.text(line.text, x + PAD * px, y, {
        fontSize: line.size * px,
        fontWeight: line.weight,
        ...(line.mono ? { fontFamily: 'monospace' } : {})
      });
      y += (lineHeight(line.size) - line.size) * px;
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

  /**
   * The names of a part's pins a wire could end on, each beside its pin
   * on a pill, and the one it will end on — `target` — in the secondary
   * colour and bold, with its pin filled: what is lit is what letting go
   * makes.
   */
  private drawPinNames(surface: PaintSurface, target: PinRef, from: PinRef, px: number): void {
    const scene = this.deps.scene();
    const c = scene.indexOf.get(target.component);
    if (c === undefined) return;
    const start = scene.indexOf.get(from.component);
    const fromDrives = start !== undefined && scene.drives(start, from.pin);
    for (const { pin } of scene.pins(c)) {
      if (pin === target.pin || scene.drives(c, pin) !== fromDrives) this.drawPinPill(surface, { component: target.component, pin }, pin, pin === target.pin, px);
    }
    const at = pinOf(scene, target);
    surface.beginPath();
    surface.arc(at.x, at.y, 4 * px, 0, Math.PI * 2);
    surface.fillColor('secondary');
    surface.fill();
  }

  /** A pin as a person reads it: its part's label, or id, and the pin — `clk.out`. */
  private pinTitle(ref: PinRef): string {
    const scene = this.deps.scene();
    const c = scene.indexOf.get(ref.component);
    const part = c === undefined ? ref.component : (scene.labels[c] ?? ref.component);
    return `${part}.${ref.pin}`;
  }

  /**
   * A pin's name on a pill beside it, outside its part on the side the
   * pin is on, a screen size at any zoom; `strong` in the secondary colour
   * and bold, as the pin a wire is about to end on or a selected wire's
   * end.
   */
  private drawPinPill(surface: PaintSurface, ref: PinRef, text: string, strong: boolean, px: number): void {
    const scene = this.deps.scene();
    const c = scene.indexOf.get(ref.component);
    if (c === undefined) return;
    const at = pinOf(scene, ref);
    const size = 11 * px;
    const left = at.x < scene.x[c]! + scene.width(c) / 2;
    const width = text.length * 0.62 * size + 8 * px;
    const x = left ? at.x - 8 * px - width : at.x + 8 * px;
    surface.beginPath();
    surface.roundRect(x, at.y - size * 0.75, width, size * 1.5, 3 * px);
    surface.fillColor(strong ? 'selectionBackground' : 'surface');
    surface.fill();
    surface.strokeColor(strong ? 'secondary' : 'border');
    surface.lineWidth((strong ? 1.5 : 1) * px);
    surface.stroke();
    surface.fillColor(strong ? 'secondary' : 'textMuted');
    surface.text(text, x + width / 2, at.y + size * 0.35, { fontSize: size, align: 'center', fontWeight: strong ? 700 : 400 });
  }

  /**
   * Where a wire being drawn would end if let go here — the same pin the
   * overlay rings, so what is shown is what is made.
   *
   * Forgiving, because a pin is a point: a pin within `DROP_REACH`
   * pixels, and failing that, anywhere on a part's body, that part's
   * nearest pin. Either way, the other kind of pin to the one the wire
   * started from — an input for a wire from an output — when the part
   * has one. The first version took only a pin within eight pixels, so
   * a wire let go on the pin's name, a unit inside a chip, went nowhere.
   */
  private dropTarget(world: Point, from: PinRef): PinRef | null {
    const scene = this.deps.scene();
    const start = scene.indexOf.get(from.component);
    const fromDrives = start !== undefined && scene.drives(start, from.pin);
    const other = (c: number, pin: string) => !(scene.ids[c] === from.component && pin === from.pin) && scene.drives(c, pin) !== fromDrives;
    const notItself = (c: number, pin: string) => !(scene.ids[c] === from.component && pin === from.pin);
    const reach = DROP_REACH / this.deps.scale();
    const near = scene.pinNear(world, reach, other);
    if (near !== null) return near;
    // On a part, or near its edge — not the part it started from: let go
    // on its own body, a wire is more likely a slip than a loop — that
    // part's nearest pin of the other kind. Beside a chip, that is the
    // pin level with the pointer, wherever along its side it is.
    const c = scene.componentNear(world, PART_REACH / this.deps.scale(), start);
    if (c >= 0) {
      const pin = scene.nearestPinOf(c, world, name => other(c, name));
      if (pin !== null) return pin;
    }
    return scene.pinNear(world, reach, notItself);
  }

  /**
   * A click on a wire. Where wires overlap — most often several leaving
   * one pin together — a click selects the nearest, and another click in
   * the same place, with it still selected, selects the next, round and
   * round; so does Tab. The status bar says which of how many it is.
   */
  private clickWire(screen: Point, additive: boolean): void {
    const scene = this.deps.scene();
    const world = this.deps.toWorld(screen);
    const ids = scene.wiresNear(world, WIRE_REACH / this.deps.scale()).map(w => scene.wireIds[w]!);
    if (ids.length === 0) return;
    const cycle = this.wireCycle;
    const again =
      cycle !== null &&
      !additive &&
      Math.hypot(screen.x - cycle.screen.x, screen.y - cycle.screen.y) <= CYCLE_REACH &&
      this.selection.size === 1 &&
      this.selection.has(cycle.ids[cycle.at]!) &&
      cycle.ids.length === ids.length &&
      cycle.ids.every((id, i) => id === ids[i]);
    const at = again ? (cycle.at + 1) % ids.length : 0;
    this.wireCycle = { screen, ids, at };
    this.select([ids[at]!], additive);
  }

  /** Tab, while a wire picked from several is selected: the next of them. Returns whether it did. */
  private nextOverlappingWire(): boolean {
    const cycle = this.wireCycle;
    if (cycle === null || cycle.ids.length < 2 || this.selection.size !== 1 || !this.selection.has(cycle.ids[cycle.at]!)) return false;
    this.wireCycle = { ...cycle, at: (cycle.at + 1) % cycle.ids.length };
    this.select([this.wireCycle.ids[this.wireCycle.at]!], false);
    this.deps.changed();
    return true;
  }

  /** A click on a component: a switch toggles, a chip clicked twice opens, a ROM clicked twice opens its program, anything else is selected. */
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
    if (twice && c !== undefined && scene.kindOf(c) === 'rom' && !additive) {
      this.lastClick = null;
      this.deps.send.openProgram(id);
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

  deleteSelection(): void {
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
  copy(): void {
    const ids = this.selectedComponents();
    if (ids.length > 0) this.deps.send.copy(ids);
  }

  /**
   * Duplicate, likewise, is copied by the application worker, under ids
   * picked here so the copies can be selected the moment they are asked
   * for: each selected part, and each wire between two of them.
   */
  duplicate(): void {
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
    // On a bus, a probe as wide as the bus, to show its value in hex.
    const width = w < 0 ? 1 : scene.wireWidth[w]!;
    this.deps.send.place('probe', at.x, at.y, id, undefined, undefined, width > 1 ? width : undefined);
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

/** Characters a line of a tooltip's note holds before it wraps. */
const NOTE_CHARS = 44;

/** Text broken into lines of at most `chars`, at spaces; a word longer than a line is a line. */
function wrap(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && line.length + 1 + word.length > chars) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function snap(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function rect(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/** The net a pin is on: a bus pin's first bit's, as a bus wire's is; -1 for none. */
function netOfPin(scene: SceneIndex, c: number, pin: string): number {
  const nets = scene.entries[c]!.nets;
  return nets[pin] ?? nets[`${pin}[0]`] ?? -1;
}

function pinOf(scene: SceneIndex, ref: PinRef): Point {
  const c = scene.indexOf.get(ref.component);
  if (c === undefined) return { x: 0, y: 0 };
  // The part's shape, not its kind: a chip's pins are its definition's,
  // and the kind's placeholder has none — which put every chip pin's
  // ring, and every wire drawn to or from one, at the chip's corner.
  return pinAt(scene.shapeOf(c), scene.x[c]!, scene.y[c]!, ref.pin, scene.rotationOf(c));
}

