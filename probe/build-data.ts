/**
 * Turns a raw probe run plus the registry snapshot into the compact files the
 * site and the badges read. Usage:
 *   node --import tsx probe/build-data.ts --in data/raw/probe-all-2026-10-03.json --registry data/raw/registry-latest.json --out data/latest
 * Writes:
 *   <out>/servers.json   one compact row per probed server
 *   <out>/summary.json   aggregates for the front page
 *   <out>/hosts.json     per-host aggregates, biggest first
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GATED_STATUSES, hostOf, isConfirmedDown, isFailing, isSchemaRefusal } from '../packages/mcpcost/src/index.js';
import { downChange, failingSinceOf } from './rows.js';
import type { ProbeResult, RegistryEntry } from '../packages/mcpcost/src/index.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    registry: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string', default: 'data/latest' },
    /** servers.json of the previous run, for the list of what changed since then and for stdio rows not probed today. */
    previous: { type: 'string' },
    /** A stdio run file from probe/stdio-run.ts: package servers probed in containers. */
    stdio: { type: 'string' },
    /** A dump of the board (name, status, failing_since) from D1: where failing_since comes from before servers.json has it. */
    'd1-status': { type: 'string' },
    /** Import even when far fewer servers answered than last time. */
    force: { type: 'boolean', default: false }
  }
});
if (!args.in) throw new Error('--in <probe run json> is required');

interface RawRow {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse' | 'stdio';
  host: string;
  updatedAt: string;
  status: string;
  result: ProbeResult;
  payloadHash?: string;
  /** Probed with stored credentials: the result is what an authorized user sees. */
  withCredentials?: boolean;
}

interface StdioRow {
  name: string;
  /** Set when the package stands in for a gated remote server: its tool set goes on that server's row. */
  derivedFor?: string;
  kind: 'npm' | 'pypi';
  identifier: string;
  version?: string;
  status: string;
  result?: ProbeResult;
  error?: string;
  payloadHash?: string;
  installMs?: number;
}

export interface ServerRow {
  name: string;
  title?: string;
  description?: string;
  url: string;
  host: string;
  /** none: a registry entry with nothing the probe can connect to (status unprobed). */
  transport: 'streamable-http' | 'sse' | 'stdio' | 'none';
  repo?: string;
  website?: string;
  registryStatus: string;
  registryUpdatedAt: string;
  /** The version of the registry entry that was probed (the latest one). */
  version?: string;
  probedAt: string;
  status: string;
  /** The first probe of the current run of failed probes (ISO time); unset while the server answers or is gated. */
  failingSince?: string;
  /** failingSince once the server is down: isConfirmedDown at this row's real probe time. The board reads it. */
  downSince?: string;
  httpStatus?: number;
  authScheme?: string;
  /** The publisher's guide to getting access, from the OAuth protected-resource metadata. */
  authDocumentation?: string;
  /** How a client gets in: oauth-dcr, oauth, token or unknown. See AuthKind in the package. */
  authKind?: string;
  /** What the OAuth metadata says: authorization servers, scopes, dynamic registration, PKCE, grant types. */
  authMetadata?: Record<string, unknown>;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  capabilities?: string[];
  initMs?: number;
  toolsMs?: number;
  toolCount?: number;
  /** o200k_base tokens over the compact JSON of the tool definitions: the estimate, the same for every server. */
  toolsTokens?: number;
  /** Hash of the full tool payloads. The next run reuses the Claude count when it is unchanged. */
  payloadHash?: string;
  /** Exact count from the Anthropic count_tokens endpoint, tool names as published. */
  claudeTokens?: number;
  /** The same with Claude Code's mcp__<server>__ prefix on each tool name. */
  claudeTokensCc?: number;
  claudeModel?: string;
  claudeMeasuredAt?: string;
  /** Why Claude refused to count, for example a schema the API does not accept. */
  claudeError?: string;
  /** Exact count from the Gemini countTokens endpoint. */
  geminiTokens?: number;
  geminiModel?: string;
  geminiMeasuredAt?: string;
  geminiError?: string;
  /** Measured with stored credentials (a header or an OAuth token), so the count is what an authorized user gets. */
  measuredWithCredentials?: boolean;
  /** For a gated remote server: the tool set of the publisher's open-source package, measured in a container. */
  derivedPackage?: {
    registry: 'npm' | 'pypi';
    name: string;
    status: string;
    probedAt: string;
    toolCount?: number;
    toolsTokens?: number;
    claudeTokens?: number;
    claudeModel?: string;
    geminiTokens?: number;
    error?: string;
  };
  instructionsChars?: number;
  /** Hash of the sorted tool names and schema sizes. Equal hashes mean the same tool set. */
  toolsetHash?: string;
  /** How many other probed servers share this tool set. */
  toolsetSiblings?: number;
  topTools?: Array<{ name: string; tokens: number }>;
  error?: string;
}

const run = JSON.parse(await readFile(args.in, 'utf8')) as { probedAt: string; rows: RawRow[] };
const registryRaw = JSON.parse(await readFile(args.registry, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
const registry = new Map(registryRaw.map((r) => [r.server.name, r.server]));
const registryMeta = new Map(registryRaw.map((r) => [r.server.name, r._meta['io.modelcontextprotocol.registry/official']]));

/**
 * Package servers: the stdio run probes one seventh of them a day, in
 * containers. Today's rows come from the run file; the rest keep their row
 * from the previous run while the registry still lists them.
 */
const stdioFile = args.stdio && existsSync(args.stdio) ? (JSON.parse(await readFile(args.stdio, 'utf8')) as { probedAt: string; rows: StdioRow[] }) : null;
/** Packages that stand in for gated remote servers, by the remote server's name. Not rows of their own. */
const derivedByName = new Map<string, StdioRow>();
for (const r of stdioFile?.rows ?? []) if (r.derivedFor) derivedByName.set(r.derivedFor, r);
// The stdio run is hours older than the remote probe. An entry that got a remote URL in between (a new version) has
// both; the remote probe of today's registry wins, and an entry that left the registry in between is not shown.
const remoteNames = new Set(run.rows.map((r) => r.name));
const stdioRows: RawRow[] = (stdioFile?.rows ?? []).filter((r) => !r.derivedFor && !remoteNames.has(r.name) && registry.has(r.name)).map((r) => {
  const kind = r.kind ?? 'npm';
  const host = kind === 'npm' ? 'npmjs.com' : 'pypi.org';
  const url = kind === 'npm' ? `npm:${r.identifier}${r.version ? `@${r.version}` : ''}` : `pypi:${r.identifier}${r.version ? `==${r.version}` : ''}`;
  const result: ProbeResult = r.result ?? { url, transport: 'stdio', probedAt: stdioFile!.probedAt, status: r.status as ProbeResult['status'], latencyMs: {}, error: r.error };
  result.url = url;
  result.transport = 'stdio';
  result.status = r.status as ProbeResult['status'];
  if (r.status !== 'ok' && r.error && !result.error) result.error = r.error;
  const meta = registryMeta.get(r.name);
  return { name: r.name, url, type: 'stdio', host, updatedAt: meta?.updatedAt ?? '', status: meta?.status ?? 'active', result, payloadHash: r.payloadHash };
});
const probedNow = new Set([...run.rows, ...stdioRows].map((r) => r.name));
const previousForCarry = args.previous && existsSync(args.previous) ? (JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[]) : [];
// A carried row keeps its count. An error that is not a refused schema (the API refused the key) is not a fact about the
// package, so it goes, and the row shows the estimate until its day of the stdio cycle counts it again.
const carried: ServerRow[] = previousForCarry
  .filter((r) => r.transport === 'stdio' && r.status !== 'unprobed' && !probedNow.has(r.name) && registry.has(r.name))
  .map((r) => (r.claudeError && !isSchemaRefusal(r.claudeError) && r.claudeTokens == null ? { ...r, claudeError: undefined, claudeModel: undefined, claudeMeasuredAt: undefined } : r));

const rows: ServerRow[] = [...run.rows, ...stdioRows].map((r) => {
  const s = registry.get(r.name);
  const res = r.result;
  const toolsetHash = res.tools?.length
    ? createHash('sha1').update(res.tools.map((t) => `${t.name}:${t.bytes}`).sort().join('|')).digest('hex').slice(0, 12)
    : undefined;
  return {
    name: r.name,
    title: s?.title,
    description: s?.description?.slice(0, 200),
    url: r.url,
    host: r.host,
    transport: r.type,
    repo: s?.repository?.url,
    website: s?.websiteUrl,
    registryStatus: r.status,
    registryUpdatedAt: r.updatedAt,
    version: s?.version,
    probedAt: res.probedAt,
    status: res.status,
    httpStatus: res.httpStatus,
    authScheme: res.authScheme,
    authDocumentation: res.authDocumentation,
    authKind: res.status === 'auth' ? res.authKind : undefined,
    authMetadata: res.authMetadata,
    protocolVersion: res.protocolVersion,
    serverName: res.serverInfo?.name,
    serverVersion: res.serverInfo?.version,
    capabilities: res.capabilities,
    initMs: res.latencyMs.initialize,
    toolsMs: res.latencyMs.toolsList,
    toolCount: res.toolCount,
    toolsTokens: res.toolsTokens,
    payloadHash: r.payloadHash,
    claudeTokens: res.claude?.tokens,
    claudeTokensCc: res.claude?.tokensClaudeCode,
    claudeModel: res.claude?.model,
    claudeMeasuredAt: res.claude?.measuredAt,
    claudeError: res.claude?.error,
    geminiTokens: res.gemini?.tokens,
    geminiModel: res.gemini?.model,
    geminiMeasuredAt: res.gemini?.measuredAt,
    geminiError: res.gemini?.error,
    measuredWithCredentials: r.withCredentials || undefined,
    instructionsChars: res.instructionsChars,
    toolsetHash,
    topTools: res.tools ? [...res.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((t) => ({ name: t.name, tokens: t.tokens })) : undefined,
    error: res.status === 'ok' ? undefined : res.error?.slice(0, 160)
  };
});

rows.push(...carried);
// One row per entry: the evidence check refuses a file with an entry twice, and D1 would keep only one of them.
{
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)));
  if (unique.length < rows.length) console.error(`::warning::${rows.length - unique.length} rows named an entry twice; the first one is kept`);
  rows.splice(0, rows.length, ...unique);
}

/**
 * failingSince: the first probe of the current run of failed probes. A server that fails today and failed at its
 * previous probe keeps the date it had; one that answered last time starts today. Before servers.json carried the
 * field, the D1 dump has it (seeded once from the probes history), and else the previous probe is the lower bound.
 * A server is down only when isConfirmedDown says so: one failed probe is "no answer", not an outage.
 */
const d1FailingSince = new Map<string, string>();
if (args['d1-status'] && existsSync(args['d1-status'])) {
  const raw = JSON.parse(await readFile(args['d1-status'], 'utf8')) as Array<{ results?: Array<{ name: string; failing_since?: string | null }> }>;
  for (const r of raw.flatMap((x) => x.results ?? [])) if (r.failing_since) d1FailingSince.set(r.name, r.failing_since);
}
const previousByName = new Map(previousForCarry.map((r) => [r.name, r]));
for (const r of rows) {
  r.failingSince = failingSinceOf(r, previousByName.get(r.name), d1FailingSince.get(r.name));
  r.downSince = isConfirmedDown(r.status, r.failingSince, r.probedAt) ? r.failingSince : undefined;
}

/**
 * Every registry entry is on the board. An entry the probe cannot run yet gets a row with the status unprobed and
 * the reason: only an OCI image, an MCPB bundle, a NuGet or Cargo package, or nothing to connect to. So the list holds
 * the whole registry and says what it does not check. These rows are not in the counts of probed servers, the hosts,
 * the dataset or the evidence.
 */
const PACKAGE_HOST: Record<string, string> = { npm: 'npmjs.com', pypi: 'pypi.org', nuget: 'nuget.org', cargo: 'crates.io' };
const PACKAGE_ORDER = ['npm', 'pypi', 'oci', 'mcpb', 'nuget', 'cargo'];
/** docker.io/user/image:tag, ghcr.io/org/image:1.0, or user/image (Docker Hub). */
const ociHost = (identifier: string) => {
  const first = identifier.split('/')[0];
  return identifier.includes('/') && /[.:]/.test(first) ? first : 'docker.io';
};
function unprobedRow(s: RegistryEntry['server'], meta: RegistryEntry['meta'] | undefined, probedAt: string): ServerRow {
  const pkg = [...(s.packages ?? [])].sort((a, b) => (PACKAGE_ORDER.indexOf(a.registryType) + 99) % 99 - (PACKAGE_ORDER.indexOf(b.registryType) + 99) % 99)[0];
  let url = '';
  let host = 'registry.modelcontextprotocol.io';
  let transport = 'none';
  let reason = 'The entry has no remote URL and no package: there is nothing to connect to.';
  if (pkg) {
    const t = pkg.registryType;
    transport = 'stdio';
    if (t === 'oci') {
      url = `oci:${pkg.identifier}`;
      host = ociHost(pkg.identifier);
      reason = 'The entry has only an OCI (Docker) image. The probe does not run OCI images yet.';
    } else if (t === 'mcpb') {
      url = `mcpb:${pkg.identifier}`;
      host = hostOf(pkg.identifier);
      reason = 'The entry has only an MCPB bundle. The probe does not run MCPB bundles yet.';
    } else if (t === 'npm' || t === 'pypi') {
      url = t === 'npm' ? `npm:${pkg.identifier}${pkg.version ? `@${pkg.version}` : ''}` : `pypi:${pkg.identifier}${pkg.version ? `==${pkg.version}` : ''}`;
      host = PACKAGE_HOST[t];
      reason = 'A new package. The probe starts it on the day after it is published, and then once a week.';
    } else {
      url = `${t}:${pkg.identifier}${pkg.version ? `@${pkg.version}` : ''}`;
      host = PACKAGE_HOST[t] ?? t;
      reason = `The entry has only a ${t} package. The probe runs npm and PyPI packages, OCI images and MCPB bundles only.`;
    }
  } else if (s.remotes?.length) {
    const callable = s.remotes.find((r) => r.type === 'streamable-http' || r.type === 'sse');
    url = (callable ?? s.remotes[0]).url;
    host = hostOf(url);
    transport = (callable ?? s.remotes[0]).type;
    reason = callable ? 'A new entry. The next daily probe calls it.' : 'The entry has a remote of a kind that the probe does not call.';
  }
  return {
    name: s.name, title: s.title, description: s.description?.slice(0, 200), url, host, transport: transport as ServerRow['transport'],
    repo: s.repository?.url, website: s.websiteUrl, registryStatus: meta?.status ?? 'active', registryUpdatedAt: meta?.updatedAt ?? '',
    version: s.version, probedAt, status: 'unprobed', error: reason
  };
}
const onBoard = new Set(rows.map((r) => r.name));
for (const raw of registryRaw) {
  const meta = registryMeta.get(raw.server.name);
  if (onBoard.has(raw.server.name) || meta?.status === 'tracked') continue;
  rows.push(unprobedRow(raw.server, meta, run.probedAt));
}
const probedRows = rows.filter((r) => r.status !== 'unprobed');
/** The kind of an entry the probe did not run: the package registry of its URL, or none. */
const unprobedKind = (r: ServerRow) => (r.url.includes(':') && !/^https?:/.test(r.url) ? r.url.slice(0, r.url.indexOf(':')) : r.url ? 'remote' : 'none');

// The derived tool set of a gated remote server: today's container result, else what the previous run had.
const previousDerived = new Map(previousForCarry.filter((r) => r.derivedPackage).map((r) => [r.name, r.derivedPackage!]));
for (const r of rows) {
  if (r.transport === 'stdio' || (r.status !== 'auth' && r.status !== 'payment')) continue;
  const d = derivedByName.get(r.name);
  if (d) {
    r.derivedPackage = {
      registry: d.kind,
      name: d.identifier,
      status: d.status,
      probedAt: stdioFile?.probedAt ?? run.probedAt,
      toolCount: d.result?.toolCount,
      toolsTokens: d.result?.toolsTokens,
      claudeTokens: d.result?.claude?.tokens,
      claudeModel: d.result?.claude?.model,
      geminiTokens: d.result?.gemini?.tokens,
      error: d.status === 'ok' ? undefined : (d.error ?? d.result?.error)?.slice(0, 160)
    };
  } else if (previousDerived.has(r.name)) r.derivedPackage = previousDerived.get(r.name);
}

/**
 * A broken runner looks like a mass outage: on 2026-10-14 a run saw 15 049
 * timeouts instead of 202 and would have marked half the registry down. When
 * far fewer servers answer than last time, the run is not trusted: no import,
 * no artifact; the next run tries again. --force skips the check.
 */
if (previousForCarry.length && !args.force) {
  const prevOk = previousForCarry.filter((r) => r.transport !== 'stdio' && r.status === 'ok').length;
  const nowOk = run.rows.filter((r) => r.result.status === 'ok').length;
  const timeouts = run.rows.filter((r) => r.result.status === 'timeout').length;
  if (nowOk < 0.7 * prevOk || timeouts > 0.2 * run.rows.length) {
    console.error(`::error::This run looks broken: ${nowOk} alive against ${prevOk} last time, ${timeouts} timeouts of ${run.rows.length}. Not importing.`);
    process.exit(2);
  }
}

const siblings = new Map<string, number>();
for (const r of rows) if (r.toolsetHash) siblings.set(r.toolsetHash, (siblings.get(r.toolsetHash) ?? 0) + 1);
for (const r of rows) if (r.toolsetHash) r.toolsetSiblings = (siblings.get(r.toolsetHash) ?? 1) - 1;

const count = <T>(xs: T[], key: (x: T) => string | undefined) => {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = key(x) ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/**
 * What changed since the previous run: servers that appeared or left the
 * registry, that went down or came back, and whose tool definitions grew or
 * shrank by a fifth and at least 500 tokens. The exact Claude count is used
 * when both runs have it, the estimate otherwise.
 */
export interface Changes {
  since: string;
  added: Array<{ name: string; status: string; tokens?: number }>;
  removed: string[];
  wentDown: Array<{ name: string; from: string; to: string }>;
  cameBack: Array<{ name: string; from: string; to: string }>;
  tokenChanges: Array<{ name: string; before: number; after: number; exact: boolean }>;
  counts: { added: number; removed: number; wentDown: number; cameBack: number; tokenChanges: number };
}
function diffRuns(previousRows: ServerRow[], current: ServerRow[]): Changes {
  const prev = new Map(previousRows.map((r) => [r.name, r]));
  const now = new Map(current.map((r) => [r.name, r]));
  const since = previousRows.reduce((a, r) => (r.probedAt > a ? r.probedAt : a), '');
  const added = current.filter((r) => !prev.has(r.name)).map((r) => ({ name: r.name, status: r.status, tokens: r.claudeTokens ?? r.toolsTokens }));
  const removed = previousRows.filter((r) => !now.has(r.name)).map((r) => r.name);
  const wentDown: Changes['wentDown'] = [];
  const cameBack: Changes['cameBack'] = [];
  const tokenChanges: Changes['tokenChanges'] = [];
  for (const r of current) {
    const p = prev.get(r.name);
    if (!p) continue;
    const change = downChange(p, r, d1FailingSince.get(p.name));
    if (change === 'went-down') wentDown.push({ name: r.name, from: p.status, to: r.status });
    if (change === 'came-back') cameBack.push({ name: r.name, from: p.status, to: r.status });
    const exact = p.claudeTokens != null && r.claudeTokens != null;
    const before = exact ? p.claudeTokens! : p.toolsTokens;
    const after = exact ? r.claudeTokens! : r.toolsTokens;
    if (before != null && after != null && p.status === 'ok' && r.status === 'ok') {
      const delta = Math.abs(after - before);
      if (delta >= 500 && delta >= 0.2 * Math.max(before, 1)) tokenChanges.push({ name: r.name, before, after, exact });
    }
  }
  tokenChanges.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  added.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
  const cap = <T>(xs: T[]) => xs.slice(0, 60);
  return {
    since,
    added: cap(added), removed: cap(removed), wentDown: cap(wentDown), cameBack: cap(cameBack), tokenChanges: cap(tokenChanges),
    counts: { added: added.length, removed: removed.length, wentDown: wentDown.length, cameBack: cameBack.length, tokenChanges: tokenChanges.length }
  };
}

const previousRows = args.previous && existsSync(args.previous) ? (JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[]) : null;
const changes = previousRows ? diffRuns(previousRows, rows) : undefined;

const ok = probedRows.filter((r) => r.status === 'ok');
const tokens = ok.map((r) => r.toolsTokens ?? 0);
const counted = ok.filter((r) => r.claudeTokens != null);
const claude = counted.map((r) => r.claudeTokens!);
const claudeCc = counted.map((r) => r.claudeTokensCc ?? r.claudeTokens!);
const claudeModel = counted[0]?.claudeModel;
const geminiCounted = ok.filter((r) => r.geminiTokens != null);
const geminiAll = geminiCounted.map((r) => r.geminiTokens!);
/** Histogram of the exact counts: how many alive servers fall into each cost band. */
const HISTOGRAM_EDGES = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const histogram = (xs: number[]) => {
  const bins = new Array(HISTOGRAM_EDGES.length + 1).fill(0) as number[];
  for (const x of xs) bins[HISTOGRAM_EDGES.findIndex((e) => x < e) === -1 ? HISTOGRAM_EDGES.length : HISTOGRAM_EDGES.findIndex((e) => x < e)]++;
  return { edges: HISTOGRAM_EDGES, bins };
};
const uniqueToolsets = new Set(ok.map((r) => r.toolsetHash)).size;
const hostMap = new Map<string, ServerRow[]>();
for (const r of probedRows) (hostMap.get(r.host) ?? hostMap.set(r.host, []).get(r.host)!).push(r);
const hosts = [...hostMap.entries()]
  .map(([host, list]) => ({
    host,
    servers: list.length,
    byStatus: count(list, (r) => r.status),
    down: list.filter((r) => isConfirmedDown(r.status, r.failingSince, r.probedAt)).length,
    noAnswer: list.filter((r) => isFailing(r.status) && !isConfirmedDown(r.status, r.failingSince, r.probedAt)).length,
    uniqueToolsets: new Set(list.filter((r) => r.toolsetHash).map((r) => r.toolsetHash)).size,
    medianTokens: quantile(list.filter((r) => r.status === 'ok').map((r) => r.toolsTokens ?? 0), 0.5)
  }))
  .sort((a, b) => b.servers - a.servers);

/** The hosts page and the statistics read the biggest hosts from the run summary: one row written a day instead of 1 700. */
const topHosts = hosts.slice(0, 500).map((h) => ({
  host: h.host,
  servers: h.servers,
  ok: h.byStatus.ok ?? 0,
  gated: [...GATED_STATUSES].reduce((a, k) => a + (h.byStatus[k] ?? 0), 0),
  /** Down for two days or more (isConfirmedDown). */
  dead: h.down,
  /** No valid answer in this run, for less than two days. */
  noAnswer: h.noAnswer,
  uniqueToolsets: h.uniqueToolsets,
  medianTokens: h.medianTokens
}));
/** Ranks by the exact Claude count when the run has one, else by the estimate. */
const weight = (r: ServerRow) => r.claudeTokens ?? (counted.length ? -1 : (r.toolsTokens ?? 0));
const summary = {
  probedAt: run.probedAt,
  registryEntries: registryRaw.filter((r) => r._meta['io.modelcontextprotocol.registry/official']?.status !== 'tracked').length,
  tracked: registryRaw.filter((r) => r._meta['io.modelcontextprotocol.registry/official']?.status === 'tracked').length,
  registryWithRemote: registryRaw.filter((r) => r.server.remotes?.length).length,
  registryWithPackage: registryRaw.filter((r) => !r.server.remotes?.length && r.server.packages?.some((p) => p.registryType === 'npm' || p.registryType === 'pypi')).length,
  stdioProbed: probedRows.filter((r) => r.transport === 'stdio').length,
  stdioToday: stdioRows.length,
  probed: probedRows.length,
  /** Registry entries the probe does not run yet, by kind: oci, mcpb, nuget, cargo, npm or pypi (new), remote, none. */
  unprobed: count(rows.filter((r) => r.status === 'unprobed'), unprobedKind),
  byStatus: count(rows, (r) => r.status),
  /** The failing servers that are not down yet: fewer than DOWN_AFTER_DAYS days without a valid answer, by status. */
  noAnswer: count(rows.filter((r) => isFailing(r.status) && !isConfirmedDown(r.status, r.failingSince, r.probedAt)), (r) => r.status),
  reachable: ok.length + probedRows.filter((r) => GATED_STATUSES.has(r.status)).length,
  ok: ok.length,
  uniqueToolsets,
  duplicateServers: ok.length - uniqueToolsets,
  protocols: count(ok, (r) => r.protocolVersion),
  authSchemes: count(rows.filter((r) => r.status === 'auth'), (r) => r.authScheme ?? 'none'),
  authKinds: count(rows.filter((r) => r.status === 'auth'), (r) => r.authKind ?? 'unknown'),
  transports: count(probedRows, (r) => r.transport),
  toolsTokens: { median: quantile(tokens, 0.5), p90: quantile(tokens, 0.9), p99: quantile(tokens, 0.99), max: Math.max(0, ...tokens), total: tokens.reduce((a, b) => a + b, 0) },
  claudeTokens: counted.length
    ? {
        model: claudeModel,
        counted: counted.length,
        refused: ok.filter((r) => isSchemaRefusal(r.claudeError)).length,
        histogram: histogram(claude),
        median: quantile(claude, 0.5), p90: quantile(claude, 0.9), p99: quantile(claude, 0.99), max: Math.max(0, ...claude), total: claude.reduce((a, b) => a + b, 0),
        claudeCode: { median: quantile(claudeCc, 0.5), p90: quantile(claudeCc, 0.9), p99: quantile(claudeCc, 0.99), max: Math.max(0, ...claudeCc), total: claudeCc.reduce((a, b) => a + b, 0) },
        /** Exact count divided by the estimate, over the counted servers. */
        ratioToEstimate: { median: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.5), p10: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.1), p90: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.9) }
      }
    : undefined,
  geminiTokens: geminiCounted.length
    ? {
        model: geminiCounted[0]?.geminiModel,
        counted: geminiCounted.length,
        refused: ok.filter((r) => r.geminiError).length,
        median: quantile(geminiAll, 0.5), p90: quantile(geminiAll, 0.9), p99: quantile(geminiAll, 0.99), max: Math.max(0, ...geminiAll), total: geminiAll.reduce((a, b) => a + b, 0)
      }
    : undefined,
  toolCount: { median: quantile(ok.map((r) => r.toolCount ?? 0), 0.5), p90: quantile(ok.map((r) => r.toolCount ?? 0), 0.9), max: Math.max(0, ...ok.map((r) => r.toolCount ?? 0)) },
  initMs: { median: quantile(ok.map((r) => r.initMs ?? 0), 0.5), p90: quantile(ok.map((r) => r.initMs ?? 0), 0.9) },
  hosts: new Set(rows.map((r) => r.host)).size,
  topHosts,
  shownTokens: (() => {
    const shown = ok.map((r) => r.claudeTokens ?? r.toolsTokens).filter((n): n is number => n != null);
    return shown.length ? { min: Math.min(...shown), max: Math.max(...shown) } : undefined;
  })(),
  changes,
  heaviest: [...ok].sort((a, b) => weight(b) - weight(a)).slice(0, 20).map((r) => ({ name: r.name, toolCount: r.toolCount, toolsTokens: r.toolsTokens, claudeTokens: r.claudeTokens, claudeTokensCc: r.claudeTokensCc, host: r.host }))
};

await mkdir(args.out, { recursive: true });
await writeFile(`${args.out}/servers.json`, JSON.stringify(rows));
await writeFile(`${args.out}/summary.json`, JSON.stringify(summary, null, 2));
await writeFile(`${args.out}/hosts.json`, JSON.stringify(hosts));
console.log(JSON.stringify({ ...summary, heaviest: summary.heaviest.slice(0, 5) }, null, 2));
console.error(`wrote ${rows.length} rows to ${args.out}/`);
