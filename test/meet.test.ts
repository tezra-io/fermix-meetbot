/**
 * The Meet-facing modules cannot be exercised without a real meeting, so what
 * is tested here is everything that is *not* the DOM: the selector inventory
 * (so churn stays a one-file change and no group is ever silently emptied),
 * the PCM arithmetic the shared clock rests on, and the roster identity rules.
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { AUDIO_SAMPLE_RATE_HZ, MAX_AUDIO_BYTES, ROSTER_MAX } from '../src/protocol.js';
import { AudioPipeline, FRAME_BYTES } from '../src/meet/audio.js';
import { PcmChunker, Resampler } from '../src/meet/pcm.js';
import {
  normalizeParticipants,
  resolveSpeaker,
  rosterChanged,
  stableId,
} from '../src/meet/roster.js';
import { SELECTOR_GROUPS } from '../src/meet/selectors.js';

describe('selectors', () => {
  it('exposes a non-empty candidate list for every group', () => {
    for (const [name, group] of Object.entries(SELECTOR_GROUPS)) {
      assert.ok(group.length > 0, `${name} has no candidates`);
    }
  });

  it('has no empty or duplicated candidate within a group', () => {
    for (const [name, group] of Object.entries(SELECTOR_GROUPS)) {
      for (const selector of group) {
        assert.ok(selector.trim().length > 0, `${name} carries an empty selector`);
      }
      assert.equal(new Set(group).size, group.length, `${name} repeats a selector`);
    }
  });

  it('covers every outcome the join_result enum can report from the DOM', () => {
    // A missing marker group is how a real join silently degrades to
    // knock_timeout, so the inventory is asserted rather than assumed.
    for (const name of [
      'SIGNIN_MARKERS',
      'DENIED_MARKERS',
      'BOT_BLOCKED_MARKERS',
      'KNOCKING_MARKERS',
      'IN_MEETING_MARKERS',
    ]) {
      assert.ok(name in SELECTOR_GROUPS, `${name} is gone from the selector inventory`);
    }
  });
});

describe('Resampler', () => {
  it('converts 48 kHz to 16 kHz at a third of the sample count', () => {
    const resampler = new Resampler(48_000);
    const pcm = resampler.push(new Float32Array(4800));
    assert.equal(pcm.byteLength / 2, 1600);
  });

  it('produces the same bytes whether the source arrives whole or in blocks', () => {
    const source = Float32Array.from({ length: 9600 }, (_value, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 48_000),
    );

    const whole = new Resampler(48_000).push(source);

    const chunked = new Resampler(48_000);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < source.length; offset += 617) {
      parts.push(chunked.push(source.subarray(offset, offset + 617)));
    }
    assert.deepEqual(Buffer.concat(parts), whole);
  });

  it('passes a matched rate through with the sample count preserved', () => {
    const pcm = new Resampler(AUDIO_SAMPLE_RATE_HZ).push(new Float32Array(1600).fill(0.5));
    assert.equal(pcm.byteLength / 2, 1600);
    assert.equal(pcm.readInt16LE(0), Math.round(0.5 * 32_767));
  });

  it('clamps rather than wrapping on out-of-range input', () => {
    const pcm = new Resampler(AUDIO_SAMPLE_RATE_HZ).push(Float32Array.from([2, -2]));
    assert.equal(pcm.readInt16LE(0), 32_767);
    assert.equal(pcm.readInt16LE(2), -32_768);
  });

  it('refuses a nonsensical rate', () => {
    assert.throws(() => new Resampler(0), RangeError);
    assert.throws(() => new Resampler(48_000, -1), RangeError);
  });
});

describe('PcmChunker', () => {
  it('emits whole frames and holds the remainder', () => {
    const chunker = new PcmChunker(FRAME_BYTES);
    assert.deepEqual(chunker.push(Buffer.alloc(FRAME_BYTES - 2)), []);
    assert.equal(chunker.pending, FRAME_BYTES - 2);

    const frames = chunker.push(Buffer.alloc(FRAME_BYTES + 2));
    assert.equal(frames.length, 2);
    assert.ok(frames.every((entry) => entry.byteLength === FRAME_BYTES));
    assert.equal(chunker.pending, 0);
  });

  it('never emits a frame past the wire cap or an odd byte count', () => {
    const chunker = new PcmChunker(FRAME_BYTES);
    for (const entry of chunker.push(Buffer.alloc(FRAME_BYTES * 5 + 7))) {
      assert.ok(entry.byteLength <= MAX_AUDIO_BYTES);
      assert.equal(entry.byteLength % 2, 0);
    }
  });

  it('drains the tail to a whole number of samples', () => {
    const chunker = new PcmChunker(FRAME_BYTES);
    chunker.push(Buffer.alloc(101));
    const tail = chunker.drain();
    assert.equal(tail?.byteLength, 100);
    assert.equal(chunker.drain(), null);
  });

  it('refuses a frame size the wire would reject', () => {
    assert.throws(() => new PcmChunker(MAX_AUDIO_BYTES + 2), RangeError);
    assert.throws(() => new PcmChunker(101), RangeError);
    assert.throws(() => new PcmChunker(0), RangeError);
  });

  it('sizes the default frame at 100 ms, matching the daemon fixture', () => {
    assert.equal(FRAME_BYTES, 3200);
  });
});

describe('AudioPipeline', () => {
  it('turns page blocks into wire-sized frames', () => {
    const pipeline = new AudioPipeline();
    // 2400 source samples at 48 kHz = 800 output samples = half a frame.
    const halfFrame = { sampleRate: 48_000, samples: Array.from({ length: 2400 }, () => 0) };

    assert.deepEqual(pipeline.accept(halfFrame), [], 'a partial frame is held, never truncated');
    const frames = pipeline.accept(halfFrame);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.byteLength, FRAME_BYTES);
  });

  it('restarts cleanly when the page audio context changes rate', () => {
    const pipeline = new AudioPipeline();
    pipeline.accept({ sampleRate: 48_000, samples: Array.from({ length: 480 }, () => 0) });
    const frames = pipeline.accept({
      sampleRate: 44_100,
      samples: Array.from({ length: 44_100 }, () => 0),
    });
    assert.ok(frames.length > 0);
  });
});

describe('roster identity', () => {
  it('derives a stable, opaque id', () => {
    assert.equal(stableId('spaces/abc/devices/xyz'), stableId('spaces/abc/devices/xyz'));
    assert.notEqual(stableId('Ada Lovelace'), stableId('Alan Turing'));
    assert.match(stableId('Ada Lovelace'), /^p_[0-9a-f]{8}$/);
    assert.throws(() => stableId('  '), RangeError);
  });

  it('drops unnamed rows, de-duplicates, and caps at the roster limit', () => {
    const rows = [
      { id: 'a', name: 'Ada Lovelace' },
      { id: 'a', name: 'Ada Lovelace (duplicate node)' },
      { id: null, name: '   ' },
      { id: null, name: 'Fermix Notetaker' },
      ...Array.from({ length: 300 }, (_value, index) => ({
        id: `x${String(index)}`,
        name: `Guest ${String(index)}`,
      })),
    ];
    const participants = normalizeParticipants(rows);

    assert.equal(participants.length, ROSTER_MAX);
    assert.equal(participants[0]?.name, 'Ada Lovelace');
    assert.equal(new Set(participants.map((entry) => entry.id)).size, participants.length);
  });

  it('detects membership changes and ignores identical snapshots', () => {
    const snapshot = [{ id: 'p_1', name: 'Ada' }];
    assert.equal(rosterChanged(null, snapshot), true);
    assert.equal(rosterChanged(snapshot, [{ id: 'p_1', name: 'Ada' }]), false);
    assert.equal(rosterChanged(snapshot, [{ id: 'p_1', name: 'Ada L.' }]), true);
    assert.equal(rosterChanged(snapshot, []), true);
  });

  it('maps a speaking id onto the roster, or reports none', () => {
    const participants = normalizeParticipants([{ id: 'raw-1', name: 'Ada' }]);
    assert.equal(resolveSpeaker('raw-1', participants), participants[0]?.id);
    assert.equal(resolveSpeaker('raw-2', participants), null);
    assert.equal(resolveSpeaker(null, participants), null);
    assert.equal(resolveSpeaker('', participants), null);
  });
});
