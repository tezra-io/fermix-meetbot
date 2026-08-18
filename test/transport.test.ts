import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import {
  MAX_FRAME_BYTES,
  ProtocolError,
  audioFrame,
  controlFrame,
  decode,
  encodeAudio,
  encodeControl,
  type S2dControl,
} from '../src/protocol.js';
import { FrameReader, FrameWriter } from '../src/transport.js';
import { MemorySink } from './support/memory-sink.js';
import { audioFixture, controlFixtures } from './support/fixtures.js';

/** Feeds `stream` to a reader one slice at a time, at the given boundaries. */
function readWithSplits(stream: Buffer, boundaries: readonly number[]): Buffer[] {
  const reader = new FrameReader();
  const bodies: Buffer[] = [];
  let cursor = 0;
  for (const boundary of [...boundaries, stream.byteLength]) {
    if (boundary <= cursor) {
      continue;
    }
    bodies.push(...reader.push(stream.subarray(cursor, boundary)));
    cursor = boundary;
  }
  assert.equal(reader.pending, 0, 'reader held bytes after a complete stream');
  return bodies;
}

/** Deterministic PRNG so a failing split is reproducible from the seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('FrameReader', () => {
  const fixtures = controlFixtures();
  const bodies = [
    ...fixtures.map((fixture) => encodeControl(fixture.frame)),
    encodeAudio(audioFixture()),
  ];
  const stream = Buffer.concat([
    ...fixtures.map((fixture) => controlFrame(fixture.frame)),
    audioFrame(audioFixture()),
  ]);

  it('reassembles a stream delivered in one chunk', () => {
    assert.deepEqual(readWithSplits(stream, []), bodies);
  });

  it('reassembles a stream delivered one byte at a time', () => {
    const boundaries = Array.from({ length: stream.byteLength }, (_value, index) => index + 1);
    assert.deepEqual(readWithSplits(stream, boundaries), bodies);
  });

  it('reassembles across every single split point, including mid-prefix', () => {
    for (let split = 1; split < stream.byteLength; split += 1) {
      assert.deepEqual(
        readWithSplits(stream, [split]),
        bodies,
        `split at ${String(split)} drifted`,
      );
    }
  });

  it('reassembles a length prefix split at each of its four bytes', () => {
    // The first frame's prefix occupies bytes 0..3; splitting inside it is the
    // case a naive "one chunk is one frame" reader gets wrong.
    for (const split of [1, 2, 3]) {
      assert.deepEqual(readWithSplits(stream, [split]), bodies);
    }
  });

  it('reassembles an audio frame split across chunks', () => {
    const audio = audioFrame(audioFixture());
    const boundaries = [2, 4, 5, 1000, 2000, 3100];
    assert.deepEqual(readWithSplits(audio, boundaries), [encodeAudio(audioFixture())]);
  });

  it('reassembles under randomized chunking', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = makeRandom(seed);
      const boundaries: number[] = [];
      let cursor = 0;
      while (cursor < stream.byteLength) {
        cursor += 1 + Math.floor(random() * 900);
        boundaries.push(Math.min(cursor, stream.byteLength));
      }
      assert.deepEqual(readWithSplits(stream, boundaries), bodies, `seed ${String(seed)} drifted`);
    }
  });

  it('holds an incomplete frame instead of emitting a short body', () => {
    const reader = new FrameReader();
    assert.deepEqual(reader.push(stream.subarray(0, 3)), []);
    assert.equal(reader.pending, 3);
    assert.deepEqual(reader.push(stream.subarray(3, 5)), []);
    assert.ok(reader.pending > 0);
  });

  it('refuses a declared length past the protocol cap', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    assert.throws(
      () => new FrameReader().push(header),
      (error: unknown) => error instanceof ProtocolError && error.code === 'frame_too_large',
    );
  });

  it('accepts a frame exactly at the cap', () => {
    const body = Buffer.alloc(MAX_FRAME_BYTES, 0x02);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES, 0);
    const emitted = new FrameReader().push(Buffer.concat([header, body]));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.byteLength, MAX_FRAME_BYTES);
  });
});

describe('FrameWriter', () => {
  it('writes framed bytes a reader reads back identically', () => {
    const sink = new MemorySink();
    const writer = new FrameWriter(sink.stream);
    const pcm = audioFixture();

    writer.writeControl({
      type: 'hello',
      protocol_version: 1,
      sidecar_version: '0.1.0',
      platforms: ['meet'],
    });
    writer.writeAudio(pcm);
    writer.writeControl({ type: 'pong' });

    const bodies = new FrameReader().push(sink.bytes());
    assert.equal(bodies.length, 3);
    assert.deepEqual(
      bodies.map((body) => decode(body).kind),
      ['control', 'audio', 'control'],
    );
  });

  it('emits nothing but frames — the whole stream parses with no residue', () => {
    const sink = new MemorySink();
    const writer = new FrameWriter(sink.stream);
    for (const fixture of controlFixtures().filter((entry) => entry.dir === 's2d')) {
      writer.writeControl(fixture.frame as S2dControl);
    }
    const reader = new FrameReader();
    const bodies = reader.push(sink.bytes());
    assert.equal(reader.pending, 0);
    assert.equal(bodies.length, controlFixtures().filter((entry) => entry.dir === 's2d').length);
  });

  it('refuses to write an odd-length audio payload', () => {
    const writer = new FrameWriter(new MemorySink().stream);
    assert.throws(
      () => writer.writeAudio(Buffer.alloc(3)),
      (error: unknown) => error instanceof ProtocolError && error.code === 'audio_odd_bytes',
    );
  });

  it('runs the flush callback after the queued writes', () => {
    const sink = new MemorySink();
    const writer = new FrameWriter(sink.stream);
    writer.writeControl({ type: 'pong' });
    let flushed = false;
    writer.flush(() => {
      flushed = true;
    });
    assert.equal(flushed, true);
  });
});
