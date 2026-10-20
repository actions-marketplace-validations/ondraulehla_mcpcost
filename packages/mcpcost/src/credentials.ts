/**
 * Credentials for servers that need auth: static headers, or OAuth client
 * information and tokens from the MCP authorization flow. One JSON file,
 * keyed by server URL, written with mode 0600. The provider below implements
 * the SDK's OAuthClientProvider over that file, so a transport refreshes
 * tokens on its own and the refreshed tokens land back in the file.
 *
 * Node only: the Worker never imports this file.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthEntry {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  scope?: string;
  /** When the user last went through the consent step. */
  authorizedAt?: string;
}

export interface CredentialEntry {
  /** Static request headers, for example an Authorization header with an API key. */
  headers?: Record<string, string>;
  /** The state of the MCP OAuth flow for this server. */
  oauth?: OAuthEntry;
}

export interface CredentialStore {
  version: 1;
  servers: Record<string, CredentialEntry>;
}

export function defaultCredentialsPath(): string {
  return process.env.MCPCOST_CREDENTIALS || path.join(homedir(), '.mcpcost', 'credentials.json');
}

/** The key of a server in the store: its URL without fragment or trailing slash. */
export function credentialKey(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

export function emptyStore(): CredentialStore {
  return { version: 1, servers: {} };
}

export async function loadCredentials(file = defaultCredentialsPath()): Promise<CredentialStore> {
  if (!existsSync(file)) return emptyStore();
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<CredentialStore>;
  return { version: 1, servers: parsed.servers ?? {} };
}

/** Writes the store with mode 0600; the directory is created when needed. */
export async function saveCredentials(store: CredentialStore, file = defaultCredentialsPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600);
}

export function entryFor(store: CredentialStore, url: string): CredentialEntry | undefined {
  try {
    return store.servers[credentialKey(url)];
  } catch {
    return undefined;
  }
}

/** What an entry holds, without a secret value in it. */
export function describeEntry(entry: CredentialEntry): string {
  const parts: string[] = [];
  if (entry.headers) parts.push(`headers: ${Object.keys(entry.headers).join(', ')}`);
  if (entry.oauth) {
    const t = entry.oauth.tokens;
    parts.push(
      t
        ? `oauth: ${t.refresh_token ? 'access and refresh token' : 'access token only'}${entry.oauth.authorizedAt ? `, authorized ${entry.oauth.authorizedAt.slice(0, 10)}` : ''}`
        : entry.oauth.clientInformation
          ? 'oauth: client registered, no token yet'
          : 'oauth: nothing yet'
    );
  }
  return parts.join('; ') || 'empty';
}

export interface ProviderOptions {
  /** Where the authorization server sends the user back. Any URL for a non-interactive provider. */
  redirectUrl?: string;
  /** Called with the authorization URL when the user has to consent. Without it the provider refuses, so a batch run never hangs. */
  onRedirect?: (url: URL) => void | Promise<void>;
  /** Called after every write to the store. */
  onChange?: () => void;
  scope?: string;
}

export interface FileProvider extends OAuthClientProvider {
  /** True once the provider wrote to the store. */
  readonly changed: boolean;
  /** The state parameter of the authorization request, for the callback check. */
  readonly lastState: string | undefined;
}

/** An OAuthClientProvider over one entry of the store. */
export function createProvider(store: CredentialStore, url: string, options: ProviderOptions = {}): FileProvider {
  const key = credentialKey(url);
  const entry = (store.servers[key] ??= {});
  const oauth = (entry.oauth ??= {});
  if (options.scope) oauth.scope = options.scope;
  const redirectUrl = options.redirectUrl ?? 'http://127.0.0.1/callback';
  let changed = false;
  // A client registered for another redirect URI (an earlier port) cannot be used; register again.
  if (options.onRedirect && oauth.clientInformation && !oauth.tokens) {
    const uris = (oauth.clientInformation as { redirect_uris?: string[] }).redirect_uris;
    if (uris && !uris.includes(redirectUrl)) {
      delete oauth.clientInformation;
      changed = true;
    }
  }
  let verifier: string | undefined;
  let state: string | undefined;
  const touched = () => {
    changed = true;
    options.onChange?.();
  };
  return {
    get changed() {
      return changed;
    },
    get lastState() {
      return state;
    },
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'mcpcost',
        client_uri: 'https://mcpcost.ulehla.dev',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(oauth.scope ? { scope: oauth.scope } : {})
      };
    },
    state() {
      state = randomBytes(16).toString('hex');
      return state;
    },
    clientInformation() {
      return oauth.clientInformation;
    },
    saveClientInformation(info) {
      oauth.clientInformation = info;
      touched();
    },
    tokens() {
      return oauth.tokens;
    },
    saveTokens(tokens) {
      oauth.tokens = tokens;
      oauth.authorizedAt ??= new Date().toISOString();
      touched();
    },
    async redirectToAuthorization(authorizationUrl) {
      if (!options.onRedirect) throw new Error(`${key} needs the consent step: run "mcpcost auth ${key}"`);
      await options.onRedirect(authorizationUrl);
    },
    saveCodeVerifier(v) {
      verifier = v;
    },
    codeVerifier() {
      if (!verifier) throw new Error('no code verifier: the authorization did not start in this process');
      return verifier;
    },
    saveDiscoveryState(s) {
      oauth.discovery = s;
      touched();
    },
    discoveryState() {
      return oauth.discovery;
    },
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') delete oauth.tokens;
      if (scope === 'all' || scope === 'client') delete oauth.clientInformation;
      if (scope === 'all' || scope === 'discovery') delete oauth.discovery;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope !== 'verifier') touched();
    }
  };
}

/** What a probe needs for a URL: static headers, an OAuth provider, or nothing. */
export function credentialsFor(store: CredentialStore, url: string, options: ProviderOptions = {}): { headers?: Record<string, string>; authProvider?: FileProvider } | undefined {
  const entry = entryFor(store, url);
  if (!entry) return undefined;
  const out: { headers?: Record<string, string>; authProvider?: FileProvider } = {};
  if (entry.headers && Object.keys(entry.headers).length) out.headers = { ...entry.headers };
  if (entry.oauth?.tokens || entry.oauth?.clientInformation) out.authProvider = createProvider(store, url, options);
  return out.headers || out.authProvider ? out : undefined;
}
