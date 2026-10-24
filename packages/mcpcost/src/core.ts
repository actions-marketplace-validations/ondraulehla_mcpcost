/**
 * The transport-level probe without token counting. The board's Worker imports
 * this file, so it must not pull in the tokenizer (its tables take CPU to load).
 * probe.ts and stdio.ts add the token costs on top.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { jsonSchemaValidator, JsonSchemaValidator, JsonSchemaValidatorResult } from '@modelcontextprotocol/sdk/validation/types.js';
import type { AuthKind, AuthMetadata, ProbeResult, ProbeStatus, RemoteTransport } from './types.js';

export const VERSION = '0.3.4';
export const USER_AGENT = `mcpcost/${VERSION} (mcpcost; +https://github.com/ondraulehla/mcpcost)`;

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CoreOptions {
  /** Timeout for the whole probe and for each request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Extra request headers, for example an Authorization header from your config. */
  headers?: Record<string, string>;
  /** An OAuth client with stored tokens; the transport sends them and refreshes them. See credentials.ts. */
  authProvider?: OAuthClientProvider;
  fetch?: typeof fetch;
}

export interface RawProbe {
  result: ProbeResult;
  tools: RawTool[];
}

interface Observed {
  status: number;
  headers: Headers;
  url: string;
}

export function emptyResult(url: string, transport: ProbeResult['transport']): ProbeResult {
  return { url, transport, probedAt: new Date().toISOString(), status: 'error', latencyMs: {} };
}

/** Connects to a remote MCP server and lists its tools. No token counting. */
export async function probeRemoteRaw(remote: { url: string; type: RemoteTransport }, options: CoreOptions = {}): Promise<RawProbe> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseFetch = options.fetch ?? fetch;
  const result = emptyResult(remote.url, remote.type);

  let url: URL;
  try {
    url = new URL(remote.url);
  } catch {
    result.error = 'invalid URL';
    return { result, tools: [] };
  }

  let first: Observed | undefined;
  const observingFetch: typeof fetch = async (input, init) => {
    // The probe needs no server-initiated messages. Answering 405 to the standalone
    // GET makes the SDK skip that stream, which otherwise stalls tools/list on some
    // servers (DeepWiki held it for 15 s and never answered the POST meanwhile).
    if (remote.type !== 'sse' && (init?.method ?? 'GET') === 'GET') {
      return new Response(null, { status: 405 });
    }
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const headers = new Headers(init?.headers);
    headers.set('user-agent', USER_AGENT);
    const res = await baseFetch(input, { ...init, headers, signal });
    first ??= { status: res.status, headers: res.headers, url: String(input instanceof Request ? input.url : input) };
    return res;
  };

  // Follow redirects across origins too: a server that moved should be measured where it lives.
  const requestInit: RequestInit = { headers: options.headers };
  const transport =
    remote.type === 'sse'
      ? new SSEClientTransport(url, { fetch: observingFetch, requestInit, redirectPolicy: 'follow', authProvider: options.authProvider })
      : new StreamableHTTPClientTransport(url, { fetch: observingFetch, requestInit, redirectPolicy: 'follow', authProvider: options.authProvider });

  const tools = await measure(transport, result, timeoutMs);

  if (result.status === 'ok') {
    result.httpStatus = first?.status;
  } else {
    result.status = classify(result.error, first);
    if (first) {
      result.httpStatus = first.status;
      const www = first.headers.get('www-authenticate');
      if (www) {
        result.authScheme = www.split(/[\s,]/)[0];
        const m = /resource_metadata="([^"]+)"/i.exec(www);
        if (m) result.authResourceMetadata = m[1];
      }
      if (result.status === 'auth') {
        const access = await readAuthMetadata(url, result.authResourceMetadata, baseFetch, Math.min(timeoutMs, 10_000));
        if (access.documentation) result.authDocumentation = access.documentation;
        if (access.metadata) result.authMetadata = access.metadata;
        result.authKind = access.metadata ? (access.metadata.dynamicRegistration ? 'oauth-dcr' : 'oauth') : result.authScheme ? 'token' : 'unknown';
      }
    }
  }
  return { result, tools };
}

/** Reads one small JSON document with the probe's identity, or nothing: the metadata is a bonus, not a result. */
async function readJson(candidate: string, baseFetch: typeof fetch, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await baseFetch(candidate, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const doc = (await res.json()) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const httpUrl = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) && v.trim().length <= max ? v.trim() : undefined);
const shortStrings = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, max);
  return out.length ? out : undefined;
};

/**
 * What a server that needs auth publishes about getting in. First the OAuth protected-resource metadata
 * (RFC 9728): the URL from WWW-Authenticate, else the well-known path with the resource path, then the bare
 * one, as the SDK's discovery does. Then, when it names an authorization server, that server's metadata
 * (RFC 8414, then OpenID discovery, in the SDK's order), for the one fact a client needs most: whether it
 * can register itself. Two to four small requests, never a token, never a consent.
 */
async function readAuthMetadata(url: URL, fromHeader: string | undefined, baseFetch: typeof fetch, timeoutMs: number): Promise<{ documentation?: string; metadata?: AuthMetadata }> {
  const candidates = fromHeader
    ? [fromHeader]
    : [...(url.pathname !== '/' ? [`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`] : []), `${url.origin}/.well-known/oauth-protected-resource`];
  let prm: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    prm = await readJson(candidate, baseFetch, timeoutMs);
    if (prm) break;
  }
  if (!prm) return {};
  const metadata: AuthMetadata = {};
  const servers = shortStrings(prm.authorization_servers, 3)?.map((v) => httpUrl(v)).filter((v): v is string => !!v);
  if (servers?.length) metadata.authorizationServers = servers;
  const scopes = shortStrings(prm.scopes_supported, 20);
  if (scopes) metadata.scopesSupported = scopes;
  if (typeof prm.resource_name === 'string' && prm.resource_name.trim()) metadata.resourceName = prm.resource_name.trim().slice(0, 120);
  const documentation = httpUrl(prm.resource_documentation);

  const issuer = servers?.[0];
  if (issuer) {
    const as = await authorizationServerMetadata(issuer, baseFetch, timeoutMs);
    metadata.authorizationServerMetadata = !!as;
    if (as) {
      metadata.dynamicRegistration = !!httpUrl(as.registration_endpoint);
      metadata.pkce = Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes('S256');
      metadata.grantTypes = shortStrings(as.grant_types_supported, 5) ?? ['authorization_code'];
    }
  }
  return { documentation, metadata };
}

/** The authorization server's metadata, at the well-known paths the SDK tries, in its order. */
async function authorizationServerMetadata(issuer: string, baseFetch: typeof fetch, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return undefined;
  }
  const path = u.pathname.replace(/\/$/, '');
  const candidates = path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    const doc = await readJson(candidate, baseFetch, timeoutMs);
    if (doc) return doc;
  }
  return undefined;
}

/** The part every transport shares: initialize, read the server info, list the tools. */
/**
 * The probe never calls a tool, so it never validates a tool result. A no-op
 * validator skips the SDK's default, which compiles schemas with new Function
 * and is refused inside Cloudflare Workers.
 */
const noValidation: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: input as T, errorMessage: undefined });
  }
};

export async function measure(transport: Transport, result: ProbeResult, timeoutMs: number): Promise<RawTool[]> {
  const client = new Client({ name: 'mcpcost', version: VERSION }, { capabilities: {}, jsonSchemaValidator: noValidation });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`probe timed out after ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const tools: RawTool[] = [];
  try {
    const t0 = performance.now();
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), deadline]);
    result.latencyMs.initialize = Math.round(performance.now() - t0);

    const info = client.getServerVersion();
    if (info) result.serverInfo = { name: info.name, version: info.version, title: info.title };
    const caps = client.getServerCapabilities() ?? {};
    result.capabilities = Object.keys(caps).sort();
    result.instructionsChars = client.getInstructions()?.length ?? 0;
    result.protocolVersion = (transport as { protocolVersion?: string }).protocolVersion;

    if (caps.tools) {
      let cursor: string | undefined;
      const t1 = performance.now();
      do {
        const page = await Promise.race([client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }), deadline]);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 2_000);
      result.latencyMs.toolsList = Math.round(performance.now() - t1);
    }
    result.toolCount = tools.length;
    result.status = 'ok';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; code?: string } };
    result.error = [e?.message ?? String(err), e?.cause?.message, e?.cause?.code].filter(Boolean).join(' | ').slice(0, 400);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
  return tools;
}

export function classify(message: string | undefined, first: Observed | undefined): ProbeStatus {
  const text = message ?? '';
  // The server speaks a protocol version that this SDK does not support yet.
  if (/protocol version is not supported/i.test(text)) return 'newer_protocol';
  if (first) {
    if (first.status === 401 || first.status === 403) return 'auth';
    if (first.status === 402) return 'payment';
    if (first.status === 404 || first.status === 405 || first.status === 410) return 'not_found';
    if (first.status === 429) return 'rate_limited';
    // Inside Cloudflare Workers a failed origin fetch comes back as a 52x/530 page.
    if (first.status === 530 || /error code: 10(00|16)/.test(text)) return 'dns';
    if (first.status === 522 || first.status === 524) return 'timeout';
    if (first.status === 521 || first.status === 523) return 'refused';
    if (first.status === 525 || first.status === 526) return 'tls';
    if (first.status >= 500) return 'server_error';
    if (first.status >= 200 && first.status < 300) {
      if (/timed? ?out|TimeoutError/i.test(text)) return 'timeout';
      return 'protocol_error';
    }
  }
  if (/timed? ?out|TimeoutError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(text)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'dns';
  if (/CERT_|certificate|TLS|SSL|ERR_TLS/i.test(text)) return 'tls';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET/i.test(text)) return 'refused';
  return 'error';
}
