import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import {
  AUDIO_FRAME_TYPE,
  CONTROL_FRAME_TYPE,
  D2S_TYPES,
  END_REASONS,
  JOIN_STATUSES,
  LOG_LEVELS,
  MAX_AUDIO_BYTES,
  MAX_CONTROL_BYTES,
  PHASES,
  PROTOCOL_VERSION,
  ProtocolError,
  ROSTER_MAX,
  S2D_TYPES,
  audioFrame,
  controlFrame,
  decode,
  encodeAudio,
  encodeControl,
  frame,
  parseInbound,
  samplesToMs,
  type Control,
} from '../src/protocol.js';
import { audioFixture, controlFixtures, protocolMarkdown } from './support/fixtures.js';

function rejects(work: () => unknown, code: string): void {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ProtocolError, `expected a ProtocolError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('control frame fixtures', () => {
  const fixtures = controlFixtures();

  it('covers every control message the export declares', () => {
    assert.ok(fixtures.length >= 22, 'the vendored fixture file lost lines');
  });

  it('round-trips every fixture through encode/decode unchanged', () => {
    for (const fixture of fixtures) {
      const body = encodeControl(fixture.frame);
      const decoded = decode(body);
      assert.equal(decoded.kind, 'control');
      assert.deepEqual(
        decoded.kind === 'control' ? decoded.message : null,
        fixture.frame,
        `round-trip changed ${fixture.raw}`,
      );
    }
  });

  it('re-encodes every fixture to the exact bytes in the export', () => {
    for (const fixture of fixtures) {
      const body = encodeControl(fixture.frame);
      assert.equal(body[0], CONTROL_FRAME_TYPE);
      assert.equal(
        body.subarray(1).toString('utf8'),
        fixture.frameJson,
        `byte drift on ${fixture.raw}`,
      );
    }
  });

  it('frames every fixture with a 4-byte big-endian length prefix', () => {
    for (const fixture of fixtures) {
      const body = encodeControl(fixture.frame);
      const framed = controlFrame(fixture.frame);
      assert.equal(framed.readUInt32BE(0), body.byteLength);
      assert.deepEqual(framed.subarray(4), body);
    }
  });

  it('pins the known-type tables to the fixtures, per direction', () => {
    const byDirection = (dir: 's2d' | 'd2s'): string[] =>
      [
        ...new Set(
          fixtures
            .filter((fixture) => fixture.dir === dir)
            .map((fixture) => (fixture.frame as { type: string }).type),
        ),
      ].sort();

    assert.deepEqual(byDirection('s2d'), [...S2D_TYPES].sort());
    assert.deepEqual(byDirection('d2s'), [...D2S_TYPES].sort());
  });

  it('pins every enumeration to the fixtures', () => {
    const values = (key: string): string[] =>
      [
        ...new Set(
          fixtures
            .map((fixture) => (fixture.frame as unknown as Record<string, unknown>)[key])
            .filter((value): value is string => typeof value === 'string'),
        ),
      ].sort();

    assert.deepEqual(values('phase'), [...PHASES].sort());
    assert.deepEqual(values('status'), [...JOIN_STATUSES].sort());
    assert.deepEqual(values('reason'), [...END_REASONS].sort());
    assert.ok(LOG_LEVELS.includes('info'));
  });

  it('parses the join command the daemon actually sends', () => {
    const joinFixture = fixtures.find(
      (fixture) => (fixture.frame as { type: string }).type === 'join',
    );
    assert.ok(joinFixture, 'the export no longer carries a join fixture');

    const command = parseInbound(joinFixture.frame);
    assert.equal(command.type, 'join');
    assert.equal(command.type === 'join' ? command.platform : null, 'meet');
    assert.equal(command.type === 'join' ? command.passcode : 'unset', null);
    assert.equal(command.type === 'join' ? command.announce : null, true);
    assert.ok(command.type === 'join' && command.profile_dir.length > 0);
  });

  it('refuses a sidecar-side type arriving from the daemon', () => {
    rejects(() => parseInbound({ type: 'pong' }), 'invalid_control_shape');
  });

  it('refuses a join whose fields are the wrong shape', () => {
    const base = {
      type: 'join',
      platform: 'meet',
      url: 'https://meet.google.com/abc-defg-hij',
      passcode: null,
      bot_name: 'Fermix Notetaker',
      announce: true,
      announce_message: 'hello',
      profile_dir: '/tmp/profile',
    };
    rejects(
      () => parseInbound({ ...base, announce: 'yes' } as unknown as Control),
      'invalid_control_shape',
    );
    rejects(
      () => parseInbound({ ...base, url: 42 } as unknown as Control),
      'invalid_control_shape',
    );
    rejects(
      () => parseInbound({ ...base, passcode: 7 } as unknown as Control),
      'invalid_control_shape',
    );
  });
});

describe('audio frame fixture', () => {
  const pcm = audioFixture();

  it('is 100 ms of 16 kHz mono s16le', () => {
    assert.equal(pcm.byteLength, 3200);
    assert.equal(pcm.byteLength % 2, 0);
    assert.ok(pcm.byteLength <= MAX_AUDIO_BYTES);
    assert.equal(samplesToMs(pcm.byteLength / 2), 100);
  });

  it('round-trips through encode/decode byte-for-byte', () => {
    const body = encodeAudio(pcm);
    assert.equal(body[0], AUDIO_FRAME_TYPE);

    const decoded = decode(body);
    assert.equal(decoded.kind, 'audio');
    assert.deepEqual(decoded.kind === 'audio' ? decoded.pcm : null, pcm);
  });

  it('frames to the payload length plus the type byte', () => {
    assert.equal(audioFrame(pcm).readUInt32BE(0), pcm.byteLength + 1);
  });
});

describe('protocol caps and rejections', () => {
  it('rejects an unknown frame type byte', () => {
    rejects(() => decode(Buffer.of(0x03, 0x00)), 'unknown_frame_type');
  });

  it('rejects an empty frame body', () => {
    rejects(() => decode(Buffer.alloc(0)), 'empty_frame');
    rejects(() => frame(Buffer.alloc(0)), 'empty_frame');
  });

  it('rejects an oversized control payload in both directions', () => {
    const huge = Buffer.concat([
      Buffer.of(CONTROL_FRAME_TYPE),
      Buffer.alloc(MAX_CONTROL_BYTES + 1, 0x20),
    ]);
    rejects(() => decode(huge), 'control_too_large');
    rejects(
      () => encodeControl({ type: 'log', level: 'info', message: 'x'.repeat(MAX_CONTROL_BYTES) }),
      'control_too_large',
    );
  });

  it('rejects an oversized audio payload', () => {
    rejects(() => encodeAudio(Buffer.alloc(MAX_AUDIO_BYTES + 2)), 'audio_too_large');
    rejects(
      () => decode(Buffer.concat([Buffer.of(AUDIO_FRAME_TYPE), Buffer.alloc(MAX_AUDIO_BYTES + 2)])),
      'audio_too_large',
    );
  });

  it('rejects an odd-length audio payload', () => {
    rejects(() => encodeAudio(Buffer.alloc(3)), 'audio_odd_bytes');
    rejects(
      () => decode(Buffer.concat([Buffer.of(AUDIO_FRAME_TYPE), Buffer.alloc(3)])),
      'audio_odd_bytes',
    );
  });

  it('accepts an audio payload exactly at the cap', () => {
    const decoded = decode(encodeAudio(Buffer.alloc(MAX_AUDIO_BYTES)));
    assert.equal(decoded.kind, 'audio');
  });

  it('rejects a non-JSON control payload', () => {
    rejects(
      () => decode(Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), Buffer.from('not json')])),
      'invalid_json',
    );
    rejects(
      () => decode(Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), Buffer.from('[1,2]')])),
      'invalid_json',
    );
    rejects(
      () => decode(Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), Buffer.from('{"a":1}')])),
      'invalid_json',
    );
  });

  it('rejects an unknown control type', () => {
    rejects(
      () =>
        decode(Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), Buffer.from('{"type":"signin"}')])),
      'unknown_control_type',
    );
  });
});

describe('PROTOCOL.md pins', () => {
  const markdown = protocolMarkdown();

  it('pins the protocol version', () => {
    assert.match(markdown, /currently \*\*1\*\*/);
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it('pins the frame type bytes', () => {
    assert.match(markdown, /`0x01` \| control/);
    assert.match(markdown, /`0x02` \| audio/);
    assert.equal(CONTROL_FRAME_TYPE, 0x01);
    assert.equal(AUDIO_FRAME_TYPE, 0x02);
  });

  it('pins the payload caps', () => {
    assert.ok(markdown.includes(String(MAX_CONTROL_BYTES)));
    assert.ok(markdown.includes(String(MAX_AUDIO_BYTES)));
  });

  it('pins the clock formula and the roster cap', () => {
    assert.match(markdown, /t_ms = samples \/ 16/);
    assert.ok(markdown.includes(`Capped at ${String(ROSTER_MAX)} entries`));
  });

  it('pins the 4-byte big-endian framing', () => {
    assert.match(markdown, /\{:packet, 4\}/);
    assert.match(markdown, /4-byte big-endian/);
  });
});
