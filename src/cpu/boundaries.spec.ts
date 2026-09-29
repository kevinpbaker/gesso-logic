import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The CPU's tools — the ISA, the emulator, the assembler — are plain
 * TypeScript, as the simulator is: they import only each other, so they
 * run headless under vitest, in the app worker, or in a script.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT = /^\s*(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const ALLOWED_IN_SPECS = new Set(['vitest', 'node:fs', 'node:path', 'node:url']);

describe('the CPU tools have no dependencies', () => {
  it('import nothing but each other', () => {
    const files = readdirSync(HERE).filter(name => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(HERE, file), 'utf8');
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2]!;
        if (specifier.startsWith('./')) continue;
        if (file.endsWith('.spec.ts') && ALLOWED_IN_SPECS.has(specifier)) continue;
        offenders.push(`${file} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
