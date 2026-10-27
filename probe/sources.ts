/**
 * Public MCP servers that the official registry does not list, from two catalogs under the MIT license: Docker's MCP
 * Catalog, and awesome-remote-mcp-servers, whose entries answered an initialize handshake when they were added. Many
 * are the official servers of known vendors (Asana, HubSpot, Cloudflare), so a board without them is not the whole
 * picture. Only remote endpoints.
 *
 * Each catalog endpoint becomes a registry-shaped entry with the status "listed" and the name that a server tracked
 * from /check gets (url/<host>/<path>), so a URL that someone tracks and a catalog lists is one server. An endpoint
 * that a registry entry has, under either transport path (/mcp or /sse), stays the registry's.
 */
import type { RegistryEntry, RegistryRemote } from '../packages/mcpcost/src/index.js';

export interface Source {
  name: string;
  /** The catalog's own page, for the link on the board. */
  url: string;
  /** What the probe reads. */
  data: string;
}
export const DOCKER: Source = { name: "Docker's MCP Catalog", url: 'https://hub.docker.com/mcp', data: 'https://desktop.docker.com/mcp/catalog/v3/catalog.json' };
export const AWESOME_REMOTE: Source = {
  name: 'awesome-remote-mcp-servers',
  url: 'https://github.com/punkpeye/awesome-remote-mcp-servers',
  data: 'https://raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md'
};

/** Where a catalog lists one server: the catalog's name and the page that shows the server, or the list. */
export interface Listing {
  name: string;
  url: string;
}

/** One endpoint as a catalog lists it. */
export interface Listed {
  url: string;
  transport: 'streamable-http' | 'sse';
  title: string;
  description?: string;
  website?: string;
  listing: Listing;
}

/** The registry-shaped entry of a listed server and the catalogs that list it. */
export type ListedEntry = RegistryEntry & { listedIn: Listing[] };

/** The key in the cached registry file that carries the listings: probe/run.ts writes it, probe/build-data.ts reads it. */
export const LISTED_META = 'dev.ulehla.mcpcost/listed';

/** The board name of an endpoint outside the registry. The same rule as trackedName in site/src/lib/track.ts. */
export function listedName(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '').replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\/+/g, '/');
  return `url/${url.hostname.toLowerCase()}${path}`;
}

/** One endpoint, however it is written: the host in lower case without www, the path without a trailing slash, no query. */
export function endpointKey(raw: string): string | undefined {
  if (/[{}]|\$\{/.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** One server under both of its transport paths: a last /mcp or /sse (or both) is dropped, so x/mcp and x/sse are one. */
export function familyKey(raw: string): string | undefined {
  let k = endpointKey(raw);
  for (let i = 0; k && i < 2 && /\/(mcp|sse)$/.test(k); i++) k = k.replace(/\/(mcp|sse)$/, '');
  return k;
}

const transportOf = (url: string): Listed['transport'] => (/\/sse\/?$/.test(new URL(url).pathname) ? 'sse' : 'streamable-http');

/** The remote servers of Docker's catalog (catalog.json: registry.<id> with type "remote"). */
export function parseDocker(json: unknown): Listed[] {
  const registry = (json as { registry?: Record<string, { type?: string; title?: string; description?: string; remote?: { url?: string; transport_type?: string } }> })?.registry ?? {};
  const out: Listed[] = [];
  for (const [id, s] of Object.entries(registry)) {
    const url = s.remote?.url?.trim();
    if (s.type !== 'remote' || !url || !endpointKey(url)) continue;
    out.push({
      url,
      transport: s.remote?.transport_type === 'sse' ? 'sse' : 'streamable-http',
      title: (s.title ?? id).trim(),
      description: s.description?.trim() || undefined,
      listing: { name: DOCKER.name, url: `https://hub.docker.com/mcp/server/${encodeURIComponent(id)}/overview` }
    });
  }
  return out;
}

/**
 * The servers of awesome-remote-mcp-servers. An entry is "- [Name](homepage) `endpoint`", then badge lines, then a
 * line with a lock (open, OAuth or token) and the description. Only the part under "## Servers" is read.
 */
export function parseAwesomeRemote(markdown: string): Listed[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+Servers\b/.test(l));
  const out: Listed[] = [];
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const m = /^- \[([^\]]+)\]\(([^)\s]+)\)\s+`(https?:\/\/[^`\s]+)`/.exec(lines[i]);
    if (!m || !endpointKey(m[3])) continue;
    let description: string | undefined;
    for (let j = i + 1; j < lines.length && j <= i + 4 && !lines[j].startsWith('- '); j++) {
      const d = /^\s+(?:\p{Extended_Pictographic}️?\s*)?-\s+(.+)$/u.exec(lines[j]);
      if (d) {
        description = d[1].trim();
        break;
      }
    }
    out.push({ url: m[3], transport: transportOf(m[3]), title: m[1].trim(), description, website: /^https?:\/\//.test(m[2]) ? m[2] : undefined, listing: { name: AWESOME_REMOTE.name, url: AWESOME_REMOTE.url } });
  }
  return out;
}

/**
 * The catalog endpoints that no registry entry has, one entry per server: the listings of one server (by family key)
 * are merged, the streamable-http endpoint first and the other one as the fallback the probe tries when it fails.
 */
export function listedEntries(listed: Listed[], registry: RegistryEntry[], now: string): ListedEntry[] {
  const inRegistry = new Set<string>();
  for (const e of registry) for (const r of e.server.remotes ?? []) {
    const k = familyKey(r.url);
    if (k) inRegistry.add(k);
  }
  const byFamily = new Map<string, Listed[]>();
  for (const l of listed) {
    const k = familyKey(l.url);
    if (!k || inRegistry.has(k)) continue;
    byFamily.set(k, [...(byFamily.get(k) ?? []), l]);
  }
  const out: ListedEntry[] = [];
  for (const group of byFamily.values()) {
    const remotes: RegistryRemote[] = [];
    for (const l of [...group.filter((g) => g.transport === 'streamable-http'), ...group.filter((g) => g.transport === 'sse')]) {
      if (!remotes.some((r) => endpointKey(r.url) === endpointKey(l.url))) remotes.push({ type: l.transport, url: l.url });
    }
    const docker = group.find((g) => g.listing.name === DOCKER.name);
    const first = docker ?? group[0];
    const listedIn: Listing[] = [];
    for (const g of group) if (!listedIn.some((x) => x.name === g.listing.name)) listedIn.push(g.listing);
    out.push({
      server: {
        name: listedName(new URL(remotes[0].url)),
        title: first.title,
        description: (docker?.description ?? group.find((g) => g.description)?.description)?.slice(0, 300),
        websiteUrl: group.find((g) => g.website)?.website,
        remotes: remotes.slice(0, 2)
      },
      meta: { status: 'listed', publishedAt: now, updatedAt: now, isLatest: true },
      listedIn
    });
  }
  return out.sort((a, b) => (a.server.name < b.server.name ? -1 : a.server.name > b.server.name ? 1 : 0));
}

/** Both catalogs, read once a run. A catalog that cannot be read is left out of this run, with a line in the log. */
export async function loadListed(registry: RegistryEntry[], fetcher: typeof fetch = fetch): Promise<ListedEntry[]> {
  const get = async (source: Source, parse: (body: string) => Listed[]): Promise<Listed[]> => {
    try {
      const res = await fetcher(source.data, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'mcpcost-probe (+https://mcpcost.ulehla.dev/methodology)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const listed = parse(await res.text());
      console.error(`${source.name}: ${listed.length} remote endpoints`);
      return listed;
    } catch (e) {
      console.error(`${source.name} not loaded: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const all = [...(await get(DOCKER, (b) => parseDocker(JSON.parse(b)))), ...(await get(AWESOME_REMOTE, parseAwesomeRemote))];
  return listedEntries(all, registry, new Date().toISOString());
}
