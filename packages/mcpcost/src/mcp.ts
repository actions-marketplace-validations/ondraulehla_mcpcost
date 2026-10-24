/**
 * mcpcost as an MCP server over stdio: the same measurements as the CLI, for
 * an agent that wants to know what a server costs before it is added to a
 * config. Two tools work offline (they probe the server themselves); four ask
 * the public board for registry data.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION, probeRemote } from './probe.js';
import { probeStdio } from './stdio.js';
import { readConfigFile } from './configs.js';
import type { ProbeResult } from './types.js';
import { compare, formatComparison, rowFromBoard, unknownRow, COMPARE_FORMATS, type CompareFormat } from './compare.js';

const BOARD = 'https://mcpcost.ulehla.dev';

/** The board's JSON for a registry name, or for an endpoint URL through the lookup redirect; neither contacts the server. */
const boardRowUrl = (nameOrUrl: string) => (/^https?:\/\//.test(nameOrUrl) ? `${BOARD}/api/lookup.json?url=${encodeURIComponent(nameOrUrl)}` : `${BOARD}/api/s/${nameOrUrl}.json`);

function compact(r: ProbeResult, window: number) {
  return {
    status: r.status,
    error: r.error,
    protocolVersion: r.protocolVersion,
    serverInfo: r.serverInfo,
    toolCount: r.toolCount,
    toolsTokensEstimate: r.toolsTokens,
    claudeTokens: r.claude?.tokens,
    claudeTokensClaudeCode: r.claude?.tokensClaudeCode,
    claudeError: r.claude?.error,
    shareOfWindow: r.toolsTokens != null ? Number((((r.claude?.tokens ?? r.toolsTokens) / window) * 100).toFixed(2)) : undefined,
    latencyMs: r.latencyMs,
    topTools: r.tools ? [...r.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 10).map((t) => ({ name: t.name, tokens: t.tokens })) : undefined
  };
}

const claudeOptions = (serverName: string) => (process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY, serverName } : undefined);
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

/** Every tool reads and reports; none changes a server, a file or the board. The measuring tools reach the network or start a process. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const TOKEN_FIELDS = {
  status: { type: 'string', description: 'ok (answered initialize and tools/list), auth (needs credentials), payment (402), not_found, protocol_error (not MCP), timeout, dns, tls, refused, server_error, rate_limited, newer_protocol, or for a local command: install_failed, no_bin, needs_env, needs_args, needs_network, crashed' },
  error: { type: 'string', description: 'The first line of the failure, when status is not ok' },
  protocolVersion: { type: 'string', description: 'The MCP protocol version the server negotiated' },
  serverInfo: { type: 'object', description: 'name, version and title the server reports in initialize' },
  toolCount: { type: 'integer', description: 'How many tools tools/list returned' },
  toolsTokensEstimate: { type: 'integer', description: 'o200k_base tokens over the compact JSON of every tool definition; the exact Claude count is about 1.9 times this at the median' },
  claudeTokens: { type: 'integer', description: 'Exact count from the Anthropic count_tokens endpoint, names as published; only with ANTHROPIC_API_KEY' },
  claudeTokensClaudeCode: { type: 'integer', description: 'The same with the Claude Code prefix mcp__<server>__ on each tool name' },
  claudeError: { type: 'string', description: 'Why the Anthropic endpoint refused to count, for example a schema it does not accept' },
  shareOfWindow: { type: 'number', description: 'Percent of the context window the tool definitions take, exact when claudeTokens is present, else the estimate' },
  latencyMs: { type: 'object', description: 'initialize and toolsList, milliseconds' },
  topTools: { type: 'array', description: 'The ten most expensive tools: name and o200k_base tokens', items: { type: 'object', properties: { name: { type: 'string' }, tokens: { type: 'integer' } } } }
} as const;

/** The board's JSON says null for a value it does not have; a schema that forbids null would reject every gated server. */
function nullableProps<T extends Record<string, { type: string } & Record<string, unknown>>>(props: T): Record<keyof T, Record<string, unknown>> {
  const out = {} as Record<keyof T, Record<string, unknown>>;
  for (const k of Object.keys(props) as Array<keyof T>) out[k] = { ...props[k], type: [props[k].type, 'null'] };
  return out;
}

const TOOLS = [
  {
    name: 'measure_server',
    title: 'Measure one server now',
    description:
      'Measures one MCP server now: connects to a remote URL, or starts a local command and stops it after tools/list, then reports the result, the protocol version, the tool count and the context-token cost of the tool definitions (o200k_base estimate; the exact Claude count when ANTHROPIC_API_KEY is set). Use it for a server that is not in the official registry, or for a local command; for a registry server prefer lookup_server, which answers from the daily board without a connection. Sends no credentials: a server that needs them comes back with status "auth", not an error. 15 s timeout per request. Give url or command, not both.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote endpoint to connect to, https://…/mcp (Streamable HTTP) or an …/sse URL. Use this or command.' },
        command: { type: 'string', description: 'Local server command with its arguments, started with stdio and stopped after tools/list, for example "npx -y @modelcontextprotocol/server-filesystem /tmp". Use this or url.' },
        window: { type: 'integer', minimum: 1, description: 'Context window in tokens for shareOfWindow; default 200000 (Claude)' }
      }
    },
    outputSchema: { type: 'object', properties: { target: { type: 'string', description: 'The url or command that was measured' }, ...TOKEN_FIELDS } }
  },
  {
    name: 'measure_config',
    title: 'Measure every server in a config file',
    description:
      'Measures every server in one MCP config file (.mcp.json, Claude Desktop, Cursor, VS Code or Windsurf format): starts each local server the way the client would and stops it after tools/list, connects to each remote one, and reports the tokens per server and the total. Use it to see what a whole config costs the context window; use measure_server for one server. A server that fails to start or needs credentials is reported with its status, never thrown. Up to about 15 s per server.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the config file, absolute or relative to the working directory' },
        window: { type: 'integer', minimum: 1, description: 'Context window in tokens for shareOfWindow; default 200000 (Claude)' },
        noStdio: { type: 'boolean', description: 'true = measure the remote servers only and start no local process; default false' }
      },
      required: ['path']
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The config file that was read' },
        total: { type: 'object', description: 'Over the servers that answered: how many, their tokens (exact when a Claude count exists, else the estimate) and the share of the window', properties: { servers: { type: 'integer' }, tokens: { type: 'integer' }, shareOfWindow: { type: 'number' } } },
        servers: { type: 'array', description: 'One entry per configured server: name, kind (remote or stdio) and the same fields as measure_server; or name and skipped, with the reason', items: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['remote', 'stdio'] }, skipped: { type: 'string', description: 'Why the server was not measured: disabled in config, or a local server under noStdio' }, ...TOKEN_FIELDS } } }
      }
    }
  },
  {
    name: 'lookup_server',
    title: 'Look up a registry server on the board',
    description:
      'Reads the public board\'s latest daily probe of one server in the official MCP registry: status, how a client gets access, the exact Claude token cost of its tool definitions, tool count, latency and the history of changes. Instant, no connection to the server, with a registry name or with the endpoint URL as the registry lists it. Use it when the server is in the registry; use search_servers when you do not know its name, and measure_server to probe a URL or a local command here and now. A name or URL that is not on the board returns isError with a short message that points to measure_server.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: { nameOrUrl: { type: 'string', description: 'The registry name, for example io.github.owner/name, or the https URL of the endpoint as the registry lists it; both are looked up on the board, nothing is contacted' } },
      required: ['nameOrUrl']
    },
    outputSchema: {
      type: 'object',
      properties: nullableProps({
        name: { type: 'string', description: 'The registry name' },
        title: { type: 'string' },
        url: { type: 'string', description: 'The endpoint the board probes' },
        status: TOKEN_FIELDS.status,
        statusLabel: { type: 'string', description: 'The status in words, as the board shows it' },
        httpStatus: { type: 'integer' },
        authScheme: { type: 'string', description: 'The WWW-Authenticate scheme of a server that needs auth' },
        authKind: { type: 'string', description: 'How a client gets in: oauth-dcr (clients register themselves), oauth (client id from the publisher), token (a key in the Authorization header), unknown' },
        authDocumentation: { type: 'string', description: 'The publisher\'s guide to getting access' },
        protocolVersion: TOKEN_FIELDS.protocolVersion,
        toolCount: TOKEN_FIELDS.toolCount,
        claudeTokens: { type: 'integer', description: 'Exact count from the Anthropic count_tokens endpoint, names as published' },
        claudeTokensClaudeCode: TOKEN_FIELDS.claudeTokensClaudeCode,
        claudeModel: { type: 'string', description: 'The model the exact count is for' },
        toolsTokens: { type: 'integer', description: 'o200k_base estimate over the compact JSON of the tool definitions' },
        shareOf200k: { type: 'number', description: 'Percent of a 200k window, exact when claudeTokens is present' },
        latencyMs: TOKEN_FIELDS.latencyMs,
        topTools: { type: 'array', description: 'The five most expensive tools: name and o200k_base tokens' },
        probedAt: { type: 'string', description: 'ISO 8601 time of the probe' },
        page: { type: 'string', description: 'The server\'s page on the board' }
      })
    }
  },
  {
    name: 'search_servers',
    title: 'Search the board',
    description:
      'Finds servers on the public board by words in their name, title, description or host, with optional filters, sorted by exact Claude token cost (highest first) by default. With no query and no filter it ranks the whole board, so page 1 is the most expensive servers in the registry and sort=claude-asc the cheapest. Use it to discover servers or to rank them by cost; use lookup_server once you have a name, compare_servers for a few side by side, registry_summary for the totals. Returns up to twenty servers per page with name, host, status, tool count and tokens; `hasNext` says whether a next page exists.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match, three or more characters each, as prefixes: "git copilot" finds the GitHub Copilot servers. Omit for the whole list.' },
        status: { type: 'string', enum: ['ok', 'auth', 'payment', 'newer_protocol', 'down'], description: 'ok = answers and lists tools; auth = needs credentials; payment = 402; newer_protocol = a protocol newer than the SDK; down = every other failure. Omit for all.' },
        sort: { type: 'string', enum: ['claude', 'claude-asc', 'tokens', 'tools', 'latency', 'name', 'updated'], description: 'claude = exact Claude tokens, highest first (default); claude-asc = lowest first; tokens = the o200k_base estimate; tools = tool count; latency = initialize time; name; updated = registry date' },
        page: { type: 'integer', minimum: 1, maximum: 20, description: 'Page number, 1 to 20, twenty servers each; default 1' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: nullableProps({
        page: { type: 'integer' },
        perPage: { type: 'integer' },
        sort: { type: 'string', description: 'The sort that was applied; a big unfiltered list keeps the token order' },
        hasNext: { type: 'boolean' },
        next: { type: 'string', description: 'Cursor for the next page, when hasNext' },
        fields: { type: 'object', description: 'What claude_tokens, claude_tokens_cc and tools_tokens mean' },
        servers: {
          type: 'array',
          items: {
            type: 'object',
            properties: nullableProps({
              name: { type: 'string', description: 'The registry name; the page on the board is https://mcpcost.ulehla.dev/s/<name>' },
              title: { type: 'string' },
              host: { type: 'string' },
              transport: { type: 'string', enum: ['streamable-http', 'sse', 'stdio'] },
              status: TOKEN_FIELDS.status,
              http_status: { type: 'integer' },
              auth_scheme: { type: 'string', description: 'The WWW-Authenticate scheme of a server that needs auth' },
              protocol_version: { type: 'string' },
              init_ms: { type: 'integer', description: 'initialize latency, milliseconds' },
              tool_count: { type: 'integer' },
              tools_tokens: { type: 'integer', description: 'o200k_base estimate' },
              claude_tokens: { type: 'integer', description: 'Exact Claude count, names as published' },
              claude_tokens_cc: { type: 'integer', description: 'Exact Claude count with the Claude Code prefix' },
              shown_tokens: { type: 'integer', description: 'The number the board shows: exact when it exists, else the estimate' }
            })
          }
        }
      })
    }
  },
  {
    name: 'compare_servers',
    title: 'Compare servers side by side',
    description:
      'Puts two to five servers next to each other from the board\'s latest daily probe: status, how a client gets in, tool count, token cost (exact in Claude when counted, else the estimate), share of a 200k window and initialize latency, with the cheapest, the most expensive and the spread. Use it to choose between servers that do the same job; use lookup_server for the full record of one server, search_servers to find candidates, and measure_server to measure a server that is not in the registry. Instant, no connection to the servers, with registry names or endpoint URLs as the registry lists them. A name the board does not know gets a row with status "unknown" and the comparison goes on. format picks the text layout (JSON, a Markdown table, or CSV to paste into a spreadsheet); the structured content is always JSON.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' }, description: 'Two to five registry names (io.github.owner/name) or https URLs of MCP endpoints' },
        format: { type: 'string', enum: ['json', 'markdown', 'csv'], description: 'The layout of the text content: json (default), markdown (a table with a summary line), or csv (a header row, then one row per server)' }
      },
      required: ['servers']
    },
    outputSchema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          description: 'One row per requested server, in the order given',
          items: {
            type: 'object',
            properties: nullableProps({
              name: { type: 'string', description: 'The registry name, or what was given when the board does not know it' },
              host: { type: 'string' },
              status: { type: 'string', description: 'The probe status, or "unknown" when the board has no such server' },
              statusLabel: { type: 'string' },
              authKind: { type: 'string', description: 'oauth-dcr, oauth, token or unknown, for a server that needs auth' },
              toolCount: { type: 'integer' },
              claudeTokens: { type: 'integer', description: 'Exact Claude count' },
              toolsTokens: { type: 'integer', description: 'o200k_base estimate' },
              tokens: { type: 'integer', description: 'The number compared: the exact count when it exists, else the estimate' },
              exact: { type: 'boolean', description: 'Whether tokens is the exact count' },
              shareOf200k: { type: 'number' },
              initMs: { type: 'integer' },
              protocolVersion: { type: 'string' },
              probedAt: { type: 'string' },
              page: { type: 'string', description: 'The server\'s page on the board' },
              error: { type: 'string', description: 'Why there is no data, for example "not on the board"' }
            })
          }
        },
        measured: { type: 'integer', description: 'How many rows have a token number' },
        cheapest: { type: ['string', 'null'], description: 'The server with the fewest tokens, when two or more rows are measured' },
        mostExpensive: { type: ['string', 'null'] },
        tokenSpread: { type: ['integer', 'null'], description: 'Tokens between the most expensive and the cheapest' },
        format: { type: 'string', enum: ['json', 'markdown', 'csv'] }
      }
    }
  },
  {
    name: 'registry_summary',
    title: 'The whole registry in numbers',
    description:
      'Aggregates of the board\'s latest daily run over the whole official MCP registry: how many servers answer and why the rest do not, token cost percentiles and the exact-to-estimate ratio, how servers authenticate, protocol versions, transports, the heaviest servers and the biggest publishers. Use it for the state of the registry as a whole, or as the baseline a single server is compared against; use search_servers for a ranked list and lookup_server for one server. Instant, no input, a few kilobytes of JSON.',
    annotations: READ_ONLY,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        probedAt: { type: 'string', description: 'ISO 8601 time of the run' },
        registryEntries: { type: 'integer', description: 'Entries in the registry' },
        registryWithRemote: { type: 'integer', description: 'Entries with a remote endpoint' },
        probed: { type: 'integer', description: 'Servers probed in this run' },
        ok: { type: 'integer', description: 'Servers that answered initialize and tools/list' },
        byStatus: { type: 'object', description: 'Servers per status', additionalProperties: { type: 'integer' } },
        authSchemes: { type: 'object', description: 'Servers that need auth, per WWW-Authenticate scheme', additionalProperties: { type: 'integer' } },
        authKinds: { type: 'object', description: 'Servers that need auth, per kind of access: oauth-dcr, oauth, token, unknown', additionalProperties: { type: 'integer' } },
        protocols: { type: 'object', description: 'Alive servers per negotiated protocol version', additionalProperties: { type: 'integer' } },
        transports: { type: 'object', additionalProperties: { type: 'integer' } },
        toolsTokens: { type: 'object', description: 'o200k_base estimate: median, p90, p99, max, total' },
        claudeTokens: { type: 'object', description: 'Exact Claude counts: model, counted, refused, median, p90, p99, max, histogram, ratioToEstimate' },
        toolCount: { type: 'object', description: 'median, p90, max' }
      }
    }
  }
] as const;

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string) => (typeof a[k] === 'number' ? (a[k] as number) : undefined);
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

async function call(name: string, a: Args) {
  const w = num(a, 'window') ?? 200_000;
  switch (name) {
    case 'measure_server': {
      const url = str(a, 'url');
      const command = str(a, 'command');
      if (url) {
        const r = await probeRemote({ url, type: /\/sse\/?$/.test(url) ? 'sse' : 'streamable-http' }, { timeoutMs: 15_000, claude: claudeOptions(new URL(url).hostname) });
        return text({ target: url, ...compact(r, w) });
      }
      if (command) {
        const [cmd, ...args] = command.trim().split(/\s+/);
        const r = await probeStdio({ command: cmd, args }, { timeoutMs: 20_000, claude: claudeOptions(cmd) });
        return text({ target: command, ...compact(r, w) });
      }
      return fail('Give url or command.');
    }
    case 'measure_config': {
      const path = str(a, 'path');
      if (!path) return fail('Give path.');
      const cfg = await readConfigFile(path, 'config');
      if (!cfg) return fail(`Cannot read ${path}`);
      const noStdio = a.noStdio === true;
      const servers = await Promise.all(
        cfg.servers.map(async (s) => {
          if (s.disabled) return { name: s.name, skipped: 'disabled in config' };
          if (s.kind === 'stdio' && noStdio) return { name: s.name, skipped: 'local server, noStdio' };
          const r =
            s.kind === 'remote'
              ? await probeRemote({ url: s.url!, type: s.type ?? 'streamable-http' }, { timeoutMs: 15_000, headers: s.headers, claude: claudeOptions(s.name) })
              : await probeStdio({ command: s.command!, args: s.args, env: s.env, cwd: s.cwd }, { timeoutMs: 20_000, claude: claudeOptions(s.name) });
          return { name: s.name, kind: s.kind, ...compact(r, w) };
        })
      );
      const measured = servers.filter((s) => 'status' in s && s.status === 'ok') as Array<{ toolsTokensEstimate?: number; claudeTokens?: number }>;
      const total = measured.reduce((t, s) => t + (s.claudeTokens ?? s.toolsTokensEstimate ?? 0), 0);
      return text({ path, total: { servers: measured.length, tokens: total, shareOfWindow: Number(((total / w) * 100).toFixed(2)) }, servers });
    }
    case 'lookup_server': {
      const nameOrUrl = str(a, 'nameOrUrl');
      if (!nameOrUrl) return fail('Give nameOrUrl.');
      const res = await fetch(boardRowUrl(nameOrUrl), { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
      if (!res.ok) return fail(`The board has no server ${nameOrUrl} (HTTP ${res.status}). Use measure_server to probe it now.`);
      return text(await res.json());
    }
    case 'search_servers': {
      const u = new URL(`${BOARD}/api/servers.json`);
      const query = str(a, 'query');
      if (query) u.searchParams.set('q', query);
      const status = str(a, 'status');
      if (status) u.searchParams.set('status', status);
      u.searchParams.set('sort', str(a, 'sort') ?? 'claude');
      u.searchParams.set('page', String(num(a, 'page') ?? 1));
      u.searchParams.set('per_page', '20');
      const res = await fetch(u, { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
      if (!res.ok) return fail(`The board did not answer (HTTP ${res.status}).`);
      return text(await res.json());
    }
    case 'compare_servers': {
      const ids = Array.isArray(a.servers) ? (a.servers as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      if (ids.length < 2 || ids.length > 5) return fail('Give two to five registry names or URLs in servers.');
      const format = (COMPARE_FORMATS as readonly string[]).includes(str(a, 'format') ?? 'json') ? ((str(a, 'format') ?? 'json') as CompareFormat) : 'json';
      const rows = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await fetch(boardRowUrl(id), { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
            if (!res.ok) return unknownRow(id, res.status === 404 ? 'not on the board' : `the board answered HTTP ${res.status}`);
            return rowFromBoard((await res.json()) as Record<string, unknown>, id);
          } catch (e) {
            return unknownRow(id, e instanceof Error ? e.message : String(e));
          }
        })
      );
      const out = compare(rows, format);
      return { content: [{ type: 'text' as const, text: formatComparison(out) }], structuredContent: out as unknown as Record<string, unknown> };
    }
    case 'registry_summary': {
      const res = await fetch(`${BOARD}/api/summary.json`, { headers: { accept: 'application/json', 'user-agent': `mcpcost/${VERSION}` } });
      if (!res.ok) return fail(`The board did not answer (HTTP ${res.status}).`);
      const j = (await res.json()) as Record<string, unknown>;
      return text((j.summary ?? j) as Record<string, unknown>);
    }
    default:
      return fail(`Unknown tool ${name}`);
  }
}

export function buildServer(): Server {
  const server = new Server(
    { name: 'mcpcost', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Measures what MCP servers cost in context tokens. measure_server probes one server (remote URL or local command) now. measure_config measures every server in a config file. lookup_server, search_servers, compare_servers and registry_summary read the public board at mcpcost.ulehla.dev, which probes the whole registry daily; none of them contacts a server. Token numbers are o200k_base estimates; with ANTHROPIC_API_KEY set, claudeTokens is the exact count from the free count_tokens endpoint.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await call(req.params.name, (req.params.arguments ?? {}) as Args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });
  return server;
}

/** Serves the tools over stdio until the client closes the pipe. */
export async function serveStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
