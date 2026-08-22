/**
 * The one-time interactive sign-in: `fermix-meetbot signin --profile-dir <dir>`.
 *
 * Opens a HEADED Chromium on the persistent profile so the operator signs the
 * bot's Google account in by hand. Google actively challenges automated
 * sign-ins, so a real window the human drives is the only honest path — nothing
 * here types a password.
 *
 * Success is NOT "a session cookie appeared". A cookie can be in-memory
 * (session-scoped) and vanish the moment the profile is reopened for a join, so
 * the sidecar once reported "signed in" while the bot showed up signed out.
 * Success is: the session cookie is present AND persistent, AND a navigation to
 * Meet does not bounce to the account chooser — the profile actually carries a
 * working session onto disk, which is the point.
 *
 * This is NOT the packet-4 meeting wire — it is a plain subprocess. Status is
 * NDJSON on stdout (the daemon reads it for progress) and the exit code is the
 * verdict: 0 signed in, 2 cancelled (window closed first), 3 timed out, 1 error.
 */

import process from 'node:process';
import { chromium, type BrowserContext } from 'playwright';

/** How often the verification runs while the human works. */
const POLL_MS = 1_500;
/** How long the human has before the attempt times out. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Where the window opens — Google sign-in, continuing to Meet on success. */
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/';
/** Where verification navigates. `/home` is auth-gated: a live session stays on
 *  it, a dead one is bounced to `accounts.google.com`. The bare landing page is
 *  NOT auth-gated — a signed-out profile lands on the marketing site — which is
 *  how a presence-only check would let a stale profile pass. */
const MEET_HOME = 'https://meet.google.com/home';
/** How long the verification navigation may take before we call it not-yet. */
const VERIFY_MS = 15_000;
/**
 * The durable session cookie Google drops on `.google.com`. Presence alone is
 * the false positive that shipped: it must be PERSISTENT (a session-scoped
 * cookie is gone when the join reopens the profile), and even then only a Meet
 * navigation that does not bounce to sign-in proves the session holds.
 */
export const SESSION_COOKIE = '__Secure-1PSID';

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

/** The two facts a verification navigation gathers, split out so the verdict is
 *  a pure function the tests can pin without a browser. */
export interface SessionProbe {
  readonly cookies: readonly { name: string; value: string; expires: number }[];
  /** The final URL after navigating the context to {@link MEET_HOME}. */
  readonly meetUrl: string;
}

/**
 * A durable, Meet-usable session: the session cookie is present AND persistent
 * (`expires <= 0` is a session cookie that won't survive the profile close),
 * AND the authed home kept the context on meet.google.com. All three, or it is
 * not signed in — the presence check alone is what shipped the false positive.
 */
export function sessionIsDurable({ cookies, meetUrl }: SessionProbe): boolean {
  const sid = cookies.find((c) => c.name === SESSION_COOKIE && c.value.length > 0);
  if (!sid || sid.expires <= 0) {
    return false;
  }
  // The authed home keeps a live session on meet.google.com and bounces a dead
  // one away — to the account chooser, or the marketing site. A positive host
  // check is the honest signal; "not accounts.google.com" would pass the
  // marketing redirect a signed-out profile lands on.
  return meetUrl.startsWith('https://meet.google.com');
}

/**
 * Proves the profile carries a working session: gathers cookies, and only once
 * the persistent cookie is actually present pays for a Meet navigation to see
 * whether it holds. Any failure is a not-yet, never a throw — the poll retries.
 */
async function verifySession(context: BrowserContext): Promise<boolean> {
  const durable = (await context.cookies()).some(
    (c) => c.name === SESSION_COOKIE && c.value.length > 0 && c.expires > 0,
  );
  if (!durable) {
    return false;
  }
  const probe = await context.newPage();
  try {
    await probe.goto(MEET_HOME, { waitUntil: 'domcontentloaded', timeout: VERIFY_MS });
    return sessionIsDurable({ cookies: await context.cookies(), meetUrl: probe.url() });
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
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

  // Already signed in (a re-run) — report and finish, idempotent. Verification,
  // not cookie presence, so a stale profile correctly re-prompts.
  if (await verifySession(context)) {
    await finish('ok', { already: true });
    return;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SIGNIN_URL).catch(() => {});
  emitState('awaiting_signin');

  const deadline = Date.now() + timeoutMs;
  let verifying = false;
  const tick = setInterval(() => {
    void (async () => {
      if (done || verifying) {
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(tick);
        await finish('timeout');
        return;
      }
      verifying = true;
      try {
        if (await verifySession(context)) {
          clearInterval(tick);
          emitState('signed_in');
          await finish('ok');
        }
      } finally {
        verifying = false;
      }
    })();
  }, POLL_MS);
}
