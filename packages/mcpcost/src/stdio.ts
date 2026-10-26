import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyResult, measure, priceTools, attachClaude, attachGemini, type ProbeOptions } from './probe.js';
import type { RawTool } from './core.js';
import type { ProbeResult } from './types.js';

export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Starts a local MCP server over stdio, lists its tools and measures what it costs. */
export async function probeStdio(target: StdioTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const { result, tools } = await probeStdioRaw(target, options);
  priceTools(result, tools, options.includeTools ?? true);
  await attachClaude(result, tools, options.claude);
  await attachGemini(result, tools, options.gemini);
  return result;
}

/** The same, with the tool definitions as the server sent them, for callers that count tokens their own way. */
/**
 * The lines of a server's stderr that say why it stopped: the exception line of a Python traceback (its last line),
 * the first line of Node that names an error, then the last lines. A long stack trace is mostly frames; a slice of
 * it says nothing.
 */
export function stderrSummary(stderr: string, max = 600): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const key: string[] = [];
  const python = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(l.trim()));
  if (python) key.push(python.trim());
  const node = lines.find((l) => /^\s*(?:Uncaught )?(?:[A-Z]\w*)?Error(?: \[[A-Z0-9_]+\])?:/.test(l));
  if (node && !key.includes(node.trim())) key.push(node.trim());
  const tail = lines.slice(-4).filter((l) => !key.includes(l.trim()));
  return [...key, ...tail].join('\n').slice(0, max);
}

/** stderr kept for a failed start: the first 4 000 characters and the last 16 000, so both ends of a long trace stay. */
const STDERR_HEAD = 4_000;
const STDERR_TAIL = 16_000;

export async function probeStdioRaw(target: StdioTarget, options: ProbeOptions = {}): Promise<{ result: ProbeResult; tools: RawTool[] }> {
  const label = [target.command, ...(target.args ?? [])].join(' ');
  const result = emptyResult(`stdio:${label}`, 'stdio');
  let stderrHead = '';
  let stderrRest = '';
  let stderrCut = false;
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    cwd: target.cwd,
    env: { ...getDefaultEnvironment(), ...(target.env ?? {}) },
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    const room = STDERR_HEAD - stderrHead.length;
    stderrHead += text.slice(0, Math.max(0, room));
    stderrRest += text.slice(Math.max(0, room));
    if (stderrRest.length > 2 * STDERR_TAIL) {
      stderrRest = stderrRest.slice(-STDERR_TAIL);
      stderrCut = true;
    }
  });

  const tools = await measure(transport, result, options.timeoutMs ?? 15_000);

  if (result.status !== 'ok') {
    const stderr = `${stderrHead}${stderrCut ? '\n…\n' : ''}${stderrCut ? stderrRest.slice(-STDERR_TAIL) : stderrRest}`.trim();
    const text = `${result.error ?? ''} ${stderr}`;
    // Only the transport's own ENOENT means the command is missing; a server may print ENOENT about something else.
    if (/ENOENT/.test(result.error ?? '') || /spawn .* ENOENT/.test(stderr)) {
      result.status = 'not_found';
      result.error = `command not found: ${target.command}`;
    } else if (/timed? ?out|TimeoutError/i.test(text)) {
      result.status = 'timeout';
    } else {
      result.status = /JSON|parse|Unexpected token/i.test(text) ? 'protocol_error' : 'error';
    }
    if (stderr && result.status !== 'not_found') result.error = `${result.error ?? ''}\n${stderrSummary(stderr)}`.trim();
  }
  return { result, tools };
}
