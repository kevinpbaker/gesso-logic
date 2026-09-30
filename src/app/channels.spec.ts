import { afterEach, describe, expect, it } from 'vitest';

import { serveForTest, type ServedForTest } from 'gesso-testing';

import { Circuit } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { circuitChannels } from './channels';
import { signalOf } from './SignalPacking';
import { entriesOf, entryOf } from './CircuitContract';

/**
 * Phase 2's exit: the circuit channel driven from the render worker's
 * side, with no browser.
 *
 * `serveForTest` serves `circuitChannels` — the function `AppWorker.ts`
 * serves — over a real patch stream, and hands back the replica a screen
 * would bind to. So every command below crosses the barrier as a
 * command, every answer comes back as a patch, and the spec reads what
 * the canvas will read: geometry for where a pin's net is, signals for
 * whether it is high.
 */
describe('the circuit channel', () => {
  let served: ServedForTest;

  afterEach(() => served.dispose());

  it('places two switches and an AND gate, wires them, and lights the output only when both are on', async () => {
    served = serveForTest(circuitChannels(new CircuitService()));
    const circuit = served.get(Circuit);

    circuit.send.place('input', 0, 0, 'left');
    circuit.send.place('input', 0, 4, 'right');
    circuit.send.place('and', 4, 2, 'gate');
    circuit.send.place('output', 8, 2, 'led');
    circuit.send.connect({ component: 'left', pin: 'out' }, { component: 'gate', pin: 'a' });
    circuit.send.connect({ component: 'right', pin: 'out' }, { component: 'gate', pin: 'b' });
    circuit.send.connect({ component: 'gate', pin: 'out' }, { component: 'led', pin: 'in' });
    await served.settle(() => circuit.view.document.value.revision === 7);

    expect(circuit.view.document.value).toEqual({
      revision: 7,
      opened: 0,
      components: 4,
      gates: 1,
      wires: 3,
      nets: 3,
      error: null,
      canUndo: true,
      canRedo: false,
      name: null,
      handle: null,
      dirty: true,
      camera: null,
      message: null,
      path: [],
      welcome: false,
      changedChips: [],
      chips: [],
      library: expect.any(Array)
    });
    const led = () => {
      const net = entryOf(circuit.view.geometry.value.components, "led")?.nets.in;
      return net === undefined ? -1 : signalOf(circuit.view.signals.value.chunks, net);
    };
    expect(led()).toBe(0);

    circuit.send.setInput('left', 1);
    await served.settle();
    expect(led(), 'one switch on').toBe(0);

    circuit.send.setInput('right', 1);
    await served.settle(() => led() === 1);
    expect(led(), 'both switches on').toBe(1);

    circuit.send.setInput('left', 0);
    await served.settle(() => led() === 0);
    expect(led(), 'one switch off again').toBe(0);
    expect(served.errors).toEqual([]);
  });

  it('says why a document does not compile, and publishes no signals for it', async () => {
    served = serveForTest(circuitChannels(new CircuitService()));
    const circuit = served.get(Circuit);

    circuit.send.place('input', 0, 0, 'x');
    circuit.send.place('input', 0, 4, 'y');
    circuit.send.place('output', 4, 2, 'led');
    circuit.send.connect({ component: 'x', pin: 'out' }, { component: 'led', pin: 'in' });
    circuit.send.connect({ component: 'y', pin: 'out' }, { component: 'led', pin: 'in' });
    await served.settle(() => circuit.view.document.value.revision === 5);

    expect(circuit.view.document.value.error).toBe('x.out and y.out both drive the same net.');
    expect(circuit.view.signals.value.chunks).toEqual({});
    // The document is kept — someone is halfway through drawing it — and
    // drawn, with no net on any wire until it compiles.
    expect(entriesOf(circuit.view.geometry.value.wires).map(([, entry]) => entry).map(wire => wire.net)).toEqual([-1, -1]);
  });

  it('steps the clock and runs it, reporting cycles in status', async () => {
    served = serveForTest(circuitChannels(new CircuitService()));
    const circuit = served.get(Circuit);
    circuit.send.place('clock', 0, 0, 'clk');
    circuit.send.place('output', 4, 0, 'led');
    circuit.send.connect({ component: 'clk', pin: 'out' }, { component: 'led', pin: 'in' });
    await served.settle(() => circuit.view.document.value.revision === 3);

    circuit.send.step();
    circuit.send.step();
    await served.settle(() => circuit.view.status.value.cycles === 2);

    circuit.send.run();
    await served.settle(() => circuit.view.status.value.running && circuit.view.status.value.cycles > 50);
    circuit.send.pause();
    await served.settle(() => !circuit.view.status.value.running);
    expect(circuit.view.status.value.cycles).toBeGreaterThan(50);
  });
});
