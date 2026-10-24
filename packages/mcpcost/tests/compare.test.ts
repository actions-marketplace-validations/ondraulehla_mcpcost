import { describe, expect, it } from 'vitest';
import { compare, formatComparison, rowFromBoard, unknownRow } from '../src/compare.js';

const a = rowFromBoard({ name: 'io.github.a/a', host: 'a.example', status: 'ok', statusLabel: 'alive', toolCount: 10, claudeTokens: 4000, toolsTokens: 2100, latencyMs: { initialize: 300 }, protocolVersion: '2025-11-25', probedAt: '2026-10-24T08:00:00Z', page: 'https://mcpcost.ulehla.dev/s/io.github.a/a' }, 'io.github.a/a');
const b = rowFromBoard({ name: 'io.github.b/b', status: 'ok', toolCount: 3, toolsTokens: 900, latencyMs: { initialize: null } }, 'io.github.b/b');
const c = rowFromBoard({ name: 'io.github.c/c', status: 'auth', authKind: 'oauth-dcr', claudeTokens: null, toolsTokens: null }, 'io.github.c/c');

describe('compare_servers', () => {
  it('compares by the exact count when it exists, else the estimate, and skips rows without a number', () => {
    const out = compare([a, b, c, unknownRow('io.github.d/d')]);
    expect(a.exact).toBe(true);
    expect(b.exact).toBe(false);
    expect(b.shareOf200k).toBe(0.45);
    expect(out.measured).toBe(2);
    expect(out.cheapest).toBe('io.github.b/b');
    expect(out.mostExpensive).toBe('io.github.a/a');
    expect(out.tokenSpread).toBe(3100);
    expect(out.servers[3]).toMatchObject({ status: 'unknown', error: 'not on the board' });
  });

  it('needs two measured rows for a spread', () => {
    const out = compare([a, c]);
    expect(out.cheapest).toBeNull();
    expect(out.tokenSpread).toBeNull();
  });

  it('renders a Markdown table with the estimate marked, and CSV with a header row', () => {
    const md = formatComparison(compare([a, b], 'markdown'));
    expect(md).toContain('| server | status | access | tools | tokens |');
    expect(md).toContain('| io.github.a/a | alive |  | 10 | 4000 |');
    expect(md).toContain('| io.github.b/b | ok |  | 3 | ≈ 900 |');
    expect(md).toContain('Cheapest: io.github.b/b. Most expensive: io.github.a/a. Spread: 3100 tokens.');
    const csv = formatComparison(compare([a, b], 'csv'));
    expect(csv.split('\n')[0]).toBe('server,status,access,tools,tokens,of 200k,initialize ms,protocol,probed');
    expect(csv.split('\n')[1]).toBe('io.github.a/a,alive,,10,4000,2 %,300,2025-11-25,2026-10-24');
  });
});
