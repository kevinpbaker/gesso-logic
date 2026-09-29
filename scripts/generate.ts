/**
 * Writes the generated parts to `circuits/`: the 128-byte RAM and the
 * register file, as circuit files the editor opens. `Generators.spec.ts`
 * fails when these are stale, so run this after changing a generator.
 *
 *   pnpm generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { generatedFiles } from '../src/app/Generators.ts';
import { writeCircuit } from '../src/sim/CircuitFile.ts';

mkdirSync('circuits', { recursive: true });
for (const [name, circuit] of Object.entries(generatedFiles())) {
  const text = writeCircuit(circuit);
  writeFileSync(`circuits/${name}`, text);
  console.log(`circuits/${name}: ${text.length.toLocaleString('en')} bytes`);
}
