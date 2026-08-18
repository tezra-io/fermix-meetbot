/**
 * The Google Meet join choreography.
 *
 * Navigate, clear the pre-join dialogs, set the bot's display name, ask to
 * join, then wait for exactly one of the outcomes the protocol enumerates.
 * Every selector comes from `selectors.ts`; nothing here matches on markup
 * directly.
 */

import type { Page } from 'playwright';

import type { JoinCommand, JoinStatus, LogLevel, Phase } from '../protocol.js';
import {
  BOT_BLOCKED_MARKERS,
  CHAT_INPUT,
  CHAT_SEND_BUTTONS,
  CHAT_TOGGLES,
  CAMERA_TOGGLES,
  DENIED_MARKERS,
  DISMISS_BUTTONS,
  IN_MEETING_MARKERS,
  JOIN_BUTTONS,
  KNOCKING_MARKERS,
  LEAVE_BUTTONS,
  MUTE_TOGGLES,
  NAME_INPUT,
  SIGNIN_MARKERS,
} from './selectors.js';

export interface JoinProgress {
  state(phase: Phase): void;
  log(level: LogLevel, message: string): void;
}

export interface JoinTimings {
  /** How long the pre-join page has to render before we call it broken. */
  pageReadyMs: number;
  /** How long a knock may stay unanswered before `knock_timeout`. */
  admitMs: number;
  /** Per-selector probe budget. */
  probeMs: number;
}

export const DEFAULT_TIMINGS: JoinTimings = {
  pageReadyMs: 30_000,
  admitMs: 120_000,
  probeMs: 2_000,
};

/** Clicks the first candidate that is present, and reports whether any was. */
export async function clickFirst(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.click({ timeout: timeoutMs });
      return true;
    } catch {
      // Meet renders a different subset of these controls on every variant of
      // the pre-join page; a missing one is expected, not an error.
      continue;
    }
  }
  return false;
}

/** Resolves with the index of the first selector group that matches, or null. */
export async function raceMarkers(
  page: Page,
  groups: readonly (readonly string[])[],
  timeoutMs: number,
): Promise<number | null> {
  const attempts = groups.flatMap((group, index) =>
    group.map(async (selector) => {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      return index;
    }),
  );
  if (attempts.length === 0) {
    return null;
  }
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

/**
 * Drives the pre-join page and returns the single `join_result` status.
 *
 * The order of `OUTCOMES` is the order of the protocol's status enum for the
 * ones that can race; sign-in is checked first because Meet renders the
 * account wall instead of the pre-join page entirely.
 */
export async function joinMeeting(
  page: Page,
  command: JoinCommand,
  progress: JoinProgress,
  timings: JoinTimings = DEFAULT_TIMINGS,
): Promise<JoinStatus> {
  progress.state('joining');
  progress.log('info', `navigating to ${command.url}`);
  await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: timings.pageReadyMs });

  const gate = await raceMarkers(
    page,
    [SIGNIN_MARKERS, BOT_BLOCKED_MARKERS, NAME_INPUT, JOIN_BUTTONS, IN_MEETING_MARKERS],
    timings.pageReadyMs,
  );
  if (gate === 0) {
    return 'signin_required';
  }
  if (gate === 1) {
    return 'bot_blocked';
  }
  if (gate === null) {
    return 'login_required';
  }

  await dismissDialogs(page, timings.probeMs);
  await setBotName(page, command.bot_name, timings.probeMs);
  await muteSelf(page, timings.probeMs);

  if (!(await clickFirst(page, JOIN_BUTTONS, timings.probeMs))) {
    progress.log('warn', 'no join button was present on the pre-join page');
    return 'login_required';
  }

  return awaitAdmission(page, progress, timings);
}

async function awaitAdmission(
  page: Page,
  progress: JoinProgress,
  timings: JoinTimings,
): Promise<JoinStatus> {
  const knocking = await raceMarkers(page, [IN_MEETING_MARKERS, KNOCKING_MARKERS], timings.probeMs);
  if (knocking === 1) {
    progress.state('knocking');
    progress.log('info', 'waiting for a host to admit the notetaker');
  }

  const outcome = await raceMarkers(
    page,
    [IN_MEETING_MARKERS, DENIED_MARKERS, SIGNIN_MARKERS, BOT_BLOCKED_MARKERS],
    timings.admitMs,
  );

  switch (outcome) {
    case 0:
      return 'admitted';
    case 1:
      return 'denied';
    case 2:
      return 'signin_required';
    case 3:
      return 'bot_blocked';
    default:
      return 'knock_timeout';
  }
}

async function dismissDialogs(page: Page, probeMs: number): Promise<void> {
  // Bounded: Meet stacks at most a couple of these, and an unbounded loop on a
  // re-rendering dialog would hang the join.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await clickFirst(page, DISMISS_BUTTONS, probeMs))) {
      return;
    }
  }
}

async function setBotName(page: Page, botName: string, probeMs: number): Promise<void> {
  for (const selector of NAME_INPUT) {
    const locator = page.locator(selector).first();
    try {
      await locator.fill(botName, { timeout: probeMs });
      return;
    } catch {
      // A signed-in account has no name field: Meet uses the profile name.
      continue;
    }
  }
}

async function muteSelf(page: Page, probeMs: number): Promise<void> {
  await clickFirst(page, MUTE_TOGGLES, probeMs);
  await clickFirst(page, CAMERA_TOGGLES, probeMs);
}

/** Posts the consent announcement into the meeting chat. */
export async function postAnnouncement(
  page: Page,
  message: string,
  probeMs: number,
): Promise<boolean> {
  if (!(await clickFirst(page, CHAT_TOGGLES, probeMs))) {
    return false;
  }
  for (const selector of CHAT_INPUT) {
    const locator = page.locator(selector).first();
    try {
      await locator.fill(message, { timeout: probeMs });
      if (await clickFirst(page, CHAT_SEND_BUTTONS, probeMs)) {
        return true;
      }
      await locator.press('Enter');
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Clicks "Leave call". Best effort — the caller closes the browser regardless. */
export async function leaveMeeting(page: Page, probeMs: number): Promise<boolean> {
  return clickFirst(page, LEAVE_BUTTONS, probeMs);
}
