import { map } from 'rxjs/operators';

import { percent } from 'gesso-core';
import { Switch } from 'gesso-components';
import { internalState, type ComponentContext, type Inputs } from 'gesso-framework';

/**
 * The screen.
 *
 * A Gesso component is a function that runs once. What it returns is a
 * tree of nodes that stays: nothing here re-runs when the count
 * changes, because `text` is bound to an Observable, so one property on
 * one node is written and the next frame is drawn from it.
 *
 * Three things are worth knowing before you change them.
 *
 *   - `internalState(0)` is state this component owns. Writing
 *     `count.value++` marks exactly the bindings that read it, and
 *     nothing else.
 *   - A bound property costs what it touches. `text` is content and
 *     `opacity` is paint, so neither re-runs layout; a bound `width` or
 *     `gap` would.
 *   - No colour here is a hex value. `primary`, `background` and
 *     `textMuted` are names looked up on whichever theme the node
 *     inherits, so this screen follows a theme it never mentions.
 *
 * The elements are lowercase because they are intrinsic, resolved by
 * `jsxImportSource` in `tsconfig.json`, the same way `<div>` needs no
 * import in React. `Switch` is capitalised because it is a component
 * from `gesso-components`, so it is imported like any other value.
 */
export function App(_inputs: Inputs<{}>, _context: ComponentContext) {
  const count = internalState(0);
  const hinted = internalState(true);

  return (
    <column gap={16} x="center" y="center" width={percent(100)} height={percent(100)} backgroundColor="background">
      <text text="Hello from a render worker" fontSize={22} fontWeight="bold" />

      <row gap={12} y="center">
        <text text={count.pipe(map(value => `Clicks: ${value}`))} fontSize={16} />
        <button
          label="Add one"
          onClick={() => count.value++}
          padding={8}
          borderRadius={6}
          backgroundColor="primary"
          cursor="pointer">
          <text text="+1" color="background" fontSize={14} />
        </button>
      </row>

      <text
        text={count.pipe(map(value => (value === 0 ? 'Press the button.' : 'Nothing was rebuilt to do that.')))}
        fontSize={12}
        color="textMuted"
        opacity={hinted.pipe(map(showing => (showing ? 1 : 0)))}
      />

      <Switch label="Show the hint" checked={hinted} onChange={next => (hinted.value = next)} />
    </column>
  );
}
