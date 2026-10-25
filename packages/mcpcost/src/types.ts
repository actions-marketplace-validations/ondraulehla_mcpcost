export type RemoteTransport = 'streamable-http' | 'sse';
export type ProbeTransport = RemoteTransport | 'stdio';

/** A value for a {placeholder} in a remote URL, as the registry entry declares it. */
export interface RegistryVariable {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  choices?: string[];
  format?: string;
}

export interface RegistryRemote {
  type: RemoteTransport;
  /** The endpoint. It can hold {placeholders} that a client fills in, for example https://{tenant}.example.com/mcp. */
  url: string;
  headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
  /** The values for the placeholders in url, by name. */
  variables?: Record<string, RegistryVariable>;
}

export interface RegistryArgument {
  type: 'positional' | 'named' | 'flag' | string;
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  isRequired?: boolean;
  isRepeated?: boolean;
  description?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string; url?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean; default?: string }>;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string };
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}

export interface RegistryEntry {
  server: RegistryServer;
  meta: {
    status: 'active' | 'deprecated' | 'deleted' | string;
    publishedAt: string;
    updatedAt: string;
    isLatest: boolean;
  };
}

export type ProbeStatus =
  | 'ok'
  | 'auth'
  | 'payment'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'protocol_error'
  | 'newer_protocol'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'refused'
  | 'error'
  // The registry URL has {placeholders} with no usable value: each user fills in their own. Not probed.
  | 'needs_url'
  // package (stdio) servers only
  | 'install_failed'
  | 'no_bin'
  | 'needs_env'
  | 'needs_args'
  | 'needs_network'
  | 'crashed';

/** Reachable but not usable without something from the user: credentials, arguments, a network, a URL of their own, or a newer SDK. */
export const GATED_STATUSES: ReadonlySet<string> = new Set(['auth', 'payment', 'newer_protocol', 'needs_env', 'needs_args', 'needs_network', 'needs_url']);

/** A result that is neither alive nor gated: the server did not give a valid answer in this probe. */
export function isFailing(status: string): boolean {
  return status !== 'ok' && !GATED_STATUSES.has(status);
}

/**
 * Calendar days of failed probes before a server counts as down. One failed probe is not an outage: a timeout, a
 * 429 or a 5xx on one day can be the server's bad hour or the probe's own network.
 */
export const DOWN_AFTER_DAYS = 2;

/**
 * True when the server has failed in every probe since failingSince, and failingSince is at least DOWN_AFTER_DAYS
 * calendar days (UTC) before this probe. A daily server is down on its third day without a valid answer; a package
 * server, probed once a week, at its second failed probe.
 */
export function isConfirmedDown(status: string, failingSince: string | null | undefined, probedAt: string | null | undefined): boolean {
  if (!isFailing(status) || !failingSince || !probedAt) return false;
  const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return (day(probedAt) - day(failingSince)) / 86_400_000 >= DOWN_AFTER_DAYS;
}

export interface ToolCost {
  name: string;
  /** Tokens of the tool definition as a model would see it (name, description, input schema). */
  tokens: number;
  /** Bytes of the compact JSON of the same definition. */
  bytes: number;
  descriptionChars: number;
}

/**
 * How a client gets access to a server that needs auth, from what the server publishes:
 * - `oauth-dcr`: OAuth protected-resource metadata (RFC 9728) and an authorization server with dynamic client
 *   registration (RFC 7591). A client such as Claude Code or `mcpcost auth` registers itself and asks for consent.
 * - `oauth`: the same metadata, but the authorization server has no registration endpoint, or its metadata could
 *   not be read: the publisher must give the client an id first.
 * - `token`: a WWW-Authenticate scheme and no OAuth metadata: a key or token the publisher hands out, sent in
 *   the Authorization header.
 * - `unknown`: 401 or 403 with no WWW-Authenticate header and no metadata.
 */
export type AuthKind = 'oauth-dcr' | 'oauth' | 'token' | 'unknown';

/** The public OAuth metadata of a server that needs auth. Every field is optional: the probe keeps what it could read. */
export interface AuthMetadata {
  /** `authorization_servers` of the protected-resource metadata, at most three. */
  authorizationServers?: string[];
  /** `scopes_supported` of the protected-resource metadata, at most twenty. */
  scopesSupported?: string[];
  /** `resource_name` of the protected-resource metadata. */
  resourceName?: string;
  /** Whether the first authorization server's metadata was read (RFC 8414 or OpenID discovery). */
  authorizationServerMetadata?: boolean;
  /** Whether that server has a `registration_endpoint`: dynamic client registration, no setup for the client. */
  dynamicRegistration?: boolean;
  /** Whether `code_challenge_methods_supported` includes S256. */
  pkce?: boolean;
  /** `grant_types_supported`, at most five; `authorization_code` when the field is absent, as RFC 8414 says. */
  grantTypes?: string[];
}

export interface ProbeResult {
  /** The endpoint URL, or `stdio:<command>` for a local server. */
  url: string;
  transport: ProbeTransport;
  probedAt: string;
  status: ProbeStatus;
  httpStatus?: number;
  /** Scheme from the WWW-Authenticate header, for example "Bearer". */
  authScheme?: string;
  /** Whether the server advertises OAuth protected-resource metadata in WWW-Authenticate. */
  authResourceMetadata?: string;
  /** The `resource_documentation` URL of that metadata: the server's own guide to getting access. */
  authDocumentation?: string;
  /** How a client gets in, read from the public OAuth metadata of a server that needs auth. See AuthKind. */
  authKind?: AuthKind;
  /** What the OAuth metadata says, for a server that publishes it. */
  authMetadata?: AuthMetadata;
  latencyMs: {
    initialize?: number;
    toolsList?: number;
  };
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string; title?: string };
  capabilities?: string[];
  instructionsChars?: number;
  toolCount?: number;
  /** Sum of tokens over all tool definitions. */
  toolsTokens?: number;
  toolsBytes?: number;
  tools?: ToolCost[];
  /** Exact count from the Anthropic count_tokens endpoint, when a key was available. */
  claude?: ClaudeTokens;
  /** Exact count from the Gemini countTokens endpoint, when a key was available. */
  gemini?: GeminiTokens;
  error?: string;
}

export interface GeminiTokens {
  /** Model id the count was made for, for example gemini-3.8-flash. */
  model: string;
  /** Tokens the tool definitions add, from the Gemini countTokens endpoint. */
  tokens?: number;
  measuredAt: string;
  /** Why the count failed, for example a schema the API does not accept. */
  error?: string;
}

export interface ClaudeTokens {
  /** Model id the count was made for, for example claude-opus-5-5. */
  model: string;
  /** Tokens the tool definitions add, with the tool names as the server publishes them. */
  tokens?: number;
  /** The same with Claude Code's mcp__<server>__ prefix on every tool name. */
  tokensClaudeCode?: number;
  measuredAt: string;
  /** Why the count failed, for example a schema the API does not accept. */
  error?: string;
}
