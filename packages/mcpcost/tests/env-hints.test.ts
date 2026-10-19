import { describe, expect, it } from 'vitest';
import { envNamesFromError } from '../src/env-hints.js';

describe('envNamesFromError', () => {
  it('finds the variables a server asks for', () => {
    expect(envNamesFromError('MCP error -32000: Connection closed\n[aidoo-mcp] No API key found. Pass AIDOO_API_KEY or set AIDOO_BASE_URL')).toEqual(['AIDOO_API_KEY', 'AIDOO_BASE_URL']);
    expect(envNamesFromError('PRIMATE_API_KEY is not set. Add it to the environment.')).toEqual(['PRIMATE_API_KEY']);
  });

  it('leaves Node and npm noise out', () => {
    expect(envNamesFromError('Error [ERR_MODULE_NOT_FOUND]: Cannot find module; NODE_ENV=production; UND_ERR_CONNECT_TIMEOUT')).toEqual([]);
    expect(envNamesFromError('nothing here')).toEqual([]);
  });

  it('stops at ten names', () => {
    const text = Array.from({ length: 14 }, (_, i) => `VAR_NUMBER_${i}`).join(' ');
    expect(envNamesFromError(text)).toHaveLength(10);
  });
});
