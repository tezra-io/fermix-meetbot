/**
 * The sidecar lifecycle state machine.
 *
 * Everything the daemon can observe about us is decided here: the handshake,
 * the join choreography, the shared sample clock, ping answers, the idle
 * watchdog, and the bounded exit paths. The browser lives behind
 * `MeetingDriver`, so this module is fully testable without Chromium — which
 * is the point, because this is the half the daemon's teardown logic keys on.
 *
 * Two invariants are enforced rather than trusted:
 *
 * - **`join_result` is sent exactly once.** A second one is a bug in the
 *   driver, and it fails the session loudly instead of confusing the daemon.
 * - **`t_ms` is the sample clock.** Every `active_speaker` is stamped with
 *   `samples_sent_before_the_event / 16`. Wall-clock time is never consulted
 *   for a timestamp; deriving it from the wall clock misattributes speech.
 */

import { Buffer } from 'node:buffer';

import {
  PROTOCOL_VERSION,
  ProtocolError,
  ROSTER_MAX,
  assertAudioPayload,
  decode,
  parseInbound,
  samplesToMs,
  type D2sControl,
  type EndReason,
  type JoinCommand,
  type JoinStatus,
  type LogLevel,
  type Participant,
  type Phase,
  type S2dControl,
} from './protocol.js';

/** The frame sink the session writes through (`FrameWriter` in production). */
export interface FrameSink {
  writeControl(message: S2dControl): void;
  writeAudio(pcm: Buffer): void;
}

/** Progress the driver reports while it works. */
export interface DriverEvents {
  state(phase: Phase): void;
  log(level: LogLevel, message: string): void;
  roster(participants: Participant[]): void;
  activeSpeaker(id: string): void;
  audio(pcm: Buffer): void;
  chatPosted(): void;
  meetingEnded(reason: EndReason): void;
}

/**
 * The browser mechanism, split so frame ordering is structural.
 *
 * `join` may report `state` and `log` only; the session refuses any capture
 * event before `join_result` has gone out. `capture` runs only after an
 * `admitted` result and owns the announcement, the first roster snapshot, and
 * the audio stream.
 */
export interface MeetingDriver {
  join(command: JoinCommand, events: DriverEvents): Promise<JoinStatus>;
  capture(command: JoinCommand, events: DriverEvents): Promise<void>;
  leave(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SessionDeps {
  sink: FrameSink;
  driver: MeetingDriver;
  sidecarVersion: string;
  exit: (code: number) => void;
  now: () => number;
  /**
   * Where a fault during teardown goes. By then the `error` frame has either
   * been sent or the pipe is gone, so this is the last channel left — it must
   * exist, because a silently dropped teardown fault is a hung Chromium nobody
   * can account for.
   */
  onTeardownFault: (message: string) => void;
  /** How long we tolerate total inbound silence before assuming the daemon is gone. */
  inboundIdleLimitMs?: number;
  /** Bound on a best-effort leave, so the 2 s exit contract is never missed. */
  leaveTimeoutMs?: number;
}

/** The daemon pings at 30 s of silence and tears us down 15 s later. */
const DEFAULT_INBOUND_IDLE_LIMIT_MS = 45_000;
const DEFAULT_LEAVE_TIMEOUT_MS = 1_500;

const PLATFORMS = ['meet'];

export class Session {
  readonly #sink: FrameSink;
  readonly #driver: MeetingDriver;
  readonly #sidecarVersion: string;
  readonly #exit: (code: number) => void;
  readonly #now: () => number;
  readonly #onTeardownFault: (message: string) => void;
  readonly #inboundIdleLimitMs: number;
  readonly #leaveTimeoutMs: number;

  #started = false;
  #finished = false;
  #joinCommand: JoinCommand | null = null;
  #joinResult: JoinStatus | null = null;
  #lastSpeakerId: string | null = null;
  #samplesSent = 0;
  #lastInboundAt = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: SessionDeps) {
    this.#sink = deps.sink;
    this.#driver = deps.driver;
    this.#sidecarVersion = deps.sidecarVersion;
    this.#exit = deps.exit;
    this.#now = deps.now;
    this.#onTeardownFault = deps.onTeardownFault;
    this.#inboundIdleLimitMs = deps.inboundIdleLimitMs ?? DEFAULT_INBOUND_IDLE_LIMIT_MS;
    this.#leaveTimeoutMs = deps.leaveTimeoutMs ?? DEFAULT_LEAVE_TIMEOUT_MS;
  }

  /** Samples written to the wire so far — the shared clock's numerator. */
  get samplesSent(): number {
    return this.#samplesSent;
  }

  /**
   * Sends `hello`. Synchronous and first, before any browser work: the daemon
   * gives us 15 s from spawn and a sidecar that boots Chromium before saying
   * hello is the classic handshake hang.
   */
  start(): void {
    if (this.#started) {
      throw new Error('session already started');
    }
    this.#started = true;
    this.#lastInboundAt = this.#now();
    this.#sink.writeControl({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      sidecar_version: this.#sidecarVersion,
      platforms: PLATFORMS,
    });
  }

  /** Feeds one reassembled frame body from stdin. */
  handleFrame(body: Buffer): void {
    this.#lastInboundAt = this.#now();

    let inbound: D2sControl;
    try {
      const decoded = decode(body);
      if (decoded.kind !== 'control') {
        throw new ProtocolError(
          'unknown_frame_type',
          'the daemon may only send control frames; audio is sidecar -> daemon',
        );
      }
      inbound = parseInbound(decoded.message);
    } catch (cause) {
      this.#enqueue(() => this.#fail(protocolCode(cause), errorMessage(cause)));
      return;
    }

    this.#enqueue(() => this.#dispatch(inbound));
  }

  /**
   * stdin closed. The daemon is tearing us down, so we leave the meeting
   * best-effort and exit — no frames, because the far end of the pipe is gone.
   */
  handleEof(): void {
    this.#enqueue(async () => {
      await this.#leaveQuietly();
      this.#finish(0);
    });
  }

  /**
   * Watchdog tick, driven by the runtime's interval. Total inbound silence past
   * the daemon's own ping deadline means the daemon died without closing our
   * stdin; we leave rather than hold a bot in the meeting forever.
   */
  tick(): void {
    if (!this.#started || this.#finished) {
      return;
    }
    if (this.#now() - this.#lastInboundAt < this.#inboundIdleLimitMs) {
      return;
    }
    this.#enqueue(async () => {
      await this.#leaveQuietly();
      this.#finish(0);
    });
  }

  /** Resolves once every queued lifecycle step has run. Test seam. */
  whenIdle(): Promise<void> {
    return this.#queue;
  }

  /** Reports a terminal failure: `error` frame, then exit within 2 s. */
  fail(code: string, message: string): void {
    this.#enqueue(() => this.#fail(code, message));
  }

  #enqueue(step: () => Promise<void> | void): void {
    this.#queue = this.#queue.then(async () => {
      try {
        await step();
      } catch (cause) {
        // A step that throws has already left the session in an unknown state;
        // the only honest move is the terminal error frame.
        await this.#fail(protocolCode(cause), errorMessage(cause));
      }
    });
  }

  async #dispatch(inbound: D2sControl): Promise<void> {
    if (this.#finished) {
      return;
    }
    switch (inbound.type) {
      case 'ping':
        this.#sink.writeControl({ type: 'pong' });
        return;
      case 'leave':
        await this.#handleLeave();
        return;
      case 'join':
        await this.#handleJoin(inbound);
        return;
    }
  }

  async #handleJoin(command: JoinCommand): Promise<void> {
    if (this.#joinCommand !== null) {
      throw new ProtocolError(
        'invalid_control_shape',
        'received a second join; the daemon sends join exactly once per spawn',
      );
    }
    this.#joinCommand = command;

    const events = this.#events();
    const status = await this.#driver.join(command, events);
    this.#sendJoinResult(status);

    if (status !== 'admitted') {
      return;
    }
    await this.#driver.capture(command, events);
  }

  /**
   * The `leave` command. Note what is *not* emitted: a `state{phase:"leaving"}`.
   * The daemon accepts that phase and deliberately ignores it — it learns the
   * bot is out from `meeting_ended` — and the teardown paths that share this
   * code run after stdin has closed, where writing a frame means writing to a
   * pipe with nobody on the other end. The phase stays in the type surface
   * because the protocol defines it; v1 has no honest place to send it.
   */
  async #handleLeave(): Promise<void> {
    await withTimeout(this.#driver.leave(), this.#leaveTimeoutMs);
    this.#sink.writeControl({ type: 'meeting_ended', reason: 'left' });
    this.#finish(0);
  }

  #sendJoinResult(status: JoinStatus): void {
    if (this.#joinResult !== null) {
      throw new ProtocolError(
        'invalid_control_shape',
        `join_result already sent as "${this.#joinResult}"; it is sent exactly once`,
      );
    }
    this.#joinResult = status;
    this.#sink.writeControl({ type: 'join_result', status });
  }

  #events(): DriverEvents {
    return {
      state: (phase) => {
        this.#guardOpen();
        this.#sink.writeControl({ type: 'state', phase });
      },
      log: (level, message) => {
        this.#guardOpen();
        this.#sink.writeControl({ type: 'log', level, message });
      },
      roster: (participants) => {
        this.#guardAdmitted('roster');
        this.#sink.writeControl({
          type: 'roster',
          participants: participants.slice(0, ROSTER_MAX),
        });
      },
      activeSpeaker: (id) => {
        this.#guardAdmitted('active_speaker');
        if (id === this.#lastSpeakerId) {
          return;
        }
        this.#lastSpeakerId = id;
        this.#sink.writeControl({
          type: 'active_speaker',
          id,
          t_ms: samplesToMs(this.#samplesSent),
        });
      },
      audio: (pcm) => {
        this.#guardAdmitted('audio');
        assertAudioPayload(pcm);
        this.#sink.writeAudio(pcm);
        this.#samplesSent += pcm.byteLength / 2;
      },
      chatPosted: () => {
        this.#guardAdmitted('chat_posted');
        this.#sink.writeControl({ type: 'chat_posted' });
      },
      meetingEnded: (reason) => {
        this.#guardOpen();
        this.#sink.writeControl({ type: 'meeting_ended', reason });
        this.#finish(0);
      },
    };
  }

  #guardOpen(): void {
    if (this.#finished) {
      throw new Error('the session is finished; no further frames may be emitted');
    }
  }

  #guardAdmitted(what: string): void {
    this.#guardOpen();
    if (this.#joinResult !== 'admitted') {
      throw new ProtocolError(
        'invalid_control_shape',
        `${what} was emitted before an admitted join_result`,
      );
    }
  }

  async #fail(code: string, message: string): Promise<void> {
    if (this.#finished) {
      return;
    }
    this.#sink.writeControl({ type: 'error', code, message });
    await this.#leaveQuietly();
    this.#finish(1);
  }

  /**
   * Best-effort meeting exit, bounded so the 2 s contract holds.
   *
   * Neither step may abort the other: failing to click "Leave call" must still
   * close the browser, or a headless Chromium survives with the bot sitting in
   * the meeting. Faults are reported rather than swallowed — this runs on paths
   * where the wire is already spoken for, so they go to the out-of-band
   * channel.
   */
  async #leaveQuietly(): Promise<void> {
    await this.#attemptTeardown('leave', () => this.#driver.leave());
    await this.#attemptTeardown('dispose', () => this.#driver.dispose());
  }

  async #attemptTeardown(step: string, work: () => Promise<void>): Promise<void> {
    try {
      await withTimeout(work(), this.#leaveTimeoutMs);
    } catch (cause) {
      this.#onTeardownFault(`${step} failed during teardown: ${errorMessage(cause)}`);
    }
  }

  #finish(code: number): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#exit(code);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function protocolCode(cause: unknown): string {
  return cause instanceof ProtocolError ? cause.code : 'sidecar_fault';
}

/** Bounds a promise; the timer is unref'd so it never holds the process open. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
