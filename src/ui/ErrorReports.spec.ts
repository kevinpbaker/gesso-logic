import { describe, expect, it } from 'vitest';

import { readReport } from '../../api/errors';
import { MAX_REPORT_TEXT, reportBody } from '../ErrorReports';

describe('error reports', () => {
  it('send the error and where, trimmed, and never the circuit after #', () => {
    const body = JSON.parse(reportBody({ thread: 'app', kind: 'uncaught', message: 'x'.repeat(9000), stack: 'at f' }, '/', 'abc1234')) as Record<string, string>;
    expect(body).toMatchObject({ thread: 'app', kind: 'uncaught', stack: 'at f', path: '/', build: 'abc1234' });
    expect(body.message).toHaveLength(MAX_REPORT_TEXT);
  });

  it('are taken by the function only in the shape the page sends', () => {
    const at = new Date('2026-10-09T00:00:00Z');
    expect(readReport({ thread: 'render', kind: 'frame', message: 'boom', path: '/', build: 'abc', agent: 'Chrome' }, at)).toEqual({
      at: '2026-10-09T00:00:00.000Z',
      thread: 'render',
      kind: 'frame',
      message: 'boom',
      path: '/',
      build: 'abc',
      agent: 'Chrome'
    });
    expect(readReport({ thread: 'elsewhere', kind: 'x', message: 'boom' }, at)).toBeNull();
    expect(readReport({ thread: 'page', kind: 'x', message: '' }, at)).toBeNull();
    expect(readReport('boom', at)).toBeNull();
  });
});
