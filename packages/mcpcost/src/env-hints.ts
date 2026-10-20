/**
 * A package server that exits on start often says what it wants:
 * "PRIMATE_API_KEY is not set", "No API key found. Pass NOTION_TOKEN".
 * The names it mentions get placeholder values on a second attempt.
 */
const SKIP = /^(ERR_|NODE_|UND_|NPM_|UV_|PATH$|HOME$|HTTP_|HTTPS_|JSON_|MCP_SERVER$|TODO|README)/;

/** Environment variable names an error message mentions, at most ten. */
export function envNamesFromError(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    const n = m[1];
    if (n.length >= 5 && n.length <= 60 && !SKIP.test(n)) names.add(n);
  }
  return [...names].slice(0, 10);
}
