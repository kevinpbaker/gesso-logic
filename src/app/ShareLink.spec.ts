import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { writeCircuit } from '../sim/CircuitFile';
import { computerScene } from './Scenes';
import { circuitOfLink, linkOf } from './ShareLink';

const games = join(dirname(fileURLToPath(import.meta.url)), '../cpu/games');

describe('a circuit as a link', () => {
  const pong = computerScene(Array.from(assemble(readFileSync(join(games, 'pong.asm'), 'utf8')).rom), 18_000);

  it('opens Pong exactly as it was shared, in a link a few thousand characters long', async () => {
    const link = await linkOf(pong);
    expect(link.startsWith('c=')).toBe(true);
    expect(link.length).toBeLessThan(6_000);
    expect(writeCircuit(await circuitOfLink(link))).toBe(writeCircuit(pong));
  }, 60_000);

  it('carries a changed chip whole, and what is traced', async () => {
    const changed = {
      ...pong,
      chips: { ...pong.chips, ALU: { ...pong.chips!['ALU']!, components: pong.chips!['ALU']!.components.map(c => (c.id === 'zero' ? { ...c, x: c.x + 4 } : c)) } },
      traces: [{ path: ['cpu', 'datapath'], pin: { component: 'alu', pin: 'Y' } }]
    };
    const link = await linkOf(changed);
    expect(link.length).toBeGreaterThan((await linkOf(pong)).length);
    const opened = await circuitOfLink(link);
    expect(writeCircuit(opened)).toBe(writeCircuit(changed));
    expect(opened.traces).toEqual(changed.traces);
  }, 60_000);

  it('says why a link does not open: cut off, not a link, or another version’s chip', async () => {
    const link = await linkOf(pong);
    await expect(circuitOfLink(link.slice(0, link.length / 2))).rejects.toThrow(/damaged/);
    await expect(circuitOfLink('x=abc')).rejects.toThrow(/not a gessologic link/);
    // A payload naming a built-in chip with another fingerprint.
    const payload = JSON.stringify({ 'gessologic-link': 1, file: JSON.parse(writeCircuit({ ...pong, chips: {} })), builtins: { CPU: '00000000' } });
    const bytes = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const other = `c=${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    await expect(circuitOfLink(other)).rejects.toThrow(/another version/);
  }, 60_000);
});
