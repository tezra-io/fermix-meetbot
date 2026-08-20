/**
 * The one-time interactive sign-in: `fermix-meetbot signin --profile-dir <dir>`.
 *
 * Opens a HEADED Chromium on the persistent profile so the operator signs the
 * bot's Google account in by hand. Google actively challenges automated
 * sign-ins, so a real window the human drives is the only honest path — nothing
 * here types a password. Success is read from the Google session cookie landing
 * in the profile; the profile persists on context close, which is the point.
 *
 * This is NOT the packet-4 meeting wire — it is a plain subprocess. Status is
 * NDJSON on stdout (the daemon reads it for progress) and the exit code is the
 * verdict: 0 signed in, 2 cancelled (window closed first), 3 timed out, 1 error.
 */

import process from 'node:process';
import { chromium, type BrowserContext } from 'playwright';

/** How often the cookie check runs while the human works. */
const POLL_MS = 1_500;
/** How long the human has before the attempt times out. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Where the window opens — Google sign-in, continuing to Meet on success. */
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/';
/**
 * A signed-in Google session drops this cookie on `.google.com`. Its presence
 * is the whole signal — we never scrape the account page or read a password.
 */
const SESSION_COOKIE = '__Secure-1PSID';

export type SigninState = 'launching' | 'awaiting_signin' | 'signed_in';
export type SigninResult = 'ok' | 'cancelled' | 'timeout' | 'error';

/** The process exit code each terminal result maps to. */
export const EXIT_CODES: Record<SigninResult, number> = {
  ok: 0,
  error: 1,
  cancelled: 2,
  timeout: 3,
};

/** Reads the required `--profile-dir <dir>` out of the subcommand args. */
export function parseProfileDir(args: readonly string[]): string {
  const i = args.indexOf('--profile-dir');
  const dir = i === -1 ? undefined : args[i + 1];
  if (!dir) {
    throw new Error('signin requires --profile-dir <dir>');
  }
  return dir;
}

function emitState(state: SigninState, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: 'signin_state', state, ...extra })}\n`);
}

function emitResult(status: SigninResult, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: 'signin_result', status, ...extra })}\n`);
}

async function hasSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some((c) => c.name === SESSION_COOKIE && c.value.length > 0);
}

/**
 * Runs the flow to a terminal state and exits the process. Errors become an
 * `error` result rather than an unhandled rejection — the daemon reads the
 * exit code, so it must always be one we mint.
 */
export async function runSignin(
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  let profileDir: string;
  try {
    profileDir = parseProfileDir(args);
  } catch (cause) {
    process.stderr.write(
      `fermix-meetbot signin: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    emitResult('error');
    process.exit(EXIT_CODES.error);
  }

  emitState('launching');

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      // Full Chromium (not chrome-headless-shell) — same build the join uses.
      channel: 'chromium',
      args: ['--no-first-run', '--no-default-browser-check'],
      viewport: { width: 1024, height: 760 },
    });
  } catch (cause) {
    process.stderr.write(
      `fermix-meetbot signin: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    emitResult('error');
    process.exit(EXIT_CODES.error);
  }

  let done = false;
  const finish = async (
    result: SigninResult,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    if (done) {
      return;
    }
    done = true;
    emitResult(result, extra);
    // Closing the context flushes the profile to disk — the signed-in state.
    await context.close().catch(() => {});
    process.exit(EXIT_CODES[result]);
  };

  // The operator closing the window before signing in is a cancel, not a hang.
  context.on('close', () => {
    void finish('cancelled');
  });

  // Already signed in (a re-run) — report and finish, idempotent.
  if (await hasSession(context)) {
    await finish('ok', { already: true });
    return;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SIGNIN_URL).catch(() => {});
  emitState('awaiting_signin');

  const deadline = Date.now() + timeoutMs;
  const tick = setInterval(() => {
    void (async () => {
      if (done) {
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(tick);
        await finish('timeout');
        return;
      }
      if (await hasSession(context).catch(() => false)) {
        clearInterval(tick);
        emitState('signed_in');
        await finish('ok');
      }
    })();
  }, POLL_MS);
}
