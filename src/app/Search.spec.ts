import { describe, expect, it } from 'vitest';

import { cpu } from './Generators';
import { findParts } from './Search';

describe('finding parts', () => {
  const { chips, ...top } = cpu();
  const document = { ...top, chips };

  it('finds a part at any depth by its name, and says where it is', () => {
    const alu = findParts(document, 'alu').find(p => p.id === 'alu');
    expect(alu).toMatchObject({ path: ['datapath'], name: 'alu', kind: 'chip', chip: 'ALU', where: 'datapath' });
  });

  it('ranks an exact name first, the shallow before the deep', () => {
    const results = findParts(document, 'datapath');
    expect(results[0]).toMatchObject({ id: 'datapath', where: 'top' });
  });

  it('finds a chip by the chip it is an instance of', () => {
    expect(findParts(document, 'control unit').map(p => p.id)).toContain('control');
  });

  it('gives nothing for nothing asked, and no more than it is asked for', () => {
    expect(findParts(document, '  ')).toEqual([]);
    expect(findParts(document, 'a', 5)).toHaveLength(5);
  });
});
