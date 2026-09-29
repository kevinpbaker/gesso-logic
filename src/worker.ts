/**
 * The render worker: everything the person sees.
 *
 * A component cannot cross `postMessage`, so the root is named here
 * rather than passed in from `main.ts`. `useChannel(Circuit)` binds the
 * application worker's circuit channel, which `App` reads.
 */
import { renderRoot } from 'gesso-framework';
import { App } from './App';
import { Circuit } from './app/CircuitContract';

renderRoot(App).useChannel(Circuit);
