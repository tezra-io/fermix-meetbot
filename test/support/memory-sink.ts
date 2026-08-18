/**
 * A `Writable` that keeps every byte in memory, so a test can read back
 * exactly what the sidecar would have put on stdout.
 */

import { Buffer } from 'node:buffer';
import type { Writable } from 'node:stream';

export class MemorySink {
  readonly chunks: Buffer[] = [];

  readonly stream: Writable;

  constructor() {
    const chunks = this.chunks;
    this.stream = {
      write(chunk: Buffer, ...rest: unknown[]): boolean {
        chunks.push(Buffer.from(chunk));
        const callback = rest.find((argument) => typeof argument === 'function');
        if (typeof callback === 'function') {
          (callback as () => void)();
        }
        return true;
      },
    } as unknown as Writable;
  }

  /** Every byte written, concatenated. */
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
