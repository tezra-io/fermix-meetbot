import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT_CODES, parseProfileDir } from '../src/signin.js';

describe('signin argument parsing', () => {
  it('reads --profile-dir', () => {
    assert.equal(
      parseProfileDir(['--profile-dir', '/home/ada/.fermix/plugins/meetbot/profile']),
      '/home/ada/.fermix/plugins/meetbot/profile',
    );
  });

  it('ignores unrelated flags around it', () => {
    assert.equal(parseProfileDir(['--verbose', '--profile-dir', '/p', '--x', 'y']), '/p');
  });

  it('refuses a missing flag rather than guessing', () => {
    assert.throws(() => parseProfileDir([]), /requires --profile-dir/);
    assert.throws(() => parseProfileDir(['--profile-dir']), /requires --profile-dir/);
  });
});

describe('signin exit codes', () => {
  it('maps every terminal result to a distinct code the daemon reads', () => {
    assert.deepEqual(EXIT_CODES, { ok: 0, error: 1, cancelled: 2, timeout: 3 });
    // Distinct so the daemon can tell "signed in" from "closed the window".
    const codes = Object.values(EXIT_CODES);
    assert.equal(new Set(codes).size, codes.length);
  });
});
