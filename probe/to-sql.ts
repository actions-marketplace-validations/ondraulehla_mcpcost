/**
 * Turns data/latest/*.json into one SQL file for D1. Usage:
 *   node --import tsx probe/to-sql.ts --in data/latest --out data/latest/import.sql [--previous old/servers.json]
 * Then:
 *   npx wrangler d1 execute mcp-pulse --remote --file=data/latest/import.sql
 * The file uses INSERT OR REPLACE, so it is safe to run again.
 *
 * With --previous, only servers whose row changed since that run are written, and
 * a history row is added only for them. D1 counts every index entry as a row
 * written, and the free tier allows 100 000 a day, so a full rewrite of 24 000
 * servers with ten indexes would not fit. probed_at of an unchanged server stays
 * at the last change; the run date on the board comes from the runs table.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ServerRow } from './build-data.js';
import { GATED_STATUSES } from '../packages/mcpcost/src/index.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest/import.sql' },
    previous: { type: 'string' },
    /**
     * The board's own state: name and status of every row, from
     * `wrangler d1 execute mcp-pulse --remote --json --command "SELECT name, status FROM servers"`.
     * A row whose status in the database differs from this run is written whole, and a row the
     * registry no longer has is deleted. Without it the diff trusts the previous artifact, and a
     * failed or bad import stays in the database for good: on 2026-10-14 one left 14 000 rows on "timeout".
     */
    'd1-status': { type: 'string' },
    /**
     * The daily write budget the import may use. D1's free tier allows 100 000 rows written a day,
     * and every index entry counts as a row; the rest is for the watches and the credentials.
     */
    'write-budget': { type: 'string', default: '85000' },
    /** At most this many drifted rows repaired in one run, whatever the budget leaves. */
    'repair-limit': { type: 'string', default: '6000' },
    /** At most this many stale rows deleted in one run. */
    'delete-limit': { type: 'string', default: '1000' },
    'rows-per-insert': { type: 'string', default: '40' }
  }
});
const rowsPerInsert = Number(args['rows-per-insert']);

const allServers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
const previous = args.previous ? ((JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[])) : null;

/**
 * What counts as a change: everything except the probe timestamp and the two
 * latencies, which differ on every run and would turn every row into a write.
 */
function fingerprint(s: ServerRow): string {
  // The error text is informational and often carries ids or timestamps; it is written only when the result changes.
  const { probedAt: _probedAt, initMs: _initMs, toolsMs: _toolsMs, payloadHash: _payloadHash, error: _error, ...rest } = s;
  return JSON.stringify(rest);
}
const previousByName = new Map((previous ?? []).map((s) => [s.name, fingerprint(s)]));
const servers = previous ? allServers.filter((s) => previousByName.get(s.name) !== fingerprint(s)) : allServers;
const currentNames = new Set(allServers.map((s) => s.name));
const removed = previous ? [...previousByName.keys()].filter((name) => !currentNames.has(name)) : [];

/** name → status as the database has it now, when a dump was given. */
const d1Status = new Map<string, string>();
if (args['d1-status'] && existsSync(args['d1-status'])) {
  const raw = JSON.parse(await readFile(args['d1-status'], 'utf8')) as Array<{ results?: Array<{ name: string; status: string }> }> | Array<{ name: string; status: string }>;
  const rows = Array.isArray(raw) && raw.length && 'results' in (raw[0] as object) ? (raw as Array<{ results?: Array<{ name: string; status: string }> }>).flatMap((r) => r.results ?? []) : (raw as Array<{ name: string; status: string }>);
  for (const r of rows) d1Status.set(r.name, r.status);
}
const summary = JSON.parse(await readFile(`${args.in}/summary.json`, 'utf8')) as { probedAt: string };

type Value = string | number | boolean | null | undefined | string[] | object;
function lit(v: Value): string {
  if (v === undefined || v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function multiInsert(table: string, columns: string[], rows: Value[][], verb = 'INSERT OR REPLACE', suffix = ''): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += rowsPerInsert) {
    const chunk = rows.slice(i, i + rowsPerInsert).map((r) => `(${r.map(lit).join(',')})`);
    out.push(`${verb} INTO ${table} (${columns.join(',')}) VALUES\n${chunk.join(',\n')}${suffix};`);
  }
  return out;
}

/** An upsert fires the UPDATE trigger that keeps the FTS index in step; REPLACE would not. */
function upsertSuffix(key: string, columns: string[]): string {
  return `\nON CONFLICT(${key}) DO UPDATE SET ${columns.filter((c) => c !== key).map((c) => `${c}=excluded.${c}`).join(', ')}`;
}

const serverColumns = [
  'name', 'title', 'description', 'url', 'host', 'transport', 'repo', 'website', 'registry_status', 'registry_updated_at',
  'probed_at', 'status', 'http_status', 'auth_scheme', 'protocol_version', 'server_name', 'server_version', 'capabilities',
  'init_ms', 'tools_ms', 'tool_count', 'tools_tokens', 'instructions_chars', 'toolset_hash', 'toolset_siblings', 'top_tools', 'error',
  'claude_model', 'claude_tokens', 'claude_tokens_cc', 'claude_measured_at', 'claude_error',
  'gemini_model', 'gemini_tokens', 'gemini_measured_at', 'gemini_error', 'measured_with_credentials',
  'derived_package', 'derived_registry', 'derived_status', 'derived_probed_at', 'derived_tool_count', 'derived_tools_tokens', 'derived_claude_tokens', 'derived_error',
  'auth_documentation', 'auth_kind', 'auth_metadata'
];
function serverValues(s: ServerRow): Value[] {
  return [
    s.name, s.title, s.description, s.url, s.host, s.transport, s.repo, s.website, s.registryStatus, s.registryUpdatedAt,
    s.probedAt, s.status, s.httpStatus, s.authScheme, s.protocolVersion, s.serverName, s.serverVersion, s.capabilities ? JSON.stringify(s.capabilities) : null,
    s.initMs, s.toolsMs, s.toolCount, s.toolsTokens, s.instructionsChars, s.toolsetHash, s.toolsetSiblings, s.topTools ? JSON.stringify(s.topTools) : null, s.error,
    s.claudeModel, s.claudeTokens, s.claudeTokensCc, s.claudeMeasuredAt, s.claudeError,
    s.geminiModel, s.geminiTokens, s.geminiMeasuredAt, s.geminiError, s.measuredWithCredentials ? 1 : 0,
    s.derivedPackage?.name, s.derivedPackage?.registry, s.derivedPackage?.status, s.derivedPackage?.probedAt, s.derivedPackage?.toolCount, s.derivedPackage?.toolsTokens, s.derivedPackage?.claudeTokens, s.derivedPackage?.error,
    s.authDocumentation, s.authKind, s.authMetadata ? JSON.stringify(s.authMetadata) : null
  ];
}
const previousRows = new Map((previous ?? []).map((s) => [s.name, s]));
const newServers = servers.filter((s) => !previousRows.has(s.name));
const changedServers = servers.filter((s) => previousRows.has(s.name));

/**
 * SQLite rewrites every index whose column is in the SET list, whether the
 * value changed or not, and D1 counts each index entry as a row written. So a
 * changed server gets an UPDATE that names only the columns that differ from
 * the previous run. Rows with the same set of changed columns share one
 * statement through UPDATE ... FROM (VALUES ...).
 */
function narrowUpdates(rows: ServerRow[]): string[] {
  const groups = new Map<string, { columns: string[]; values: Value[][] }>();
  for (const s of rows) {
    const before = serverValues(previousRows.get(s.name)!);
    const after = serverValues(s);
    // The two latencies differ on every probe and sit in two indexes each. They are written only when the result changed; the probes table keeps the fresh value.
    const statusChanged = s.status !== previousRows.get(s.name)!.status;
    const changed = serverColumns.filter((c, i) => c !== 'name' && lit(before[i]) !== lit(after[i]) && (statusChanged || (c !== 'init_ms' && c !== 'tools_ms' && c !== 'error')));
    if (!changed.length) continue;
    const key = changed.join(',');
    const g = groups.get(key) ?? groups.set(key, { columns: changed, values: [] }).get(key)!;
    g.values.push([s.name, ...changed.map((c) => after[serverColumns.indexOf(c)])]);
  }
  const out: string[] = [];
  for (const { columns, values } of groups.values()) {
    const cols = ['name', ...columns].map((c) => `c_${c}`);
    for (let i = 0; i < values.length; i += rowsPerInsert) {
      const chunk = values.slice(i, i + rowsPerInsert).map((r) => `(${r.map(lit).join(',')})`);
      // A CTE with a column list is the one form of a named VALUES table that SQLite accepts.
      out.push(`WITH v(${cols.join(',')}) AS (VALUES\n${chunk.join(',\n')})\nUPDATE servers SET ${columns.map((c) => `${c}=v.c_${c}`).join(', ')} FROM v WHERE servers.name = v.c_name;`);
    }
  }
  return out;
}
const serverStatements = [
  ...multiInsert('servers', serverColumns, newServers.map(serverValues), 'INSERT', upsertSuffix('name', serverColumns)),
  ...narrowUpdates(changedServers)
];
/** History gets a row when the result, the tool count or a token count changed; a new registry entry gets its first row. */
const probeRows = servers
  .filter((s) => {
    const p = previousRows.get(s.name);
    return !p || p.status !== s.status || p.toolCount !== s.toolCount || p.toolsTokens !== s.toolsTokens || p.claudeTokens !== s.claudeTokens;
  })
  .map((s) => [s.name, s.probedAt, s.status, s.initMs, s.toolCount, s.toolsTokens, s.claudeTokens]);
// The hosts table is not written any more: the hosts page reads the biggest hosts from the run summary.

/**
 * Rows the database holds with another status than this run found, outside the
 * ordinary diff: written whole, alive servers first, at most --repair-limit a run.
 * Rows the database has and the registry no longer lists: deleted, at most --delete-limit.
 */
const written = new Set(servers.map((s) => s.name));
const rank = (s: ServerRow) => (s.status === 'ok' ? 0 : GATED_STATUSES.has(s.status) ? 1 : 2);
const drifted = d1Status.size
  ? allServers.filter((s) => !written.has(s.name) && d1Status.has(s.name) && d1Status.get(s.name) !== s.status).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  : [];
/**
 * Writes per row, counted the way D1 counts them (the row plus one entry per index touched,
 * plus the FTS triggers): with the seven indexes left a new or whole row costs about 11, a narrow
 * update about 6, a delete about 10, a history row 2. The repair takes what the ordinary import leaves.
 */
const ordinaryWrites = newServers.length * 11 + changedServers.length * 6 + probeRows.length * 2 + removed.length * 10 + 2;
const left = Math.max(0, Number(args['write-budget']) - ordinaryWrites);
const staleAll = d1Status.size ? [...d1Status.keys()].filter((n) => !currentNames.has(n) && !removed.includes(n)) : [];
const stale = staleAll.slice(0, Math.min(Number(args['delete-limit']), Math.floor(left / 10 / 4)));
const repaired = drifted.slice(0, Math.min(Number(args['repair-limit']), Math.floor((left - stale.length * 10) / 11)));
const repairStatements = [
  ...multiInsert('servers', serverColumns, repaired.map(serverValues), 'INSERT', upsertSuffix('name', serverColumns)),
  ...multiInsert('probes', ['name', 'probed_at', 'status', 'init_ms', 'tool_count', 'tools_tokens', 'claude_tokens'], repaired.map((s) => [s.name, s.probedAt, s.status, s.initMs, s.toolCount, s.toolsTokens, s.claudeTokens]), 'INSERT OR IGNORE'),
  ...(stale.length ? [`DELETE FROM servers WHERE name IN (${stale.map(lit).join(',')});`] : [])
];

const statements = [
  `INSERT OR REPLACE INTO runs (probed_at, summary) VALUES (${lit(summary.probedAt)}, ${lit(JSON.stringify(summary))});`,
  ...serverStatements,
  ...multiInsert('probes', ['name', 'probed_at', 'status', 'init_ms', 'tool_count', 'tools_tokens', 'claude_tokens'], probeRows, 'INSERT OR IGNORE'),
  ...(removed.length ? [`DELETE FROM servers WHERE name IN (${removed.map(lit).join(',')});`] : []),
  // Keep 90 days of history so the free tier database stays small.
  `DELETE FROM probes WHERE probed_at < ${lit(new Date(Date.now() - 90 * 86_400_000).toISOString())};`,
  // Last, so the ordinary import is complete even when the write budget runs out here.
  ...repairStatements
];
if (d1Status.size) console.error(`drift against the database: ${drifted.length} rows differ in status, ${repaired.length} repaired in this run, ${stale.length} of ${staleAll.length} stale rows deleted; about ${ordinaryWrites} writes for the ordinary import, ${repaired.length * 11 + stale.length * 10} for the repair, budget ${args['write-budget']}`);
await writeFile(args.out, statements.join('\n') + '\n');
await writeFile(`${args.in}/changed.json`, JSON.stringify({ changed: servers.map((s) => s.name), removed }));
console.error(
  previous
    ? `wrote ${statements.length} statements: ${newServers.length} new and ${changedServers.length} changed of ${allServers.length} servers, ${removed.length} removed, to ${args.out}`
    : `wrote ${statements.length} statements for ${servers.length} servers to ${args.out}`
);
