import type { RegistryEntry, RegistryRemote, RemoteTransport } from './types.js';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

interface RawPage {
  servers: Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
  metadata: { nextCursor?: string; count: number };
}

export interface FetchRegistryOptions {
  /** Only the latest version of each server. Default true. */
  latest?: boolean;
  /** Page size, max 100. */
  limit?: number;
  /** Stop after this many entries (for tests and samples). */
  max?: number;
  fetch?: typeof fetch;
  onPage?: (loaded: number) => void;
}

/** Downloads the registry listing page by page. */
export async function fetchRegistry(options: FetchRegistryOptions = {}): Promise<RegistryEntry[]> {
  const { latest = true, limit = 100, max = Infinity, onPage } = options;
  const doFetch = options.fetch ?? fetch;
  const entries: RegistryEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = new URL(REGISTRY_URL);
    url.searchParams.set('limit', String(limit));
    if (latest) url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    // The registry answers 5xx now and then in the middle of a 400-page walk. Wait and ask again.
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(url, { headers: { accept: 'application/json' } }).catch((e: unknown) => {
        if (attempt >= 5) throw e;
        return undefined;
      });
      if (res?.ok) break;
      if (attempt >= 5) throw new Error(`registry ${url} responded ${res?.status ?? 'nothing'}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    const page = (await res.json()) as RawPage;
    for (const item of page.servers) {
      entries.push({ server: item.server, meta: item._meta[OFFICIAL_META] });
      if (entries.length >= max) return entries;
    }
    onPage?.(entries.length);
    cursor = page.metadata.nextCursor;
    if (!cursor) return entries;
  }
}

/** Picks the remote endpoint to probe: streamable-http first, then sse. */
export function primaryRemote(entry: RegistryEntry): RegistryRemote | undefined {
  const remotes = entry.server.remotes ?? [];
  return remotes.find((r) => r.type === 'streamable-http') ?? remotes.find((r) => r.type === 'sse');
}

/** A remote endpoint the probe can call. */
export interface RemoteCandidate {
  url: string;
  type: RemoteTransport;
  /** Placeholders that the probe filled in from the registry's default or first choice. */
  filled?: Record<string, string>;
}

/** A remote URL that the probe cannot call as it is: each user fills in some placeholders. */
export interface RemoteTemplate {
  url: string;
  type: RemoteTransport;
  /** The placeholders with no usable value. */
  missing: string[];
  /** True when the registry's default points to the user's own machine (localhost or a private address). */
  selfHosted?: boolean;
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** True for a host on the user's own machine or network: localhost, .local, and private or loopback addresses. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
}

/**
 * The remote endpoints of an entry in the order the probe tries them: streamable-http first, then sse, each in the
 * registry's order. A {placeholder} in a URL is filled from the variable's default, else its first choice. A URL that
 * still has an empty placeholder, or that points to the user's own machine, is not a candidate: the first such URL is
 * the template, which the board shows as "needs a URL of your own".
 */
export function remoteCandidates(entry: RegistryEntry): { candidates: RemoteCandidate[]; template?: RemoteTemplate } {
  const remotes = entry.server.remotes ?? [];
  const ordered = [...remotes.filter((r) => r.type === 'streamable-http'), ...remotes.filter((r) => r.type === 'sse')];
  const candidates: RemoteCandidate[] = [];
  let template: RemoteTemplate | undefined;
  const seen = new Set<string>();
  for (const r of ordered) {
    const names = [...new Set([...r.url.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    const filled: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const v = r.variables?.[name];
      const value = v?.default?.trim() || v?.choices?.find((c) => c.trim())?.trim();
      if (value) filled[name] = value;
      else missing.push(name);
    }
    if (missing.length) {
      template ??= { url: r.url, type: r.type, missing };
      continue;
    }
    const url = names.length ? r.url.replace(PLACEHOLDER, (_, name: string) => filled[name]) : r.url;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      template ??= { url: r.url, type: r.type, missing: names };
      continue;
    }
    if (names.length && isLocalHost(hostname)) {
      template ??= { url: r.url, type: r.type, missing: names, selfHosted: true };
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push(names.length ? { url, type: r.type, filled } : { url, type: r.type });
  }
  return template ? { candidates, template } : { candidates };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
