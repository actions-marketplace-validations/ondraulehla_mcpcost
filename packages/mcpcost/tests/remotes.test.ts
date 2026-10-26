import { describe, expect, it } from 'vitest';
import { isLocalHost, remoteCandidates } from '../src/registry.js';
import { isConfirmedDown, isFailing } from '../src/types.js';
import type { RegistryEntry, RegistryRemote } from '../src/types.js';

const entry = (...remotes: RegistryRemote[]): RegistryEntry => ({
  server: { name: 'io.example/server', remotes },
  meta: { status: 'active', publishedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', isLatest: true }
});

describe('remoteCandidates', () => {
  it('keeps a plain URL, streamable-http before sse, and drops a repeated URL', () => {
    const e = entry({ type: 'sse', url: 'https://a.example/sse' }, { type: 'streamable-http', url: 'https://a.example/mcp' }, { type: 'streamable-http', url: 'https://a.example/mcp' });
    expect(remoteCandidates(e)).toEqual({ candidates: [{ url: 'https://a.example/mcp', type: 'streamable-http' }, { url: 'https://a.example/sse', type: 'sse' }] });
  });

  it('fills a placeholder from the default, else from the first choice', () => {
    const e = entry(
      { type: 'streamable-http', url: 'https://{api_host}/mcp', variables: { api_host: { isRequired: true, choices: ['api.example.com', 'api.eu.example.com'] } } },
      { type: 'sse', url: 'https://mcp.example.com/{core}/sse', variables: { core: { default: 'main' } } }
    );
    expect(remoteCandidates(e).candidates).toEqual([
      { url: 'https://api.example.com/mcp', type: 'streamable-http', filled: { api_host: 'api.example.com' } },
      { url: 'https://mcp.example.com/main/sse', type: 'sse', filled: { core: 'main' } }
    ]);
  });

  it('gives a template, not a candidate, when a placeholder has no value', () => {
    const e = entry({ type: 'streamable-http', url: 'https://mcp.example.com/v2/{project_slug}/mcp', variables: { project_slug: { isRequired: true } } });
    expect(remoteCandidates(e)).toEqual({ candidates: [], template: { url: 'https://mcp.example.com/v2/{project_slug}/mcp', type: 'streamable-http', missing: ['project_slug'] } });
  });

  it('treats a default on the user own machine as a URL of their own', () => {
    const e = entry({ type: 'streamable-http', url: 'https://{FQDN}:{PORT}/mcp', variables: { FQDN: { default: 'localhost' }, PORT: { default: '3030' } } });
    expect(remoteCandidates(e)).toEqual({ candidates: [], template: { url: 'https://{FQDN}:{PORT}/mcp', type: 'streamable-http', missing: ['FQDN', 'PORT'], selfHosted: true } });
  });

  it('uses a plain URL of the entry when another one is a template', () => {
    const e = entry({ type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' }, { type: 'sse', url: 'https://example.com/sse' });
    const r = remoteCandidates(e);
    expect(r.candidates).toEqual([{ url: 'https://example.com/sse', type: 'sse' }]);
    expect(r.template?.missing).toEqual(['tenant']);
  });
});

describe('isLocalHost', () => {
  it('knows loopback, private and .local hosts from public ones', () => {
    for (const h of ['localhost', 'api.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.1.1', '0.0.0.0', '[::1]', 'fd12:3456::1']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1']) expect(isLocalHost(h), h).toBe(false);
  });
});

describe('isConfirmedDown', () => {
  it('needs two calendar days of failed probes, whatever the hour', () => {
    expect(isConfirmedDown('timeout', '2026-10-24T10:30:00Z', '2026-10-25T09:00:00Z')).toBe(false);
    expect(isConfirmedDown('timeout', '2026-10-24T10:30:00Z', '2026-10-26T08:10:00Z')).toBe(true);
    expect(isConfirmedDown('dns', '2026-10-25T08:00:00Z', '2026-10-25T08:00:00Z')).toBe(false);
  });

  it('is never true for a server that answers or is gated, or without a date', () => {
    expect(isConfirmedDown('ok', '2026-10-01T00:00:00Z', '2026-10-25T00:00:00Z')).toBe(false);
    expect(isConfirmedDown('needs_url', '2026-10-01T00:00:00Z', '2026-10-25T00:00:00Z')).toBe(false);
    expect(isConfirmedDown('not_found', undefined, '2026-10-25T00:00:00Z')).toBe(false);
    expect(isFailing('needs_url')).toBe(false);
    expect(isFailing('crashed')).toBe(true);
  });
});
