import { describe, expect, it } from 'vitest';

import { written } from './Waveform';

describe('an analyser row’s value, written', () => {
  it('in hex, decimal, two’s complement or bits, by the bus’s width', () => {
    expect(written(0xfe, 8, 'hex')).toBe('FE');
    expect(written(0xfe, 8, 'dec')).toBe('254');
    expect(written(0xfe, 8, 'signed')).toBe('-2');
    expect(written(0x7f, 8, 'signed')).toBe('127');
    expect(written(5, 4, 'bin')).toBe('0101');
  });
});
