/**
 * Drives a built `fermix-meetbot` executable over the real packet-4 wire,
 * exactly as the daemon's Erlang Port does.
 *
 * Two phases, neither of which needs a browser or a network:
 *
 *   wire      hello -> ping/pong -> leave -> meeting_ended{left} -> exit 0.
 *             Proves the bundle loads (playwright included), the transport
 *             frames correctly, and the lifecycle exits cleanly.
 *   registry  hello -> join -> error. The join must fail *because Chromium is
 *             not installed*, which is only reachable once playwright's
 *             inlined browsers.json has been read and the browser path
 *             resolved. A bundling regression fails here as a module error
 *             instead, which is the whole point of asserting the text.
 *
 * Actually joining a meeting needs Chromium and a signed-in Google account,
 * and stays an owner gate.
 *
 *   node scripts/smoke-binary.mjs build/fermix-meetbot-macos-aarch64
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const CONTROL = 0x01;
const TIMEOUT_MS = 60_000;

function frame(object) {
  const payload = Buffer.from(JSON.stringify(object), 'utf8');
  const out = Buffer.alloc(5 + payload.byteLength);
  out.writeUInt32BE(1 + payload.byteLength, 0);
  out.writeUInt8(CONTROL, 4);
  payload.copy(out, 5);
  return out;
}

function fail(message) {
  console.error(`smoke: FAILED — ${message}`);
  process.exit(1);
}

/**
 * Runs the binary, feeding it whatever `respond` returns for each frame it
 * emits, and resolves with the transcript and exit code.
 */
function drive(binary, respond) {
  return new Promise((resolve) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const received = [];
    let buffered = Buffer.alloc(0);

    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`no exit within ${String(TIMEOUT_MS)} ms; saw ${JSON.stringify(received)}`);
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.byteLength >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.byteLength - 4 < length) {
          break;
        }
        const body = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);
        if (body[0] !== CONTROL) {
          fail(`expected a control frame, got type byte ${String(body[0])}`);
        }
        const message = JSON.parse(body.subarray(1).toString('utf8'));
        received.push(message);
        const reply = respond(message);
        if (reply !== undefined && child.stdin.writable) {
          child.stdin.write(frame(reply));
        }
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      if (signal !== null) {
        fail(`the sidecar died on ${signal}`);
      }
      resolve({ received, code });
    });
  });
}

function assertHello(message) {
  if (message.type !== 'hello') {
    fail(`the first frame must be hello, got "${String(message.type)}"`);
  }
  if (message.protocol_version !== 1) {
    fail(`hello declared protocol_version ${String(message.protocol_version)}, expected 1`);
  }
  if (!Array.isArray(message.platforms) || !message.platforms.includes('meet')) {
    fail(`hello must advertise the meet platform, got ${JSON.stringify(message.platforms)}`);
  }
}

async function wirePhase(binary) {
  const { received, code } = await drive(binary, (message) => {
    if (message.type === 'hello') {
      assertHello(message);
      return { type: 'ping' };
    }
    if (message.type === 'pong') {
      return { type: 'leave' };
    }
    return undefined;
  });

  const shape = received.map((message) => message.type).join(',');
  if (shape !== 'hello,pong,meeting_ended') {
    fail(`wire phase produced "${shape}", expected "hello,pong,meeting_ended"`);
  }
  if (received[2].reason !== 'left') {
    fail(`meeting_ended must report "left", got "${String(received[2].reason)}"`);
  }
  if (code !== 0) {
    fail(`wire phase exited ${String(code)}, expected 0`);
  }
  console.log('smoke: wire ok — hello, pong, meeting_ended{left}, exit 0');
}

async function registryPhase(binary) {
  const profileDir = mkdtempSync(join(tmpdir(), 'fermix-meetbot-smoke-'));
  const { received, code } = await drive(binary, (message) => {
    if (message.type === 'hello') {
      assertHello(message);
      return {
        type: 'join',
        platform: 'meet',
        url: 'https://meet.google.com/abc-defg-hij',
        passcode: null,
        bot_name: 'Fermix Notetaker',
        announce: false,
        announce_message: '',
        profile_dir: profileDir,
      };
    }
    return undefined;
  });

  const error = received.find((message) => message.type === 'error');
  if (error === undefined) {
    fail(`registry phase produced no error frame; saw ${JSON.stringify(received)}`);
  }
  // The browser path in this text is built from the inlined browsers.json
  // revision, so its presence is the assertion.
  if (!/ms-playwright|playwright install|Executable doesn't exist/.test(error.message)) {
    fail(`the join failure is not a missing-browser report: ${String(error.message)}`);
  }
  if (code !== 1) {
    fail(`registry phase exited ${String(code)}, expected 1 after a terminal error`);
  }
  console.log('smoke: registry ok — the browser path resolved from the inlined browsers.json');
}

const binary = process.argv[2];
if (binary === undefined || !existsSync(binary)) {
  fail(`usage: node scripts/smoke-binary.mjs <path to fermix-meetbot> (got ${String(binary)})`);
}

await wirePhase(binary);
await registryPhase(binary);
console.log('smoke: the binary speaks the wire and resolves its browser');
