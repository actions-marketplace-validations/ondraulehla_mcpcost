/**
 * The rows of the open dataset and of the re-check evidence, built from one row of servers.json, and the rule for
 * how long a server fails before it counts as down. No side effects, so the tests can import it; probe/dataset.ts
 * and probe/build-data.ts use it.
 */
import { isConfirmedDown, isFailing } from '../packages/mcpcost/src/index.js';
import type { ServerRow } from './build-data.js';

/** The columns, with the words the page and the JSON API use for them. Null when the probe did not record the value. */
export const DATASET_FIELDS: Record<string, string> = {
  name: 'the registry name; the server page is https://mcpcost.ulehla.dev/s/<name>',
  version: 'the version of the registry entry that was probed (the latest one)',
  host: 'the host of the remote endpoint; npmjs.com or pypi.org for a package server',
  transport: 'streamable-http, sse or stdio',
  status: 'the probe result: ok, auth, payment, newer_protocol, needs_url, not_found, protocol_error, dns, tls, timeout, refused, server_error, rate_limited, error; for a package: crashed, install_failed, no_bin, needs_env, needs_args, needs_network. needs_url: every URL of the entry has a placeholder that each user fills in, so the probe did not call it',
  failing_since: 'for a server with no valid answer: the first probe of the current run of failed probes (ISO 8601). The board calls a server down after two days of them; one failed probe is "no answer"',
  http_status: 'the HTTP status of the first response, when there was one',
  auth_scheme: 'the WWW-Authenticate scheme of a server that needs auth',
  auth_kind: 'how a client gets into a server that needs auth: oauth-dcr, oauth, token or unknown',
  protocol_version: 'the protocol version the server negotiated',
  tool_count: 'the number of tools in tools/list',
  tools_tokens: 'estimate: o200k_base over the compact JSON of the tool definitions',
  claude_tokens: 'exact: the Anthropic count_tokens endpoint, claude-opus-5-5, tool names as published',
  claude_tokens_cc: 'exact: the same with the Claude Code prefix mcp__<server>__ on each tool name',
  probed_at: 'when this run probed the server (ISO 8601); a package server keeps the time of its last container run'
};

export interface DatasetRow {
  name: string;
  version: string | null;
  host: string;
  transport: string;
  status: string;
  failing_since: string | null;
  http_status: number | null;
  auth_scheme: string | null;
  auth_kind: string | null;
  protocol_version: string | null;
  tool_count: number | null;
  tools_tokens: number | null;
  claude_tokens: number | null;
  claude_tokens_cc: number | null;
  probed_at: string;
}

export function datasetRow(s: ServerRow): DatasetRow {
  return {
    name: s.name,
    version: s.version ?? null,
    host: s.host,
    transport: s.transport,
    status: s.status,
    failing_since: s.failingSince ?? null,
    http_status: s.httpStatus ?? null,
    auth_scheme: s.authScheme ?? null,
    auth_kind: s.authKind ?? null,
    protocol_version: s.protocolVersion ?? null,
    tool_count: s.toolCount ?? null,
    tools_tokens: s.toolsTokens ?? null,
    claude_tokens: s.claudeTokens ?? null,
    claude_tokens_cc: s.claudeTokensCc ?? null,
    probed_at: s.probedAt
  };
}

/**
 * The five states the registry thread settled on. A probe status maps to one of them by what it says about
 * the entry, not about today's network: a 429 or a 5xx is transient, a 404 or no DNS is dead, 401/402/403 is
 * auth (reachable, not open). A package that needs values or a network to start is unknown, not dead, and so is
 * a URL with placeholders that each user fills in. A dead status counts only after two days of failed probes
 * (isConfirmedDown); before that the row is transient, because one failed probe can be the probe's own network.
 */
export type EvidenceState = 'alive' | 'auth' | 'transient' | 'dead' | 'unknown';
export const EVIDENCE_STATE: Record<string, EvidenceState> = {
  ok: 'alive',
  newer_protocol: 'alive',
  auth: 'auth',
  payment: 'auth',
  timeout: 'transient',
  rate_limited: 'transient',
  server_error: 'transient',
  refused: 'transient',
  dns: 'dead',
  tls: 'dead',
  not_found: 'dead',
  protocol_error: 'dead',
  install_failed: 'dead',
  no_bin: 'dead',
  crashed: 'unknown',
  needs_env: 'unknown',
  needs_args: 'unknown',
  needs_network: 'unknown',
  needs_url: 'unknown',
  error: 'unknown'
};

export interface EvidenceRow {
  /** The registry name. */
  entry: string;
  /** The version of the entry that was checked (the latest one). */
  version?: string;
  /** When the check ran, ISO 8601. */
  checked_at: string;
  /** What was checked: the remote endpoint, or the npm or PyPI package started in a container. */
  check: 'endpoint' | 'package';
  state: EvidenceState;
  /** What the check saw: the probe status by cause and the facts behind it. */
  evidence: {
    status: string;
    target: string;
    http_status?: number;
    auth_scheme?: string;
    auth_kind?: string;
    protocol_version?: string;
    tool_count?: number;
    /** For a failed check: the first check of the current run of failed checks, ISO 8601. */
    failing_since?: string;
    error?: string;
  };
}

export function evidenceRow(s: ServerRow): EvidenceRow {
  const evidence: EvidenceRow['evidence'] = { status: s.status, target: s.url };
  if (s.httpStatus != null) evidence.http_status = s.httpStatus;
  if (s.authScheme) evidence.auth_scheme = s.authScheme;
  if (s.authKind) evidence.auth_kind = s.authKind;
  if (s.protocolVersion) evidence.protocol_version = s.protocolVersion;
  if (s.toolCount != null) evidence.tool_count = s.toolCount;
  if (s.failingSince) evidence.failing_since = s.failingSince;
  if (s.error) evidence.error = s.error;
  let state = EVIDENCE_STATE[s.status] ?? 'unknown';
  // Our own failed check is not proof that the entry is dead: that takes two days of failed checks.
  if (state === 'dead' && !isConfirmedDown(s.status, s.failingSince, s.probedAt)) state = 'transient';
  return { entry: s.name, ...(s.version ? { version: s.version } : {}), checked_at: s.probedAt, check: s.transport === 'stdio' ? 'package' : 'endpoint', state, evidence };
}

/**
 * The failingSince of a row: the first probe of its current run of failed probes. previous is the same server in
 * the previous run's servers.json, seeded the value D1 had before servers.json carried the field. A server that
 * answers or is gated has none. A row carried from the previous run (not probed again) keeps its value; a server
 * that failed at its previous probe keeps that run's date; one that answered then starts today. Without a value
 * the previous probe is the lower bound.
 */
export function failingSinceOf(row: Pick<ServerRow, 'status' | 'probedAt' | 'failingSince'>, previous: Pick<ServerRow, 'status' | 'probedAt' | 'failingSince'> | undefined, seeded?: string): string | undefined {
  if (!isFailing(row.status)) return undefined;
  const before = previous && isFailing(previous.status) ? (previous.failingSince ?? seeded ?? previous.probedAt) : undefined;
  return before ?? row.probedAt;
}

/**
 * Whether a server went down or came back between two runs. Down means isConfirmedDown: one failed probe is not
 * news, and an answer after it is not a comeback. A previous row with no failingSince and no seeded value is from
 * before the rule, and counts as down when it failed, as the board said then.
 */
export function downChange(previous: Pick<ServerRow, 'status' | 'probedAt' | 'failingSince'>, current: Pick<ServerRow, 'status' | 'probedAt' | 'failingSince'>, seeded?: string): 'went-down' | 'came-back' | undefined {
  const since = previous.failingSince ?? seeded;
  const downBefore = since ? isConfirmedDown(previous.status, since, previous.probedAt) : isFailing(previous.status);
  const downNow = isConfirmedDown(current.status, current.failingSince, current.probedAt);
  if (!downBefore && downNow) return 'went-down';
  if (downBefore && !isFailing(current.status)) return 'came-back';
  return undefined;
}
