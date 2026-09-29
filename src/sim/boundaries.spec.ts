import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The seam, as a spec rather than as a promise in a comment.
 *
 * Copied from gessosheet, where the same rule held the sheet model.
 * The roadmap decided up front that the simulator imports nothing from
 * the framework: plain TypeScript, no RxJS, no browser. That is what
 * lets these specs run in node in milliseconds, and it is what will let
 * Phase 2 put the simulator behind a channel without the simulator
 * noticing.
 *
 * It is also the kind of rule that decays silently. One `import type`
 * for convenience is harmless, and the one after it drags a runtime
 * import in behind it, and by then the simulator only runs in a worker and
 * nobody can say which change did it. So it is checked: a dependency
 * that is not a relative path inside this directory fails the build,
 * with the file and the import named.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const IMPORT = /^\s*import\b[^'"]*['"]([^'"]+)['"]/gm;
const EXPORT_FROM = /^\s*export\b[^'"]*from\s*['"]([^'"]+)['"]/gm;

/** node: builtins, for the one spec that reads the source. */
const ALLOWED_BARE = new Set(['vitest', 'node:fs', 'node:path', 'node:url']);

function sources(): string[] {
  return readdirSync(HERE).filter(name => name.endsWith('.ts'));
}

function importsOf(file: string): string[] {
  const text = readFileSync(join(HERE, file), 'utf8');
  const found: string[] = [];
  for (const pattern of [IMPORT, EXPORT_FROM]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.push(match[1]);
    }
  }
  return found;
}

describe('the simulator has no dependencies', () => {
  it('has files to check', () => {
    // A guard against the check passing because it found nothing.
    expect(sources().length).toBeGreaterThan(6);
  });

  it('imports nothing but its own siblings', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const isSpec = file.endsWith('.spec.ts');
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('./')) {
          continue;
        }
        if (isSpec && ALLOWED_BARE.has(specifier)) {
          continue;
        }
        offenders.push(`${file} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names the framework nowhere, not even in a type position', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      // This file has to name them in order to look for them, and
      // caught itself on the first run.
      if (file === 'boundaries.spec.ts') {
        continue;
      }
      const text = readFileSync(join(HERE, file), 'utf8');
      for (const banned of ['gesso-core', 'gesso-framework', 'gesso-components', 'rxjs']) {
        if (text.includes(`'${banned}`) || text.includes(`"${banned}`)) {
          offenders.push(`${file} mentions ${banned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
