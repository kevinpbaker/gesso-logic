import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from './Assembler';
import { Emulator } from './Emulator';

/**
 * The test program suite: every `programs/*.asm`, assembled and run on
 * the emulator until it halts, then held to what its comments say.
 *
 *   `;< in0=0x0A in1=1`   what each input port reads
 *   `;! A=6 X=3 Z=1`      registers and flags at the halt
 *   `;! [0x40]=0xFF`      a byte of RAM
 *   `;! out0=3`           the last value written to an output port
 *   `;! log=1,2,3`        every value written to port 3, in order
 *
 * Port 3 is the suite's: the hardware has nothing on it, so a program
 * logs its checkpoints there. Phase 18 runs these same programs on the
 * gate-level CPU in lockstep with the emulator.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAMS = join(HERE, 'programs');

const number = (text: string) => Number(text.startsWith('0x') || text.startsWith('0X') ? Number.parseInt(text.slice(2), 16) : text);

function directives(source: string, marker: string): [string, string][] {
  return source
    .split('\n')
    .filter(line => line.startsWith(marker))
    .flatMap(line => line.slice(marker.length).trim().split(/\s+/))
    .filter(pair => pair !== '')
    .map(pair => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    });
}

describe('the test program suite, on the emulator', () => {
  const files = readdirSync(PROGRAMS).filter(name => name.endsWith('.asm'));

  it('has the programs the roadmap asks for', () => {
    expect(files.sort()).toEqual(['arithmetic.asm', 'branches.asm', 'callret.asm', 'flags.asm', 'indexed.asm', 'io.asm', 'logic.asm']);
  });

  for (const file of files) {
    it(file, () => {
      const source = readFileSync(join(PROGRAMS, file), 'utf8');
      const inputs = new Map(directives(source, ';<').map(([k, v]) => [Number(k.slice(2)), number(v)]));
      const outputs = new Map<number, number>();
      const log: number[] = [];
      const emulator = new Emulator(assemble(source).rom, {
        read: port => inputs.get(port) ?? 0,
        write: (port, value) => (port === 3 ? log.push(value) : outputs.set(port, value))
      });
      emulator.run(100_000);
      const state = emulator.state;
      const expectations = directives(source, ';!');
      expect(expectations.length, 'a program says what it expects').toBeGreaterThan(0);
      for (const [key, text] of expectations) {
        if (key === 'log') {
          expect(log, 'the log').toEqual(text.split(',').map(number));
        } else if (key.startsWith('[')) {
          expect(emulator.ram[number(key.slice(1, -1))], key).toBe(number(text));
        } else if (key.startsWith('out')) {
          expect(outputs.get(Number(key.slice(3))), key).toBe(number(text));
        } else if (key === 'Z' || key === 'C' || key === 'N') {
          expect(state[key.toLowerCase() as 'z' | 'c' | 'n'], key).toBe(text === '1');
        } else {
          expect(state[key.toLowerCase() as 'a' | 'b' | 'x' | 'pc' | 'l'], key).toBe(number(text));
        }
      }
    });
  }
});
