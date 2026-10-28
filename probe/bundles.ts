/**
 * Registry entries whose remotes are several servers. The registry means the remotes of an entry as ways to reach one
 * server (a transport, a region), and the probe measures the first one. Some publishers list a set of servers in one
 * entry instead: com.cloudflare.mcp/mcp has 15 (docs, radar, browser, ...), each under /mcp and /sse. The probe then
 * measured docs only, and fell back to radar when docs failed, under the entry's name.
 *
 * An entry whose callable remotes belong to BUNDLE_MIN or more servers (family keys, see probe/sources.ts) is a bundle.
 * Its first server keeps the entry's name and row, and its fallbacks stay inside that server. Each other server gets a
 * row of its own with the status "bundled", named like a URL tracked from /check (url/<host>/<path>), with a link back
 * to the entry. Regional or per-client copies of one server are bundles by this rule too; their pages say "one of the N
 * servers of the entry", which is true for both. Two remotes are left as they are: mostly a public and a signed-in path
 * of one server, where the second one is the right fallback.
 */
import type { RegistryEntry, RegistryRemote } from '../packages/mcpcost/src/index.js';
import { endpointKey, familyKey, listedName, type Listed, type Listing } from './sources.js';

/** The fewest servers in one entry that make it a bundle. */
export const BUNDLE_MIN = 3;

/** The key in the cached registry file that carries the bundle of an entry or of one of its servers. */
export const BUNDLE_META = 'dev.ulehla.mcpcost/bundle';

/** On the entry: its other servers. On one of them: the entry, and the catalogs that list it on its own. */
export type Bundle =
  | { members: Array<{ name: string; host: string }>; servers: number }
  | { entry: string; servers: number; listedIn?: Listing[] };

export type BundledEntry = RegistryEntry & { bundle: Bundle };

const callable = (r: RegistryRemote) => (r.type === 'streamable-http' || r.type === 'sse') && endpointKey(r.url) !== undefined;

/** The servers of an entry in the probe's order (streamable-http first): one family key each, with its remotes. */
export function familiesOf(entry: RegistryEntry): Array<{ key: string; remotes: RegistryRemote[] }> {
  const remotes = entry.server.remotes ?? [];
  const ordered = [...remotes.filter((r) => r.type === 'streamable-http'), ...remotes.filter((r) => r.type === 'sse')].filter(callable);
  const out: Array<{ key: string; remotes: RegistryRemote[] }> = [];
  for (const r of ordered) {
    const key = familyKey(r.url)!;
    const f = out.find((x) => x.key === key);
    if (f) {
      if (!f.remotes.some((x) => endpointKey(x.url) === endpointKey(r.url))) f.remotes.push(r);
    } else out.push({ key, remotes: [r] });
  }
  return out;
}

/**
 * Splits the bundles of the registry. Returns:
 * - targets: the registry with each bundle cut to its first server, so the probe does not fall back to another server
 *   under the entry's name. The cached registry file keeps the whole entry; only the probe gets the cut one.
 * - members: one entry per other server of a bundle. A catalog that lists such a server on its own gives it its title
 *   and description. A URL in two bundles is one member, the first.
 * - entries: the bundle of each entry that is one, by name, for its row.
 */
export function splitBundles(registry: RegistryEntry[], catalog: Listed[] = []): { targets: RegistryEntry[]; members: BundledEntry[]; entries: Map<string, Bundle> } {
  const byFamily = new Map<string, Listed[]>();
  for (const l of catalog) {
    const k = familyKey(l.url);
    if (k) byFamily.set(k, [...(byFamily.get(k) ?? []), l]);
  }
  const members: BundledEntry[] = [];
  const targets: RegistryEntry[] = [];
  const entries = new Map<string, Bundle>();
  const taken = new Set(registry.map((e) => e.server.name));
  for (const e of registry) {
    const families = familiesOf(e);
    if (families.length < BUNDLE_MIN) {
      targets.push(e);
      continue;
    }
    const [first, ...rest] = families;
    const own: BundledEntry[] = rest.flatMap((f) => {
      const url = new URL(f.remotes[0].url);
      const name = listedName(url);
      if (taken.has(name)) return [];
      taken.add(name);
      const listed = byFamily.get(f.key) ?? [];
      const listedIn: Listing[] = [];
      for (const l of listed) if (!listedIn.some((x) => x.name === l.listing.name)) listedIn.push(l.listing);
      const member: BundledEntry = {
        server: {
          name,
          title: listed.find((l) => l.title)?.title ?? e.server.title ?? e.server.name,
          description: (listed.find((l) => l.description)?.description ?? e.server.description)?.slice(0, 300),
          websiteUrl: e.server.websiteUrl,
          repository: e.server.repository,
          remotes: f.remotes.slice(0, 2)
        },
        meta: { ...e.meta, status: 'bundled' },
        bundle: { entry: e.server.name, servers: families.length, ...(listedIn.length ? { listedIn } : {}) }
      };
      return [member];
    });
    members.push(...own);
    targets.push({ server: { ...e.server, remotes: first.remotes }, meta: e.meta });
    entries.set(e.server.name, { members: own.map((m) => ({ name: m.server.name, host: new URL(m.server.remotes![0].url).hostname })), servers: families.length });
  }
  return { targets, members, entries };
}
