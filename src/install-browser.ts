/**
 * `fermix-meetbot install-browser`: install this binary's own matching Chromium.
 *
 * The daemon runs this on enable so the operator never touches `npx`. Correct
 * version-matching is the whole point — the SEA inlines this Playwright's
 * `browsers.json`, so both the idempotency check (`chromium.executablePath()`)
 * and the install (Playwright's own `install` CLI command, driven in-process)
 * agree on the exact revision to place in the ms-playwright cache. A mismatched
 * revision from a stray `npx playwright install` is precisely the failure this
 * removes.
 *
 * Not the packet-4 meeting wire — a plain subprocess. Status is NDJSON on
 * stdout; the exit code is the verdict (0 ok, 1 error). The install CLI's own
 * progress chatter is routed to stderr so stdout stays pure NDJSON.
 */

import process from 'node:process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
// `decorateProgram` attaches the `install` command to a commander program,
// exactly as the `playwright` CLI does. Both subpaths are in playwright-core's
// exports map, so esbuild bundles them and the inline plugin fixes browsers.json.
import { libCli } from 'playwright-core/lib/coreBundle';
import { program } from 'playwright-core/lib/utilsBundle';

export type BrowserState = 'checking' | 'downloading' | 'installed';
export type BrowserResult = 'ok' | 'error';

/** The process exit code each terminal result maps to. */
export const EXIT_CODES: Record<BrowserResult, number> = { ok: 0, error: 1 };

/** Thrown internally when the install CLI tries to exit the process. */
const CLI_EXIT_SENTINEL = '__fermix_meetbot_install_exit__';

function emitState(state: BrowserState, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: 'browser_state', state, ...extra })}\n`);
}

function emitResult(status: BrowserResult, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: 'browser_result', status, ...extra })}\n`);
}

/**
 * True when the exact Chromium this binary expects is already on disk.
 * `executablePath()` resolves through the same registry the launch uses, so it
 * honours `PLAYWRIGHT_BROWSERS_PATH`; it returns the expected path whether or
 * not it exists, so the real signal is the file being there.
 */
export function chromiumPresent(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * Drives Playwright's own `install chromium` in-process, with the CLI's stdout
 * chatter redirected to stderr and its `process.exit` intercepted so this
 * subprocess stays in control of its own NDJSON + exit code.
 */
async function installMatchingChromium(): Promise<number> {
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realExit = process.exit.bind(process);
  let cliExitCode: number | null = null;

  process.stdout.write = (chunk: string | Uint8Array): boolean => process.stderr.write(chunk);
  process.exit = (code?: number): never => {
    cliExitCode = typeof code === 'number' ? code : 0;
    throw new Error(CLI_EXIT_SENTINEL);
  };

  try {
    libCli.decorateProgram(program);
    await program.parseAsync(['node', 'fermix-meetbot', 'install', 'chromium']);
  } catch (cause) {
    if (!(cause instanceof Error && cause.message === CLI_EXIT_SENTINEL)) {
      throw cause;
    }
  } finally {
    process.stdout.write = realStdoutWrite;
    process.exit = realExit;
  }

  return cliExitCode ?? 0;
}

/** Runs the flow to a terminal state and exits the process. */
export async function runInstallBrowser(): Promise<void> {
  emitState('checking');

  if (chromiumPresent()) {
    emitResult('ok', { already: true });
    process.exit(EXIT_CODES.ok);
  }

  emitState('downloading');

  try {
    const code = await installMatchingChromium();
    // Trust the disk, not a clean return: confirm the browser actually landed.
    if (code === 0 && chromiumPresent()) {
      emitState('installed');
      emitResult('ok');
      process.exit(EXIT_CODES.ok);
    }
  } catch (cause) {
    process.stderr.write(
      `fermix-meetbot install-browser: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }

  emitResult('error');
  process.exit(EXIT_CODES.error);
}
