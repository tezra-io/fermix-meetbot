import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '../src/protocol.js';
import { SIDECAR_VERSION } from '../src/version.js';
import { packageManifest, protocolMarkdown } from './support/fixtures.js';

describe('versions', () => {
  it('declares the same sidecar_version the package publishes', () => {
    assert.equal(SIDECAR_VERSION, packageManifest().version);
  });

  it('speaks the protocol version PROTOCOL.md declares', () => {
    // Paired release: the daemon refuses any other value in hello and tears
    // the sidecar down, so this constant may only move with a fermix release.
    assert.equal(PROTOCOL_VERSION, 1);
    assert.match(protocolMarkdown(), /A single integer, `protocol_version`, currently \*\*1\*\*/);
  });

  it('requires the Node the runtime is built against', () => {
    assert.equal(packageManifest().engines.node, '>=22');
  });
});
