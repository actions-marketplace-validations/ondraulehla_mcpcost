/**
 * What a failed start of a package server means, from the error text of the stdio client (the transport's message,
 * then stderrSummary: the exception line, the first error of Node, the last lines). The exception line decides: a
 * module that is not there or a syntax error is a broken package (crashed); a key, a token or a variable that is not
 * set is a package that wants setup (needs_env), even when Python prints it as a traceback. No side effects, so the
 * tests can import it; probe/stdio-run.ts uses it for npm, PyPI, OCI and MCPB alike.
 */
import type { ProbeResult } from '../packages/mcpcost/src/index.js';

export type StdioStatus = ProbeResult['status'] | 'install_failed' | 'no_bin' | 'needs_env' | 'needs_args' | 'needs_network' | 'crashed';

/** The line that names the exception: Python's last traceback line, or Node's first error line. */
const KEY_LINE = /^(?:Uncaught )?(?:[A-Za-z_][\w.]*(?:Error|Exception|Exit)\b|(?:[A-Z]\w*)?Error(?: \[[A-Z0-9_]+\])?:)/;
/** The server reached for the network on start. With the network off that is not a defect; a bridge to a remote server is one. */
const NETWORK = /mcp-remote|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|fetch failed|ConnectError|ConnectionError|ConnectTimeout|Name or service not known|Temporary failure in name resolution|Network is unreachable|StreamableHTTPClientTransport|SSEClientTransport|urlopen error/i;
/** The package itself is broken: a module, a file of its own or a name that is not there, or a syntax error. */
const BROKEN = /ModuleNotFoundError|ImportError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|SyntaxError|is not a function|is not defined|is not a constructor/;
/** The server wants a value from the user: a key, a token, a variable, a config file. */
const SETUP = /api[_ -]?key|\btokens?\b|credential|\bsecrets?\b|password|unauthori[sz]ed|environment variable|env var|must be set|must be provided|\bnot set\b|is required|are required|missing required|not configured|please set|placeholder|invalid (?:url|key|token)|\.env\b/i;
/** A name such as OPENAI_API_KEY in a KeyError or a message, or "set X_Y" for any variable name. */
const SETUP_NAME = /KeyError: ['"]?[A-Z][A-Z0-9_]{2,}['"]?|\b[A-Z][A-Z0-9]*_(?:KEY|TOKEN|SECRET|URL|URI|HOST|ID|PASSWORD|USER|ENDPOINT|DSN|PATH|DIR)\b|\b[Ss]et (?:the )?[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
/** The server printed its usage: it wants arguments the entry does not list. */
const USAGE = /^usage:|\busage:|unknown command|missing argument|expected a command|too few arguments|unrecognized arguments/im;
/** A binary for another system, or a command that is not in the image. */
const FOREIGN = /ENOEXEC|exec format error|cannot execute binary file|executable file not found in \$PATH/i;

export function classify(result: Pick<ProbeResult, 'status' | 'error'>): { status: StdioStatus; text: string } {
  const text = `${result.error ?? ''}`;
  if (result.status === 'ok') return { status: 'ok', text };
  const key = text.split('\n').map((l) => l.trim()).find((l) => KEY_LINE.test(l)) ?? '';
  let status: StdioStatus = result.status;
  if (FOREIGN.test(text)) status = 'no_bin';
  else if (NETWORK.test(text) && !BROKEN.test(key)) status = 'needs_network';
  else if (USAGE.test(text)) status = 'needs_args';
  else if (key && BROKEN.test(key)) status = 'crashed';
  else if (SETUP.test(key) || SETUP_NAME.test(key) || SETUP.test(text)) status = 'needs_env';
  else if (BROKEN.test(text) || /Traceback|Connection closed/.test(text)) status = 'crashed';
  return { status, text };
}
