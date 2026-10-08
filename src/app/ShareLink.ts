import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { circuitFrom, CircuitFileError, writeCircuit } from '../sim/CircuitFile';
import { libraryChips } from './LibraryParts';
import { computerScene } from './Scenes';

/**
 * A circuit as a link: the whole document, in the part of the url after
 * `#c=`, which a browser never sends to a server. Nothing is uploaded,
 * nothing is hosted, and the link works for as long as the app does.
 *
 * Two things keep it short enough to paste anywhere:
 *
 *   - **Built-in chips go by name.** A chip the app makes itself — a
 *     library part, the CPU and everything in it — is written as its
 *     name and a fingerprint of its definition, and made again when the
 *     link is opened. Pong's document is 380 KB as a file and most of
 *     that is the CPU; changed, a chip is no longer built-in, and goes
 *     whole. A fingerprint that does not match the opening app's own
 *     chip — a link made by another version — is refused, rather than
 *     opened as a different circuit.
 *   - **Compressed**, deflate, then base64url.
 *
 * Opening checks the circuit as opening a file does, and refuses a link
 * longer or larger than any real circuit's, so a link cannot be made to
 * hang the page.
 */

/** What comes before a link's circuit in the url: `#c=`. */
export const LINK_PREFIX = 'c=';
/** The longest link text opened: far past any real circuit's, short of one that would hang the page. */
export const MAX_LINK_CHARS = 2_000_000;
/** The most a link's circuit may be once inflated, in bytes. */
export const MAX_LINK_BYTES = 16 * 1024 * 1024;

interface Payload {
  readonly 'gessologic-link': 1;
  /** The circuit file, without the built-in chips. */
  readonly file: unknown;
  /** The built-in chips it uses, by name, each with its definition's fingerprint. */
  readonly builtins: Readonly<Record<string, string>>;
}

/** A chip definition as text, the same for the same definition: what is fingerprinted. */
function definitionText(definition: Circuit): string {
  return writeCircuit({ version: CIRCUIT_VERSION, components: definition.components, wires: definition.wires });
}

/** FNV-1a, 32 bits, in hex: enough to tell one version's chip from another's. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The chips the app makes itself, by name and then by fingerprint: made once, when a link is first made or opened. */
let builtins: Map<string, Map<string, Circuit>> | null = null;
function builtinChips(): Map<string, Map<string, Circuit>> {
  if (builtins !== null) return builtins;
  builtins = new Map();
  const add = (chips: Readonly<Record<string, Circuit>>) => {
    for (const [name, definition] of Object.entries(chips)) {
      const variants = builtins!.get(name) ?? new Map<string, Circuit>();
      variants.set(fingerprint(definitionText(definition)), definition);
      builtins!.set(name, variants);
    }
  };
  add(libraryChips());
  add(computerScene().chips ?? {});
  return builtins;
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, refusing to go past `MAX_LINK_BYTES`. */
async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LINK_BYTES) {
      await reader.cancel();
      throw new CircuitFileError('the link’s circuit is larger than any this app opens');
    }
    parts.push(value as Uint8Array<ArrayBuffer>);
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/** The text after `#` that opens `document`: `c=` and the circuit. */
export async function linkOf(document: Circuit): Promise<string> {
  const file = JSON.parse(writeCircuit(document)) as { chips?: Record<string, unknown> };
  const known = builtinChips();
  const used: Record<string, string> = {};
  for (const [name, definition] of Object.entries(document.chips ?? {})) {
    // A built-in chip given tests of its own is no longer the built-in one.
    if (definition.tests !== undefined) continue;
    const print = fingerprint(definitionText(definition));
    if (known.get(name)?.has(print) !== true) continue;
    used[name] = print;
    delete file.chips![name];
  }
  if (file.chips !== undefined && Object.keys(file.chips).length === 0) delete file.chips;
  const payload: Payload = { 'gessologic-link': 1, file, builtins: used };
  return LINK_PREFIX + toBase64Url(await deflate(JSON.stringify(payload)));
}

/** The circuit a link's text after `#` opens; throws a `CircuitFileError` saying why one does not. */
export async function circuitOfLink(fragment: string): Promise<Circuit> {
  const text = fragment.replace(/^#/, '');
  if (!text.startsWith(LINK_PREFIX)) throw new CircuitFileError('not a gessologic link');
  if (text.length > MAX_LINK_CHARS) throw new CircuitFileError('the link is longer than any this app opens');
  let payload: Payload;
  try {
    payload = JSON.parse(await inflate(fromBase64Url(text.slice(LINK_PREFIX.length)))) as Payload;
  } catch (error) {
    if (error instanceof CircuitFileError) throw error;
    throw new CircuitFileError('the link is damaged: part of it may have been cut off when it was copied');
  }
  if (payload?.['gessologic-link'] !== 1 || typeof payload.file !== 'object' || payload.file === null) {
    throw new CircuitFileError('the link is not one this version of the app can read');
  }
  const file = payload.file as { chips?: Record<string, unknown> };
  const known = builtinChips();
  for (const [name, print] of Object.entries(payload.builtins ?? {})) {
    const definition = known.get(name)?.get(print);
    if (definition === undefined) {
      throw new CircuitFileError(`it was made by another version of the app, whose “${name}” chip is not this one’s`);
    }
    const written = JSON.parse(definitionText(definition)) as { components: unknown; wires: unknown };
    file.chips = { ...file.chips, [name]: { components: written.components, wires: written.wires } };
  }
  return circuitFrom(file);
}
