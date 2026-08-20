# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The wire `protocol_version` versions independently of this file. It is defined
by fermix, exported to `protocol/`, and moves only with a paired release of
both repositories.

## [0.2.0]

Wire protocol version 1 (unchanged — sign-in is a subcommand, not a wire message).

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
