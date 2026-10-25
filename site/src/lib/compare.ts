import { findByUrl, getServer } from './db';
import { label } from './format';
import { compare, unknownRow, type CompareFormat, type CompareRow, type Comparison } from '../../../packages/mcpcost/src/compare.ts';

const SITE = 'https://mcpcost.ulehla.dev';

/** At most this many servers side by side: one point read per name, nothing else. */
export const COMPARE_MAX = 5;

/** The names or URLs a request gave, trimmed, without repeats, at most COMPARE_MAX. */
export function compareIds(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const id = r.trim().slice(0, 300);
    if (id && !out.includes(id)) out.push(id);
    if (out.length === COMPARE_MAX) break;
  }
  return out;
}

/** Two to five board rows side by side, from the latest daily probe. A name the board does not know gets an "unknown" row. */
export async function compareOnBoard(ids: string[], format: CompareFormat = 'json'): Promise<Comparison> {
  const rows: CompareRow[] = await Promise.all(
    ids.map(async (id) => {
      const name = /^https?:\/\//.test(id) ? await findByUrl(id) : id;
      const s = name ? await getServer(name) : null;
      if (!s) return unknownRow(id);
      const tokens = s.claude_tokens ?? s.tools_tokens;
      return {
        name: s.name, host: s.host, status: s.status, failingSince: s.failing_since, statusLabel: label(s.status), authKind: s.auth_kind,
        toolCount: s.tool_count, claudeTokens: s.claude_tokens, toolsTokens: s.tools_tokens, tokens, exact: s.claude_tokens != null,
        shareOf200k: tokens != null ? Number(((tokens / 200_000) * 100).toFixed(2)) : null,
        initMs: s.init_ms, protocolVersion: s.protocol_version, probedAt: s.probed_at, page: `${SITE}/s/${s.name}`
      };
    })
  );
  return compare(rows, format);
}
