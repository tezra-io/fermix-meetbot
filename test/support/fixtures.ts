/**
 * Loaders for the daemon's vendored protocol export.
 *
 * `protocol/` is not ours to edit — it is fermix's machine-readable export of
 * `FermixCore.Meetings.Sidecar.Frame`, vendored so the two independently
 * released repos have exactly one coordination point. Every assertion built on
 * these loaders is an anti-drift guarantee.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Control } from '../../src/protocol.js';

/** `dist/test/support/` -> the repository root. */
const ROOT = new URL('../../../', import.meta.url);

export interface FixtureLine {
  /** The raw file line, byte-for-byte. */
  raw: string;
  dir: 's2d' | 'd2s';
  frame: Control;
  /** The exact JSON text of the `frame` object as it appears in the file. */
  frameJson: string;
}

export function protocolMarkdown(): string {
  return readFileSync(fileURLToPath(new URL('protocol/PROTOCOL.md', ROOT)), 'utf8');
}

export function audioFixture(): Buffer {
  return readFileSync(fileURLToPath(new URL('protocol/fixtures/audio_frame.bin', ROOT)));
}

export function packageManifest(): { version: string; engines: { node: string } } {
  const text = readFileSync(fileURLToPath(new URL('package.json', ROOT)), 'utf8');
  return JSON.parse(text) as { version: string; engines: { node: string } };
}

export function controlFixtures(): FixtureLine[] {
  const text = readFileSync(
    fileURLToPath(new URL('protocol/fixtures/control_frames.jsonl', ROOT)),
    'utf8',
  );

  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((raw) => {
      const parsed = JSON.parse(raw) as { dir: 's2d' | 'd2s'; frame: Control };
      const marker = '"frame":';
      const start = raw.indexOf(marker);
      if (start < 0) {
        throw new Error(`fixture line has no "frame" key: ${raw}`);
      }
      // The frame object runs to the closing brace of the enclosing line
      // object, so the exact source text is everything between them.
      const frameJson = raw.slice(start + marker.length, raw.length - 1);
      return { raw, dir: parsed.dir, frame: parsed.frame, frameJson };
    });
}
