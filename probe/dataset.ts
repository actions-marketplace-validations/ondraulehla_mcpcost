/**
 * Writes the open dataset of one run: one row per probed server with the
 * numbers the board shows. Usage:
 *   node --import tsx probe/dataset.ts --in data/latest --out data/latest [--publish site/public/data/mcpcost-2026-10.json.gz]
 * Writes:
 *   <out>/dataset.json       one row per server, the fields below, CC BY 4.0
 *   <out>/dataset.json.gz    the same, gzip level 9
 *   <out>/evidence.json(.gz) the same run as re-check evidence for the registry, in the shape agreed in
 *                            modelcontextprotocol/registry#1715: entry name, version, check date, check
 *                            (endpoint or package), state (alive, auth, transient, dead, unknown), evidence
 * With --publish the dataset gzip is copied to that path when it is under 10 MB, and --publish-evidence
 * does the same for the evidence gzip. A static file of the site is served before the Worker and costs no
 * request on the free tier; a bigger file would go out as a GitHub release asset instead.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { ServerRow } from './build-data.js';
import { DATASET_FIELDS, NOT_AN_ENTRY, datasetRow, evidenceRow } from './rows.js';
export { DATASET_FIELDS, EVIDENCE_STATE, datasetRow, evidenceRow } from './rows.js';
export type { DatasetRow, EvidenceRow, EvidenceState } from './rows.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest' },
    publish: { type: 'string' },
    'publish-evidence': { type: 'string' },
    /** The largest gzip, in MB, that goes out as a static file of the site. */
    'max-mb': { type: 'string', default: '10' }
  }
});


// The board also lists the registry entries the probe does not run (status unprobed); the dataset holds what was probed.
// The dataset and the evidence are about the official registry, like the summary. The servers tracked from /check or
// listed by a catalog are on the board only.
const servers = (JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[]).filter((s) => s.status !== 'unprobed' && !NOT_AN_ENTRY.has(s.registryStatus));
const summary = JSON.parse(await readFile(`${args.in}/summary.json`, 'utf8')) as { probedAt: string; probed: number };
if (servers.length !== summary.probed) throw new Error(`servers.json has ${servers.length} probed registry rows, summary.json says ${summary.probed}: the two files are not from the same run`);
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

const evidenceRows = servers.map(evidenceRow).sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
/**
 * What ran the checks. In modelcontextprotocol/registry#1715 a liveness result is a function of the endpoint, the
 * protocol version the client asks for and the client itself, so the file names all three. The version the server
 * answered is in each row (evidence.protocol_version).
 */
const versionOf = (path: string) => readFile(new URL(path, import.meta.url), 'utf8').then((t) => JSON.parse(t).version as string).catch(() => 'unknown');
const checkedWith = {
  client: `mcpcost ${await versionOf('../packages/mcpcost/package.json')}`,
  sdk: `@modelcontextprotocol/sdk ${await versionOf('../node_modules/@modelcontextprotocol/sdk/package.json')} (TypeScript)`,
  requested_protocol_version: LATEST_PROTOCOL_VERSION,
  answered_protocol_version: 'evidence.protocol_version of each row: the version the server answered in initialize',
  endpoint: 'initialize, then tools/list, over the transport the entry lists (streamable-http, else SSE), with no credentials; a 401 or 403 is read for its WWW-Authenticate header and OAuth metadata',
  package: 'the same client in a container with the network off, after an install with the network on; the container has the newest 1.x SDK on the day of the run, so its requested version can be newer'
};
const evidence = {
  dataset: 'mcpcost-evidence',
  title: `Re-check evidence for every entry of the official MCP registry, run of ${summary.probedAt.slice(0, 10)}`,
  shape: 'modelcontextprotocol/registry#1715: entry, version, checked_at, check (endpoint | package), state (alive | auth | transient | dead | unknown), evidence',
  states: {
    alive: 'initialize and tools/list succeeded (also a protocol newer than the SDK)',
    auth: 'reachable, needs credentials or payment: 401, 403, 402',
    transient: 'no valid answer in this run, and not dead: a timeout, a 429, a 5xx or a refused connection; or a dead cause seen for less than two days',
    dead: 'no DNS, a TLS failure, 404/405/410, or an answer that is not MCP, in every check for two days or more (evidence.failing_since); a package that does not install or has no executable at two checks a week apart',
    unknown: 'a package that needs values, arguments or a network to start, or crashed on start; a package that starts only with an older major version of its MCP SDK (status needs_old_sdk: a plain install gets mcp 2.x and stops at an import, with mcp<2 it lists its tools); a URL with placeholders that each user fills in, so it was not called; a server that rejects the protocol version the probe asks for (status unsupported_version: it is up); or an error the probe could not classify'
  },
  probed_at: summary.probedAt,
  checked_with: checkedWith,
  entries: evidenceRows.length,
  license: 'CC BY 4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://mcpcost.ulehla.dev',
  method: 'https://mcpcost.ulehla.dev/methodology',
  rows: evidenceRows
};
const evidenceJson = JSON.stringify(evidence);
await writeFile(`${args.out}/evidence.json`, evidenceJson);
const evidenceGz = gzipSync(Buffer.from(evidenceJson), { level: 9 });
await writeFile(`${args.out}/evidence.json.gz`, evidenceGz);
const counts = evidenceRows.reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
console.error(`wrote ${evidenceRows.length} evidence rows (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}): evidence.json.gz ${(evidenceGz.length / 1e6).toFixed(2)} MB`);

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
if (args['publish-evidence']) {
  const size = (await stat(`${args.out}/evidence.json.gz`)).size;
  const max = Number(args['max-mb']) * 1e6;
  if (size > max) {
    console.error(`::error::evidence.json.gz is ${(size / 1e6).toFixed(1)} MB, over the ${args['max-mb']} MB limit for a static file.`);
    process.exit(2);
  }
  await mkdir(dirname(args['publish-evidence']), { recursive: true });
  await copyFile(`${args.out}/evidence.json.gz`, args['publish-evidence']);
  console.error(`published to ${args['publish-evidence']}`);
}
