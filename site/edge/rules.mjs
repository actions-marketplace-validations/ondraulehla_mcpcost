/**
 * The edge rules that keep scrapers off the Worker. The Workers Free plan counts every request the
 * Worker answers, a 403 as much as a page, and the scrapers of 2026-10-22 and 23 made 4 000 list
 * variants an hour, 96 000 a day, until the account's 100 000 were gone. A WAF custom rule and a rate
 * limiting rule run on the zone before the Worker, so a request they stop costs nothing.
 *
 * Idempotent: each rule carries a `ref`, and a run updates the rule with that ref or adds it.
 *
 *   CLOUDFLARE_API_TOKEN=… node site/edge/rules.mjs [--dry-run]
 *
 * The token needs Zone: Zone WAF: Edit (and Zone: Zone: Read) on ulehla.dev. The probe's token has
 * neither, so this runs with a token of its own.
 */
const token = process.env.CLOUDFLARE_API_TOKEN;
const dry = process.argv.includes('--dry-run');
const API = 'https://api.cloudflare.com/client/v4';
const HOST = 'mcpcost.ulehla.dev';

/**
 * Hosting networks the scrapers came from, by autonomous system number:
 * 32934 Meta Platforms (its cloud, not its named crawlers, which read the server pages and are
 * verified bots), 45102 and 37963 Alibaba Cloud, 25369 RapidSeedbox.
 */
const SCRAPER_ASNS = [32934, 45102, 37963, 25369];

/** A list variant: /servers with a query string, or the list API. The pages crawlers may read (server pages, sitemaps, badges) are not here. */
const LIST_VARIANT = `http.host eq "${HOST}" and ((http.request.uri.path eq "/servers" and http.request.uri.query ne "") or starts_with(http.request.uri.path, "/api/servers"))`;

const CUSTOM_RULES = [
  {
    ref: 'mcpcost-scraper-networks',
    // The whole host, not only the list: the same scrapers read 1 500 server pages and sitemaps an hour too.
    // Meta's named crawlers come from the same network and are verified bots, so they pass.
    description: 'mcpcost: scraper networks (Meta cloud, Alibaba, RapidSeedbox) are blocked before the Worker, verified bots excepted',
    expression: `(http.host eq "${HOST}" and ip.src.asnum in {${SCRAPER_ASNS.join(' ')}} and not cf.client.bot)`,
    action: 'block'
  },
  {
    ref: 'mcpcost-list-variants-challenge',
    description: 'mcpcost: list variants from anything that is not a verified bot get a managed challenge; a browser passes it once, a scraper does not',
    expression: `(${LIST_VARIANT} and not cf.client.bot)`,
    action: 'managed_challenge'
  }
];

/**
 * The one rate limiting rule of the Free plan: one address asking for more than this many list variants
 * in ten seconds is a script, not a reader. A person opens a page every few seconds; the scrapers made
 * one a second from each address. The Free plan fixes the period and the timeout at ten seconds, counts
 * by address, and blocks. The server pages and the sitemaps stay out of it: a crawler that honours
 * Crawl-delay reads them one at a time, and one that does not is a matter for the custom rules.
 */
const RATE_RULE = {
  ref: 'mcpcost-list-variants-per-10s',
  description: 'mcpcost: more than 6 list variants in 10 seconds from one address is a script; blocked for 10 seconds',
  expression: `(${LIST_VARIANT})`,
  action: 'block',
  ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 10, requests_per_period: 6, mitigation_timeout: 10 }
};

async function cf(path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 400)}`);
  return j.result;
}

/** The entrypoint ruleset of a phase, created empty when the zone has none yet. */
async function entrypoint(zone, phase) {
  try {
    return await cf(`/zones/${zone}/rulesets/phases/${phase}/entrypoint`);
  } catch (e) {
    if (!/HTTP 404/.test(String(e))) throw e;
    return cf(`/zones/${zone}/rulesets`, { method: 'POST', body: JSON.stringify({ name: `${phase} entrypoint`, kind: 'zone', phase, rules: [] }) });
  }
}

/**
 * Adds the rule with this ref, or updates the one that has it. The Free plan allows one rate limiting
 * rule, so in that phase a rule of another ref is the one to update: the zone had "one client at most
 * 60 requests in 10 seconds", which the scrapers at one request a second per address never reached.
 */
async function upsert(zone, phase, rule) {
  const set = await entrypoint(zone, phase);
  const existing = (set.rules ?? []).find((r) => r.ref === rule.ref) ?? (phase === 'http_ratelimit' ? (set.rules ?? [])[0] : undefined);
  const body = JSON.stringify({ ...rule, enabled: true });
  if (dry) {
    console.log(`${existing ? `update (${existing.description ?? existing.ref ?? existing.id})` : 'add'} ${phase} ${rule.ref}\n  ${rule.expression}\n  ${rule.action}${rule.ratelimit ? ' ' + JSON.stringify(rule.ratelimit) : ''}`);
    return;
  }
  if (existing) await cf(`/zones/${zone}/rulesets/${set.id}/rules/${existing.id}`, { method: 'PATCH', body });
  else await cf(`/zones/${zone}/rulesets/${set.id}/rules`, { method: 'POST', body });
  console.log(`${existing ? 'updated' : 'added'} ${phase} ${rule.ref}`);
}

if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}
const zones = await cf('/zones?name=ulehla.dev');
const zone = zones[0]?.id;
if (!zone) {
  console.error('The token does not see the zone ulehla.dev.');
  process.exit(1);
}
for (const rule of CUSTOM_RULES) {
  try {
    await upsert(zone, 'http_request_firewall_custom', rule);
  } catch (e) {
    // cf.client.bot (verified bots) is documented for paid plans. If the zone refuses it, the network rule goes in
    // without the exception (those networks send no verified bot the board needs) and the challenge rule is skipped.
    if (!rule.expression.includes('cf.client.bot') || !/HTTP 400/.test(String(e))) throw e;
    if (rule.action === 'block') await upsert(zone, 'http_request_firewall_custom', { ...rule, expression: rule.expression.replace(' and not cf.client.bot', '') });
    else console.log(`skipped ${rule.ref}: the zone does not accept cf.client.bot on this plan`);
  }
}
await upsert(zone, 'http_ratelimit', RATE_RULE);
const custom = await entrypoint(zone, 'http_request_firewall_custom');
const rate = await entrypoint(zone, 'http_ratelimit');
console.log(`\ncustom rules on the zone: ${(custom.rules ?? []).length} of 5; rate limiting rules: ${(rate.rules ?? []).length} of 1`);
for (const r of [...(custom.rules ?? []), ...(rate.rules ?? [])]) console.log(`  ${r.enabled ? 'on ' : 'off'} ${r.action.padEnd(17)} ${r.description ?? r.ref ?? r.id}`);
