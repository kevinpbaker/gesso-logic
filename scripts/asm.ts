/**
 * Assembles a program into a ROM image.
 *
 *   pnpm asm src/cpu/programs/flags.asm            → flags.hex beside it
 *   pnpm asm src/cpu/programs/flags.asm out.hex
 *
 * Errors are printed with their line numbers and the exit code is 1.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { assemble, AssemblyError, romImage } from '../src/cpu/Assembler.ts';

const [input, output = input?.replace(/\.asm$/, '') + '.hex'] = process.argv.slice(2);
if (input === undefined) {
  console.error('usage: pnpm asm <program.asm> [image.hex]');
  process.exit(2);
}
try {
  const { rom, size } = assemble(readFileSync(input, 'utf8'));
  writeFileSync(output, romImage(rom));
  console.log(`${input}: ${size} words → ${output}`);
} catch (error) {
  if (!(error instanceof AssemblyError)) throw error;
  for (const problem of error.problems) console.error(`${input}:${problem.line}: ${problem.message}`);
  process.exit(1);
}
