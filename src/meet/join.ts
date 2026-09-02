/**
 * The Google Meet join choreography.
 *
 * Navigate, clear the pre-join dialogs, set the bot's display name, ask to
 * join, then wait for exactly one of the outcomes the protocol enumerates.
 * Every selector comes from `selectors.ts`; nothing here matches on markup
 * directly.
 */

import type { Locator, Page } from 'playwright';

import type { JoinCommand, JoinStatus, LogLevel, Phase } from '../protocol.js';
import {
  BOT_BLOCKED_MARKERS,
  CHAT_INPUT,
  CHAT_TOGGLES,
  DENIED_MARKERS,
  DISMISS_BUTTONS,
  IN_CALL_DIALOG_DISMISS,
  IN_MEETING_MARKERS,
  JOIN_BUTTONS,
  KNOCK_EXPIRED_MARKERS,
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

/** After "Ask to join", Meet takes a moment to show either the lobby notice or the call. */
const KNOCK_DETECT_MS = 5_000;
/** A dialog over the toolbar is cleared before the chat toggle is clicked. */
const DIALOG_MS = 500;
/** The chat toggle can render before it is clickable, right after admission. */
const CHAT_TOGGLE_MS = 4_000;
/** The panel opens asynchronously once the toggle is clicked. */
const CHAT_PANEL_MS = 3_000;
/** The composer renders disabled while chat connects after admission. */
const CHAT_INPUT_MS = 4_000;
/** The toggle is a toggle; each attempt re-checks the panel before clicking. */
const CHAT_OPEN_ATTEMPTS = 3;
/** Enter must land, and the composer must clear, within this bound each. */
const CHAT_SENT_MS = 2_000;
const SENT_POLL_MS = 200;
const SENT_POLLS = 10;
/** The diagnostic rides a `log` frame; keep it far below the control cap. */
export const DIGEST_MAX_CHARS = 1_500;

export type AnnouncementResult =
  { posted: true } | { posted: false; step: 'chat_toggle' | 'chat_input' | 'send'; digest: string };

/** What the page shows around the chat, gathered in one pass for the digest. */
export interface ChatSurface {
  toggle: string;
  buttons: string[];
  dialogs: string[];
  inputs: string[];
}

/** The visible match for one selector, in DOM order; hidden duplicates are skipped. */
function visibleOne(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}

/**
 * Waits ONCE for any candidate in the group to be visible, then returns the
 * first candidate in the group's own priority order that is. The wait is
 * shared, so a group that is absent costs one bound rather than one per
 * candidate — probing each in turn spent 34 s on a pre-join page that had
 * nothing to click. Candidates must be CSS selectors (a comma-joined list).
 */
export async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    await visibleOne(page, selectors.join(', ')).waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return null;
  }
  for (const selector of selectors) {
    if ((await visibleOne(page, selector).count()) > 0) {
      return selector;
    }
  }
  return null;
}

/** Clicks the first candidate that is present, and reports whether any was. */
export async function clickFirst(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const selector = await firstVisible(page, selectors, timeoutMs);
  if (selector === null) {
    // Meet renders a different subset of these controls on every variant of
    // the pre-join page; a missing one is expected, not an error.
    return false;
  }
  try {
    await visibleOne(page, selector).click({ timeout: timeoutMs });
    return true;
  } catch {
    // Visible but not clickable within the bound: obscured, disabled, or
    // still animating in. The caller decides what that means.
    return false;
  }
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

/** True when any candidate is visible right now; no waiting. */
async function anyVisibleNow(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if ((await visibleOne(page, selector).count()) > 0) {
      return true;
    }
  }
  return false;
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

  // A dismissable dialog counts as the page being ready: with no camera
  // permission Meet can raise "Do you want people to see you?" before it
  // renders the join button at all.
  const gate = await raceMarkers(
    page,
    [
      SIGNIN_MARKERS,
      BOT_BLOCKED_MARKERS,
      NAME_INPUT,
      JOIN_BUTTONS,
      IN_MEETING_MARKERS,
      DISMISS_BUTTONS,
    ],
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

  // The one control whose absence is NOT expected: wait for it against the
  // walls Meet can swap in, so a refusal classifies at once and a slow render
  // ("Getting ready…") is given the page budget rather than a click probe.
  const ready = await raceMarkers(
    page,
    [JOIN_BUTTONS, DENIED_MARKERS, SIGNIN_MARKERS, BOT_BLOCKED_MARKERS],
    timings.pageReadyMs,
  );
  if (ready !== 0 || !(await clickFirst(page, JOIN_BUTTONS, timings.probeMs))) {
    return refusal(page, progress);
  }

  return awaitAdmission(page, progress, timings);
}

/** The pre-join page ended without a join control: read what Meet put there instead. */
async function refusal(page: Page, progress: JoinProgress): Promise<JoinStatus> {
  const status = classifyRefusal({
    denied: await anyVisibleNow(page, DENIED_MARKERS),
    signin: await anyVisibleNow(page, SIGNIN_MARKERS),
    blocked: await anyVisibleNow(page, BOT_BLOCKED_MARKERS),
  });
  if (status === 'login_required') {
    progress.log('warn', 'no join button was present on the pre-join page');
  }
  return status;
}

/**
 * Maps what the PRE-JOIN page shows in place of a join button onto the
 * protocol's statuses. Nothing here can be a host's decision: no request has
 * been made yet, so Meet's "You can't join this video call" means the meeting
 * has not started, does not exist, or does not admit this account — which is
 * `bot_blocked` ("kept out"), never `denied` ("the host said no"). Reporting
 * any of it as `login_required` sent an operator to re-run sign-in for a
 * meeting that simply would not have the bot. A host's actual decline is
 * classified in `awaitAdmission`, after the knock.
 */
export function classifyRefusal(flags: {
  denied: boolean;
  signin: boolean;
  blocked: boolean;
}): JoinStatus {
  if (flags.signin) {
    return 'signin_required';
  }
  if (flags.blocked || flags.denied) {
    return 'bot_blocked';
  }
  return 'login_required';
}

async function awaitAdmission(
  page: Page,
  progress: JoinProgress,
  timings: JoinTimings,
): Promise<JoinStatus> {
  const knocking = await raceMarkers(page, [IN_MEETING_MARKERS, KNOCKING_MARKERS], KNOCK_DETECT_MS);
  if (knocking === 1) {
    progress.state('knocking');
    progress.log('info', 'waiting for a host to admit the notetaker');
  }
  if (knocking === null) {
    // Neither the call nor a known lobby notice: say what Meet shows instead,
    // so a changed lobby copy is a one-line selector fix, not a mystery.
    progress.log('warn', `lobby not recognised; page headings: ${await headings(page)}`);
  }

  const outcome = await raceMarkers(
    page,
    [
      IN_MEETING_MARKERS,
      KNOCK_EXPIRED_MARKERS,
      SIGNIN_MARKERS,
      BOT_BLOCKED_MARKERS,
      DENIED_MARKERS,
    ],
    timings.admitMs,
  );

  switch (outcome) {
    case 0:
      return 'admitted';
    case 1:
      return 'knock_timeout';
    case 2:
      return 'signin_required';
    case 3:
      return 'bot_blocked';
    case 4:
      return 'denied';
    default:
      return 'knock_timeout';
  }
}

/** Meet's own copy only (headings), bounded, for the lobby diagnostic. */
async function headings(page: Page): Promise<string> {
  try {
    const texts = await page.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, [role="heading"]')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((text) => text.length > 0)
        .slice(0, 6),
    );
    return texts.join(' | ').slice(0, 300);
  } catch (cause) {
    return `unavailable: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 120);
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
  const selector = await firstVisible(page, NAME_INPUT, probeMs);
  if (selector === null) {
    // A signed-in account has no name field: Meet uses the profile name.
    return;
  }
  try {
    await visibleOne(page, selector).fill(botName, { timeout: probeMs });
  } catch {
    // The field vanished between the wait and the fill; the join goes on
    // under the profile name, which is what a signed-in account shows anyway.
  }
}

/** The bot never speaks; it has no camera to turn off (no camera permission). */
async function muteSelf(page: Page, probeMs: number): Promise<void> {
  await clickFirst(page, MUTE_TOGGLES, probeMs);
}

/**
 * Posts the consent announcement into the meeting chat. Never throws: a
 * failure names the step that failed and carries a digest of what the page
 * showed instead, because a bare "could not post" has been undiagnosable.
 *
 * Bounded at `CHAT_OPEN_ATTEMPTS × (DIALOG_MS + CHAT_TOGGLE_MS + CHAT_PANEL_MS
 * + CHAT_INPUT_MS) + 2 × CHAT_SENT_MS` ≈ 39 s; a healthy panel posts in 1–3 s.
 * The audio tap and the roster are already streaming when this runs.
 */
export async function postAnnouncement(page: Page, message: string): Promise<AnnouncementResult> {
  const composer = await openComposer(page, message);
  if (!composer.ok) {
    return failed(page, composer.step);
  }
  if (await sent(composer.input)) {
    return { posted: true };
  }
  return failed(page, 'send');
}

type Composer = { ok: true; input: Locator } | { ok: false; step: 'chat_toggle' | 'chat_input' };

/**
 * Opens the chat panel and fills the composer. The chat control is a TOGGLE —
 * a click on an open panel closes it — so it is clicked only while no composer
 * is visible; a composer that is visible but still disabled (chat connecting
 * right after admission) is waited on, never toggled shut. The toggle can also
 * render before it is clickable, and a dialog can sit over the toolbar, so each
 * attempt clears a visible dialog first. Bounded attempts, never a spin.
 */
async function openComposer(page: Page, message: string): Promise<Composer> {
  let step: 'chat_toggle' | 'chat_input' = 'chat_toggle';
  for (let attempt = 0; attempt < CHAT_OPEN_ATTEMPTS; attempt += 1) {
    if (!(await anyVisibleNow(page, CHAT_INPUT))) {
      await clickFirst(page, IN_CALL_DIALOG_DISMISS, DIALOG_MS);
      await clickFirst(page, CHAT_TOGGLES, CHAT_TOGGLE_MS);
    }
    const selector = await firstVisible(page, CHAT_INPUT, CHAT_PANEL_MS);
    if (selector === null) {
      step = 'chat_toggle';
      continue;
    }
    const input = visibleOne(page, selector);
    try {
      await input.fill(message, { timeout: CHAT_INPUT_MS });
      return { ok: true, input };
    } catch {
      // Visible but not editable within the bound.
      step = 'chat_input';
    }
  }
  return { ok: false, step };
}

/** Enter sends in Meet; "posted" is claimed only once the composer has cleared. */
async function sent(input: Locator): Promise<boolean> {
  try {
    await input.press('Enter', { timeout: CHAT_SENT_MS });
  } catch {
    return false;
  }
  for (let poll = 0; poll < SENT_POLLS; poll += 1) {
    if ((await input.inputValue({ timeout: CHAT_SENT_MS }).catch(() => null)) === '') {
      return true;
    }
    await input.page().waitForTimeout(SENT_POLL_MS);
  }
  return false;
}

async function failed(
  page: Page,
  step: 'chat_toggle' | 'chat_input' | 'send',
): Promise<AnnouncementResult> {
  return { posted: false, step, digest: await chatDigest(page) };
}

async function chatDigest(page: Page): Promise<string> {
  try {
    const surface = await page.evaluate(collectChatSurface, { toggles: [...CHAT_TOGGLES] });
    return formatChatDigest(surface, DIGEST_MAX_CHARS);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `digest unavailable: ${reason}`.slice(0, DIGEST_MAX_CHARS);
  }
}

/** One line, bounded, in a fixed field order so a reader can diff two failures. */
export function formatChatDigest(surface: ChatSurface, maxChars: number): string {
  const field = (label: string, items: readonly string[]): string =>
    `${label}=[${items.join(' | ')}]`;
  const text = [
    `toggle=${surface.toggle}`,
    field('buttons', surface.buttons),
    field('dialogs', surface.dialogs),
    field('inputs', surface.inputs),
  ].join(' ');
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Runs inside Chromium. Must not close over module scope — Playwright
 * serializes it. Everything is capped at the source so the digest stays small
 * even on a page with hundreds of controls, and it carries UI chrome only —
 * control labels and dialog shapes, never message text or anything a
 * participant typed, because the digest lands in the daemon log ungated.
 */
function collectChatSurface(config: { toggles: readonly string[] }): ChatSurface {
  const shown = (element: Element): boolean => element.getClientRects().length > 0;
  const label = (element: Element, max: number): string =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const toggleElement = [...document.querySelectorAll(config.toggles.join(', '))].find(shown);
  const toggle =
    toggleElement === undefined
      ? 'absent'
      : `pressed=${toggleElement.getAttribute('aria-pressed') ?? '-'} expanded=${toggleElement.getAttribute('aria-expanded') ?? '-'} disabled=${String((toggleElement as HTMLButtonElement).disabled === true)}`;
  const buttons = [...document.querySelectorAll('button[aria-label]')]
    .filter(shown)
    .map((element) => label(element, 40))
    .slice(0, 30);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .filter(shown)
    .map((dialog) => {
      const controls = [...dialog.querySelectorAll('button')]
        .map((button) => label(button, 24))
        .slice(0, 6);
      return `${(dialog.getAttribute('aria-label') ?? '').slice(0, 60)} buttons=(${controls.join(', ')})`;
    })
    .slice(0, 3);
  const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .map((element) => {
      const disabled =
        (element as HTMLTextAreaElement).disabled === true ||
        element.getAttribute('aria-disabled') === 'true';
      return `${element.tagName.toLowerCase()} aria=${(element.getAttribute('aria-label') ?? '').slice(0, 40)} placeholder=${(element.getAttribute('placeholder') ?? '').slice(0, 40)} visible=${String(shown(element))} disabled=${String(disabled)}`;
    })
    .slice(0, 5);
  return { toggle, buttons, dialogs, inputs };
}

/** Clicks "Leave call". Best effort — the caller closes the browser regardless. */
export async function leaveMeeting(page: Page, probeMs: number): Promise<boolean> {
  return clickFirst(page, LEAVE_BUTTONS, probeMs);
}
