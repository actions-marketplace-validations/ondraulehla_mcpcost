import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUNDLE_MIN, familiesOf, splitBundles } from './bundles.js';
import { DOCKER, type Listed } from './sources.js';
import type { RegistryEntry, RegistryRemote } from '../packages/mcpcost/src/index.js';

const entry = (name: string, remotes: RegistryRemote[]): RegistryEntry => ({
  server: { name, title: 'Cloudflare', description: 'Cloudflare MCP servers', websiteUrl: 'https://www.cloudflare.com', remotes },
  meta: { status: 'active', publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', isLatest: true }
});
const both = (host: string): RegistryRemote[] => [{ type: 'streamable-http', url: `https://${host}/mcp` }, { type: 'sse', url: `https://${host}/sse` }];
// The way the registry lists them: every streamable-http remote first, then every SSE remote.
const hosts = ['docs.mcp.cloudflare.com', 'radar.mcp.cloudflare.com', 'browser.mcp.cloudflare.com'];
const cloudflare = entry('com.cloudflare.mcp/mcp', [...hosts.map((h) => both(h)[0]), ...hosts.map((h) => both(h)[1])]);
const radarInDocker: Listed = { url: 'https://radar.mcp.cloudflare.com/sse', transport: 'sse', title: 'Cloudflare Radar', description: 'Internet traffic insights.', listing: { name: DOCKER.name, url: 'https://hub.docker.com/mcp/server/cloudflare-radar/overview' } };

test('the servers of an entry are its endpoints by host and path, /mcp and /sse of one host as one', () => {
  assert.deepEqual(familiesOf(cloudflare).map((f) => [f.key, f.remotes.map((r) => r.type)]), [
    ['docs.mcp.cloudflare.com', ['streamable-http', 'sse']],
    ['radar.mcp.cloudflare.com', ['streamable-http', 'sse']],
    ['browser.mcp.cloudflare.com', ['streamable-http', 'sse']]
  ]);
  // A URL that each user fills in is not a server the probe can call.
  assert.equal(familiesOf(entry('x/y', [{ type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' }])).length, 0);
});

test('an entry with fewer servers than a bundle stays as it is, with its second remote as the fallback', () => {
  assert.equal(BUNDLE_MIN, 3);
  const two = entry('ai.example/mcp', [{ type: 'streamable-http', url: 'https://mcp.example.ai/mcp/public' }, { type: 'streamable-http', url: 'https://mcp.example.ai/mcp/oauth' }]);
  const { targets, members, entries } = splitBundles([two]);
  assert.equal(targets[0], two);
  assert.equal(members.length, 0);
  assert.equal(entries.size, 0);
});

test('a bundle keeps its first server under its name; each other server gets a row that links back', () => {
  const { targets, members, entries } = splitBundles([cloudflare], [radarInDocker]);
  // The probe falls back inside the first server only, never to radar under the entry's name.
  assert.deepEqual(targets[0].server.remotes, both('docs.mcp.cloudflare.com'));
  assert.deepEqual(members.map((m) => [m.server.name, m.server.title, m.meta.status]), [
    ['url/radar.mcp.cloudflare.com/mcp', 'Cloudflare Radar', 'bundled'],
    ['url/browser.mcp.cloudflare.com/mcp', 'Cloudflare', 'bundled']
  ]);
  assert.deepEqual(members[0].server.remotes, both('radar.mcp.cloudflare.com'));
  assert.equal(members[0].server.description, 'Internet traffic insights.');
  assert.equal(members[1].server.description, 'Cloudflare MCP servers');
  assert.deepEqual(members[0].bundle, { entry: 'com.cloudflare.mcp/mcp', servers: 3, listedIn: [radarInDocker.listing] });
  assert.deepEqual(entries.get('com.cloudflare.mcp/mcp'), {
    members: [{ name: 'url/radar.mcp.cloudflare.com/mcp', host: 'radar.mcp.cloudflare.com' }, { name: 'url/browser.mcp.cloudflare.com/mcp', host: 'browser.mcp.cloudflare.com' }],
    servers: 3
  });
});

test('a URL in two bundles is one server, the first', () => {
  const again = entry('com.example/again', [...both('radar.mcp.cloudflare.com'), ...both('a.example.com'), ...both('b.example.com')]);
  const { members } = splitBundles([cloudflare, again]);
  const radar = members.filter((m) => m.server.name === 'url/radar.mcp.cloudflare.com/mcp');
  assert.equal(radar.length, 1);
  assert.deepEqual(radar[0].bundle, { entry: 'com.cloudflare.mcp/mcp', servers: 3 });
});
