import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { credentialKey, credentialsFor, createProvider, describeEntry, emptyStore, loadCredentials, saveCredentials } from '../src/credentials.js';

const SERVER = 'https://mcp.example.test/mcp';
const AS = 'https://auth.example.test';

/**
 * A fake authorization server behind fetch: protected resource metadata,
 * server metadata, dynamic registration, the code exchange and the refresh.
 */
function fakeAuthServer() {
  const calls: Array<{ url: string; body?: string }> = [];
  let refreshes = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? String(init.body) : undefined;
    calls.push({ url, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/.well-known/oauth-protected-resource')) return json({ resource: SERVER, authorization_servers: [AS] });
    if (url.includes('/.well-known/oauth-authorization-server') || url.includes('/.well-known/openid-configuration')) {
      if (!url.startsWith(AS)) return new Response('', { status: 404 });
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (url === `${AS}/register`) {
      const meta = JSON.parse(body ?? '{}') as { redirect_uris: string[] };
      return json({ client_id: 'client-1', redirect_uris: meta.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
    }
    if (url === `${AS}/token`) {
      const params = new URLSearchParams(body ?? '');
      if (params.get('grant_type') === 'authorization_code') {
        if (params.get('code') !== 'code-1' || !params.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'access-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'refresh-1') {
        refreshes++;
        return json({ access_token: `access-${refreshes + 1}`, token_type: 'bearer', expires_in: 3600 });
      }
      return json({ error: 'invalid_grant' }, 400);
    }
    return new Response('', { status: 404 });
  };
  return { fetchFn, calls, refreshes: () => refreshes };
}

describe('credentials file', () => {
  it('normalises the key', () => {
    expect(credentialKey('https://mcp.example.test/mcp/')).toBe('https://mcp.example.test/mcp');
    expect(credentialKey('https://mcp.example.test/mcp#x')).toBe('https://mcp.example.test/mcp');
  });

  it('round-trips through a file with mode 0600', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mcpcost-creds-'));
    const file = path.join(dir, 'nested', 'credentials.json');
    expect(await loadCredentials(file)).toEqual({ version: 1, servers: {} });
    const store = emptyStore();
    store.servers[credentialKey(SERVER)] = { headers: { Authorization: 'Bearer k' } };
    await saveCredentials(store, file);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(store);
    expect(await loadCredentials(file)).toEqual(store);
  });

  it('describes an entry without its secrets', () => {
    const d = describeEntry({ headers: { Authorization: 'Bearer secret-value' }, oauth: { tokens: { access_token: 'a', token_type: 'bearer', refresh_token: 'r' }, authorizedAt: '2026-10-17T10:00:00Z' } });
    expect(d).toBe('headers: Authorization; oauth: access and refresh token, authorized 2026-10-17');
    expect(d).not.toContain('secret-value');
  });

  it('hands a probe the headers, and a provider only once there is OAuth state', () => {
    const store = emptyStore();
    expect(credentialsFor(store, SERVER)).toBeUndefined();
    store.servers[credentialKey(SERVER)] = { headers: { 'x-api-key': 'k' } };
    expect(credentialsFor(store, SERVER)).toEqual({ headers: { 'x-api-key': 'k' } });
    store.servers[credentialKey(SERVER)] = { oauth: { tokens: { access_token: 'a', token_type: 'bearer' } } };
    expect(credentialsFor(store, SERVER)?.authProvider).toBeDefined();
  });
});

describe('the OAuth flow over the file provider', () => {
  it('registers, sends the user to consent, exchanges the code and stores the tokens', async () => {
    const { fetchFn, calls } = fakeAuthServer();
    const store = emptyStore();
    let consentUrl: URL | undefined;
    const provider = createProvider(store, SERVER, { redirectUrl: 'http://127.0.0.1:4242/callback', onRedirect: (u) => void (consentUrl = u) });

    expect(await auth(provider, { serverUrl: SERVER, fetchFn })).toBe('REDIRECT');
    expect(consentUrl?.origin).toBe(AS);
    expect(consentUrl?.searchParams.get('client_id')).toBe('client-1');
    expect(consentUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consentUrl?.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4242/callback');
    expect(consentUrl?.searchParams.get('state')).toBe(provider.lastState);
    expect(store.servers[credentialKey(SERVER)].oauth?.clientInformation).toMatchObject({ client_id: 'client-1' });

    expect(await auth(provider, { serverUrl: SERVER, authorizationCode: 'code-1', fetchFn })).toBe('AUTHORIZED');
    const entry = store.servers[credentialKey(SERVER)].oauth!;
    expect(entry.tokens).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(entry.authorizedAt).toBeDefined();
    expect(provider.changed).toBe(true);
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(true);
  });

  it('refreshes a stored token without any consent', async () => {
    const { fetchFn, refreshes } = fakeAuthServer();
    const store = emptyStore();
    store.servers[credentialKey(SERVER)] = {
      oauth: { clientInformation: { client_id: 'client-1', redirect_uris: ['http://127.0.0.1/callback'] }, tokens: { access_token: 'stale', token_type: 'bearer', refresh_token: 'refresh-1' } }
    };
    const provider = createProvider(store, SERVER);
    expect(await auth(provider, { serverUrl: SERVER, fetchFn })).toBe('AUTHORIZED');
    expect(refreshes()).toBe(1);
    expect(store.servers[credentialKey(SERVER)].oauth?.tokens?.access_token).toBe('access-2');
    // The refresh token stays when the server does not send a new one.
    expect(store.servers[credentialKey(SERVER)].oauth?.tokens?.refresh_token).toBe('refresh-1');
  });

  it('refuses the consent step when nobody can click', async () => {
    const { fetchFn } = fakeAuthServer();
    const provider = createProvider(emptyStore(), SERVER);
    await expect(auth(provider, { serverUrl: SERVER, fetchFn })).rejects.toThrow(/needs the consent step/);
  });
});

describe('a client registered for another callback port', () => {
  it('is registered again when the consent is to run on a new port', () => {
    const store = emptyStore();
    store.servers[credentialKey(SERVER)] = { oauth: { clientInformation: { client_id: 'old', redirect_uris: ['http://127.0.0.1:50809/callback'] } } };
    const provider = createProvider(store, SERVER, { redirectUrl: 'http://127.0.0.1:41379/callback', onRedirect: () => undefined });
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.changed).toBe(true);
  });

  it('is kept when it already has tokens, since no consent is needed', () => {
    const store = emptyStore();
    store.servers[credentialKey(SERVER)] = { oauth: { clientInformation: { client_id: 'old', redirect_uris: ['http://127.0.0.1:50809/callback'] }, tokens: { access_token: 'a', token_type: 'bearer', refresh_token: 'r' } } };
    const provider = createProvider(store, SERVER, { redirectUrl: 'http://127.0.0.1:41379/callback', onRedirect: () => undefined });
    expect(provider.clientInformation()).toMatchObject({ client_id: 'old' });
  });
});
