import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AWESOME_REMOTE, DOCKER, familyKey, listedEntries, listedName, parseAwesomeRemote, parseDocker } from './sources.js';
import type { RegistryEntry } from '../packages/mcpcost/src/index.js';

const docker = {
  registry: {
    asana: { type: 'remote', title: 'Asana', description: 'Interact with your Asana workspace.', remote: { transport_type: 'sse', url: 'https://mcp.asana.com/sse' } },
    deepwiki: { type: 'remote', title: 'DeepWiki', remote: { transport_type: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' } },
    tenant: { type: 'remote', title: 'Tenant', remote: { transport_type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' } },
    github: { type: 'server', title: 'GitHub', image: 'mcp/github' }
  }
};

const awesome = [
  '# Awesome',
  '- [Not a server](https://example.com) `https://example.com/mcp`',
  '## Servers',
  '### Productivity',
  '- [Asana](https://asana.com) `https://mcp.asana.com/mcp`',
  '  🔐 - Manage Asana tasks, projects, and portfolios.',
  '- [Linear](https://linear.app) `https://mcp.linear.app/mcp`',
  '  [![Linear MCP connector](https://glama.ai/badge.svg)](https://glama.ai/x)',
  '  🔓 - Issues and projects.',
  ''
].join('\n');

const registry = (url: string): RegistryEntry => ({ server: { name: 'app.linear/linear', remotes: [{ type: 'sse', url }] }, meta: { status: 'active', publishedAt: '', updatedAt: '', isLatest: true } });

test('the Docker catalog gives its remote servers, not its images, and no URL with a placeholder', () => {
  const listed = parseDocker(docker);
  assert.deepEqual(listed.map((l) => [l.title, l.transport, l.url]), [['Asana', 'sse', 'https://mcp.asana.com/sse'], ['DeepWiki', 'streamable-http', 'https://mcp.deepwiki.com/mcp']]);
  assert.deepEqual(listed[0].listing, { name: DOCKER.name, url: 'https://hub.docker.com/mcp/server/asana/overview' });
});

test('awesome-remote-mcp-servers gives the entries under Servers, with the description after the badges', () => {
  const listed = parseAwesomeRemote(awesome);
  assert.deepEqual(listed.map((l) => [l.title, l.url, l.description, l.website]), [
    ['Asana', 'https://mcp.asana.com/mcp', 'Manage Asana tasks, projects, and portfolios.', 'https://asana.com'],
    ['Linear', 'https://mcp.linear.app/mcp', 'Issues and projects.', 'https://linear.app']
  ]);
  assert.equal(listed[0].listing.url, AWESOME_REMOTE.url);
});

test('one server under /mcp and /sse, with or without www and a trailing slash, has one family key', () => {
  assert.equal(familyKey('https://mcp.asana.com/sse'), 'mcp.asana.com');
  assert.equal(familyKey('https://WWW.mcp.asana.com/mcp/?x=1'), 'mcp.asana.com');
  assert.equal(familyKey('https://mcp.atlassian.com/v1/mcp'), 'mcp.atlassian.com/v1');
  assert.equal(familyKey('https://{tenant}.example.com/mcp'), undefined);
});

test('the board name is the one /check gives a tracked URL', () => {
  assert.equal(listedName(new URL('https://Mcp.Example.com/v1/mcp/')), 'url/mcp.example.com/v1/mcp');
  assert.equal(listedName(new URL('https://mcp.example.com/a:b//c')), 'url/mcp.example.com/a-b/c');
});

test('a server both catalogs list is one entry; a server the registry has is left out', () => {
  const entries = listedEntries([...parseDocker(docker), ...parseAwesomeRemote(awesome)], [registry('https://mcp.linear.app/sse')], '2026-10-27T09:00:00Z');
  assert.deepEqual(entries.map((e) => e.server.name), ['url/mcp.asana.com/mcp', 'url/mcp.deepwiki.com/mcp']);
  const asana = entries[0];
  // The streamable-http endpoint first, the SSE one as the fallback the probe tries when the first fails.
  assert.deepEqual(asana.server.remotes, [{ type: 'streamable-http', url: 'https://mcp.asana.com/mcp' }, { type: 'sse', url: 'https://mcp.asana.com/sse' }]);
  assert.equal(asana.server.title, 'Asana');
  assert.equal(asana.server.description, 'Interact with your Asana workspace.');
  assert.equal(asana.server.websiteUrl, 'https://asana.com');
  assert.deepEqual(asana.listedIn.map((l) => l.name), [DOCKER.name, AWESOME_REMOTE.name]);
  assert.equal(asana.meta.status, 'listed');
});
