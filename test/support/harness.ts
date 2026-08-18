/**
 * An in-memory rig for driving `Session` exactly as the daemon would.
 *
 * The daemon's own test double is `fake_meetbot_sidecar.pl`; these scenarios
 * are its obligations restated from this side of the wire, so a change that
 * would make the daemon tear us down fails here first.
 */

import { Buffer } from 'node:buffer';

import {
  controlFrame,
  decode,
  type D2sControl,
  type JoinCommand,
  type JoinStatus,
  type S2dControl,
} from '../../src/protocol.js';
import { Session, type DriverEvents, type MeetingDriver } from '../../src/session.js';
import { FrameReader, FrameWriter } from '../../src/transport.js';
import { MemorySink } from './memory-sink.js';

export interface EmittedAudio {
  kind: 'audio';
  bytes: number;
}

export type Emitted = { kind: 'control'; message: S2dControl } | EmittedAudio;

export const JOIN_COMMAND: JoinCommand = {
  type: 'join',
  platform: 'meet',
  url: 'https://meet.google.com/abc-defg-hij',
  passcode: null,
  bot_name: 'Fermix Notetaker',
  announce: true,
  announce_message: 'Fermix Notetaker here.',
  profile_dir: '/tmp/fermix-meetbot-profile',
};

/** A driver whose whole behaviour is supplied per scenario. */
export class ScriptedDriver implements MeetingDriver {
  readonly calls: string[] = [];
  events: DriverEvents | null = null;

  constructor(
    private readonly script: {
      join: (command: JoinCommand, events: DriverEvents) => Promise<JoinStatus> | JoinStatus;
      capture?: (command: JoinCommand, events: DriverEvents) => Promise<void> | void;
      leave?: () => Promise<void> | void;
    },
  ) {}

  async join(command: JoinCommand, events: DriverEvents): Promise<JoinStatus> {
    this.calls.push('join');
    this.events = events;
    return this.script.join(command, events);
  }

  async capture(command: JoinCommand, events: DriverEvents): Promise<void> {
    this.calls.push('capture');
    this.events = events;
    await this.script.capture?.(command, events);
  }

  async leave(): Promise<void> {
    this.calls.push('leave');
    await this.script.leave?.();
  }

  dispose(): Promise<void> {
    this.calls.push('dispose');
    return Promise.resolve();
  }
}

export class Harness {
  readonly sink = new MemorySink();
  readonly session: Session;
  readonly exits: number[] = [];
  readonly teardownFaults: string[] = [];
  clock = 0;

  constructor(
    readonly driver: MeetingDriver,
    options: { inboundIdleLimitMs?: number } = {},
  ) {
    this.session = new Session({
      sink: new FrameWriter(this.sink.stream),
      driver,
      sidecarVersion: '0.1.0',
      exit: (code) => {
        this.exits.push(code);
      },
      now: () => this.clock,
      onTeardownFault: (message) => {
        this.teardownFaults.push(message);
      },
      leaveTimeoutMs: 50,
      ...(options.inboundIdleLimitMs === undefined
        ? {}
        : { inboundIdleLimitMs: options.inboundIdleLimitMs }),
    });
  }

  /** Delivers a daemon -> sidecar control message, framed, as stdin would. */
  async send(message: D2sControl): Promise<void> {
    for (const body of new FrameReader().push(controlFrame(message))) {
      this.session.handleFrame(body);
    }
    await this.session.whenIdle();
  }

  /** Delivers raw bytes, for the malformed-input cases. */
  async sendRaw(bytes: Buffer): Promise<void> {
    for (const body of new FrameReader().push(bytes)) {
      this.session.handleFrame(body);
    }
    await this.session.whenIdle();
  }

  /** Everything the sidecar has written, decoded in order. */
  emitted(): Emitted[] {
    const reader = new FrameReader();
    return reader.push(this.sink.bytes()).map((body) => {
      const decoded = decode(body);
      return decoded.kind === 'audio'
        ? { kind: 'audio' as const, bytes: decoded.pcm.byteLength }
        : { kind: 'control' as const, message: decoded.message as S2dControl };
    });
  }

  /** The `"type"` of each emitted control frame, with audio rendered as `audio`. */
  shape(): string[] {
    return this.emitted().map((entry) => (entry.kind === 'audio' ? 'audio' : entry.message.type));
  }

  controls(): S2dControl[] {
    return this.emitted()
      .filter(
        (entry): entry is { kind: 'control'; message: S2dControl } => entry.kind === 'control',
      )
      .map((entry) => entry.message);
  }

  find<T extends S2dControl['type']>(type: T): Extract<S2dControl, { type: T }> | undefined {
    return this.controls().find((message) => message.type === type) as
      Extract<S2dControl, { type: T }> | undefined;
  }
}

/** 100 ms of silence: the frame size the daemon's audio fixture uses. */
export function toneFrame(): Buffer {
  return Buffer.alloc(3200);
}
