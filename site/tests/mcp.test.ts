import { describe, expect, it } from 'vitest';
import { answer } from '../src/lib/mcp-server';
import { fromSnapshot } from '../src/lib/mcp-snapshot';

const ENDPOINT = 'https://mcpcost.ulehla.dev/mcp';
const ACCEPT = 'application/json, text/event-stream';

/** A POST as a client sends it: JSON, both media types accepted, the body's length in the header. */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, 'content-length': String(Buffer.byteLength(text)), ...headers }, body: text });
}
const initialize = (protocolVersion: string, more: { id?: unknown; capabilities?: unknown; clientInfo?: unknown; params?: object } = {}) => ({
  jsonrpc: '2.0',
  id: 'id' in more ? more.id : 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: more.capabilities ?? {}, clientInfo: more.clientInfo ?? { name: 'test', version: '1.0.0' }, ...more.params }
});
const request = (method: string, params?: object, id: unknown = 2) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const notification = (method: string, params?: object) => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });

/** The requests directories and monitors send: the snapshot answers them without the SDK. */
const QUICK: Array<[string, () => Request]> = [
  ...['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'].map((v): [string, () => Request] => [`initialize ${v}`, () => post(initialize(v))]),
  ['initialize with a version the SDK does not know', () => post(initialize('2099-01-01'))],
  ['initialize with a string id', () => post(initialize('2025-06-18', { id: 'init-1' }))],
  ['initialize with id 0', () => post(initialize('2025-06-18', { id: 0 }))],
  ['initialize with the largest safe id', () => post(initialize('2025-06-18', { id: Number.MAX_SAFE_INTEGER }))],
  ['initialize with the usual capabilities', () => post(initialize('2025-06-18', { capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} } }))],
  ['initialize with every capability the check knows', () => post(initialize('2025-11-25', { capabilities: { experimental: { a: {} }, extensions: { b: {} }, sampling: { context: {}, tools: {} }, roots: {}, elicitation: { form: { applyDefaults: true }, url: {} }, other: 1 } }))],
  ['initialize with a full clientInfo', () => post(initialize('2025-11-25', { clientInfo: { name: 'n', title: 't', version: '2', websiteUrl: 'https://example.com', description: 'd', icons: [{ src: 'https://example.com/i.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'dark' }] } }))],
  ['initialize with unknown params', () => post(initialize('2025-06-18', { params: { extra: true } }))],
  ['initialize with a charset in the content type', () => post(initialize('2025-06-18'), { 'content-type': 'application/json; charset=utf-8' })],
  ['notifications/initialized', () => post(notification('notifications/initialized'))],
  ['notifications/initialized with the protocol header', () => post(notification('notifications/initialized'), { 'mcp-protocol-version': '2025-06-18' })],
  ['notifications/cancelled with params', () => post(notification('notifications/cancelled', { requestId: 1, reason: 'gone' }))],
  ['tools/list', () => post(request('tools/list'))],
  ['tools/list with the protocol header', () => post(request('tools/list'), { 'mcp-protocol-version': '2024-11-05' })],
  ['tools/list with empty params', () => post(request('tools/list', {}))],
  ['tools/list with a cursor', () => post(request('tools/list', { cursor: 'abc' }))],
  ['tools/list with a string id', () => post(request('tools/list', undefined, 'list-"1"'))],
  ['ping', () => post(request('ping'))]
];

/** The requests the snapshot leaves to the SDK, malformed ones among them: the answer must be the SDK's all the same. */
const SDK: Array<[string, () => Request]> = [
  ['tools/call', () => post(request('tools/call', { name: 'check_server', arguments: { url: 'http://example.com/mcp' } }))],
  ['a method the server does not have', () => post(request('resources/list'))],
  ['initialize with _meta', () => post(initialize('2025-06-18', { params: { _meta: { progressToken: 1 } } }))],
  ['initialize with the tasks capability', () => post(initialize('2025-06-18', { capabilities: { tasks: { list: {} } } }))],
  ['initialize with a null title', () => post(initialize('2025-06-18', { clientInfo: { name: 'n', version: '1', title: null } }))],
  ['initialize without clientInfo', () => post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })],
  ['initialize with roots.listChanged as a string', () => post(initialize('2025-06-18', { capabilities: { roots: { listChanged: 'yes' } } }))],
  ['initialize as a notification', () => post({ jsonrpc: '2.0', method: 'initialize', params: initialize('2025-06-18').params })],
  ['initialize with a fractional id', () => post(initialize('2025-06-18', { id: 1.5 }))],
  ['initialize with an id over the safe range', () => post(initialize('2025-06-18', { id: 2 ** 53 }))],
  ['initialize with an extra top-level key', () => post({ ...initialize('2025-06-18'), extra: 1 })],
  ['a batch', () => post([initialize('2025-06-18')])],
  ['a body that is not JSON', () => post('{"jsonrpc":')],
  ['an empty body', () => post('')],
  ['a JSON-RPC response', () => post({ jsonrpc: '2.0', id: 1, result: {} })],
  ['tools/list with a protocol version the SDK does not know', () => post(request('tools/list'), { 'mcp-protocol-version': '1999-01-01' })],
  ['a notification with a protocol version the SDK does not know', () => post(notification('notifications/initialized'), { 'mcp-protocol-version': '1999-01-01' })],
  ['tools/list with a null cursor', () => post(request('tools/list', { cursor: null }))],
  ['tools/list with _meta', () => post(request('tools/list', { _meta: { progressToken: 'p' } }))],
  ['ping with jsonrpc 1.0', () => post({ jsonrpc: '1.0', id: 1, method: 'ping' })],
  ['an Accept header without text/event-stream', () => post(request('tools/list'), { accept: 'application/json' })],
  ['a text/plain body', () => post(request('tools/list'), { 'content-type': 'text/plain' })],
  ['a body without a content-length', () => new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT }, body: JSON.stringify(request('tools/list')) })],
  ['DELETE', () => new Request(ENDPOINT, { method: 'DELETE', headers: { accept: ACCEPT } })]
];

/** Status, headers and body bytes. */
async function whole(res: Response) {
  return { status: res.status, headers: [...res.headers], body: await res.text() };
}

describe('initialize, tools/list, ping and notifications from the snapshot', () => {
  for (const [name, make] of [...QUICK, ...SDK]) {
    it(`answer as the SDK does: ${name}`, async () => {
      const quick = await fromSnapshot(make());
      const got = quick instanceof Response ? await whole(quick) : await whole(await answer(quick));
      expect(got).toEqual(await whole(await answer(make())));
    });
  }

  it('need no SDK for the requests directories and monitors send', async () => {
    for (const [name, make] of QUICK) expect(await fromSnapshot(make()), name).toBeInstanceOf(Response);
  });

  it('leave the rest to the SDK', async () => {
    for (const [name, make] of SDK) expect(await fromSnapshot(make()), name).toBeInstanceOf(Request);
  });
});
