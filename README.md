# fermix-meetbot

The Google Meet notetaker sidecar for [Fermix](https://fermix.ai).

Fermix spawns this process, tells it to join a meeting, and reads back the
meeting's audio, roster, and active speaker. Everything downstream —
transcription, diarisation, summarisation, delivery — happens in the daemon.
**This repository is the browser mechanism and nothing else.** There is no
speech-to-text here, no summarisation, and no storage.

```
 fermix daemon                        fermix-meetbot                Google Meet
┌──────────────┐   stdin  {:packet,4} ┌──────────────┐  Playwright ┌──────────┐
│ Meetings     │ ───────────────────▶ │ session.ts   │ ──────────▶ │ Chromium │
│  .Sidecar    │   join / leave / ping│ transport.ts │             │ (signed  │
│              │ ◀─────────────────── │ meet/*.ts    │ ◀────────── │  in bot) │
└──────────────┘  hello, state,       └──────────────┘  audio,     └──────────┘
                  join_result, roster,                  roster
                  active_speaker, audio
```

## The wire

The transport is this process's stdin and stdout in Erlang `{:packet, 4}` mode:
every frame is a 4-byte big-endian unsigned length followed by
`<<type::8, payload>>`. Type `0x01` is a UTF-8 JSON control object; type `0x02`
is raw PCM (s16le, 16 kHz, mono), sidecar to daemon only.

**Fermix defines this protocol. This repository conforms to it.** The full
contract is `protocol/PROTOCOL.md`, which — together with `protocol/fixtures/`
— is fermix's machine-readable export of `FermixCore.Meetings.Sidecar.Frame`,
vendored here rather than hand-copied. It is the single coordination point
between two independently released repositories.

Do not edit anything under `protocol/`. To change the wire, change fermix.

Because the export is vendored, drift is _testable_, and the suite tests it:
every fixture is re-encoded to the exact bytes in the file, the known-type
tables and every enumeration are pinned to what the fixtures contain, and the
caps, framing, and clock formula are asserted against the text of
`PROTOCOL.md`. A fermix-side change that lands here as a re-vendored `protocol/`
directory turns into a red test, not a silent teardown in production.

### The clock

Audio frames carry no timestamp. The cumulative sample count from the first
audio frame **is** the shared clock:

```
t_ms = samples / 16          # 16 kHz mono, 2 bytes per sample
```

Every `t_ms` this sidecar emits equals `samples_sent_before_that_event / 16`.
Deriving it from wall-clock time attributes speech to the wrong people, so no
frame is ever dropped to relieve backpressure, and the arithmetic lives in
`src/meet/pcm.ts` where tests can reach it rather than inside an injected
browser script.

## The bot account and `profile_dir`

The bot is a **real, signed-in Google account**, not an anonymous guest. Meet
treats guests differently — extra knocking, name prompts, and outright refusal
in many organisations — so a signed-in identity is what makes joining reliable.

That signed-in state lives entirely in the Chromium profile at the
`profile_dir` the daemon names in the `join` command. This sidecar owns that
directory; the daemon never reads inside it.

**Credentials never cross the wire.** The protocol has no field for a password,
a cookie, or a token, and this sidecar never sends one. If you are looking for
where the account secret is transmitted: nowhere. It is on disk in the profile,
under the daemon's `FERMIX_HOME`, and the only thing that ever sees it is
Chromium.

Signing that profile in is an interactive, headed operation performed by the
operator once. `{"type":"signin"}` is reserved in the protocol for that flow
and is deliberately not implemented in v1.

## Paired releases

`fermix-meetbot` and fermix ship as a pair, pinned in both directions:

- The wire `protocol_version` is `1`. This sidecar declares it in `hello`; the
  daemon refuses any other value and tears the sidecar down. There is no
  negotiation window.
- Fermix pins a **release tag and a per-target sha256** in
  `FermixCore.Meetings.SidecarInstaller`, downloads the matching artifact, and
  verifies the digest before it will run anything.

So the release order is: tag here → artifacts and `SHA256SUMS.txt` published →
land the tag and digests in fermix as a normal pull request. Until that pin
lands, no fermix build can install this sidecar; the installer refuses loudly
rather than downloading something unpinned.

Artifact names are load-bearing. They match
`FermixCore.Meetings.SidecarInstaller.target/0` exactly:

| Target          | Artifact                       |
| --------------- | ------------------------------ |
| `macos-aarch64` | `fermix-meetbot-macos-aarch64` |
| `macos-x86_64`  | `fermix-meetbot-macos-x86_64`  |
| `linux-x86_64`  | `fermix-meetbot-linux-x86_64`  |
| `linux-aarch64` | `fermix-meetbot-linux-aarch64` |

Renaming one makes the daemon download a 404.

## Build and test

Requires Node 22 or newer. Nothing else — no browser, no network.

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run lint     # eslint + prettier --check
npm run build    # tsc, strict
npm test         # the hermetic suite
```

The suite is hermetic by construction: it opens no browser, makes no network
call, and touches nothing outside the repository. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
is what keeps `npm ci` from pulling ~150 MB of Chromium that the tests could
not use anyway.

What that buys, and what it does not:

- **Tested**: the codec against the vendored fixtures; frame reassembly across
  every split point of a real stream, including mid-prefix; the whole session
  state machine driven through the scenarios fermix's own test double
  (`fake_meetbot_sidecar.pl`) encodes — happy, denied, signin_required,
  crash_after_admit, hang_hello, wedge — asserting the exact emitted frames;
  the sample clock; the PCM resampler and chunker; roster identity and capping;
  the selector inventory.
- **Not tested, by nature**: the Meet DOM. Selectors can only be validated
  against a live meeting. That is why they are confined to one file and why
  everything around them is thin.

## The Meet churn surface

Google Meet's markup changes without notice and its class names are generated.
Every selector in this repository lives in **`src/meet/selectors.ts`**, as an
ordered list of candidates per purpose — semantic hooks first, text matches
last. When Meet changes, that file is the whole diff. Nothing outside it may
hard-code a selector, and a test asserts that no selector group is ever
silently emptied.

## Packaging a release artifact

The release artifact is a **single executable** the daemon downloads and
`chmod +x`es. It is built with esbuild plus Node's Single Executable
Application support:

```sh
npm run package                      # -> build/fermix-meetbot-<host target>
npm run smoke -- build/fermix-meetbot-<target>
```

Two details worth knowing before changing this:

- **SEA cannot cross-compile.** The artifact is a copy of the _running_ `node`
  binary with the bundle injected, so each target needs its own runner. Passing
  a target that does not match the host fails the build rather than mislabelling
  the output.
- **playwright reads two of its own JSON files at runtime** through requires
  built from `__dirname` — `package.json` and `browsers.json`. Neither resolves
  inside a bundle, and inside a SEA `require` of an absolute path only serves
  built-in modules. Both are inlined at bundle time under asserted needles, so
  a playwright bump that moves them fails the release build instead of shipping
  a binary that dies on first launch. `browsers.json` is the Chromium revision
  pin, which is what makes the binary agree with `npx playwright install
chromium` about which build to look for.

`npm run smoke` drives a built binary over the real packet-4 wire and asserts
both the lifecycle (`hello` → `pong` → `meeting_ended{left}` → exit 0) and that
the browser path resolves from the inlined `browsers.json`. CI runs it on every
push, so a packaging regression cannot wait until release day to appear.

**Chromium is not bundled.** The operator's machine fetches the build pinned by
this repository's playwright version:

```sh
npx playwright install chromium
```

A browser is ~150 MB; carrying one inside every fermix release to run one
optional feature is the wrong trade. The sidecar uses full Chromium in
new-headless mode (`channel: 'chromium'`) rather than `chrome-headless-shell`,
which has no WebRTC stack — a bot joined through the shell hears silence.

## Releasing

1. Bump `version` in `package.json` **and** `SIDECAR_VERSION` in
   `src/version.ts` (a test pins them together), and add the entry to
   `CHANGELOG.md`.
2. Merge to `main`.
3. Tag `vX.Y.Z`. The release workflow refuses a tag that disagrees with
   `package.json`, runs the gates, builds and smokes one artifact per target,
   signs and notarizes the macOS binaries when the Apple secrets are present —
   skipping **loudly** when they are not — and publishes the artifacts with
   `SHA256SUMS.txt`.
4. Land the tag and the per-target digests in fermix's
   `FermixCore.Meetings.SidecarInstaller` as a normal pull request.

macOS signing needs `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, and
`MACOS_SIGN_IDENTITY`; notarization needs `APPLE_ID`, `APPLE_TEAM_ID`, and
`APPLE_APP_PASSWORD`. A standalone Mach-O executable cannot be stapled — only
bundles, disk images, and installer packages can hold a ticket on disk — so
signing is the load-bearing half and Gatekeeper validates notarization online.

## Developing against a local build

Fermix resolves a `dev_local` build before any pinned release, so a checkout
here can be driven by a daemon running from source. Point
`[fermix_core.plugins] dev_local` at a directory containing:

```
<dev_local>/meetbot_sidecar/bin/<target>/fermix-meetbot
```

## Layout

```
protocol/            the daemon's vendored export — do not edit
src/protocol.ts      the packet-4 codec, caps, and validation
src/transport.ts     stdin reassembly, stdout framing
src/session.ts       the lifecycle state machine and the sample clock
src/meet/selectors.ts  every DOM selector, in one file
src/meet/join.ts     navigate, dismiss, name, ask to join, await admission
src/meet/roster.ts   participants and active speaker
src/meet/audio.ts    the WebRTC tap and the page boundary
src/meet/pcm.ts      resampling and chunking (pure, tested)
src/meet/driver.ts   the Playwright MeetingDriver
src/main.ts          process wiring
scripts/             packaging and the binary smoke test
```

## License

MIT — see [LICENSE](LICENSE).
