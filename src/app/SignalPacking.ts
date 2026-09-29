/**
 * Net values packed for the wire, and read back.
 *
 * Phase 0 settled the shape: 256 nets to a chunk, each chunk a hex
 * string, keyed by chunk id. The differ then sees a few dozen string
 * leaves instead of thousands of numbers, and a chunk whose nets did
 * not change is structurally equal and sends nothing. It measured 51
 * patches and 6.7 KiB a publish with ten thousand nets on screen.
 *
 * Plain functions with no imports, because both workers need them: the
 * application worker packs, the render worker reads.
 */

export const CHUNK = 256;

const HEX = '0123456789abcdef';
/** Character code → the four bits it carries; -1 for anything else. */
const NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i < HEX.length; i++) {
  NIBBLE[HEX.charCodeAt(i)] = i;
}

/**
 * The chunk holding nets `chunk * 256` onward, as 64 hex digits: net
 * `first + i` is bit `i % 4` of digit `i / 4`. Nets past `values.length`
 * read 0.
 */
export function packChunk(values: Uint8Array, chunk: number): string {
  const first = chunk * CHUNK;
  let text = '';
  for (let i = 0; i < CHUNK; i += 4) {
    const at = first + i;
    text += HEX[(values[at] ?? 0) | ((values[at + 1] ?? 0) << 1) | ((values[at + 2] ?? 0) << 2) | ((values[at + 3] ?? 0) << 3)];
  }
  return text;
}

/** A net's value, or -1 when no chunk holding it has arrived. */
export function signalOf(chunks: Readonly<Record<string, string>>, net: number): -1 | 0 | 1 {
  const chunk = chunks[Math.floor(net / CHUNK)];
  if (chunk === undefined) {
    return -1;
  }
  const local = net % CHUNK;
  return ((NIBBLE[chunk.charCodeAt(local >> 2)] >> (local & 3)) & 1) as 0 | 1;
}
