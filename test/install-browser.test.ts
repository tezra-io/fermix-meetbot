import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT_CODES, chromiumPresent } from '../src/install-browser.js';

// The real browser download is verified by running the PACKAGED binary against
// a fresh PLAYWRIGHT_BROWSERS_PATH (see the release/verification notes), not
// here — a unit test must not fetch ~150 MB. These cover the pure surface.

describe('install-browser exit codes', () => {
  it('maps ok and error to the codes the daemon reads', () => {
    assert.deepEqual(EXIT_CODES, { ok: 0, error: 1 });
    const codes = Object.values(EXIT_CODES);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('chromiumPresent', () => {
  it('answers a boolean without throwing, whatever the cache state', () => {
    assert.equal(typeof chromiumPresent(), 'boolean');
  });
});
