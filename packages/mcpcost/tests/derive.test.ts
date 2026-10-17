import { describe, expect, it } from 'vitest';
import { githubRepo, hintWords, packageFromPackageJson, packageFromPyproject, pickCandidates } from '../src/derive.js';

const blob = (path: string) => ({ path, type: 'blob' });

describe('pickCandidates', () => {
  it('prefers manifests that mention mcp, then shorter paths, and skips tests, examples and node_modules', () => {
    const tree = [
      blob('package.json'),
      blob('packages/mcp-server/package.json'),
      blob('packages/mcp-core/package.json'),
      blob('examples/demo/package.json'),
      blob('node_modules/x/package.json'),
      blob('a/b/c/d/package.json'),
      blob('tests/package.json'),
      { path: 'packages', type: 'tree' }
    ];
    expect(pickCandidates(tree).map((c) => c.path)).toEqual(['packages/mcp-core/package.json', 'packages/mcp-server/package.json', 'package.json']);
  });

  it('puts the package named after the server first in a monorepo', () => {
    const tree = [blob('packages/mcp-utils/package.json'), blob('packages/mcp-server-postgrest/package.json'), blob('packages/mcp-server-supabase/package.json')];
    expect(pickCandidates(tree, 5, hintWords('com.supabase/mcp', 'mcp.supabase.com'))[0].path).toBe('packages/mcp-server-supabase/package.json');
  });

  it('sees pyproject files too', () => {
    expect(pickCandidates([blob('pyproject.toml'), blob('src/x/pyproject.toml')]).map((c) => c.kind)).toEqual(['pypi', 'pypi']);
  });
});

describe('packageFromPackageJson', () => {
  it('takes a public package with a bin that looks like an MCP server', () => {
    expect(packageFromPackageJson({ name: '@sentry/mcp-server', bin: { 'sentry-mcp': './dist/index.js' } }, 'packages/mcp-server/package.json')).toEqual({ registry: 'npm', name: '@sentry/mcp-server', path: 'packages/mcp-server/package.json' });
    expect(packageFromPackageJson({ name: 'acme-tools', bin: './cli.js', mcpName: 'io.github.acme/tools' }, 'package.json')?.name).toBe('acme-tools');
  });

  it('refuses private packages, packages without a bin, and ones that do not look like MCP', () => {
    expect(packageFromPackageJson({ name: 'atlassian-mcp-server-package', private: true, bin: 'x' }, 'package.json')).toBeUndefined();
    expect(packageFromPackageJson({ name: '@supabase/mcp-utils' }, 'packages/mcp-utils/package.json')).toBeUndefined();
    expect(packageFromPackageJson({ name: 'left-pad', bin: 'cli.js' }, 'package.json')).toBeUndefined();
    expect(packageFromPackageJson(null, 'package.json')).toBeUndefined();
  });
});

describe('packageFromPyproject', () => {
  const text = `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "acme-mcp"\nversion = "1.0.0"\n\n[project.scripts]\nacme-mcp = "acme_mcp:main"\n\n[tool.hatch]\nx = 1\n`;
  it('reads the name and needs a console script', () => {
    expect(packageFromPyproject(text, 'pyproject.toml')).toEqual({ registry: 'pypi', name: 'acme-mcp', path: 'pyproject.toml' });
    expect(packageFromPyproject(text.replace('[project.scripts]\nacme-mcp = "acme_mcp:main"\n', ''), 'pyproject.toml')).toBeUndefined();
    expect(packageFromPyproject('[project]\nname = "x"\n', 'pyproject.toml')).toBeUndefined();
  });
});

describe('githubRepo', () => {
  it('parses the common URL forms', () => {
    expect(githubRepo('https://github.com/getsentry/sentry-mcp')).toBe('getsentry/sentry-mcp');
    expect(githubRepo('https://github.com/getsentry/sentry-mcp.git')).toBe('getsentry/sentry-mcp');
    expect(githubRepo('git@github.com:getsentry/sentry-mcp.git')).toBe('getsentry/sentry-mcp');
    expect(githubRepo('https://github.com/getsentry/sentry-mcp/tree/main/packages')).toBeUndefined();
    expect(githubRepo('https://gitlab.com/a/b')).toBeUndefined();
    expect(githubRepo(undefined)).toBeUndefined();
  });
});
