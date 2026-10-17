/**
 * `mcpcost auth`: the consent step for a server that needs auth, once, in the
 * user's browser. The result lands in the credentials file; every later
 * measurement of that URL uses it and refreshes the token on its own.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { credentialKey, createProvider, credentialsFor, defaultCredentialsPath, describeEntry, loadCredentials, saveCredentials } from './credentials.js';
import { probeRemote } from './probe.js';

const HELP = `mcpcost auth: store credentials for a server that needs auth

Usage
  mcpcost auth <url>                        OAuth: register, open the browser for the consent, store the tokens
  mcpcost auth <url> --header "Name: value" store a static header instead (repeatable)
  mcpcost auth --list                       what the credentials file holds, without the secrets
  mcpcost auth <url> --remove               forget the entry for this URL

Options
  --credentials <file>   the credentials file (default ~/.mcpcost/credentials.json, or $MCPCOST_CREDENTIALS)
  --scope <scope>        scope to ask for in the OAuth flow
  --port <n>             local port for the callback (default 41379; the registered client is bound to it)
  --no-open              print the authorization URL, do not open the browser
  --timeout <ms>         how long to wait for the consent (default 600000)

After the consent the server is measured once with the new credentials, so you see that it works.
The daily board uses the same file through its MCPCOST credentials table; see the README.`;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed too.
  }
}

/** The default callback port. Fixed, because the registered client's redirect URI carries it; a random port would need a new registration every time. */
export const DEFAULT_CALLBACK_PORT = 41379;

/** Waits for one GET /callback?code=…&state=… on a local port. */
function callbackServer(expectedState: () => string | undefined, timeoutMs: number, port: number): Promise<{ redirectUrl: string; code: Promise<string>; close: () => void }> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (err: Error) => void = () => undefined;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = u.searchParams.get('error');
      const received = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (error || !received) {
        res.writeHead(400).end(`<p>mcpcost: the authorization failed: ${error ?? 'no code'}. You can close this tab.</p>`);
        rejectCode(new Error(`authorization failed: ${error ?? 'no code in the callback'} ${u.searchParams.get('error_description') ?? ''}`.trim()));
        return;
      }
      if (expectedState() && state !== expectedState()) {
        res.writeHead(400).end('<p>mcpcost: the state did not match. You can close this tab.</p>');
        rejectCode(new Error('the state in the callback did not match'));
        return;
      }
      res.writeHead(200).end('<p>mcpcost: authorized. You can close this tab and go back to the terminal.</p>');
      resolveCode(received);
    });
    const timer = setTimeout(() => rejectCode(new Error(`no callback within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    timer.unref();
    server.on('error', (err: NodeJS.ErrnoException) => {
      rejectServer(err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use; pass --port <n> (the registered client is bound to the port)`) : err);
    });
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      resolveServer({ redirectUrl: `http://127.0.0.1:${bound}/callback`, code, close: () => { clearTimeout(timer); server.close(); } });
    });
  });
}

export async function authCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      header: { type: 'string', multiple: true },
      credentials: { type: 'string' },
      list: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      scope: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '600000' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const file = values.credentials ?? defaultCredentialsPath();
  const store = await loadCredentials(file);

  if (values.list) {
    const keys = Object.keys(store.servers);
    if (!keys.length) console.log(`${file}: no credentials stored`);
    for (const k of keys) console.log(`${k}\n  ${describeEntry(store.servers[k])}`);
    return 0;
  }

  const raw = positionals[0];
  if (!raw) {
    console.error(HELP);
    return 2;
  }
  let key: string;
  try {
    key = credentialKey(raw);
  } catch {
    console.error(`${raw} is not a URL`);
    return 2;
  }

  if (values.remove) {
    if (store.servers[key]) {
      delete store.servers[key];
      await saveCredentials(store, file);
      console.log(`${key}: removed from ${file}`);
    } else console.log(`${key}: nothing stored`);
    return 0;
  }

  if (values.header?.length) {
    const entry = (store.servers[key] ??= {});
    entry.headers ??= {};
    for (const h of values.header) {
      const i = h.indexOf(':');
      if (i <= 0) {
        console.error(`--header wants "Name: value", got ${JSON.stringify(h)}`);
        return 2;
      }
      entry.headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    await saveCredentials(store, file);
    console.log(`${key}: ${describeEntry(entry)} stored in ${file}`);
    return verify(store, key);
  }

  // The OAuth flow: discovery, registration, the consent in the browser, the token.
  const timeoutMs = Number(values.timeout) || 600_000;
  const cb = await callbackServer(() => provider.lastState, timeoutMs, Number(values.port) || DEFAULT_CALLBACK_PORT);
  const provider = createProvider(store, key, {
    redirectUrl: cb.redirectUrl,
    scope: values.scope,
    onRedirect: (url) => {
      console.log(`\nOpen this URL and allow the access:\n  ${url}\n`);
      if (!values['no-open']) openBrowser(url.toString());
      console.log(`Waiting for the consent, up to ${Math.round(timeoutMs / 60_000)} minutes…`);
    }
  });
  try {
    const first = await auth(provider, { serverUrl: key });
    if (first === 'REDIRECT') {
      const code = await cb.code;
      const second = await auth(provider, { serverUrl: key, authorizationCode: code });
      if (second !== 'AUTHORIZED') throw new Error(`unexpected result ${second}`);
    }
    await saveCredentials(store, file);
    console.log(`${key}: ${describeEntry(store.servers[key])} stored in ${file}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (provider.changed) await saveCredentials(store, file);
    console.error(`${key}: the OAuth flow failed: ${message}`);
    console.error('If the server takes an API key instead, store it with: mcpcost auth <url> --header "Authorization: Bearer …"');
    return 1;
  } finally {
    cb.close();
  }
  return verify(store, key);
}

/** One measurement with the stored credentials, so the user sees the result. */
async function verify(store: Awaited<ReturnType<typeof loadCredentials>>, key: string): Promise<number> {
  const creds = credentialsFor(store, key);
  const type = /\/sse\/?$/.test(new URL(key).pathname) ? 'sse' : 'streamable-http';
  const r = await probeRemote({ url: key, type }, { timeoutMs: 20_000, headers: creds?.headers, authProvider: creds?.authProvider, includeTools: false });
  if (r.status === 'ok') console.log(`measured: alive, ${r.toolCount} tools, ${r.toolsTokens?.toLocaleString('en-US')} tokens (o200k estimate)`);
  else console.log(`measured: ${r.status}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}${r.error ? `: ${r.error.split('\n')[0].slice(0, 160)}` : ''}`);
  return r.status === 'ok' ? 0 : 1;
}
