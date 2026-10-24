/**
 * Two to five servers next to each other: the rows, the cheapest, the most expensive and the spread,
 * and the same comparison as JSON, a Markdown table or CSV. Shared by the stdio server and the board's
 * MCP server; the rows come from the board's data in both cases.
 */

export const COMPARE_FORMATS = ['json', 'markdown', 'csv'] as const;
export type CompareFormat = (typeof COMPARE_FORMATS)[number];

export interface CompareRow {
  /** The registry name, or what the caller gave when the board does not know it. */
  name: string;
  host?: string | null;
  /** The probe status; "unknown" when the board has no such server. */
  status: string;
  statusLabel?: string | null;
  /** oauth-dcr, oauth, token, unknown; only for a server that needs auth. */
  authKind?: string | null;
  toolCount?: number | null;
  /** Exact count from the Anthropic count_tokens endpoint. */
  claudeTokens?: number | null;
  /** o200k_base estimate. */
  toolsTokens?: number | null;
  /** The number to compare by: the exact count when it exists, else the estimate. */
  tokens?: number | null;
  /** Whether `tokens` is the exact count. */
  exact: boolean;
  shareOf200k?: number | null;
  initMs?: number | null;
  protocolVersion?: string | null;
  probedAt?: string | null;
  /** The server's page on the board. */
  page?: string | null;
  /** Why there is no row, for example "not on the board". */
  error?: string | null;
}

export interface Comparison {
  servers: CompareRow[];
  /** How many rows have a token number. */
  measured: number;
  /** The name with the fewest tokens, when two or more rows are measured. */
  cheapest: string | null;
  mostExpensive: string | null;
  /** Tokens between the most expensive and the cheapest. */
  tokenSpread: number | null;
  format: CompareFormat;
}

/** A row from the board's JSON for one server (`/api/s/<name>.json` or `/api/check.json`). */
export function rowFromBoard(j: Record<string, unknown>, fallbackName: string): CompareRow {
  const num = (k: string) => (typeof j[k] === 'number' ? (j[k] as number) : null);
  const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : null);
  const claude = num('claudeTokens');
  const estimate = num('toolsTokens') ?? num('toolsTokensEstimate');
  const latency = j.latencyMs && typeof j.latencyMs === 'object' ? (j.latencyMs as { initialize?: number | null }) : undefined;
  const tokens = claude ?? estimate;
  return {
    name: str('name') ?? fallbackName,
    host: str('host') ?? (str('url') ? safeHost(str('url')!) : null),
    status: str('status') ?? 'unknown',
    statusLabel: str('statusLabel'),
    authKind: str('authKind'),
    toolCount: num('toolCount'),
    claudeTokens: claude,
    toolsTokens: estimate,
    tokens,
    exact: claude != null,
    shareOf200k: num('shareOf200k') ?? (tokens != null ? Number(((tokens / 200_000) * 100).toFixed(2)) : null),
    initMs: latency?.initialize ?? null,
    protocolVersion: str('protocolVersion'),
    probedAt: str('probedAt'),
    page: str('page')
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The row for a server the board does not know. The comparison goes on without it. */
export function unknownRow(name: string, why = 'not on the board'): CompareRow {
  return { name, status: 'unknown', exact: false, tokens: null, error: why };
}

export function compare(servers: CompareRow[], format: CompareFormat = 'json'): Comparison {
  const measured = servers.filter((r) => r.tokens != null) as Array<CompareRow & { tokens: number }>;
  const sorted = [...measured].sort((a, b) => a.tokens - b.tokens);
  const enough = sorted.length >= 2;
  return {
    servers,
    measured: measured.length,
    cheapest: enough ? sorted[0].name : null,
    mostExpensive: enough ? sorted[sorted.length - 1].name : null,
    tokenSpread: enough ? sorted[sorted.length - 1].tokens - sorted[0].tokens : null,
    format
  };
}

const COLUMNS: Array<[string, (r: CompareRow) => string]> = [
  ['server', (r) => r.name],
  ['status', (r) => r.statusLabel ?? r.status],
  ['access', (r) => r.authKind ?? ''],
  ['tools', (r) => (r.toolCount == null ? '' : String(r.toolCount))],
  ['tokens', (r) => (r.tokens == null ? '' : `${r.exact ? '' : '≈ '}${r.tokens}`)],
  ['of 200k', (r) => (r.shareOf200k == null ? '' : `${r.shareOf200k} %`)],
  ['initialize ms', (r) => (r.initMs == null ? '' : String(r.initMs))],
  ['protocol', (r) => r.protocolVersion ?? ''],
  ['probed', (r) => (r.probedAt ?? '').slice(0, 10)]
];

/** The comparison as text: JSON by default, a Markdown table, or CSV for a spreadsheet. */
export function formatComparison(c: Comparison): string {
  if (c.format === 'json') return JSON.stringify(c, null, 2);
  const summary = c.cheapest
    ? `Cheapest: ${c.cheapest}. Most expensive: ${c.mostExpensive}. Spread: ${c.tokenSpread} tokens. "≈" marks an o200k_base estimate; the others are exact Claude counts.`
    : `${c.measured} of ${c.servers.length} servers have a token number; the spread needs two.`;
  if (c.format === 'csv') {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [COLUMNS.map(([h]) => h).join(',')];
    for (const r of c.servers) lines.push(COLUMNS.map(([, f]) => esc(f(r))).join(','));
    return lines.join('\n') + '\n';
  }
  const cell = (v: string) => v.replace(/\|/g, '\\|');
  const lines = [`| ${COLUMNS.map(([h]) => h).join(' | ')} |`, `|${COLUMNS.map(([h]) => (['tools', 'tokens', 'of 200k', 'initialize ms'].includes(h) ? '---:' : '---')).join('|')}|`];
  for (const r of c.servers) lines.push(`| ${COLUMNS.map(([, f]) => cell(f(r))).join(' | ')} |`);
  return `${lines.join('\n')}\n\n${summary}\n`;
}
