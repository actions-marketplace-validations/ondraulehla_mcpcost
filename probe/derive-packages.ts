/**
 * For remote servers that need auth: the publisher's open-source package, found
 * in the repository the registry entry names. The weekly stdio run then
 * measures that package in a container, and the board shows its tool set on
 * the remote server's page.
 *
 *   node --import tsx probe/derive-packages.ts --servers data/latest/servers.json --cache data/cache/derived-packages.json
 *   node --import tsx probe/derive-packages.ts --repos stripe/ai,supabase/mcp --dry-run
 *
 * One tree request per repository, at most five manifest reads, one registry
 * check. A repository is looked at again after 30 days. GITHUB_TOKEN raises
 * the rate limit from 60 to 5 000 requests an hour.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { githubRepo, hintWords, packageFromPackageJson, packageFromPyproject, pickCandidates, type DerivedPackage, type TreeEntry } from '../packages/mcpcost/src/derive.js';

const { values: args } = parseArgs({
  options: {
    servers: { type: 'string', default: 'data/latest/servers.json' },
    cache: { type: 'string', default: 'data/cache/derived-packages.json' },
    aliases: { type: 'string', default: 'probe/derived-aliases.json' },
    /** Comma-separated owner/name list: resolve these only and print the result. */
    repos: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    /** At most this many repositories looked up in one run. */
    max: { type: 'string', default: '400' },
    'recheck-days': { type: 'string', default: '30' }
  }
});

interface RepoResult {
  checkedAt: string;
  /** The repository after renames, owner/name. */
  repo: string;
  package?: DerivedPackage & { version?: string };
  reason?: string;
}
interface Cache {
  version: 1;
  repos: Record<string, RepoResult>;
  /** Remote server name → package, what the stdio run reads. */
  derived: Record<string, { registry: 'npm' | 'pypi'; name: string; repo?: string; source: 'repository' | 'alias'; checkedAt: string }>;
}
interface ServerRow {
  name: string;
  host: string;
  status: string;
  transport: string;
  repo?: string;
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'mcpcost-derive (+https://github.com/ondraulehla/mcpcost)' };
if (token) headers.authorization = `Bearer ${token}`;
let remaining = Infinity;

async function github(url: string): Promise<Response> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const r = res.headers.get('x-ratelimit-remaining');
  if (r) remaining = Number(r);
  return res;
}

/** Does the package exist on its registry? Returns the latest version when it does. */
async function published(pkg: DerivedPackage): Promise<string | undefined> {
  try {
    if (pkg.registry === 'npm') {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%40', '@')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      const meta = (await res.json()) as { 'dist-tags'?: { latest?: string } };
      return meta['dist-tags']?.latest ?? 'latest';
    }
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const meta = (await res.json()) as { info?: { version?: string } };
    return meta.info?.version ?? 'latest';
  } catch {
    return undefined;
  }
}

/** The package of one repository, or the reason there is none. */
async function resolveRepo(repo: string, hints: string[]): Promise<RepoResult> {
  const checkedAt = new Date().toISOString();
  const info = await github(`https://api.github.com/repos/${repo}`);
  if (info.status === 404) return { checkedAt, repo, reason: 'repository not found' };
  if (!info.ok) return { checkedAt, repo, reason: `GitHub ${info.status}` };
  const meta = (await info.json()) as { full_name: string; default_branch: string; archived?: boolean };
  const full = meta.full_name;
  const tree = await github(`https://api.github.com/repos/${full}/git/trees/${encodeURIComponent(meta.default_branch)}?recursive=1`);
  if (!tree.ok) return { checkedAt, repo: full, reason: `tree ${tree.status}` };
  const { tree: entries, truncated } = (await tree.json()) as { tree: TreeEntry[]; truncated?: boolean };
  const candidates = pickCandidates(entries, 5, hints);
  if (!candidates.length) return { checkedAt, repo: full, reason: truncated ? 'tree truncated, no manifest seen' : 'no package.json or pyproject.toml' };
  for (const c of candidates) {
    const raw = await fetch(`https://raw.githubusercontent.com/${full}/${meta.default_branch}/${c.path}`, { headers: { 'user-agent': headers['user-agent'] }, signal: AbortSignal.timeout(20_000) });
    if (!raw.ok) continue;
    const text = await raw.text();
    let pkg: DerivedPackage | undefined;
    if (c.kind === 'npm') {
      try {
        pkg = packageFromPackageJson(JSON.parse(text), c.path);
      } catch {
        pkg = undefined;
      }
    } else pkg = packageFromPyproject(text, c.path);
    if (!pkg) continue;
    const version = await published(pkg);
    if (!version) return { checkedAt, repo: full, reason: `${pkg.name} is not on ${pkg.registry}` };
    return { checkedAt, repo: full, package: { ...pkg, version } };
  }
  return { checkedAt, repo: full, reason: 'no manifest with a bin that looks like an MCP server' };
}

const cache: Cache = existsSync(args.cache) ? { version: 1, repos: {}, derived: {}, ...(JSON.parse(await readFile(args.cache, 'utf8')) as Partial<Cache>) } : { version: 1, repos: {}, derived: {} };
const recheckMs = Number(args['recheck-days']) * 86_400_000;

if (args.repos) {
  for (const repo of args.repos.split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = await resolveRepo(repo, hintWords(repo));
    console.log(`${repo}: ${r.package ? `${r.package.registry} ${r.package.name}@${r.package.version} (${r.package.path})` : r.reason}`);
  }
  process.exit(0);
}

const servers = JSON.parse(await readFile(args.servers, 'utf8')) as ServerRow[];
const gated = servers.filter((s) => s.transport !== 'stdio' && (s.status === 'auth' || s.status === 'payment'));
const aliases = existsSync(args.aliases) ? (JSON.parse(await readFile(args.aliases, 'utf8')) as Record<string, { registry: 'npm' | 'pypi'; name: string } | string>) : {};
const now = new Date().toISOString();
let looked = 0;
let found = 0;
const max = Number(args.max);

for (const s of gated) {
  const alias = aliases[s.name];
  if (alias && typeof alias === 'object') {
    const known = cache.derived[s.name];
    if (known?.source === 'alias' && known.name === alias.name) continue;
    const version = await published({ ...alias, path: '' });
    if (version) {
      cache.derived[s.name] = { registry: alias.registry, name: alias.name, source: 'alias', checkedAt: now };
      found++;
    } else console.error(`alias for ${s.name}: ${alias.name} is not on ${alias.registry}, skipped`);
    continue;
  }
  const repo = githubRepo(s.repo);
  if (!repo) continue;
  const key = repo.toLowerCase();
  let r = cache.repos[key];
  if (!r || Date.now() - Date.parse(r.checkedAt) > recheckMs) {
    if (looked >= max || remaining < 50) continue;
    looked++;
    r = await resolveRepo(repo, hintWords(s.name, s.host));
    cache.repos[key] = r;
    console.error(`  ${repo}: ${r.package ? `${r.package.registry} ${r.package.name}` : r.reason}`);
  }
  if (r.package) {
    cache.derived[s.name] = { registry: r.package.registry, name: r.package.name, repo: r.repo, source: 'repository', checkedAt: r.checkedAt };
    found++;
  } else delete cache.derived[s.name];
}
// Servers that are not gated any more, or left the registry, drop out of the list.
const gatedNames = new Set(gated.map((s) => s.name));
for (const name of Object.keys(cache.derived)) if (!gatedNames.has(name)) delete cache.derived[name];

if (!args['dry-run']) {
  await mkdir(path.dirname(args.cache), { recursive: true });
  await writeFile(args.cache, JSON.stringify(cache, null, 1));
}
console.error(`${gated.length} gated servers, ${looked} repositories looked up now, ${Object.keys(cache.derived).length} servers with a derived package (${found} touched)${args['dry-run'] ? ', dry run' : ` → ${args.cache}`}`);
