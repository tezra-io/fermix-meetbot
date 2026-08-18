/**
 * Wire codec for the meetbot sidecar protocol v1.
 *
 * The daemon defines this protocol; `protocol/PROTOCOL.md` and
 * `protocol/fixtures/*` are its vendored export and this module conforms to
 * them byte for byte. Nothing here may be relaxed to make a local change
 * compile — the daemon refuses a mismatched frame and tears the sidecar down.
 *
 * A frame body is always `<<type::8, payload>>`; the 4-byte big-endian length
 * prefix that Erlang's `{:packet, 4}` mode adds is applied by `frame()` and
 * stripped by the reader in `transport.ts`.
 *
 * Every rejection is typed. There is no skip-and-continue: a dropped frame
 * silently desyncs the sample clock that speaker attribution is built on, so
 * the only correct response to a bad frame is a loud failure.
 */

import { Buffer } from 'node:buffer';

/** The one wire version this sidecar speaks; declared in `hello`. */
export const PROTOCOL_VERSION = 1;

export const CONTROL_FRAME_TYPE = 0x01;
export const AUDIO_FRAME_TYPE = 0x02;

export const MAX_CONTROL_BYTES = 65_536;
export const MAX_AUDIO_BYTES = 32_768;

/** Largest legal frame body (`type` byte + the largest payload). */
export const MAX_FRAME_BYTES = 1 + Math.max(MAX_CONTROL_BYTES, MAX_AUDIO_BYTES);

export const LENGTH_PREFIX_BYTES = 4;

/** A `roster` snapshot is capped by the daemon at 200 entries. */
export const ROSTER_MAX = 200;

export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_BYTES_PER_SAMPLE = 2;

/** `t_ms = samples / 16` — 16 kHz mono. The divisor is samples per millisecond. */
export const SAMPLES_PER_MS = AUDIO_SAMPLE_RATE_HZ / 1000;

export const PHASES = ['joining', 'knocking', 'leaving'] as const;
export const JOIN_STATUSES = [
  'admitted',
  'denied',
  'login_required',
  'signin_required',
  'bot_blocked',
  'knock_timeout',
] as const;
export const END_REASONS = ['host_removed', 'meeting_closed', 'left'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Control `"type"` values legal sidecar -> daemon. */
export const S2D_TYPES = [
  'hello',
  'state',
  'join_result',
  'roster',
  'active_speaker',
  'chat_posted',
  'meeting_ended',
  'error',
  'log',
  'pong',
] as const;

/** Control `"type"` values legal daemon -> sidecar. */
export const D2S_TYPES = ['join', 'leave', 'ping'] as const;

export type Phase = (typeof PHASES)[number];
export type JoinStatus = (typeof JOIN_STATUSES)[number];
export type EndReason = (typeof END_REASONS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type S2dType = (typeof S2D_TYPES)[number];
export type D2sType = (typeof D2S_TYPES)[number];

export interface Participant {
  id: string;
  name: string;
}

export type S2dControl =
  | {
      type: 'hello';
      protocol_version: number;
      sidecar_version: string;
      platforms: string[];
    }
  | { type: 'state'; phase: Phase }
  | { type: 'join_result'; status: JoinStatus }
  | { type: 'roster'; participants: Participant[] }
  | { type: 'active_speaker'; id: string; t_ms: number }
  | { type: 'chat_posted' }
  | { type: 'meeting_ended'; reason: EndReason }
  | { type: 'error'; code: string; message: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'pong' };

export interface JoinCommand {
  type: 'join';
  platform: string;
  url: string;
  passcode: string | null;
  bot_name: string;
  announce: boolean;
  announce_message: string;
  profile_dir: string;
}

export type D2sControl = JoinCommand | { type: 'leave' } | { type: 'ping' };

export type Control = S2dControl | D2sControl;

export type ProtocolErrorCode =
  | 'empty_frame'
  | 'unknown_frame_type'
  | 'control_too_large'
  | 'audio_too_large'
  | 'audio_odd_bytes'
  | 'invalid_json'
  | 'unknown_control_type'
  | 'frame_too_large'
  | 'invalid_control_shape';

/** Every codec rejection, carrying the daemon's own vocabulary for the reason. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export type DecodedFrame = { kind: 'control'; message: Control } | { kind: 'audio'; pcm: Buffer };

function isKnownControlType(type: string): boolean {
  return (
    (S2D_TYPES as readonly string[]).includes(type) ||
    (D2S_TYPES as readonly string[]).includes(type)
  );
}

/** Checks an audio payload against the size and sample-alignment caps. */
export function assertAudioPayload(pcm: Buffer): void {
  if (pcm.byteLength > MAX_AUDIO_BYTES) {
    throw new ProtocolError(
      'audio_too_large',
      `audio payload is ${String(pcm.byteLength)} bytes, cap is ${String(MAX_AUDIO_BYTES)}`,
    );
  }
  if (pcm.byteLength % AUDIO_BYTES_PER_SAMPLE !== 0) {
    throw new ProtocolError(
      'audio_odd_bytes',
      `audio payload is ${String(pcm.byteLength)} bytes, which is not a whole number of s16le samples`,
    );
  }
}

/** Encodes a control message into a frame body (`<<0x01, json>>`). */
export function encodeControl(message: Control): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.byteLength > MAX_CONTROL_BYTES) {
    throw new ProtocolError(
      'control_too_large',
      `control payload is ${String(json.byteLength)} bytes, cap is ${String(MAX_CONTROL_BYTES)}`,
    );
  }
  return Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), json]);
}

/** Encodes raw PCM into a frame body (`<<0x02, pcm>>`). */
export function encodeAudio(pcm: Buffer): Buffer {
  assertAudioPayload(pcm);
  return Buffer.concat([Buffer.of(AUDIO_FRAME_TYPE), pcm]);
}

/** Prepends the 4-byte big-endian length prefix that `{:packet, 4}` expects. */
export function frame(body: Buffer): Buffer {
  if (body.byteLength === 0) {
    throw new ProtocolError('empty_frame', 'refusing to write a zero-length frame');
  }
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      'frame_too_large',
      `frame body is ${String(body.byteLength)} bytes, cap is ${String(MAX_FRAME_BYTES)}`,
    );
  }
  const out = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.byteLength);
  out.writeUInt32BE(body.byteLength, 0);
  body.copy(out, LENGTH_PREFIX_BYTES);
  return out;
}

/** Convenience: a fully framed control message, ready for the wire. */
export function controlFrame(message: Control): Buffer {
  return frame(encodeControl(message));
}

/** Convenience: a fully framed audio message, ready for the wire. */
export function audioFrame(pcm: Buffer): Buffer {
  return frame(encodeAudio(pcm));
}

/**
 * Decodes one frame body.
 *
 * Direction-agnostic, exactly like the daemon's codec: which direction a
 * message is *legal* in is the session's invariant, not the codec's.
 */
export function decode(body: Buffer): DecodedFrame {
  if (body.byteLength === 0) {
    throw new ProtocolError('empty_frame', 'frame body is empty');
  }

  const type = body[0];
  const payload = body.subarray(1);

  if (type === CONTROL_FRAME_TYPE) {
    if (payload.byteLength > MAX_CONTROL_BYTES) {
      throw new ProtocolError(
        'control_too_large',
        `control payload is ${String(payload.byteLength)} bytes, cap is ${String(MAX_CONTROL_BYTES)}`,
      );
    }
    return { kind: 'control', message: decodeControlPayload(payload) };
  }

  if (type === AUDIO_FRAME_TYPE) {
    assertAudioPayload(payload);
    return { kind: 'audio', pcm: payload };
  }

  throw new ProtocolError('unknown_frame_type', `unknown frame type byte ${String(type)}`);
}

function decodeControlPayload(payload: Buffer): Control {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch (cause) {
    throw new ProtocolError(
      'invalid_json',
      `control payload is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('invalid_json', 'control frame is not a JSON object');
  }

  const type: unknown = (parsed as Record<string, unknown>)['type'];
  if (typeof type !== 'string') {
    throw new ProtocolError('invalid_json', 'control frame has no "type" string');
  }
  if (!isKnownControlType(type)) {
    throw new ProtocolError('unknown_control_type', `unknown control type "${type}"`);
  }

  return parsed as Control;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value: unknown = source[key];
  if (typeof value !== 'string') {
    throw new ProtocolError('invalid_control_shape', `"${key}" must be a string`);
  }
  return value;
}

/**
 * Narrows a decoded control message to one the daemon is allowed to send us,
 * validating the field shapes the session depends on. A sidecar-side type
 * arriving on stdin means the two halves have drifted, and that is fatal.
 */
export function parseInbound(message: Control): D2sControl {
  const record = message as unknown as Record<string, unknown>;
  const type = record['type'] as string;

  if (!(D2S_TYPES as readonly string[]).includes(type)) {
    throw new ProtocolError(
      'invalid_control_shape',
      `control type "${type}" is not legal daemon -> sidecar`,
    );
  }

  if (type === 'leave' || type === 'ping') {
    return { type };
  }

  const passcode: unknown = record['passcode'];
  if (passcode !== null && passcode !== undefined && typeof passcode !== 'string') {
    throw new ProtocolError('invalid_control_shape', '"passcode" must be a string or null');
  }
  const announce: unknown = record['announce'];
  if (typeof announce !== 'boolean') {
    throw new ProtocolError('invalid_control_shape', '"announce" must be a boolean');
  }

  return {
    type: 'join',
    platform: requireString(record, 'platform'),
    url: requireString(record, 'url'),
    passcode: typeof passcode === 'string' ? passcode : null,
    bot_name: requireString(record, 'bot_name'),
    announce,
    announce_message: requireString(record, 'announce_message'),
    profile_dir: requireString(record, 'profile_dir'),
  };
}

/** The shared clock: `t_ms` is derived from the audio stream, never from wall time. */
export function samplesToMs(samples: number): number {
  return Math.floor(samples / SAMPLES_PER_MS);
}
