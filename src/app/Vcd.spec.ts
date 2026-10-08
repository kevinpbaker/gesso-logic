import { describe, expect, it } from 'vitest';

import { Analyser } from './Analyser';
import { vcdName, writeVcd } from './Vcd';

describe('waveforms as VCD', () => {
  it('writes each trace once, then only what changed, cycle by cycle', () => {
    const a = new Analyser(64);
    a.configure([
      { id: 'q', name: 'count q', width: 4, nets: [0, 1, 2, 3] },
      { id: 'c', name: 'carry', width: 1, nets: [4] }
    ]);
    for (let cycle = 10; cycle <= 13; cycle++) {
      const count = cycle === 13 ? 2 : cycle - 10;
      a.record(cycle, Uint8Array.from([count & 1, (count >> 1) & 1, 0, 0, cycle === 11 ? 1 : 0]));
    }
    const text = writeVcd(a.dump(), { scope: 'counter' });
    expect(text).toContain('$scope module counter $end');
    expect(text).toContain('$var wire 4 ! count_q [3:0] $end');
    expect(text).toContain('$var wire 1 " carry $end');
    const changes = text.slice(text.indexOf('$enddefinitions $end'));
    expect(changes).toBe(
      ['$enddefinitions $end', '#10', '$dumpvars', 'b0 !', '0"', '$end', '#11', 'b1 !', '1"', '#12', 'b10 !', '0"', '#14', ''].join('\n')
    );
  });

  it('writes a trace added mid-run as unknown before it was recorded', () => {
    const a = new Analyser(64);
    a.configure([{ id: 'a', name: 'a', width: 1, nets: [0] }]);
    a.record(0, Uint8Array.from([1, 1]));
    a.configure([
      { id: 'a', name: 'a', width: 1, nets: [0] },
      { id: 'b', name: 'cpu › alu.Y', width: 1, nets: [1] }
    ]);
    a.record(1, Uint8Array.from([1, 1]));
    const text = writeVcd(a.dump());
    expect(text).toContain('$var wire 1 " cpu.alu.Y $end');
    expect(text).toContain('#0\n$dumpvars\n1!\nx"\n$end\n#1\n1"\n#2');
  });

  it('makes names a reader takes, and tells two of the same name apart', () => {
    expect(vcdName('  a b\tc ')).toBe('a_b_c');
    expect(vcdName('')).toBe('signal');
    const text = writeVcd({ traces: [{ name: 'x', width: 1 }, { name: 'x', width: 1 }], first: 0, last: 0, valueAt: () => 0 });
    expect(text).toContain(' x $end');
    expect(text).toContain(' x_2 $end');
  });
});
