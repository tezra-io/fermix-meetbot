import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT_CODES, parseProfileDir, SESSION_COOKIE, sessionIsDurable } from '../src/signin.js';

const MEET = 'https://meet.google.com/home';
const CHOOSER = 'https://accounts.google.com/v3/signin/accountchooser';
const MARKETING = 'https://workspace.google.com/products/meet/';
const persistent = { name: SESSION_COOKIE, value: 'abc', expires: 1_893_456_000 };
const inMemory = { name: SESSION_COOKIE, value: 'abc', expires: -1 };

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

describe('sessionIsDurable — the sign-in verdict', () => {
  it('accepts a persistent cookie that Meet keeps (no bounce to sign-in)', () => {
    assert.equal(sessionIsDurable({ cookies: [persistent], meetUrl: MEET }), true);
  });

  it('rejects an in-memory session cookie — the false positive that shipped', () => {
    // expires <= 0 never reaches the on-disk profile the join reopens.
    assert.equal(sessionIsDurable({ cookies: [inMemory], meetUrl: MEET }), false);
  });

  it('rejects when Meet bounced the context to the account chooser', () => {
    assert.equal(sessionIsDurable({ cookies: [persistent], meetUrl: CHOOSER }), false);
  });

  it('rejects a signed-out profile bounced to the marketing site', () => {
    // meet.google.com/ sends a signed-out profile here, not to accounts — the
    // exact case a "not accounts.google.com" check would have wrongly passed.
    assert.equal(sessionIsDurable({ cookies: [persistent], meetUrl: MARKETING }), false);
  });

  it('rejects an absent or empty session cookie', () => {
    assert.equal(sessionIsDurable({ cookies: [], meetUrl: MEET }), false);
    assert.equal(
      sessionIsDurable({
        cookies: [{ name: SESSION_COOKIE, value: '', expires: 1_893_456_000 }],
        meetUrl: MEET,
      }),
      false,
    );
  });
});
