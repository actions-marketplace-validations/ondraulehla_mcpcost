/**
 * Who reads the board and what it costs: the Worker's requests, the database rows they read, and the
 * networks and agents behind them, for one window of time (the last hour by default). The workflow
 * watch.yml runs this every hour and opens or updates a GitHub issue when a threshold is crossed, so a
 * scraper that gets past the edge rules is noticed the hour it starts, not the morning after the limit.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node site/edge/watch.mjs [from] [to]
 *
 * from and to are ISO 8601 times (UTC); without them, the hour that ended two minutes ago (the logs
 * arrive with a short delay). CLOUDFLARE_ZONE_TOKEN, when set and allowed Zone: Analytics: Read, adds
 * what the zone stopped before the Worker. Exit status 1 when a threshold is crossed, 2 when Cloudflare
 * could not be asked. The thresholds are the WATCH_* variables, per hour of the window.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const zoneToken = process.env.CLOUDFLARE_ZONE_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const HOST = 'mcpcost.ulehla.dev';
const SCRIPT = 'mcpcost';
const DB_ID = 'f1984775-849a-4277-805e-537ea5ad7611';

/** The thresholds, per hour. The scrapers of October 2026 made 4 000 requests an hour from one network, readers make a few hundred a day. */
const LIMITS = {
  requests: Number(process.env.WATCH_REQUESTS_PER_HOUR ?? 5000), // Worker requests from everyone
  network: Number(process.env.WATCH_NETWORK_REQUESTS_PER_HOUR ?? 800), // requests from one network that does not name itself a crawler
  rowsRead: Number(process.env.WATCH_ROWS_READ_PER_HOUR ?? 1_000_000) // D1 rows read
};

const args = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
const to = args[1] ? new Date(args[1]) : new Date(Date.now() - 2 * 60_000);
const from = args[0] ? new Date(args[0]) : new Date(to.getTime() - 60 * 60_000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('Usage: node site/edge/watch.mjs [from] [to], ISO 8601 times with from before to.');
  process.exit(2);
}
if (!token || !acct) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set.');
  process.exit(2);
}
const hours = (to.getTime() - from.getTime()) / 3_600_000;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const perHour = (n) => Math.round(n / hours);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

async function cf(path, body, bearer = token) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false || j.errors?.length) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j;
}
const gql = (query, variables, bearer) => cf('/graphql', { query, variables }, bearer).then((j) => j.data);

/** Worker requests per hour, from the account's analytics: every request the Worker answered, a 403 as much as a page. */
async function workerHours(since, until) {
  const d = await gql(
    `query($acct: string!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 500, filter: {datetime_geq: $from, datetime_leq: $to, scriptName: "${SCRIPT}"}, orderBy: [datetimeHour_ASC]) {
        sum { requests errors } dimensions { datetimeHour } } } } }`,
    { acct, from: iso(since), to: iso(until) }
  );
  const byHour = new Map();
  for (const r of d.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
    const h = byHour.get(r.dimensions.datetimeHour) ?? { requests: 0, errors: 0 };
    h.requests += r.sum.requests;
    h.errors += r.sum.errors;
    byHour.set(r.dimensions.datetimeHour, h);
  }
  return byHour;
}

/** D1 rows read and written per hour of a day. */
async function d1Hours(day) {
  const d = await gql(
    `query($acct: string!, $db: string!, $since: Date!) { viewer { accounts(filter: {accountTag: $acct}) {
      d1AnalyticsAdaptiveGroups(limit: 200, filter: {date_geq: $since, databaseId: $db}, orderBy: [datetimeHour_ASC]) {
        sum { readQueries rowsRead rowsWritten } dimensions { datetimeHour } } } } }`,
    { acct, db: DB_ID, since: day }
  );
  const byHour = new Map();
  for (const r of d.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? []) {
    const h = byHour.get(r.dimensions.datetimeHour) ?? { rowsRead: 0, rowsWritten: 0, queries: 0 };
    h.rowsRead += r.sum.rowsRead;
    h.rowsWritten += r.sum.rowsWritten;
    h.queries += r.sum.readQueries;
    byHour.set(r.dimensions.datetimeHour, h);
  }
  return byHour;
}

/** The Worker's log events in the window, in ten-minute slices so one query's limit does not cut an hour short. */
async function events(since, until) {
  const out = [];
  let truncated = false;
  const step = 10 * 60_000;
  const limit = 2000;
  for (let t = since.getTime(); t < until.getTime(); t += step) {
    const j = await cf(`/accounts/${acct}/workers/observability/telemetry/query`, {
      queryId: `watch-${t}`,
      timeframe: { from: t, to: Math.min(t + step, until.getTime()) },
      view: 'events',
      limit,
      parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: SCRIPT }] }
    });
    const ev = j.result?.events?.events ?? j.result?.events ?? [];
    if (!Array.isArray(ev)) continue;
    if (ev.length >= limit) truncated = true;
    out.push(...ev);
  }
  return { events: out, truncated };
}

/** The first object under this key, wherever the log puts it. */
function under(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = under(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** A URL as a class: server pages folded into one, list variants told apart by their parameters. */
function shape(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw).slice(0, 60);
  }
  let p = u.pathname;
  if (p.startsWith('/s/')) p = p.endsWith('.xml') ? '/s/*.xml' : '/s/*';
  else if (p.startsWith('/api/s/')) p = '/api/s/*';
  else if (p.startsWith('/badge/')) p = '/badge/*';
  else if (/^\/sitemap-\d+\.xml$/.test(p)) p = '/sitemap-N.xml';
  const keys = [...u.searchParams.keys()].sort();
  return `${p}${keys.length ? '?' + keys.join('&') : ''}`;
}

/** What kind of client an agent string names. The scrapers of October 2026 sent Chrome's. */
function kind(agent) {
  if (!agent) return 'no agent';
  if (/bot|crawl|spider|slurp|externalhit|externalagent|preview|validator|monitor|feedfetcher|archive/i.test(agent)) return 'named crawler';
  if (/Mozilla\/5\.0/.test(agent) && /Chrome|Safari|Firefox|Edg/.test(agent)) return 'browser';
  return 'tool';
}
const bump = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

/** What the zone stopped before the Worker, when the zone token may read analytics. */
async function edge(since, until) {
  if (!zoneToken) return { note: 'CLOUDFLARE_ZONE_TOKEN is not set, so what the zone stopped before the Worker is not shown.' };
  try {
    const z = await cf('/zones?name=ulehla.dev', undefined, zoneToken);
    const zone = z.result?.[0]?.id;
    if (!zone) return { note: 'The zone token does not see ulehla.dev.' };
    const d = await gql(
      `query($zone: string!, $from: Time!, $to: Time!) { viewer { zones(filter: {zoneTag: $zone}) {
        all: httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: "${HOST}"}) { count }
        stopped: firewallEventsAdaptiveGroups(limit: 40, filter: {datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: "${HOST}"}, orderBy: [count_DESC]) {
          count dimensions { action clientASNDescription clientRequestPath userAgent } } } } }`,
      { zone, from: iso(since), to: iso(until) },
      zoneToken
    );
    const v = d.viewer.zones[0] ?? {};
    return { total: v.all?.[0]?.count ?? 0, stopped: v.stopped ?? [] };
  } catch (e) {
    return { note: `The zone's analytics are not readable with the zone token (${String(e.message).slice(0, 120)}). Add Zone: Analytics: Read to it to see what the edge stops.` };
  }
}

const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

const midnight = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
const [windowHours, dayHours, d1, logs, zone] = await Promise.all([
  workerHours(from, to),
  workerHours(midnight, to),
  d1Hours(midnight.toISOString().slice(0, 10)),
  events(from, to).catch((e) => ({ events: [], truncated: false, error: e.message })),
  edge(from, to)
]);

const sum = (map, key) => [...map.values()].reduce((a, h) => a + h[key], 0);
const inWindow = (hour) => Date.parse(hour) >= from.getTime() - 3_600_000 && Date.parse(hour) < to.getTime();
const d1Window = new Map([...d1].filter(([h]) => inWindow(h)));
const requests = sum(windowHours, 'requests');
const rowsRead = sum(d1Window, 'rowsRead');

say(`# The edge, ${iso(from)} to ${iso(to)} (${hours % 1 ? hours.toFixed(1) : hours} h)`);
say();
say('| | in the window | per hour | since 00:00 UTC |');
say('|---|---:|---:|---:|');
say(`| Worker requests | ${fmt(requests)} | ${fmt(perHour(requests))} | ${fmt(sum(dayHours, 'requests'))} |`);
say(`| Worker errors | ${fmt(sum(windowHours, 'errors'))} | ${fmt(perHour(sum(windowHours, 'errors')))} | ${fmt(sum(dayHours, 'errors'))} |`);
say(`| D1 rows read | ${fmt(rowsRead)} | ${fmt(perHour(rowsRead))} | ${fmt(sum(d1, 'rowsRead'))} |`);
say(`| D1 rows written | ${fmt(sum(d1Window, 'rowsWritten'))} | ${fmt(perHour(sum(d1Window, 'rowsWritten')))} | ${fmt(sum(d1, 'rowsWritten'))} |`);
if (zone.total !== undefined) {
  const stopped = zone.stopped.reduce((a, r) => a + r.count, 0);
  say(`| Requests at the edge | ${fmt(zone.total)} | ${fmt(perHour(zone.total))} | |`);
  say(`| Stopped by the zone's rules | ${fmt(stopped)} | ${fmt(perHour(stopped))} | |`);
}
say();

const byNetwork = new Map();
const byNetworkUnnamed = new Map();
const byAgent = new Map();
const byShape = new Map();
const byStatus = new Map();
const byNetShape = new Map();
for (const e of logs.events) {
  const request = under(e, 'request') ?? {};
  const url = typeof request.url === 'string' ? request.url : under(e, 'url');
  if (typeof url !== 'string') continue;
  const agent = (under(request, 'user-agent') ?? under(e, 'user-agent') ?? '').toString().replace(/\s+/g, ' ');
  const asn = under(request, 'asn') ?? under(e, 'asn');
  // The organisation and the number: the number is what a rule in rules.mjs takes.
  const network = `${(under(request, 'asOrganization') ?? under(e, 'asOrganization') ?? '-').toString()}${asn ? ` (AS${asn})` : ''}`;
  const response = under(e, 'response');
  const status = response && typeof response === 'object' ? (response.status ?? '-') : '-';
  const s = shape(url);
  const k = kind(agent);
  bump(byNetwork, network);
  if (k !== 'named crawler') bump(byNetworkUnnamed, network);
  bump(byAgent, `${k}: ${agent.slice(0, 90) || '-'}`);
  bump(byShape, s);
  bump(byStatus, String(status));
  bump(byNetShape, `${network.slice(0, 30)} · ${k} · ${s.replace(/\?.*$/, '?…')} · ${status}`);
}

const table = (title, map, head, n = 12) => {
  const rows = sorted(map).slice(0, n);
  if (!rows.length) return;
  say(`## ${title}`);
  say();
  say(`| ${head} | requests | per hour |`);
  say('|---|---:|---:|');
  for (const [k, v] of rows) say(`| ${k.replace(/\|/g, '\\|')} | ${fmt(v)} | ${fmt(perHour(v))} |`);
  say();
};
if (logs.error) say(`The Worker's logs could not be read: ${logs.error}`);
else {
  say(`## What the Worker's logs say (${fmt(logs.events.length)} events${logs.truncated ? ', a busy ten minutes was cut at 2 000, so the counts below are low' : ''})`);
  say();
  table('By network', byNetwork, 'network (AS organisation, number)');
  table('By agent', byAgent, 'kind: agent');
  table('By URL shape', byShape, 'shape', 15);
  table('By response status', byStatus, 'status', 8);
  table('Network × agent kind × shape × status', byNetShape, 'who, what, how', 20);
}
if (zone.note) say(zone.note);
else if (zone.stopped.length) {
  say('## Stopped before the Worker');
  say();
  say('| action | network | path | agent | requests |');
  say('|---|---|---|---|---:|');
  for (const r of zone.stopped.slice(0, 20)) {
    const d = r.dimensions;
    say(`| ${d.action} | ${d.clientASNDescription} | ${d.clientRequestPath.replace(/^\/s\/.+/, '/s/*').slice(0, 40)} | ${d.userAgent.replace(/\|/g, ' ').slice(0, 60)} | ${fmt(r.count)} |`);
  }
  say();
}

const alarms = [];
if (perHour(requests) > LIMITS.requests) alarms.push(`${fmt(perHour(requests))} Worker requests an hour, the threshold is ${fmt(LIMITS.requests)}`);
for (const [network, n] of sorted(byNetworkUnnamed)) {
  if (perHour(n) > LIMITS.network) alarms.push(`${fmt(perHour(n))} requests an hour from ${network} with agents that do not name a crawler, the threshold is ${fmt(LIMITS.network)}`);
}
if (perHour(rowsRead) > LIMITS.rowsRead) alarms.push(`${fmt(perHour(rowsRead))} D1 rows read an hour, the threshold is ${fmt(LIMITS.rowsRead)}`);

if (alarms.length) {
  say('## Over the threshold');
  say();
  for (const a of alarms) say(`- ${a}`);
  say();
  say('Which networks and agents: the tables above. A hosting network with browser agents walking the list variants is a scraper; add its ASN to SCRAPER_ASNS in site/edge/rules.mjs and the Edge rules workflow blocks it before the Worker.');
  for (const a of alarms) console.log(`::error::${a}`);
} else say('Nothing over the thresholds.');

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (process.env.WATCH_REPORT_FILE) writeFileSync(process.env.WATCH_REPORT_FILE, lines.join('\n') + '\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `alarm=${alarms.join('; ').replace(/[\r\n]+/g, ' ')}\n`);
process.exit(alarms.length ? 1 : 0);
