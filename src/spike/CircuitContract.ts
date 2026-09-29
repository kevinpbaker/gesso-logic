import { channel } from 'gesso-framework';

import { CHUNK } from './Scene';

/**
 * The barrier for the Phase 0 spike.
 *
 * Throwaway and much narrower than Phase 2's `CircuitContract`: no
 * document, no geometry, no edits. It carries the one thing that
 * changes every frame — which nets are high — for whatever the render
 * worker says is on screen, and it declares every wire shape the spike
 * compares, because choosing one is what the spike is for.
 */

/**
 * How a snapshot of signal values is laid out for the differ.
 *
 *  - `hex` and `base64` pack 256 nets into one string per chunk, keyed
 *    by chunk id. The differ sees a few dozen string leaves, and a chunk
 *    that did not change is structurally equal and sends nothing.
 *  - `record` is the obvious shape, `Record<netId, 0 | 1>`, one leaf
 *    per visible net: what a first version would write, and the thing
 *    the packed shapes have to beat.
 */
export type WireShape = 'hex' | 'base64' | 'record';

export interface Signals {
  readonly shape: WireShape;
  /** The application worker's step counter; a new value means a new snapshot. */
  readonly tick: number;
  /**
   * When the snapshot was built, as `timeOrigin + now()`, so the render
   * worker can say how old the values it is drawing are. The two
   * workers' clocks share an origin to within a millisecond, which is
   * as close as this needs.
   */
  readonly sentAt: number;
  /** `hex` / `base64`: chunk id → the chunk's 256 bits. */
  readonly chunks: Readonly<Record<string, string>>;
  /** `record`: net id → value. */
  readonly nets: Readonly<Record<string, 0 | 1>>;
}

/**
 * What the application thread did, for the readout.
 *
 * A separate view key from `signals` so that publishing it does not
 * appear in the patch count it reports.
 */
export interface WireStats {
  readonly publishes: number;
  /** Cumulative patches and serialized bytes for `signals`. */
  readonly patches: number;
  readonly bytes: number;
  readonly lastPatches: number;
  readonly lastBytes: number;
  readonly lastChunks: number;
  readonly lastNets: number;
  /** Milliseconds building the last snapshot, and running the differ over it. */
  readonly buildMs: number;
  readonly diffMs: number;
  readonly shape: WireShape;
  readonly activity: number;
  readonly hz: number;
}

export interface CircuitCommands {
  /** The world rectangle on screen, sent when it changes. */
  setViewport(left: number, top: number, right: number, bottom: number): void;
  setShape(shape: WireShape): void;
  /** The share of nets flipped per step, 0..1. */
  setActivity(fraction: number): void;
  /** Steps per second; each step publishes. */
  setRate(hz: number): void;
}

export interface CircuitView {
  readonly signals: Signals;
  readonly stats: WireStats;
}

export const EMPTY_SIGNALS: Signals = { shape: 'hex', tick: 0, sentAt: 0, chunks: {}, nets: {} };

export const Circuit = channel<CircuitView, CircuitCommands>('circuit', {
  signals: EMPTY_SIGNALS,
  stats: {
    publishes: 0,
    patches: 0,
    bytes: 0,
    lastPatches: 0,
    lastBytes: 0,
    lastChunks: 0,
    lastNets: 0,
    buildMs: 0,
    diffMs: 0,
    shape: 'hex',
    activity: 0,
    hz: 0
  }
});

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Character code → the bits it carries, for both alphabets. -1 for a character in neither. */
const HEX_VALUE = new Int8Array(128).fill(-1);
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < HEX.length; i++) HEX_VALUE[HEX.charCodeAt(i)] = i;
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i;

/**
 * One chunk's 256 values as a string: net `first + i` is bit `i % k` of
 * character `i / k`, with k = 4 for hex and 6 for base64.
 */
export function packChunk(values: Uint8Array, first: number, shape: 'hex' | 'base64'): string {
  const bits = shape === 'hex' ? 4 : 6;
  const alphabet = shape === 'hex' ? HEX : BASE64;
  let text = '';
  for (let i = 0; i < CHUNK; i += bits) {
    let digit = 0;
    for (let j = 0; j < bits && i + j < CHUNK; j++) {
      digit |= values[first + i + j] << j;
    }
    text += alphabet[digit];
  }
  return text;
}

/** A net's value in a snapshot: 0, 1, or -1 when the snapshot does not cover it. */
export function signalOf(signals: Signals, net: number): -1 | 0 | 1 {
  if (signals.shape === 'record') {
    const value = signals.nets[net];
    return value === undefined ? -1 : value;
  }
  const chunk = signals.chunks[Math.floor(net / CHUNK)];
  if (chunk === undefined) {
    return -1;
  }
  const local = net % CHUNK;
  if (signals.shape === 'hex') {
    return ((HEX_VALUE[chunk.charCodeAt(local >> 2)] >> (local & 3)) & 1) as 0 | 1;
  }
  const at = Math.floor(local / 6);
  return ((BASE64_VALUE[chunk.charCodeAt(at)] >> (local - at * 6)) & 1) as 0 | 1;
}
