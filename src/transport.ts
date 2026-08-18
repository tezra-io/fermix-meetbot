/**
 * The packet-4 transport: stdin reassembly and stdout framing.
 *
 * Two hard rules live here.
 *
 * 1. **stdout carries frames and nothing else.** The daemon does not merge our
 *    stderr into the data channel, and a single stray byte on stdout would be
 *    read as part of a length prefix and desync every frame after it.
 *    Diagnostics go out as `log` control frames (or, before the handshake, to
 *    stderr) — never as a bare write.
 * 2. **A frame is never dropped.** Backpressure is absorbed by the stream's own
 *    buffer, because discarding an audio frame would silently shift the sample
 *    clock that speaker attribution is computed against.
 */

import { Buffer } from 'node:buffer';
import type { Writable } from 'node:stream';

import {
  LENGTH_PREFIX_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  encodeAudio,
  encodeControl,
  frame,
  type S2dControl,
} from './protocol.js';

/**
 * Reassembles length-prefixed frame bodies from an arbitrarily chunked byte
 * stream. Chunk boundaries are meaningless: a prefix may arrive split across
 * four separate reads, and several frames may arrive in one.
 */
export class FrameReader {
  #buffered: Buffer = Buffer.alloc(0);

  /** Bytes held back waiting for the rest of their frame. */
  get pending(): number {
    return this.#buffered.byteLength;
  }

  /**
   * Appends a chunk and returns every frame body that is now complete.
   *
   * Throws `ProtocolError` on a declared length past the protocol cap — an
   * unbounded allocation request is a protocol error, not something to wait
   * out.
   */
  push(chunk: Buffer): Buffer[] {
    this.#buffered =
      this.#buffered.byteLength === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);

    const bodies: Buffer[] = [];
    let offset = 0;

    // Each iteration consumes at least LENGTH_PREFIX_BYTES, so the loop is
    // bounded by the buffered byte count.
    while (this.#buffered.byteLength - offset >= LENGTH_PREFIX_BYTES) {
      const length = this.#buffered.readUInt32BE(offset);
      if (length > MAX_FRAME_BYTES) {
        throw new ProtocolError(
          'frame_too_large',
          `inbound frame declares ${String(length)} bytes, cap is ${String(MAX_FRAME_BYTES)}`,
        );
      }
      if (this.#buffered.byteLength - offset - LENGTH_PREFIX_BYTES < length) {
        break;
      }
      const start = offset + LENGTH_PREFIX_BYTES;
      bodies.push(this.#buffered.subarray(start, start + length));
      offset = start + length;
    }

    this.#buffered = offset === 0 ? this.#buffered : this.#buffered.subarray(offset);
    return bodies;
  }
}

/** Writes frames to a stream. The only thing allowed to touch stdout. */
export class FrameWriter {
  readonly #stream: Writable;

  constructor(stream: Writable) {
    this.#stream = stream;
  }

  writeControl(message: S2dControl): void {
    this.#write(encodeControl(message));
  }

  writeAudio(pcm: Buffer): void {
    this.#write(encodeAudio(pcm));
  }

  /** Runs `callback` once every byte written so far has reached the OS. */
  flush(callback: () => void): void {
    this.#stream.write(Buffer.alloc(0), () => {
      callback();
    });
  }

  #write(body: Buffer): void {
    this.#stream.write(frame(body));
  }
}
