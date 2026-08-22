# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The wire `protocol_version` versions independently of this file. It is defined
by fermix, exported to `protocol/`, and moves only with a paired release of
both repositories.

## [0.3.1]

Wire protocol version 1 (unchanged).

### Fixed

- **Sign-in verifies the session actually holds before reporting success.** The
  old check declared "signed in" the instant the `__Secure-1PSID` cookie
  appeared in the live browser, then closed the window. That cookie can be
  session-scoped (in-memory), so it never reached the on-disk profile and the
  join reopened a signed-out browser — the sign-in reported success while the
  bot showed up signed out, and every meeting join bounced to Google sign-in and
  failed silently as `login_required`. `signin.ts` now requires the cookie to be
  **persistent** and navigates to the auth-gated Meet home (`/home`) to confirm
  the session stays on `meet.google.com` rather than bouncing to sign-in — a
  positive host check, because a signed-out profile lands on the _marketing_
  site (not `accounts.google.com`) and a "not accounts" check would pass it. The
  verdict (`sessionIsDurable`) is a pure function under test. The "already signed in" re-run path verifies the same way, so a stale
  profile re-prompts instead of falsely passing.

- **The chat announcement waits for the toolbar to render.** Right after
  admission the in-meeting toolbar is still settling, and a 2 s click-probe on
  the chat control raced it — reporting "could not post the announcement" while
  the (correctly-selected) button was moments from appearing. `postAnnouncement`
  now waits for a chat toggle to become visible before clicking.

### Changed

- **`SIGNIN_MARKERS` recognizes Google's account chooser** ("Choose an account"
  / "Use another account"). A signed-out profile lands there rather than on the
  pre-join page; without these the join matched no marker and gave up silently as
  `login_required` instead of the honest `signin_required`.

## [0.3.0]

Wire protocol version 1 (unchanged — this is a subcommand, not a wire message).

### Added

- **`fermix-meetbot install-browser`** (`src/install-browser.ts`): installs this
  binary's own version-matched Chromium so the daemon can set the notetaker up
  with no `npx` and no operator commands. It drives Playwright's own `install`
  command in-process (version-matched because the SEA inlines this Playwright's
  `browsers.json`), is idempotent (`already: true` + exit 0 when the right
  Chromium is already present), and speaks NDJSON on stdout
  (`browser_state: checking | downloading | installed`, terminal
  `browser_result: ok | error`) with the CLI's progress routed to stderr. Exit
  code is the verdict (0 ok, 1 error).

### Fixed

- **SEA fork routing.** Playwright's out-of-process browser downloader `fork`s
  `process.execPath`, which inside a single-executable build re-enters this
  binary rather than Playwright's download entry. `main.ts` now detects that
  fork (a Node IPC channel the daemon's Port-spawned sidecar never has) and runs
  `registry.runOopDownloadBrowserMain()` — without which `install-browser`
  failed and leaked a meeting `hello` into its own output.

### Added

- **`fermix-meetbot signin --profile-dir <dir>`** (`src/signin.ts`): the one-time
  interactive Google sign-in. Opens a headed Chromium on the persistent profile
  so the operator signs the bot's account in by hand — nothing types a password,
  and success is read from the Google session cookie landing in the profile.
  Status is NDJSON on stdout (`signin_state` / `signin_result`) and the exit code
  is the verdict: `0` signed in, `2` cancelled (window closed first), `3` timed
  out, `1` error. The daemon spawns this through the disclaim shim and drives it
  from the setup page; the join path is unchanged.

## [0.1.0]

First release. Wire protocol version 1.

### Added

- **Packet-4 wire codec** (`src/protocol.ts`) implementing
  `protocol/PROTOCOL.md`: 4-byte big-endian length prefixes, `0x01` control /
  `0x02` audio frames, the 64 KiB / 32 KiB payload caps, the odd-audio and
  unknown-type rejections, and per-direction known-type tables. Every rejection
  is typed with the daemon's own vocabulary.
- **Anti-drift conformance tests** against the vendored export. The suite
  re-encodes every fixture in `protocol/fixtures/control_frames.jsonl` to the
  exact bytes in the file, pins the known-type tables and every enumeration to
  what the fixtures contain, validates `protocol/fixtures/audio_frame.bin`, and
  asserts the caps, the framing, and the clock formula against the text of
  `PROTOCOL.md`.
- **Transport** (`src/transport.ts`): a stdin reader that reassembles frames
  across arbitrary chunk boundaries — including a length prefix split mid-way —
  and a stdout writer that is the only thing permitted to touch the data
  channel. Diagnostics travel as `log` control frames.
- **Session state machine** (`src/session.ts`): handshake, join choreography,
  exactly-once `join_result`, ping answers, an inbound-idle watchdog, stdin-EOF
  teardown, and the bounded exit paths. The sample-count clock lives here —
  every `active_speaker` carries `t_ms = samples_sent_before / 16`, never a
  wall-clock reading.
- **Google Meet driver** (`src/meet/`) over Playwright: navigation and dialog
  handling, bot naming, ask-to-join, admit/deny/sign-in detection, the chat
  announcement, roster and active-speaker scraping, and the WebRTC audio tap
  resampled to 16 kHz mono s16le. Every DOM selector lives in
  `src/meet/selectors.ts`, so Meet UI churn is a one-file change.
- **Single-executable packaging** (`npm run package`) via esbuild plus Node's
  Single Executable Application support, with playwright's `package.json` and
  `browsers.json` inlined at bundle time under asserted needles.
- **Binary smoke test** (`npm run smoke`) that drives a built artifact over the
  real wire and asserts both the lifecycle and that the browser path resolves
  from the inlined `browsers.json`.
- **CI** on Node 22 across Linux and macOS (lint, build, test, package, smoke)
  and a **release** workflow building one artifact per target
  (`macos-aarch64`, `macos-x86_64`, `linux-x86_64`, `linux-aarch64`) with
  macOS signing and notarization gated on secrets and skipping loudly.
