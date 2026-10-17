/**
 * Finding the runnable package of an MCP server in its source repository: the
 * pure part. probe/derive-packages.ts does the GitHub and registry requests.
 *
 * A remote server that needs auth cannot be measured without an account, but
 * its tool definitions do not depend on the token. When the publisher's
 * package is on npm or PyPI, it runs in a container with placeholder values
 * and lists the same tools.
 */

export interface TreeEntry {
  path: string;
  type: string;
}

export interface Candidate {
  path: string;
  kind: 'npm' | 'pypi';
  /** Lower is better: a path that mentions mcp, then a shorter path. */
  rank: number;
}

export interface DerivedPackage {
  registry: 'npm' | 'pypi';
  name: string;
  /** The path of the manifest in the repository. */
  path: string;
}

const SKIP = /(^|\/)(node_modules|test|tests|__tests__|spec|examples?|docs?|website|site|ui|frontend|dashboard|playground|benchmarks?|fixtures?|scripts?)(\/|$)/i;

/**
 * The manifests worth reading, best first, at most `limit`. Depth at most 3 directories.
 * `hints` are words from the server's name and host; a path that carries one ranks first,
 * so a monorepo with several MCP packages yields the one for this server.
 */
export function pickCandidates(tree: TreeEntry[], limit = 5, hints: string[] = []): Candidate[] {
  const words = hints.map((h) => h.toLowerCase()).filter((h) => h.length >= 3 && !['mcp', 'server', 'com', 'org', 'app', 'www', 'github', 'api'].includes(h));
  const out: Candidate[] = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    const p = t.path;
    const kind = /(^|\/)package\.json$/.test(p) ? 'npm' : /(^|\/)pyproject\.toml$/.test(p) ? 'pypi' : null;
    if (!kind) continue;
    if ((p.match(/\//g)?.length ?? 0) > 3) continue;
    if (SKIP.test(p.slice(0, p.lastIndexOf('/') + 1))) continue;
    const mentionsMcp = /mcp|model-?context/i.test(p);
    const lower = p.toLowerCase();
    const hinted = words.some((w) => lower.includes(w));
    out.push({ path: p, kind, rank: (hinted ? -1000 : 0) + (mentionsMcp ? 0 : 100) + p.length });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/** The npm package in a package.json, when it is publishable and has a command to run. */
export function packageFromPackageJson(json: unknown, path: string): DerivedPackage | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const p = json as { name?: unknown; bin?: unknown; private?: unknown; mcpName?: unknown };
  if (typeof p.name !== 'string' || !p.name || p.private === true) return undefined;
  const bins = typeof p.bin === 'string' ? [p.name.split('/').pop()!] : p.bin && typeof p.bin === 'object' ? Object.keys(p.bin as object) : [];
  if (!bins.length) return undefined;
  const looksLikeMcp = /mcp|model-?context/i.test(p.name) || bins.some((b) => /mcp/i.test(b)) || /mcp/i.test(path) || typeof p.mcpName === 'string';
  if (!looksLikeMcp) return undefined;
  return { registry: 'npm', name: p.name, path };
}

/** The PyPI package in a pyproject.toml, when it declares a project name and a console script. A small TOML reader, enough for these two tables. */
export function packageFromPyproject(text: string, path: string): DerivedPackage | undefined {
  const project = section(text, 'project');
  if (!project) return undefined;
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(project)?.[1];
  if (!name) return undefined;
  const scripts = section(text, 'project.scripts');
  const hasScript = Boolean(scripts && /^\s*[\w.-]+\s*=\s*["']/m.test(scripts));
  if (!hasScript) return undefined;
  const looksLikeMcp = /mcp|model-?context/i.test(name) || /mcp/i.test(path) || /mcp/i.test(scripts ?? '');
  if (!looksLikeMcp) return undefined;
  return { registry: 'pypi', name, path };
}

/** The body of one TOML table, up to the next table header. */
function section(text: string, header: string): string | undefined {
  const re = new RegExp(`^\\[${header.replace(/\./g, '\\.')}\\]\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m.index + m[0].length);
  const next = /^\[[^\]]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Words of a registry name and host, for pickCandidates: io.github.getsentry/sentry-mcp → getsentry, sentry. */
export function hintWords(name: string, host?: string): string[] {
  const parts = `${name} ${host ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(parts)];
}

/** owner/name from a repository URL on GitHub, or undefined for anything else. */
export function githubRepo(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const m = /^(?:https?:\/\/|git@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
