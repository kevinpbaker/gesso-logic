/**
 * Lets Node run `src/` directly: a relative import with no extension,
 * as the bundler writes them, is tried again with `.ts`. Node strips
 * the types itself; this only finds the file.
 *
 *   node --import ./scripts/lib/extensionless.mjs scripts/speed.ts
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
});
