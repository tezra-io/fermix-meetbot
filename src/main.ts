/**
 * Entry point: wires stdin/stdout to the session and the Playwright driver.
 *
 * The only place `process` is touched. Note what is absent — nothing writes to
 * stdout except the `FrameWriter`, because a stray byte on the data channel is
 * read as part of a length prefix and desyncs every frame after it. Pre-hello
 * diagnostics go to stderr; everything after goes out as a `log` frame.
 */

import { Buffer } from 'node:buffer';
import process from 'node:process';

import { FrameReader, FrameWriter } from './transport.js';
import { Session } from './session.js';
import { MeetDriver } from './meet/driver.js';
import { registry as playwrightRegistry } from 'playwright-core/lib/coreBundle';

import { runInstallBrowser } from './install-browser.js';
import { runSignin } from './signin.js';
import { SIDECAR_VERSION } from './version.js';

/** How often the idle watchdog looks at the clock. */
const TICK_MS = 5_000;

/** Hard bound on the exit contract: the daemon gives us 2 s. */
const EXIT_DEADLINE_MS = 1_500;

export function run(): void {
  // Playwright's browser install forks THIS binary (`process.execPath`) to run
  // its out-of-process downloader. Inside a SEA that fork re-enters here instead
  // of Playwright's download entry, so route it there: a fork always has a Node
  // IPC channel, which the daemon's Port-spawned sidecar and the signin/
  // install-browser subcommands never have. Without this the download child
  // would start a meeting session and the install would fail.
  if (process.channel) {
    playwrightRegistry.runOopDownloadBrowserMain();
    return;
  }

  // `signin` is a one-off interactive subcommand, not the meeting wire: it opens
  // a headed browser for the operator and speaks NDJSON status on stdout. It
  // never touches the FrameReader/Writer below.
  if (process.argv[2] === 'signin') {
    runSignin(process.argv.slice(3)).catch((cause) => {
      process.stderr.write(
        `fermix-meetbot signin: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.stdout.write(`${JSON.stringify({ event: 'signin_result', status: 'error' })}\n`);
      process.exit(1);
    });
    return;
  }

  // `install-browser` installs this binary's own matching Chromium — the daemon
  // runs it on enable so the operator never touches npx. Also a one-off
  // subprocess with NDJSON status, not the meeting wire.
  if (process.argv[2] === 'install-browser') {
    runInstallBrowser().catch((cause) => {
      process.stderr.write(
        `fermix-meetbot install-browser: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.stdout.write(`${JSON.stringify({ event: 'browser_result', status: 'error' })}\n`);
      process.exit(1);
    });
    return;
  }

  const writer = new FrameWriter(process.stdout);
  const reader = new FrameReader();
  const driver = new MeetDriver();

  let exiting = false;
  const exit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    process.exitCode = code;
    // Whichever comes first: the last frame reaching the OS, or the deadline.
    // The daemon SIGKILLs our process group shortly after either way.
    const deadline = setTimeout(() => {
      process.exit(code);
    }, EXIT_DEADLINE_MS);
    deadline.unref();
    writer.flush(() => {
      process.exit(code);
    });
  };

  const session = new Session({
    sink: writer,
    driver,
    sidecarVersion: SIDECAR_VERSION,
    exit,
    now: () => Date.now(),
    // stderr is deliberately off the data channel, which is exactly what makes
    // it usable once the wire is closing.
    onTeardownFault: (message) => {
      process.stderr.write(`fermix-meetbot: ${message}\n`);
    },
  });

  process.stdin.on('data', (chunk: Buffer) => {
    let bodies: Buffer[];
    try {
      bodies = reader.push(chunk);
    } catch (cause) {
      session.fail('framing_error', cause instanceof Error ? cause.message : String(cause));
      return;
    }
    for (const body of bodies) {
      session.handleFrame(body);
    }
  });

  process.stdin.on('end', () => {
    session.handleEof();
  });

  process.stdin.on('error', (cause: Error) => {
    process.stderr.write(`fermix-meetbot: stdin error: ${cause.message}\n`);
    session.handleEof();
  });

  process.on('uncaughtException', (cause: Error) => {
    session.fail('sidecar_fault', cause.message);
  });

  process.on('unhandledRejection', (cause: unknown) => {
    session.fail('sidecar_fault', cause instanceof Error ? cause.message : String(cause));
  });

  const ticker = setInterval(() => {
    session.tick();
  }, TICK_MS);
  ticker.unref();

  session.start();
  process.stdin.resume();
}

run();
