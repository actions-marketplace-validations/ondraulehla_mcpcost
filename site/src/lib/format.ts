import { GATED_STATUSES } from '../../../packages/mcpcost/src/types.ts';

export const STATUS_LABEL: Record<string, string> = {
  ok: 'alive',
  auth: 'needs auth',
  payment: 'paid (402)',
  not_found: 'not found',
  rate_limited: 'rate limited',
  server_error: 'server error',
  protocol_error: 'not MCP',
  newer_protocol: 'newer protocol',
  unsupported_version: 'rejects our protocol version',
  needs_url: 'needs your URL',
  unprobed: 'not probed',
  timeout: 'timeout',
  dns: 'no DNS',
  tls: 'TLS error',
  refused: 'refused',
  error: 'error',
  install_failed: 'install failed',
  no_bin: 'no executable',
  needs_env: 'needs env',
  needs_args: 'needs args',
  needs_network: 'needs network',
  needs_old_sdk: 'needs mcp<2',
  crashed: 'crashed on start'
};

/** How a client gets into a server that needs auth, in the words the server page and the statistics use. */
export const AUTH_KIND_LABEL: Record<string, string> = {
  'oauth-dcr': 'OAuth, clients register themselves',
  oauth: 'OAuth, the publisher issues the client id',
  token: 'a key or token from the publisher',
  unknown: 'no WWW-Authenticate header, no OAuth metadata'
};

export function authKindLabel(kind: string | null | undefined): string {
  return AUTH_KIND_LABEL[kind ?? 'unknown'] ?? kind ?? 'unknown';
}

export type Bucket = 'up' | 'gated' | 'noanswer' | 'down' | 'unprobed';

/**
 * The bucket of a result, for colours and filters. With the row's failing_since (null or a date) a failing server is
 * down only when its down_since is set, which the probe sets after two days of failed probes (isConfirmedDown), and
 * "no answer" before that. Without failing_since (a history row, a live check) every failing result is down, as one
 * probe can say nothing more.
 */
export function bucket(status: string, failingSince?: string | null, downSince?: string | null): Bucket {
  if (status === 'ok') return 'up';
  if (status === 'unprobed') return 'unprobed';
  if (GATED_STATUSES.has(status)) return 'gated';
  if (failingSince === undefined) return 'down';
  return downSince ? 'down' : 'noanswer';
}

export function label(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * n.toLocaleString('en-US') with `separator` in place of the commas. toLocaleString builds a number format on every
 * call, about 15 µs, and the changes page made 1 400 calls, 60 % of its CPU time; so an integer, nearly every number
 * here, is grouped by hand, to the same text.
 */
export function grouped(n: number, separator: string): string {
  if (Number.isSafeInteger(n) && !Object.is(n, -0)) return (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+$)/g, separator);
  return n.toLocaleString('en-US').replace(/,/g, separator);
}

/** A number with a narrow no-break space between the thousands. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return grouped(n, '\u202f');
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)} %` : '';
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/** Short name of the model behind the exact counts. */
export function modelName(id: string | null | undefined): string {
  if (!id) return 'Claude';
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/** Share of a 200k context window, as text. */
export function windowShare(tokensCount: number | null | undefined, window = 200_000): string {
  if (!tokensCount) return '';
  const share = (tokensCount / window) * 100;
  return share < 0.1 ? '<0.1 %' : `${share.toFixed(1)} %`;
}
