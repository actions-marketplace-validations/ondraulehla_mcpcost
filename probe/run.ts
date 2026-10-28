/**
 * Probes a sample of remote servers from the MCP registry and writes the results
 * to data/. Usage:
 *   npm run probe -- --sample 200 --per-host 2 --concurrency 16
 *   npm run probe -- --all --out data/raw/probe-all.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchRegistry, hostOf, remoteCandidates, isFailing, CLAUDE_MODEL } from '../packages/mcpcost/src/index.js';
import type { RemoteTemplate } from '../packages/mcpcost/src/index.js';
import { probeRemoteRaw } from '../packages/mcpcost/src/core.js';
import { priceTools } from '../packages/mcpcost/src/probe.js';
import { createClaudeCounter, payloadHash, reportKeyError } from './claude-cache.js';
import { shardOf, todayShard } from './shard.js';
import { LISTED_META, familyKey, listedEntries, loadCatalogs, type ListedEntry } from './sources.js';
import { BUNDLE_META, splitBundles, type Bundle, type BundledEntry } from './bundles.js';
import { createGeminiCounter } from './gemini-cache.js';
import { loadCredentials, saveCredentials, credentialsFor, type CredentialStore, type FileProvider } from '../packages/mcpcost/src/credentials.js';
import type { ProbeResult, RegistryEntry } from '../packages/mcpcost/src/index.js';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '200' },
    'per-host': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '16' },
    timeout: { type: 'string', default: '15000' },
    all: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    cache: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string' },
    /** servers.json of the previous run. Servers whose tools did not change keep their Claude count from it. */
    'claude-cache': { type: 'string' },
    'claude-model': { type: 'string', default: CLAUDE_MODEL },
    /** count_tokens requests a minute. Small organisations get 100. */
    'claude-rpm': { type: 'string', default: '90' },
    /** Minutes after start when counting stops. Servers left over are counted next run. */
    'claude-deadline-min': { type: 'string', default: '270' },
    /** Servers tracked on request, outside the registry. Empty string: none. */
    tracked: { type: 'string', default: 'https://mcpcost.ulehla.dev/api/tracked.json' },
    /** Credentials for servers that need auth, see packages/mcpcost/src/credentials.ts. A missing file means none. */
    credentials: { type: 'string' },
    'gemini-model': { type: 'string', default: 'gemini-3.8-flash' },
    'gemini-rpm': { type: 'string', default: '60' }
  }
});
const started = Date.now();

const sampleSize = Number(args.sample);
const perHost = Number(args['per-host']);
let concurrency = Number(args.concurrency);
const timeoutMs = Number(args.timeout);

interface Target {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse';
  host: string;
  updatedAt: string;
  status: string;
  /** The entry's other endpoints, tried in order when this one does not give a valid answer. */
  alternates?: Array<{ url: string; type: 'streamable-http' | 'sse' }>;
  /** Set when every endpoint has a placeholder that each user fills in: the target is not probed. */
  template?: RemoteTemplate;
}

const credentials: CredentialStore | null = args.credentials && existsSync(args.credentials) ? await loadCredentials(args.credentials) : null;
const providers: FileProvider[] = [];
if (credentials) console.error(`${Object.keys(credentials.servers).length} servers have credentials (${args.credentials})`);

const claude = await createClaudeCounter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  cachePath: args['claude-cache'],
  model: args['claude-model'],
  rpm: Number(args['claude-rpm']) || 90,
  deadline: started + (Number(args['claude-deadline-min']) || 270) * 60_000
});

const gemini = await createGeminiCounter({
  apiKey: process.env.GEMINI_API_KEY,
  cachePath: args['claude-cache'],
  model: args['gemini-model'],
  rpm: Number(args['gemini-rpm']) || 60,
  deadline: started + (Number(args['claude-deadline-min']) || 270) * 60_000
});

/**
 * An entry as the cached registry file keeps it; build-data reads the same file. A listed server carries its catalogs,
 * a bundle and each of its servers carry the bundle (probe/bundles.ts).
 */
function cacheEntry(e: RegistryEntry | ListedEntry | BundledEntry, bundle?: Bundle) {
  const b = bundle ?? ('bundle' in e ? e.bundle : undefined);
  return { server: e.server, _meta: { 'io.modelcontextprotocol.registry/official': e.meta, ...('listedIn' in e ? { [LISTED_META]: e.listedIn } : {}), ...(b ? { [BUNDLE_META]: b } : {}) } };
}

async function loadRegistry(): Promise<RegistryEntry[]> {
  if (existsSync(args.cache)) {
    const raw = JSON.parse(await readFile(args.cache, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
    // The rows that an earlier run added (tracked, listed, the servers of a bundle) are made fresh below.
    return raw.map((r) => ({ server: r.server, meta: r._meta['io.modelcontextprotocol.registry/official'] })).filter((e) => !['tracked', 'listed', 'bundled'].includes(e.meta.status));
  }
  console.error('downloading registry…');
  const entries = await fetchRegistry({ onPage: (n) => n % 2000 === 0 && console.error(`  ${n} entries`) });
  await mkdir('data/raw', { recursive: true });
  await writeFile(args.cache, JSON.stringify(entries.map((e) => cacheEntry(e))));
  return entries;
}

/** The servers tracked on request, as registry-shaped entries with the status "tracked". */
async function loadTracked(): Promise<RegistryEntry[]> {
  if (!args.tracked) return [];
  try {
    const res = await fetch(args.tracked, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'mcpcost-probe' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tracked } = (await res.json()) as { tracked: Array<{ name: string; url: string; transport: 'streamable-http' | 'sse'; submittedAt: string }> };
    return tracked.map((t) => ({
      server: { name: t.name, title: t.url.replace(/^https:\/\//, ''), description: 'Tracked on request. Not in the official MCP registry.', remotes: [{ type: t.transport, url: t.url }] },
      meta: { status: 'tracked', publishedAt: t.submittedAt, updatedAt: t.submittedAt, isLatest: true }
    }));
  } catch (e) {
    console.error(`tracked list not loaded: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A host with this many entries or more is probed one seventh of its entries a day. */
const BIG_HOST = 200;

function pickTargets(entries: RegistryEntry[]): Target[] {
  const all: Target[] = [];
  for (const e of entries) {
    const { candidates, template } = remoteCandidates(e);
    const [first, ...rest] = candidates;
    if (first) {
      all.push({ name: e.server.name, url: first.url, type: first.type, host: hostOf(first.url), updatedAt: e.meta.updatedAt, status: e.meta.status, ...(rest.length ? { alternates: rest.slice(0, 2).map(({ url, type }) => ({ url, type })) } : {}) });
    } else if (template) {
      // The host part of a template can itself be a placeholder ({api_host}); keep it as written.
      const host = template.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] || template.url;
      all.push({ name: e.server.name, url: template.url, type: template.type, host, updatedAt: e.meta.updatedAt, status: e.meta.status, template });
    }
  }
  if (args.all) {
    // A host with hundreds of entries gets as many requests a day, and some limit anonymous clients (pipeworx: 500 a
    // day). Its entries are probed on their day of the seven-day cycle; build-data carries the others from the run before.
    const perHostAll = new Map<string, number>();
    for (const t of all) if (!t.template) perHostAll.set(t.host, (perHostAll.get(t.host) ?? 0) + 1);
    const day = todayShard();
    const big = new Set([...perHostAll].filter(([, n]) => n >= BIG_HOST).map(([h]) => h));
    const kept = all.filter((t) => t.template || !big.has(t.host) || shardOf(t.name) === day);
    if (big.size) console.error(`${big.size} hosts with ${BIG_HOST} or more entries are probed one seventh a day: ${all.length - kept.length} entries wait for their day (${[...big].join(', ')})`);
    return kept;
  }
  const rand = mulberry32(Number(args.seed));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const perHostCount = new Map<string, number>();
  const picked: Target[] = [];
  for (const t of all) {
    const n = perHostCount.get(t.host) ?? 0;
    if (n >= perHost) continue;
    perHostCount.set(t.host, n + 1);
    picked.push(t);
    if (picked.length >= sampleSize) break;
  }
  return picked;
}

/** Runs probes with a global concurrency limit and at most one in flight per host. */
async function runAll(targets: Target[]): Promise<Array<Target & { result: ProbeResult; payloadHash?: string; withCredentials?: boolean }>> {
  const out: Array<Target & { result: ProbeResult; payloadHash?: string; withCredentials?: boolean }> = [];
  const busyHosts = new Set<string>();
  const queue = [...targets];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const idx = queue.findIndex((t) => !busyHosts.has(t.host));
      if (idx === -1) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const [target] = queue.splice(idx, 1);
      busyHosts.add(target.host);
      try {
        let creds = credentials ? credentialsFor(credentials, target.url) : undefined;
        if (creds?.authProvider) providers.push(creds.authProvider);
        let { result, tools } = await probeRemoteRaw({ url: target.url, type: target.type }, { timeoutMs, headers: creds?.headers, authProvider: creds?.authProvider });
        let answered = { url: target.url, type: target.type };
        // An entry with several endpoints is judged by the first one that answers: the others are the same server.
        for (const alt of isFailing(result.status) ? target.alternates ?? [] : []) {
          const altCreds = credentials ? credentialsFor(credentials, alt.url) : undefined;
          if (altCreds?.authProvider) providers.push(altCreds.authProvider);
          const second = await probeRemoteRaw(alt, { timeoutMs, headers: altCreds?.headers, authProvider: altCreds?.authProvider });
          if (isFailing(second.result.status)) continue;
          ({ result, tools } = second);
          answered = alt;
          creds = altCreds;
          break;
        }
        priceTools(result, tools);
        let hash: string | undefined;
        if (result.status === 'ok' && tools.length) {
          hash = payloadHash(tools);
          busyHosts.delete(target.host);
          result.claude = await claude.count(target.name, tools, hash);
          result.gemini = await gemini.count(target.name, tools, hash);
        }
        out.push({ ...target, url: answered.url, type: answered.type, host: hostOf(answered.url), result, payloadHash: hash, withCredentials: creds ? true : undefined });
      } finally {
        busyHosts.delete(target.host);
        done++;
        if (done % 25 === 0 || done === targets.length) {
          const s = Math.round((Date.now() - started) / 1000);
          console.error(`  ${done}/${targets.length} probed (${s}s)`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

function summarize(rows: Array<Target & { result: ProbeResult }>) {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.result.status] = (byStatus[r.result.status] ?? 0) + 1;
  const ok = rows.filter((r) => r.result.status === 'ok');
  const tokens = ok.map((r) => r.result.toolsTokens ?? 0).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);
  const init = ok.map((r) => r.result.latencyMs.initialize ?? 0).sort((a, b) => a - b);
  const top = [...ok].sort((a, b) => (b.result.toolsTokens ?? 0) - (a.result.toolsTokens ?? 0)).slice(0, 10)
    .map((r) => ({ name: r.name, tools: r.result.toolCount, tokens: r.result.toolsTokens }));
  const protocols: Record<string, number> = {};
  for (const r of ok) protocols[r.result.protocolVersion ?? 'unknown'] = (protocols[r.result.protocolVersion ?? 'unknown'] ?? 0) + 1;
  const authSchemes: Record<string, number> = {};
  for (const r of rows.filter((r) => r.result.status === 'auth')) {
    const k = r.result.authScheme ?? 'none';
    authSchemes[k] = (authSchemes[k] ?? 0) + 1;
  }
  return {
    probed: rows.length,
    byStatus,
    ok: ok.length,
    toolsTokens: { median: median(tokens), p90: tokens[Math.floor(tokens.length * 0.9)] ?? 0, max: tokens.at(-1) ?? 0 },
    initializeMs: { median: median(init), p90: init[Math.floor(init.length * 0.9)] ?? 0 },
    protocols,
    authSchemes,
    top
  };
}

const registryEntries = await loadRegistry();
const tracked = await loadTracked();
const catalog = await loadCatalogs();
// An entry that lists several servers is measured server by server (probe/bundles.ts).
const { targets: registryTargets, members, entries: bundles } = splitBundles(registryEntries, catalog);
const listed = listedEntries(catalog, registryEntries, new Date().toISOString());
const known = new Set(registryEntries.map((e) => e.server.name));
// A URL tracked from /check that a bundle or a catalog has is one server: that row takes the tracked name, so the page stays where it was.
const trackedByFamily = new Map(tracked.map((t) => [familyKey(t.server.remotes?.[0]?.url ?? ''), t.server.name]));
const superseded = new Map<string, string>();
for (const e of [...members, ...listed]) {
  const name = trackedByFamily.get(familyKey(e.server.remotes?.[0]?.url ?? ''));
  if (name && ![...superseded.values()].includes(name)) {
    superseded.set(e.server.name, name);
    e.server.name = name;
  }
}
for (const b of bundles.values()) if ('members' in b) for (const m of b.members) m.name = superseded.get(m.name) ?? m.name;
const taken = new Set(superseded.values());
const outside = [...members, ...tracked.filter((t) => !taken.has(t.server.name)), ...listed].filter((e) => !known.has(e.server.name));
const entries = [...registryTargets, ...outside];
// build-data reads the same file, so the rows that are not registry entries must be in it too. The registry entries go in
// whole: a bundle is cut to its first server for the probe only.
await writeFile(args.cache, JSON.stringify([...registryEntries.map((e) => cacheEntry(e, bundles.get(e.server.name))), ...outside.map((e) => cacheEntry(e))]));
console.error(`${bundles.size} entries list several servers: ${members.length} more targets; ${outside.length - members.length - listed.length} tracked and ${listed.length} listed servers added`);
const targets = pickTargets(entries);
console.error(`${registryEntries.length} registry entries and ${outside.length} other rows, ${targets.length} targets, concurrency ${concurrency}, timeout ${timeoutMs}ms`);
/**
 * A URL with a placeholder that each user fills in (https://{tenant}.example.com/mcp) is not called: the literal URL
 * has no DNS name or no route, and that is not a fact about the server. The row says what the user must supply.
 */
function needsUrl(t: Target): Target & { result: ProbeResult } {
  const names = t.template!.missing.map((n) => `{${n}}`).join(', ');
  const error = t.template!.selfHosted
    ? `The URL points to the user's own machine by default (${names}): each user runs the server and sets the URL.`
    : `The URL has placeholders that each user fills in: ${names}.`;
  return { ...t, result: { url: t.url, transport: t.type, probedAt: new Date().toISOString(), status: 'needs_url', latencyMs: {}, error } };
}
const templated = targets.filter((t) => t.template).map(needsUrl);
if (templated.length) console.error(`${templated.length} targets have only URL templates: not probed (needs_url)`);
let rows: Array<Target & { result: ProbeResult; payloadHash?: string; withCredentials?: boolean }> = [...(await runAll(targets.filter((t) => !t.template))), ...templated];
// A transient fault on the runner's side shows up as a wave of timeouts on servers that answered yesterday.
// Those get a second, slower attempt; a server that fails twice keeps its timeout.
const previousStatus = new Map<string, string>();
if (args['claude-cache'] && existsSync(args['claude-cache'])) {
  for (const p of JSON.parse(await readFile(args['claude-cache'], 'utf8')) as Array<{ name: string; status: string }>) previousStatus.set(p.name, p.status);
}
const LIVE_BEFORE = new Set(['ok', 'auth', 'payment', 'newer_protocol', 'rate_limited']);
const retry = rows.filter((r) => r.result.status === 'timeout' && LIVE_BEFORE.has(previousStatus.get(r.name) ?? '')).map(({ result: _r, payloadHash: _h, withCredentials: _c, ...t }) => t);
if (retry.length) {
  console.error(`${retry.length} servers timed out but answered last time: second attempt`);
  concurrency = Math.min(concurrency, 4);
  const again = new Map((await runAll(retry)).map((r) => [r.name, r]));
  rows = rows.map((r) => again.get(r.name) ?? r);
  console.error(`  ${[...again.values()].filter((r) => r.result.status !== 'timeout').length} answered on the second attempt`);
}
const summary = summarize(rows);
if (credentials && args.credentials && providers.some((p) => p.changed)) {
  await saveCredentials(credentials, args.credentials);
  console.error('credentials: refreshed tokens written back');
}
if (claude.enabled) {
  const c = claude.stats();
  console.error(`Claude counts: ${c.counted} servers counted now, ${c.reused} reused from the previous run, ${c.skipped} left for the next run (${c.keyError ? 'the API refused the key' : 'deadline'})`);
  await reportKeyError(c.keyError);
}
else console.error('ANTHROPIC_API_KEY is not set: no exact Claude counts in this run.');
if (gemini.enabled) { const g = gemini.stats(); console.error(`Gemini counts: ${g.counted} servers counted now, ${g.reused} reused from the previous run, ${g.skipped} left for the next run (deadline)`); }
else console.error('GEMINI_API_KEY is not set: no exact Gemini counts in this run.');
const stamp = new Date().toISOString().slice(0, 10);
await mkdir('data/samples', { recursive: true });
const file = args.out ?? `data/samples/probe-${stamp}${args.all ? '-all' : `-n${targets.length}`}.json`;
await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
await writeFile(file, JSON.stringify({ probedAt: new Date().toISOString(), options: { ...args }, summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.error(`written ${file}`);
