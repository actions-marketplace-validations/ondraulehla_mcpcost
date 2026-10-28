import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downChange, evidenceRow, failingSinceOf } from './rows.js';
import type { ServerRow } from './build-data.js';

const DAY1 = '2026-10-24T08:40:00.000Z';
const DAY2 = '2026-10-25T09:10:00.000Z';
const DAY3 = '2026-10-26T08:20:00.000Z';

function server(over: Partial<ServerRow>): ServerRow {
  return { name: 'io.example/server', url: 'https://example.com/mcp', host: 'example.com', transport: 'streamable-http', registryStatus: 'active', registryUpdatedAt: DAY1, probedAt: DAY3, status: 'ok', ...over };
}

test('failingSince starts at the first failed probe and stays while the server fails', () => {
  assert.equal(failingSinceOf({ status: 'ok', probedAt: DAY3 }, { status: 'timeout', probedAt: DAY2, failingSince: DAY1 }), undefined);
  assert.equal(failingSinceOf({ status: 'timeout', probedAt: DAY3 }, { status: 'ok', probedAt: DAY2 }), DAY3);
  assert.equal(failingSinceOf({ status: 'dns', probedAt: DAY3 }, { status: 'timeout', probedAt: DAY2, failingSince: DAY1 }), DAY1);
  assert.equal(failingSinceOf({ status: 'timeout', probedAt: DAY3 }, undefined), DAY3);
});

test('failingSince takes the seeded D1 value before servers.json has one, else the previous probe', () => {
  assert.equal(failingSinceOf({ status: 'timeout', probedAt: DAY3 }, { status: 'timeout', probedAt: DAY2 }, DAY1), DAY1);
  assert.equal(failingSinceOf({ status: 'timeout', probedAt: DAY3 }, { status: 'timeout', probedAt: DAY2 }), DAY2);
  // A carried package row (not probed again) keeps its value.
  assert.equal(failingSinceOf({ status: 'crashed', probedAt: DAY1, failingSince: DAY1 }, { status: 'crashed', probedAt: DAY1, failingSince: DAY1 }), DAY1);
});

test('a server goes down only after two days of failed probes, and comes back only from down', () => {
  assert.equal(downChange({ status: 'ok', probedAt: DAY2 }, { status: 'timeout', probedAt: DAY3, failingSince: DAY3 }), undefined);
  assert.equal(downChange({ status: 'timeout', probedAt: DAY2, failingSince: DAY1 }, { status: 'timeout', probedAt: DAY3, failingSince: DAY1 }), 'went-down');
  assert.equal(downChange({ status: 'timeout', probedAt: DAY2, failingSince: DAY2 }, { status: 'ok', probedAt: DAY3 }), undefined);
  assert.equal(downChange({ status: 'dns', probedAt: DAY3, failingSince: DAY1 }, { status: 'ok', probedAt: '2026-10-27T08:00:00.000Z' }), 'came-back');
  // A previous row from before the rule counts as down when it failed, as the board said then.
  assert.equal(downChange({ status: 'not_found', probedAt: DAY2 }, { status: 'auth', probedAt: DAY3 }), 'came-back');
  assert.equal(downChange({ status: 'not_found', probedAt: DAY2 }, { status: 'not_found', probedAt: DAY3, failingSince: DAY1 }), undefined);
});

test('evidence calls an entry dead only after two days, and a URL template unknown', () => {
  assert.equal(evidenceRow(server({ status: 'dns', failingSince: DAY3 })).state, 'transient');
  assert.equal(evidenceRow(server({ status: 'dns', failingSince: DAY1 })).state, 'dead');
  assert.equal(evidenceRow(server({ status: 'timeout', failingSince: DAY1 })).state, 'transient');
  assert.equal(evidenceRow(server({ status: 'needs_url', url: 'https://{tenant}.example.com/mcp' })).state, 'unknown');
  assert.equal(evidenceRow(server({ status: 'ok' })).state, 'alive');
});

test('evidence carries the entry version and the first failed check', () => {
  const row = evidenceRow(server({ status: 'not_found', version: '1.2.0', failingSince: DAY1, httpStatus: 404 }));
  assert.equal(row.version, '1.2.0');
  assert.deepEqual(Object.keys(row), ['entry', 'version', 'checked_at', 'check', 'state', 'evidence']);
  assert.equal(row.evidence.failing_since, DAY1);
  assert.equal('version' in evidenceRow(server({ status: 'ok' })), false);
});

test('a server that rejects the requested protocol version is unknown, never dead, and the row keeps the step and the error code', () => {
  const rejected = server({ status: 'unsupported_version', httpStatus: 400, failingSince: DAY1, error: 'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":0,"error":{"code":-32022,"message":"Unsupported protocol version: 2025-11-25"}}' });
  const row = evidenceRow(rejected);
  assert.equal(row.state, 'unknown');
  assert.equal(row.evidence.method_phase, 'initialize');
  assert.equal(row.evidence.jsonrpc_error_code, -32022);
  // A server that answered initialize and failed on tools/list says so; a package check has no phase.
  assert.equal(evidenceRow(server({ status: 'protocol_error', initMs: 120, error: 'MCP error -32601: Method not found' })).evidence.method_phase, 'tools/list');
  assert.equal(evidenceRow(server({ status: 'protocol_error', initMs: 120, error: 'MCP error -32601: Method not found' })).evidence.jsonrpc_error_code, -32601);
  assert.equal(evidenceRow(server({ status: 'crashed', transport: 'stdio' })).evidence.method_phase, undefined);
  assert.equal(evidenceRow(server({ status: 'ok' })).evidence.method_phase, undefined);
});
