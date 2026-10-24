/**
 * Writes the open dataset of one run: one row per probed server with the
 * numbers the board shows. Usage:
 *   node --import tsx probe/dataset.ts --in data/latest --out data/latest [--publish site/public/data/mcpcost-2026-10.json.gz]
 * Writes:
 *   <out>/dataset.json      one row per server, the fields below, CC BY 4.0
 *   <out>/dataset.json.gz   the same, gzip level 9
 * With --publish the gzip is copied to that path when it is under 10 MB. A
 * static file of the site is served before the Worker and costs no request on
 * the free tier; a bigger file would go out as a GitHub release asset instead.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { ServerRow } from './build-data.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest' },
    publish: { type: 'string' },
    /** The largest gzip, in MB, that goes out as a static file of the site. */
    'max-mb': { type: 'string', default: '10' }
  }
});

/** The columns, with the words the page and the JSON API use for them. Null when the probe did not record the value. */
export const DATASET_FIELDS: Record<string, string> = {
  name: 'the registry name; the server page is https://mcpcost.ulehla.dev/s/<name>',
  host: 'the host of the remote endpoint; npmjs.com or pypi.org for a package server',
  transport: 'streamable-http, sse or stdio',
  status: 'the probe result: ok, auth, payment, newer_protocol, not_found, protocol_error, dns, tls, timeout, refused, server_error, rate_limited, error; for a package: crashed, install_failed, no_bin, needs_env, needs_args, needs_network',
  http_status: 'the HTTP status of the first response, when there was one',
  auth_scheme: 'the WWW-Authenticate scheme of a server that needs auth',
  auth_kind: 'how a client gets into a server that needs auth: oauth-dcr, oauth, token or unknown',
  protocol_version: 'the protocol version the server negotiated',
  tool_count: 'the number of tools in tools/list',
  tools_tokens: 'estimate: o200k_base over the compact JSON of the tool definitions',
  claude_tokens: 'exact: the Anthropic count_tokens endpoint, claude-opus-5-5, tool names as published',
  claude_tokens_cc: 'exact: the same with the Claude Code prefix mcp__<server>__ on each tool name',
  probed_at: 'when this run probed the server (ISO 8601); a package server keeps the time of its last container run'
};

export interface DatasetRow {
  name: string;
  host: string;
  transport: string;
  status: string;
  http_status: number | null;
  auth_scheme: string | null;
  auth_kind: string | null;
  protocol_version: string | null;
  tool_count: number | null;
  tools_tokens: number | null;
  claude_tokens: number | null;
  claude_tokens_cc: number | null;
  probed_at: string;
}

export function datasetRow(s: ServerRow): DatasetRow {
  return {
    name: s.name,
    host: s.host,
    transport: s.transport,
    status: s.status,
    http_status: s.httpStatus ?? null,
    auth_scheme: s.authScheme ?? null,
    auth_kind: s.authKind ?? null,
    protocol_version: s.protocolVersion ?? null,
    tool_count: s.toolCount ?? null,
    tools_tokens: s.toolsTokens ?? null,
    claude_tokens: s.claudeTokens ?? null,
    claude_tokens_cc: s.claudeTokensCc ?? null,
    probed_at: s.probedAt
  };
}

const servers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
const summary = JSON.parse(await readFile(`${args.in}/summary.json`, 'utf8')) as { probedAt: string; probed: number };
if (servers.length !== summary.probed) throw new Error(`servers.json has ${servers.length} rows, summary.json says ${summary.probed} probed: the two files are not from the same run`);
const rows = servers.map(datasetRow).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const month = summary.probedAt.slice(0, 7);
const dataset = {
  dataset: 'mcpcost',
  title: `Health and token cost of every server in the official MCP registry, run of ${summary.probedAt.slice(0, 10)}`,
  month,
  probed_at: summary.probedAt,
  servers: rows.length,
  license: 'CC BY 4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://mcpcost.ulehla.dev',
  report: `https://mcpcost.ulehla.dev/report/${month}`,
  method: 'https://mcpcost.ulehla.dev/methodology',
  cite: `Ondřej Úlehla, mcpcost: health and token cost of every server in the official MCP registry, run of ${summary.probedAt.slice(0, 10)}, https://mcpcost.ulehla.dev/report/${month}, CC BY 4.0`,
  fields: DATASET_FIELDS,
  rows
};
await mkdir(args.out, { recursive: true });
const json = JSON.stringify(dataset);
await writeFile(`${args.out}/dataset.json`, json);
const gz = gzipSync(Buffer.from(json), { level: 9 });
await writeFile(`${args.out}/dataset.json.gz`, gz);
console.error(`wrote ${rows.length} rows: dataset.json ${(json.length / 1e6).toFixed(1)} MB, dataset.json.gz ${(gz.length / 1e6).toFixed(2)} MB`);

if (args.publish) {
  const size = (await stat(`${args.out}/dataset.json.gz`)).size;
  const max = Number(args['max-mb']) * 1e6;
  if (size > max) {
    console.error(`::error::dataset.json.gz is ${(size / 1e6).toFixed(1)} MB, over the ${args['max-mb']} MB limit for a static file. Publish it as a release asset instead.`);
    process.exit(2);
  }
  await mkdir(dirname(args.publish), { recursive: true });
  await copyFile(`${args.out}/dataset.json.gz`, args.publish);
  console.error(`published to ${args.publish}`);
}
