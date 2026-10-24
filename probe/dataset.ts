/**
 * Writes the open dataset of one run: one row per probed server with the
 * numbers the board shows. Usage:
 *   node --import tsx probe/dataset.ts --in data/latest --out data/latest [--publish site/public/data/mcpcost-2026-10.json.gz]
 * Writes:
 *   <out>/dataset.json       one row per server, the fields below, CC BY 4.0
 *   <out>/dataset.json.gz    the same, gzip level 9
 *   <out>/evidence.json(.gz) the same run as re-check evidence for the registry, in the shape agreed in
 *                            modelcontextprotocol/registry#1715: entry name, check date, check
 *                            (endpoint or package), state (alive, auth, transient, dead, unknown), evidence
 * With --publish the dataset gzip is copied to that path when it is under 10 MB, and --publish-evidence
 * does the same for the evidence gzip. A static file of the site is served before the Worker and costs no
 * request on the free tier; a bigger file would go out as a GitHub release asset instead.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { ServerRow } from './build-data.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest' },
    publish: { type: 'string' },
    'publish-evidence': { type: 'string' },
    /** The largest gzip, in MB, that goes out as a static file of the site. */
    'max-mb': { type: 'string', default: '10' }
  }
});

/** The columns, with the words the page and the JSON API use for them. Null when the probe did not record the value. */
export const DATASET_FIELDS: Record<string, string> = {
  name: 'the registry name; the server page is https://mcpcost.ulehla.dev/s/<name>',
  host: 'the host of the remote endpoint; npmjs.com or pypi.org for a package server',
  transport: 'streamable-http, sse or stdio',
  status: 'the probe result: ok, auth, payment, newer_protocol, not_found, protocol_error, dns, tls, timeout, refused, server_error, rate_limited, error; for a package: crashed, install_failed, no_bin, needs_env, needs_args, needs_network',
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
  host: string;
  transport: string;
  status: string;
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
    host: s.host,
    transport: s.transport,
    status: s.status,
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
 * auth (reachable, not open). A package that needs values or a network to start is unknown, not dead.
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
  error: 'unknown'
};

export interface EvidenceRow {
  /** The registry name. */
  entry: string;
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
  if (s.error) evidence.error = s.error;
  return { entry: s.name, checked_at: s.probedAt, check: s.transport === 'stdio' ? 'package' : 'endpoint', state: EVIDENCE_STATE[s.status] ?? 'unknown', evidence };
}

const servers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
const summary = JSON.parse(await readFile(`${args.in}/summary.json`, 'utf8')) as { probedAt: string; probed: number };
if (servers.length !== summary.probed) throw new Error(`servers.json has ${servers.length} rows, summary.json says ${summary.probed} probed: the two files are not from the same run`);
const rows = servers.map(datasetRow).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const month = summary.probedAt.slice(0, 7);
const dataset = {
  dataset: 'mcpcost',
  title: `Health and token cost of every server in the official MCP registry, run of ${summary.probedAt.slice(0, 10)}`,
  month,
  probed_at: summary.probedAt,
  servers: rows.length,
  license: 'CC BY 4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://mcpcost.ulehla.dev',
  report: `https://mcpcost.ulehla.dev/report/${month}`,
  method: 'https://mcpcost.ulehla.dev/methodology',
  cite: `Ondřej Úlehla, mcpcost: health and token cost of every server in the official MCP registry, run of ${summary.probedAt.slice(0, 10)}, https://mcpcost.ulehla.dev/report/${month}, CC BY 4.0`,
  fields: DATASET_FIELDS,
  rows
};
await mkdir(args.out, { recursive: true });
const json = JSON.stringify(dataset);
await writeFile(`${args.out}/dataset.json`, json);
const gz = gzipSync(Buffer.from(json), { level: 9 });
await writeFile(`${args.out}/dataset.json.gz`, gz);
console.error(`wrote ${rows.length} rows: dataset.json ${(json.length / 1e6).toFixed(1)} MB, dataset.json.gz ${(gz.length / 1e6).toFixed(2)} MB`);

const evidenceRows = servers.map(evidenceRow).sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
const evidence = {
  dataset: 'mcpcost-evidence',
  title: `Re-check evidence for every entry of the official MCP registry, run of ${summary.probedAt.slice(0, 10)}`,
  shape: 'modelcontextprotocol/registry#1715: entry, checked_at, check (endpoint | package), state (alive | auth | transient | dead | unknown), evidence',
  states: {
    alive: 'initialize and tools/list succeeded (also a protocol newer than the SDK)',
    auth: 'reachable, needs credentials or payment: 401, 403, 402',
    transient: 'the endpoint exists but did not serve this run: timeout, 429, 5xx, connection refused',
    dead: 'no DNS, TLS failure, 404/405/410, or an answer that is not MCP; a package that does not install or has no executable',
    unknown: 'a package that needs values, arguments or a network to start, or crashed on start; or an error the probe could not classify'
  },
  probed_at: summary.probedAt,
  entries: evidenceRows.length,
  license: 'CC BY 4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://mcpcost.ulehla.dev',
  method: 'https://mcpcost.ulehla.dev/methodology',
  rows: evidenceRows
};
const evidenceJson = JSON.stringify(evidence);
await writeFile(`${args.out}/evidence.json`, evidenceJson);
const evidenceGz = gzipSync(Buffer.from(evidenceJson), { level: 9 });
await writeFile(`${args.out}/evidence.json.gz`, evidenceGz);
const counts = evidenceRows.reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
console.error(`wrote ${evidenceRows.length} evidence rows (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}): evidence.json.gz ${(evidenceGz.length / 1e6).toFixed(2)} MB`);

if (args.publish) {
  const size = (await stat(`${args.out}/dataset.json.gz`)).size;
  const max = Number(args['max-mb']) * 1e6;
  if (size > max) {
    console.error(`::error::dataset.json.gz is ${(size / 1e6).toFixed(1)} MB, over the ${args['max-mb']} MB limit for a static file. Publish it as a release asset instead.`);
    process.exit(2);
  }
  await mkdir(dirname(args.publish), { recursive: true });
  await copyFile(`${args.out}/dataset.json.gz`, args.publish);
  console.error(`published to ${args.publish}`);
}
if (args['publish-evidence']) {
  const size = (await stat(`${args.out}/evidence.json.gz`)).size;
  const max = Number(args['max-mb']) * 1e6;
  if (size > max) {
    console.error(`::error::evidence.json.gz is ${(size / 1e6).toFixed(1)} MB, over the ${args['max-mb']} MB limit for a static file.`);
    process.exit(2);
  }
  await mkdir(dirname(args['publish-evidence']), { recursive: true });
  await copyFile(`${args.out}/evidence.json.gz`, args['publish-evidence']);
  console.error(`published to ${args['publish-evidence']}`);
}
