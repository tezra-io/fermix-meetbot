/**
 * Conformance against the daemon's scenario double (`fake_meetbot_sidecar.pl`).
 *
 * Each `describe` below is one of the scenarios that double encodes, restated
 * as an assertion on the exact frames this sidecar puts on the wire.
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { CONTROL_FRAME_TYPE, controlFrame, frame, samplesToMs } from '../src/protocol.js';
import { Harness, JOIN_COMMAND, ScriptedDriver, toneFrame } from './support/harness.js';
import { audioFixture } from './support/fixtures.js';

describe('handshake', () => {
  it('sends hello as the very first frame, synchronously on start', () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    assert.deepEqual(harness.emitted(), []);

    harness.session.start();

    const first = harness.emitted()[0];
    assert.ok(first !== undefined && first.kind === 'control');
    assert.deepEqual(first.message, {
      type: 'hello',
      protocol_version: 1,
      sidecar_version: '0.1.0',
      platforms: ['meet'],
    });
  });

  it('hang_hello: a sidecar that never starts writes nothing at all', () => {
    // The daemon's 15 s handshake deadline exists for exactly this shape. The
    // guarantee on our side is that hello needs no I/O, no browser, and no
    // await — so it cannot be what hangs.
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    assert.equal(harness.sink.bytes().byteLength, 0);
  });

  it('refuses a second start', () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();
    assert.throws(() => {
      harness.session.start();
    });
  });
});

describe('happy scenario', () => {
  it('emits the full admitted choreography and exits 0 on leave', async () => {
    const driver = new ScriptedDriver({
      join: (_command, events) => {
        events.state('joining');
        return 'admitted';
      },
      capture: (_command, events) => {
        events.chatPosted();
        events.roster([
          { id: 'p_ab12', name: 'Ada Lovelace' },
          { id: 'p_cd34', name: 'Fermix Notetaker' },
        ]);
        events.activeSpeaker('p_ab12');
        for (let i = 0; i < 3; i += 1) {
          events.audio(audioFixture());
        }
      },
    });
    const harness = new Harness(driver);
    harness.session.start();

    await harness.send(JOIN_COMMAND);
    assert.deepEqual(harness.shape(), [
      'hello',
      'state',
      'join_result',
      'chat_posted',
      'roster',
      'active_speaker',
      'audio',
      'audio',
      'audio',
    ]);
    assert.deepEqual(harness.find('join_result'), { type: 'join_result', status: 'admitted' });
    assert.equal(harness.find('roster')?.participants.length, 2);
    assert.deepEqual(harness.exits, []);

    await harness.send({ type: 'leave' });
    assert.deepEqual(harness.shape().slice(-1), ['meeting_ended']);
    assert.deepEqual(harness.find('meeting_ended'), { type: 'meeting_ended', reason: 'left' });
    assert.deepEqual(harness.exits, [0]);
    assert.ok(driver.calls.includes('leave'));
  });

  it('answers ping with pong', async () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();

    await harness.send({ type: 'ping' });
    assert.deepEqual(harness.shape(), ['hello', 'pong']);
  });
});

describe('denied scenario', () => {
  it('emits state then exactly one denied join_result and stays up', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: (_command, events) => {
          events.state('joining');
          return 'denied';
        },
      }),
    );
    harness.session.start();

    await harness.send(JOIN_COMMAND);
    assert.deepEqual(harness.shape(), ['hello', 'state', 'join_result']);
    assert.deepEqual(harness.find('join_result'), { type: 'join_result', status: 'denied' });
    assert.deepEqual(harness.exits, [], 'a denied join is reported, not crashed on');
  });

  it('never calls capture on a non-admitted result', async () => {
    const driver = new ScriptedDriver({ join: () => 'denied' });
    const harness = new Harness(driver);
    harness.session.start();
    await harness.send(JOIN_COMMAND);
    assert.deepEqual(driver.calls, ['join']);
  });
});

describe('signin_required scenario', () => {
  it('reports the status the daemon routes to the operator sign-in flow', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: (_command, events) => {
          events.state('joining');
          return 'signin_required';
        },
      }),
    );
    harness.session.start();

    await harness.send(JOIN_COMMAND);
    assert.deepEqual(harness.find('join_result'), {
      type: 'join_result',
      status: 'signin_required',
    });
  });
});

describe('crash_after_admit scenario', () => {
  it('turns a driver fault into a terminal error frame and a non-zero exit', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.audio(audioFixture());
          throw new Error('the meeting tab crashed while capturing');
        },
      }),
    );
    harness.session.start();

    await harness.send(JOIN_COMMAND);
    assert.deepEqual(harness.shape(), ['hello', 'join_result', 'audio', 'error']);
    assert.deepEqual(harness.find('error'), {
      type: 'error',
      code: 'sidecar_fault',
      message: 'the meeting tab crashed while capturing',
    });
    assert.deepEqual(harness.exits, [1]);
  });

  it('quotes the fault instead of collapsing it to a status word', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => {
          throw new Error('chrome exited: SingletonLock held by another process');
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.match(harness.find('error')?.message ?? '', /SingletonLock/);
  });
});

describe('wedge scenario', () => {
  it('answers pings while the driver produces nothing', async () => {
    const harness = new Harness(
      new ScriptedDriver({ join: () => 'admitted', capture: () => undefined }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    for (let i = 0; i < 3; i += 1) {
      harness.clock += 30_000;
      await harness.send({ type: 'ping' });
    }
    assert.deepEqual(harness.shape(), ['hello', 'join_result', 'pong', 'pong', 'pong']);
    assert.deepEqual(harness.exits, []);
  });

  it('leaves the meeting when the daemon goes silent past its own ping deadline', async () => {
    const driver = new ScriptedDriver({ join: () => 'admitted' });
    const harness = new Harness(driver, { inboundIdleLimitMs: 45_000 });
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    harness.clock += 44_000;
    harness.session.tick();
    await harness.session.whenIdle();
    assert.deepEqual(harness.exits, [], 'inside the deadline the session holds');

    harness.clock += 2_000;
    harness.session.tick();
    await harness.session.whenIdle();
    assert.deepEqual(harness.exits, [0]);
    assert.ok(
      driver.calls.includes('leave'),
      'a wedged daemon must not strand the bot in the call',
    );
  });
});

describe('stdin EOF', () => {
  it('leaves the meeting, disposes the browser, and exits 0 without writing', async () => {
    const driver = new ScriptedDriver({ join: () => 'admitted' });
    const harness = new Harness(driver);
    harness.session.start();
    await harness.send(JOIN_COMMAND);
    const before = harness.shape();

    harness.session.handleEof();
    await harness.session.whenIdle();

    assert.deepEqual(harness.shape(), before, 'the pipe is gone; nothing may be written');
    assert.deepEqual(harness.exits, [0]);
    assert.ok(driver.calls.includes('leave'));
    assert.ok(driver.calls.includes('dispose'));
  });
});

describe('teardown faults', () => {
  it('reports a failing leave and still disposes the browser', async () => {
    const driver = new ScriptedDriver({
      join: () => 'admitted',
      leave: () => {
        throw new Error('the leave button was never found');
      },
    });
    const harness = new Harness(driver);
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    harness.session.handleEof();
    await harness.session.whenIdle();

    assert.deepEqual(harness.teardownFaults, [
      'leave failed during teardown: the leave button was never found',
    ]);
    assert.ok(
      driver.calls.includes('dispose'),
      'a failed leave must not strand a headless Chromium',
    );
    assert.deepEqual(harness.exits, [0]);
  });

  it('keeps a teardown fault off the wire — the pipe is already closing', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        leave: () => {
          throw new Error('boom');
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);
    const before = harness.shape();

    harness.session.handleEof();
    await harness.session.whenIdle();

    assert.deepEqual(harness.shape(), before);
  });
});

describe('protocol invariants', () => {
  it('sends join_result exactly once', async () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();

    await harness.send(JOIN_COMMAND);
    await harness.send(JOIN_COMMAND);

    assert.equal(harness.controls().filter((message) => message.type === 'join_result').length, 1);
    assert.equal(harness.find('error')?.code, 'invalid_control_shape');
    assert.deepEqual(harness.exits, [1]);
  });

  it('refuses a capture event emitted before an admitted join_result', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: (_command, events) => {
          events.roster([{ id: 'p_ab12', name: 'Ada Lovelace' }]);
          return 'admitted';
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.deepEqual(harness.shape(), ['hello', 'error']);
    assert.match(harness.find('error')?.message ?? '', /before an admitted join_result/);
  });

  it('caps a roster snapshot at 200 entries', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.roster(
            Array.from({ length: 250 }, (_value, index) => ({
              id: `p_${String(index)}`,
              name: `Participant ${String(index)}`,
            })),
          );
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.equal(harness.find('roster')?.participants.length, 200);
  });

  it('emits active_speaker on change only', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.activeSpeaker('p_ab12');
          events.activeSpeaker('p_ab12');
          events.activeSpeaker('p_cd34');
          events.activeSpeaker('p_cd34');
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.deepEqual(
      harness.controls().filter((message) => message.type === 'active_speaker'),
      [
        { type: 'active_speaker', id: 'p_ab12', t_ms: 0 },
        { type: 'active_speaker', id: 'p_cd34', t_ms: 0 },
      ],
    );
  });

  it('fails on a malformed inbound frame rather than skipping it', async () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();

    await harness.sendRaw(frame(Buffer.concat([Buffer.of(CONTROL_FRAME_TYPE), Buffer.from('{')])));

    assert.equal(harness.find('error')?.code, 'invalid_json');
    assert.deepEqual(harness.exits, [1]);
  });

  it('fails on an inbound audio frame — audio is sidecar -> daemon only', async () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();

    await harness.sendRaw(frame(Buffer.concat([Buffer.of(0x02), Buffer.alloc(4)])));

    assert.equal(harness.find('error')?.code, 'unknown_frame_type');
  });

  it('reports a driver-observed meeting end and exits 0', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.meetingEnded('host_removed');
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.deepEqual(harness.find('meeting_ended'), {
      type: 'meeting_ended',
      reason: 'host_removed',
    });
    assert.deepEqual(harness.exits, [0]);
  });

  it('ignores frames that arrive after the session finished', async () => {
    const harness = new Harness(new ScriptedDriver({ join: () => 'admitted' }));
    harness.session.start();
    await harness.send({ type: 'leave' });
    const after = harness.shape();

    await harness.send({ type: 'ping' });
    assert.deepEqual(harness.shape(), after);
    assert.deepEqual(harness.exits, [0], 'exit is reported once');
  });
});

describe('the sample clock', () => {
  it('stamps t_ms as samples sent before the event, divided by 16', async () => {
    const stamps: number[] = [];
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          // 1600 samples per frame = 100 ms each.
          events.activeSpeaker('p_ab12');
          events.audio(toneFrame());
          events.audio(toneFrame());
          events.activeSpeaker('p_cd34');
          events.audio(toneFrame());
          events.activeSpeaker('p_ab12');
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    for (const message of harness.controls()) {
      if (message.type === 'active_speaker') {
        stamps.push(message.t_ms);
      }
    }
    assert.deepEqual(stamps, [0, 200, 300]);
    assert.equal(harness.session.samplesSent, 4800);
    assert.equal(samplesToMs(harness.session.samplesSent), 300);
  });

  it('never derives t_ms from wall-clock time', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.audio(toneFrame());
          events.activeSpeaker('p_ab12');
        },
      }),
    );
    harness.clock = 1_764_000_000_000;
    harness.session.start();
    await harness.send(JOIN_COMMAND);
    harness.clock += 999_999;

    assert.equal(harness.find('active_speaker')?.t_ms, 100);
  });

  it('refuses an odd-length audio payload from the driver', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: () => 'admitted',
        capture: (_command, events) => {
          events.audio(Buffer.alloc(101));
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    assert.equal(harness.find('error')?.code, 'audio_odd_bytes');
  });
});

describe('the wire the daemon reads', () => {
  it('produces bytes identical to hand-framing every emitted control message', async () => {
    const harness = new Harness(
      new ScriptedDriver({
        join: (_command, events) => {
          events.state('joining');
          return 'admitted';
        },
      }),
    );
    harness.session.start();
    await harness.send(JOIN_COMMAND);

    const expected = Buffer.concat(harness.controls().map((message) => controlFrame(message)));
    assert.deepEqual(harness.sink.bytes(), expected);
  });
});
