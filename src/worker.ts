/**
 * The render worker: everything the person sees.
 *
 * A component cannot cross `postMessage`, so the root is named here
 * rather than passed in from `main.ts`. That one constraint is the
 * only reason this file exists, and it is why every Gesso application
 * has three files rather than two.
 */
import { renderRoot } from 'gesso-framework';
import { App } from './App';

renderRoot(App);
