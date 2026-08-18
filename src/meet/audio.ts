/**
 * The meeting audio tap.
 *
 * Meet delivers remote audio as WebRTC `MediaStream`s attached to `<audio>` /
 * `<video>` elements. In-page we route every such stream into one AudioContext
 * and forward raw Float32 blocks out through an exposed binding; on the Node
 * side we resample to 16 kHz mono s16le and cut fixed frames.
 *
 * The split is deliberate: the injected script does the one thing only the
 * page can do (reach the MediaStream) and nothing else, so the arithmetic the
 * shared clock depends on stays in `pcm.ts` where tests can reach it.
 */

import type { Buffer } from 'node:buffer';
import type { Page } from 'playwright';

import { AUDIO_SAMPLE_RATE_HZ } from '../protocol.js';
import { PcmChunker, Resampler } from './pcm.js';

/** 100 ms of 16 kHz mono s16le — the frame size the daemon's fixture uses. */
export const FRAME_BYTES = (AUDIO_SAMPLE_RATE_HZ / 10) * 2;

/** The page->node binding name. Also referenced by the injected script. */
export const AUDIO_BINDING = '__fermixMeetbotAudio';

export interface AudioBlock {
  sampleRate: number;
  samples: number[];
}

/**
 * Converts page blocks into wire frames. One instance per meeting: the
 * resampler and chunker are stateful and their carry is what keeps the sample
 * count exact across blocks.
 */
export class AudioPipeline {
  #resampler: Resampler | null = null;
  #sourceRate = 0;
  readonly #chunker = new PcmChunker(FRAME_BYTES);

  accept(block: AudioBlock): Buffer[] {
    if (this.#resampler === null || block.sampleRate !== this.#sourceRate) {
      // A rate change means a new AudioContext; the old carry belongs to a
      // stream that no longer exists.
      this.#sourceRate = block.sampleRate;
      this.#resampler = new Resampler(block.sampleRate);
    }
    return this.#chunker.push(this.#resampler.push(Float32Array.from(block.samples)));
  }

  /** The trailing partial frame, emitted once when capture stops. */
  drain(): Buffer | null {
    return this.#chunker.drain();
  }
}

/**
 * Installs the tap. `onBlock` is invoked for every block the page produces;
 * the caller feeds it to an `AudioPipeline` and writes the frames.
 */
export async function attachAudioTap(
  page: Page,
  onBlock: (block: AudioBlock) => void,
): Promise<void> {
  await page.exposeBinding(AUDIO_BINDING, (_source, block: AudioBlock) => {
    onBlock(block);
  });
  await page.evaluate(installTap, { binding: AUDIO_BINDING, blockSize: 4096 });
}

/**
 * Runs inside Chromium. Must not close over module scope — Playwright
 * serializes it — and must not throw, because an exception here would leave
 * the meeting running with no audio and no signal.
 */
function installTap(config: { binding: string; blockSize: number }): void {
  interface TapWindow extends Window {
    __fermixMeetbotTapInstalled?: boolean;
    [key: string]: unknown;
  }
  const scope = window as unknown as TapWindow;
  if (scope.__fermixMeetbotTapInstalled === true) {
    return;
  }
  scope.__fermixMeetbotTapInstalled = true;

  const context = new AudioContext();
  const merger = context.createGain();
  const processor = context.createScriptProcessor(config.blockSize, 1, 1);
  const attached = new WeakSet<MediaStream>();

  processor.onaudioprocess = (event: AudioProcessingEvent): void => {
    const channel = event.inputBuffer.getChannelData(0);
    const send = scope[config.binding];
    if (typeof send === 'function') {
      (send as (block: { sampleRate: number; samples: number[] }) => void)({
        sampleRate: context.sampleRate,
        samples: Array.from(channel),
      });
    }
  };

  merger.connect(processor);
  // A ScriptProcessor only runs while connected to a destination; a zeroed gain
  // keeps it pulling without adding the meeting audio to the local output.
  const silent = context.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(context.destination);

  const attach = (): void => {
    const media = document.querySelectorAll('audio, video');
    for (const element of media) {
      const stream = (element as HTMLMediaElement).srcObject;
      if (stream === null || !(stream instanceof MediaStream) || attached.has(stream)) {
        continue;
      }
      if (stream.getAudioTracks().length === 0) {
        continue;
      }
      attached.add(stream);
      context.createMediaStreamSource(stream).connect(merger);
    }
  };

  attach();
  // Participants join and leave for the whole meeting, each bringing a new
  // stream; the poll is the only way to notice a srcObject assignment.
  setInterval(attach, 2000);
}
