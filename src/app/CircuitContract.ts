import { channel } from 'gesso-framework';

import type { PinRef, Rotation } from '../sim/Circuit';
import type { Fragment } from './DocumentEdits';
import type { Kind } from '../sim/Primitives';

/**
 * The barrier between the application worker, which owns the circuit
 * and runs it, and the render worker, which draws it.
 *
 * Four view keys, split by how often they change, because the differ
 * walks a key every time it is published and a key that changes every
 * frame must not drag one that changes on an edit along with it:
 *
 *   - `document` — a summary: revision, counts, the compile error if
 *     there is one. Changes on an edit.
 *   - `geometry` — where everything is, keyed by id: components, and
 *     wires with the net each is on. Changes on an edit. The render
 *     worker never sees the netlist; it sees this.
 *   - `signals` — which nets are high, packed 256 to a hex string, only
 *     for nets in the viewport. Changes every frame the circuit runs.
 *   - `status` — running or not, the clock rate asked for and achieved,
 *     and any oscillation. Changes a few times a second while running.
 *
 * Keyed maps rather than arrays, because Phase 0 measured an array-shaped
 * view at 80× the bytes of a keyed one: a change near the front shifts
 * every element, and the differ re-sends them all.
 */

export interface DocumentSummary {
  /** Bumped on every edit that changed the document. */
  readonly revision: number;
  /**
   * Bumped when a document is opened — a scene loaded, and from Phase 6 a
   * file — and not by edits. The canvas frames the view on this, and
   * only this: framing on the first component placed fitted one switch
   * to the window.
   */
  readonly opened: number;
  readonly components: number;
  readonly gates: number;
  readonly wires: number;
  readonly nets: number;
  /** Why the document does not compile, or null when it does. While it does not, nothing runs. */
  readonly error: string | null;
  /** Whether there is an edit to undo, or an undone one to redo. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface ComponentGeometry {
  readonly kind: Kind;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly label: string | null;
  /** The net each pin is on, by pin name. Empty while the document does not compile. */
  readonly nets: Readonly<Record<string, number>>;
}

export interface WireGeometry {
  readonly from: PinRef;
  readonly to: PinRef;
  /** The net the wire is on, or -1 while the document does not compile. */
  readonly net: number;
}

export interface Geometry {
  readonly components: Readonly<Record<string, ComponentGeometry>>;
  readonly wires: Readonly<Record<string, WireGeometry>>;
}

export interface Signals {
  /** Clock cycles run, for telling one snapshot from the next. */
  readonly cycle: number;
  /** Chunk id → 64 hex digits; see `SignalPacking.ts`. Only chunks with a visible net are present. */
  readonly chunks: Readonly<Record<string, string>>;
}

export type ClockRate = number | 'max';

/** The documents the application can open by name, until Phase 6 opens files. */
export type SceneName = 'empty' | 'bench';

export interface Status {
  readonly running: boolean;
  /** Clock cycles a second asked for, or `max` for as fast as the machine allows. */
  readonly clockHz: ClockRate;
  /** Clock cycles a second achieved over the last second of running; 0 while paused. */
  readonly achievedHz: number;
  readonly cycles: number;
  /** The nets that were ringing when the circuit last failed to settle, by name; empty when it settles. */
  readonly ringing: readonly string[];
}

/**
 * Every command that creates something takes the id to give it, so the
 * render worker can select what it just made without waiting to be told
 * its name. A command whose id is already taken does nothing.
 *
 * Edits that belong to one gesture — the moves of a single drag — carry
 * the same `gesture` string, and undo takes the whole gesture back at
 * once rather than one pointer event at a time.
 */
export interface CircuitCommands {
  /** Adds a component. With no id, one is made from the kind. */
  place(kind: Kind, x: number, y: number, id?: string, rotation?: Rotation): void;
  /** Joins two pins with a wire. With no id, one is made. */
  connect(from: PinRef, to: PinRef, id?: string): void;
  move(id: string, x: number, y: number): void;
  /** Moves components by an offset: a selection dragged. */
  moveBy(ids: readonly string[], dx: number, dy: number, gesture?: string): void;
  /** Turns components a quarter turn clockwise. */
  rotate(ids: readonly string[]): void;
  /** Removes components and wires; wires left with an end on nothing go too. */
  remove(ids: readonly string[]): void;
  /** Adds components and wires whose ids are already fresh: paste, duplicate. */
  insert(fragment: Fragment): void;
  undo(): void;
  redo(): void;
  /** Replaces the document with a named one, and forgets its history. */
  loadScene(name: SceneName): void;
  /** Drives an input component, as a person flipping a switch does. */
  setInput(id: string, value: 0 | 1): void;
  run(): void;
  pause(): void;
  /** One clock cycle, while paused. */
  step(): void;
  setClockHz(rate: ClockRate): void;
  /** The world rectangle on screen. Until the first one, every net is published. */
  setViewport(left: number, top: number, right: number, bottom: number): void;
}

export interface CircuitView {
  readonly document: DocumentSummary;
  readonly geometry: Geometry;
  readonly signals: Signals;
  readonly status: Status;
}

export const EMPTY_SUMMARY: DocumentSummary = {
  revision: 0,
  opened: 0,
  components: 0,
  gates: 0,
  wires: 0,
  nets: 0,
  error: null,
  canUndo: false,
  canRedo: false
};
export const EMPTY_GEOMETRY: Geometry = { components: {}, wires: {} };
export const EMPTY_SIGNALS: Signals = { cycle: 0, chunks: {} };
export const INITIAL_STATUS: Status = { running: false, clockHz: 'max', achievedHz: 0, cycles: 0, ringing: [] };

export const Circuit = channel<CircuitView, CircuitCommands>('circuit', {
  document: EMPTY_SUMMARY,
  geometry: EMPTY_GEOMETRY,
  signals: EMPTY_SIGNALS,
  status: INITIAL_STATUS
});
