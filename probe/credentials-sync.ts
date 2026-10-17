/**
 * Keeps the credentials file in the board's D1 database, table `credentials`,
 * so the daily run can read it before the probe and write the refreshed tokens
 * back after it. Artifacts of a public repository are readable by anyone, and
 * the workflow cannot update a repository secret, so D1 it is.
 *
 *   node --import tsx probe/credentials-sync.ts pull --out data/cache/credentials.json
 *   node --import tsx probe/credentials-sync.ts push --in ~/.mcpcost/credentials.json
 *
 * Runs wrangler in site/, so it needs the Cloudflare login or CLOUDFLARE_API_TOKEN.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE = new URL('../site/', import.meta.url).pathname;
const KEY = 'default';

const { values, positionals } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
const command = positionals[0];

async function wrangler(args: string[]): Promise<string> {
  const { stdout } = await run('npx', ['wrangler', 'd1', 'execute', 'mcp-pulse', '--remote', '--json', ...args], { cwd: SITE, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

if (command === 'pull') {
  const out = values.out ?? 'data/cache/credentials.json';
  let json: string | undefined;
  try {
    const raw = await wrangler(['--command', `SELECT json FROM credentials WHERE key = ${lit(KEY)}`]);
    const parsed = JSON.parse(raw) as Array<{ results: Array<{ json: string }> }>;
    json = parsed[0]?.results?.[0]?.json;
  } catch (e) {
    console.error(`credentials: nothing pulled (${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 120)})`);
  }
  if (json) {
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, json, { mode: 0o600 });
    const n = Object.keys((JSON.parse(json) as { servers?: object }).servers ?? {}).length;
    console.error(`credentials: ${n} servers pulled to ${out}`);
  } else console.error('credentials: none stored');
} else if (command === 'push') {
  const file = values.in ?? 'data/cache/credentials.json';
  if (!existsSync(file)) {
    console.error(`credentials: ${file} does not exist, nothing pushed`);
    process.exit(0);
  }
  const json = await readFile(file, 'utf8');
  JSON.parse(json);
  // The SQL goes through a file with mode 0600, not through the command line.
  const tmp = path.join(SITE, '.wrangler', `credentials-${process.pid}.sql`);
  await mkdir(path.dirname(tmp), { recursive: true });
  await writeFile(
    tmp,
    `CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);\nINSERT INTO credentials (key, json, updated_at) VALUES (${lit(KEY)}, ${lit(json)}, ${lit(new Date().toISOString())}) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at;\n`,
    { mode: 0o600 }
  );
  try {
    await wrangler(['--file', tmp]);
    const n = Object.keys((JSON.parse(json) as { servers?: object }).servers ?? {}).length;
    console.error(`credentials: ${n} servers pushed from ${file}`);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
} else {
  console.error('usage: credentials-sync.ts pull --out <file> | push --in <file>');
  process.exit(2);
}
