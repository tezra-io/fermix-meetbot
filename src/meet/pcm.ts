/**
 * PCM conversion, kept pure and on the Node side of the page boundary.
 *
 * The page hands us Float32 samples at whatever rate its AudioContext runs
 * (48 kHz in practice); the wire wants s16le at 16 kHz mono. Doing the
 * conversion here rather than in an injected worklet means the arithmetic —
 * which the shared clock is built on — is ordinary testable code instead of a
 * string evaluated inside Chromium.
 */

import { Buffer } from 'node:buffer';

import { AUDIO_SAMPLE_RATE_HZ, MAX_AUDIO_BYTES } from '../protocol.js';

const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/**
 * Linear-interpolating resampler to 16 kHz mono s16le.
 *
 * Stateful on purpose: the fractional read position and the trailing sample
 * carry across pushes, so a stream chopped into arbitrary blocks produces the
 * same bytes as one contiguous block. Any drift here becomes drift in `t_ms`.
 */
export class Resampler {
  readonly #ratio: number;
  #position = 0;
  #previous = 0;
  #primed = false;

  constructor(sourceRateHz: number, targetRateHz: number = AUDIO_SAMPLE_RATE_HZ) {
    if (!Number.isFinite(sourceRateHz) || sourceRateHz <= 0) {
      throw new RangeError(`source rate must be a positive number, got ${String(sourceRateHz)}`);
    }
    if (!Number.isFinite(targetRateHz) || targetRateHz <= 0) {
      throw new RangeError(`target rate must be a positive number, got ${String(targetRateHz)}`);
    }
    this.#ratio = sourceRateHz / targetRateHz;
  }

  /** Converts one block of source samples into 16 kHz s16le bytes. */
  push(samples: Float32Array): Buffer {
    if (samples.length === 0) {
      return Buffer.alloc(0);
    }
    if (!this.#primed) {
      this.#previous = samples[0] ?? 0;
      this.#primed = true;
    }

    const out: number[] = [];
    // `#position` is an index into [previous, ...samples], so -1 addresses the
    // carried sample. The loop is bounded by the block length over the ratio.
    while (this.#position < samples.length) {
      const index = Math.floor(this.#position);
      const fraction = this.#position - index;
      const left = index < 0 ? this.#previous : (samples[index] ?? 0);
      const right = samples[index + 1] ?? left;
      out.push(toInt16(left + (right - left) * fraction));
      this.#position += this.#ratio;
    }
    this.#position -= samples.length;
    this.#previous = samples[samples.length - 1] ?? this.#previous;

    const buffer = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i += 1) {
      buffer.writeInt16LE(out[i] ?? 0, i * 2);
    }
    return buffer;
  }
}

function toInt16(sample: number): number {
  const scaled = Math.round(sample * INT16_MAX);
  if (scaled > INT16_MAX) {
    return INT16_MAX;
  }
  if (scaled < INT16_MIN) {
    return INT16_MIN;
  }
  return scaled;
}

/**
 * Accumulates PCM and hands out fixed-size frames.
 *
 * Frames are whole samples and never exceed the wire cap, so the session can
 * write whatever comes out without re-checking. The remainder is held, never
 * dropped — a discarded tail shifts every later `t_ms`.
 */
export class PcmChunker {
  readonly #frameBytes: number;
  #held: Buffer = Buffer.alloc(0);

  constructor(frameBytes: number) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new RangeError(`frame size must be a positive integer, got ${String(frameBytes)}`);
    }
    if (frameBytes % 2 !== 0) {
      throw new RangeError(
        `frame size must be a whole number of s16le samples, got ${String(frameBytes)}`,
      );
    }
    if (frameBytes > MAX_AUDIO_BYTES) {
      throw new RangeError(
        `frame size ${String(frameBytes)} exceeds the ${String(MAX_AUDIO_BYTES)}-byte wire cap`,
      );
    }
    this.#frameBytes = frameBytes;
  }

  /** Bytes held back, waiting to complete a frame. */
  get pending(): number {
    return this.#held.byteLength;
  }

  push(pcm: Buffer): Buffer[] {
    this.#held = this.#held.byteLength === 0 ? pcm : Buffer.concat([this.#held, pcm]);

    const frames: Buffer[] = [];
    let offset = 0;
    while (this.#held.byteLength - offset >= this.#frameBytes) {
      frames.push(this.#held.subarray(offset, offset + this.#frameBytes));
      offset += this.#frameBytes;
    }
    this.#held = offset === 0 ? this.#held : this.#held.subarray(offset);
    return frames;
  }

  /** Emits the remainder, padded to a whole sample. Called once, at the end. */
  drain(): Buffer | null {
    if (this.#held.byteLength === 0) {
      return null;
    }
    const whole = this.#held.byteLength - (this.#held.byteLength % 2);
    const tail = this.#held.subarray(0, whole);
    this.#held = Buffer.alloc(0);
    return tail.byteLength === 0 ? null : tail;
  }
}
