/**
 * The Playwright `MeetingDriver`: the only module that owns a browser.
 *
 * The Chromium profile at `profile_dir` holds the bot account's signed-in
 * state and is the sidecar's alone — credentials never cross the wire, and the
 * daemon never reads inside it. A persistent context is the whole reason the
 * bot can be a real signed-in participant rather than an anonymous guest.
 */

import type { Buffer } from 'node:buffer';
import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

import type { DriverEvents, MeetingDriver } from '../session.js';
import type { JoinCommand, JoinStatus, Participant } from '../protocol.js';
import { AudioPipeline, attachAudioTap } from './audio.js';
import { DEFAULT_TIMINGS, joinMeeting, leaveMeeting, postAnnouncement } from './join.js';
import { MEETING_CLOSED_MARKERS, REMOVED_MARKERS, IN_MEETING_MARKERS } from './selectors.js';
import {
  SCRAPE_CONFIG,
  normalizeParticipants,
  resolveSpeaker,
  rosterChanged,
  scrapeRoster,
} from './roster.js';

/**
 * Headless Chromium needs a fake microphone or Meet refuses to arm the mic UI;
 * the bot mutes it on the pre-join page and never speaks. The fake camera the
 * same flag provides is never granted (see `permissions` below), so the bot has
 * no video tile — Chromium's fake camera is an animated test pattern with a
 * running counter, which is what every participant saw when it was on.
 */
const CHROMIUM_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
];

const ROSTER_POLL_MS = 1_500;
/**
 * Consecutive polls with no in-meeting control before the call is declared
 * over. A capture ended on one glitched poll cannot be resumed (relaunch is
 * pre-admission only); the debounce costs ≤ one poll against a minute-scale
 * alone grace.
 */
const GONE_POLLS_TO_END = 2;

export interface MeetDriverOptions {
  headless?: boolean;
  rosterPollMs?: number;
}

export class MeetDriver implements MeetingDriver {
  readonly #headless: boolean;
  readonly #rosterPollMs: number;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #poll: NodeJS.Timeout | null = null;
  #roster: Participant[] | null = null;
  #pipeline: AudioPipeline | null = null;
  #gonePolls = 0;
  #speakerResolved = false;
  #speakerUnmatched = false;

  constructor(options: MeetDriverOptions = {}) {
    this.#headless = options.headless ?? true;
    this.#rosterPollMs = options.rosterPollMs ?? ROSTER_POLL_MS;
  }

  async join(command: JoinCommand, events: DriverEvents): Promise<JoinStatus> {
    if (command.platform !== 'meet') {
      throw new Error(`unsupported platform "${command.platform}"; this sidecar joins meet only`);
    }
    const context = await chromium.launchPersistentContext(command.profile_dir, {
      headless: this.#headless,
      // `channel: 'chromium'` selects the full Chromium build in new-headless
      // mode. Plain `headless: true` resolves to chrome-headless-shell, which
      // has no WebRTC stack — the bot would join and hear silence forever.
      channel: 'chromium',
      args: CHROMIUM_ARGS,
      permissions: ['microphone'],
      viewport: { width: 1280, height: 800 },
    });
    this.#context = context;
    this.#page = context.pages()[0] ?? (await context.newPage());

    return joinMeeting(this.#page, command, events, DEFAULT_TIMINGS);
  }

  /**
   * The audio tap and the roster are the product; the announcement is a
   * courtesy. They come first, so a slow or failing chat never costs the
   * opening seconds of the meeting.
   */
  async capture(command: JoinCommand, events: DriverEvents): Promise<void> {
    const page = this.#requirePage();

    const pipeline = new AudioPipeline();
    this.#pipeline = pipeline;
    await attachAudioTap(page, (block) => {
      for (const pcmFrame of pipeline.accept(block)) {
        events.audio(pcmFrame);
      }
    });

    await this.#emitRoster(events, true);
    this.#poll = setInterval(() => {
      void this.#tick(events);
    }, this.#rosterPollMs);

    if (command.announce) {
      await this.#announce(page, command.announce_message, events);
    }
  }

  async #announce(page: Page, message: string, events: DriverEvents): Promise<void> {
    const result = await postAnnouncement(page, message);
    if (result.posted) {
      events.chatPosted();
      return;
    }
    events.log(
      'warn',
      `could not post the announcement to the meeting chat (${result.step}); ${result.digest}`,
    );
  }

  async leave(): Promise<void> {
    this.#stopPolling();
    const page = this.#page;
    if (page === null || page.isClosed()) {
      return;
    }
    await leaveMeeting(page, DEFAULT_TIMINGS.probeMs);
  }

  async dispose(): Promise<void> {
    this.#stopPolling();
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    if (context !== null) {
      await context.close();
    }
  }

  /** The trailing partial audio frame, if capture stopped mid-frame. */
  drainAudio(): Buffer | null {
    return this.#pipeline?.drain() ?? null;
  }

  async #tick(events: DriverEvents): Promise<void> {
    const page = this.#page;
    if (page === null || page.isClosed()) {
      this.#stopPolling();
      events.meetingEnded('meeting_closed');
      return;
    }

    const ended = await this.#endedReason(page);
    if (ended !== null) {
      this.#stopPolling();
      events.meetingEnded(ended);
      return;
    }

    await this.#emitRoster(events, false);
  }

  async #endedReason(page: Page): Promise<'host_removed' | 'meeting_closed' | null> {
    if (await anyVisible(page, REMOVED_MARKERS)) {
      return 'host_removed';
    }
    if (await anyVisible(page, MEETING_CLOSED_MARKERS)) {
      return 'meeting_closed';
    }
    if (await anyVisible(page, IN_MEETING_MARKERS)) {
      this.#gonePolls = 0;
      return null;
    }
    this.#gonePolls += 1;
    return this.#gonePolls >= GONE_POLLS_TO_END ? 'meeting_closed' : null;
  }

  async #emitRoster(events: DriverEvents, force: boolean): Promise<void> {
    const page = this.#requirePage();
    const scrape = await page.evaluate(scrapeRoster, {
      itemSelectors: [...SCRAPE_CONFIG.itemSelectors],
      idAttributes: [...SCRAPE_CONFIG.idAttributes],
      nameSelectors: [...SCRAPE_CONFIG.nameSelectors],
      speakingSelectors: [...SCRAPE_CONFIG.speakingSelectors],
    });

    const participants = normalizeParticipants(scrape.participants);
    if (force || rosterChanged(this.#roster, participants)) {
      this.#roster = participants;
      events.roster(participants);
    }

    const speaker = resolveSpeaker(scrape.speakingId, participants);
    this.#noteSpeakerResolution(events, scrape.speakingId, speaker);
    if (speaker !== null) {
      events.activeSpeaker(speaker);
    }
  }

  /**
   * One line per meeting each way, so the daemon log says whether speaker
   * attribution ever had a signal to work with — "Unknown speaker" on every
   * transcript line used to be indistinguishable from nobody having spoken.
   */
  #noteSpeakerResolution(events: DriverEvents, raw: string | null, speaker: string | null): void {
    if (speaker !== null && !this.#speakerResolved) {
      this.#speakerResolved = true;
      events.log('info', 'speaking indicator resolved to a roster participant');
    }
    if (raw !== null && speaker === null && !this.#speakerUnmatched) {
      this.#speakerUnmatched = true;
      events.log('warn', 'speaking indicator matched, but its participant id is not on the roster');
    }
  }

  #requirePage(): Page {
    const page = this.#page;
    if (page === null) {
      throw new Error('the browser is not open; join must run before capture');
    }
    return page;
  }

  #stopPolling(): void {
    if (this.#poll !== null) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
  }
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if ((await page.locator(selector).first().count()) > 0) {
      return true;
    }
  }
  return false;
}
