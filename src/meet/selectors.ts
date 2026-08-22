/**
 * Every Google Meet DOM selector, in one file.
 *
 * Meet's markup churns without notice and its class names are generated, so
 * each entry is an ordered list of candidates and the join logic takes the
 * first one that matches. When Meet changes, this file is the whole diff —
 * nothing outside it may hard-code a selector.
 *
 * Ordering matters: stable, semantic hooks (aria labels, jsname, data
 * attributes) come first, and text-matching fallbacks last.
 */

export const NAME_INPUT = [
  'input[aria-label="Your name"]',
  'input[placeholder="Your name"]',
  'input[jsname="YPqjbf"]',
] as const;

export const DISMISS_BUTTONS = [
  'button[aria-label="Close"]',
  'button[aria-label="Dismiss"]',
  'button[aria-label="Got it"]',
  '[role="dialog"] button:has-text("Got it")',
  '[role="dialog"] button:has-text("Dismiss")',
  '[role="dialog"] button:has-text("Continue without microphone")',
] as const;

export const MUTE_TOGGLES = [
  'div[role="button"][aria-label*="Turn off microphone"]',
  'div[role="button"][data-is-muted="false"][aria-label*="microphone"]',
] as const;

export const CAMERA_TOGGLES = [
  'div[role="button"][aria-label*="Turn off camera"]',
  'div[role="button"][data-is-muted="false"][aria-label*="camera"]',
] as const;

export const JOIN_BUTTONS = [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'div[role="button"]:has-text("Ask to join")',
  'div[role="button"]:has-text("Join now")',
] as const;

/** Present once we are inside the meeting. */
export const IN_MEETING_MARKERS = [
  'button[aria-label="Leave call"]',
  'button[aria-label*="Leave call"]',
  '[data-meeting-code]',
] as const;

/** The waiting-room state: asked to join, nobody has answered yet. */
export const KNOCKING_MARKERS = [
  'text=Asking to be let in',
  "text=You'll join the call when someone lets you in",
] as const;

export const DENIED_MARKERS = [
  "text=You can't join this video call",
  'text=Your request to join was denied',
  'text=No one responded to your request to join',
] as const;

/** Meet wants a Google account before it will let anyone in. */
export const SIGNIN_MARKERS = [
  'text=Sign in to join this video call',
  'input[type="email"][name="identifier"]',
  'text=You must sign in to join this call',
  // A signed-out profile lands on Google's account chooser, not the pre-join
  // page; without these the join matched no marker and gave up silently as
  // login_required instead of the honest signin_required.
  'text=Choose an account',
  'text=Use another account',
] as const;

/** Meet refused the account itself (policy, org restriction, bot detection). */
export const BOT_BLOCKED_MARKERS = [
  "text=You can't create a meeting yourself",
  'text=Your account is not allowed to join',
  'text=This meeting is restricted',
] as const;

export const MEETING_CLOSED_MARKERS = [
  "text=You've left the meeting",
  'text=The call ended',
  'text=This meeting has ended',
] as const;

export const REMOVED_MARKERS = ['text=You were removed from the meeting'] as const;

export const LEAVE_BUTTONS = [
  'button[aria-label="Leave call"]',
  'button[aria-label*="Leave call"]',
  'div[role="button"][aria-label*="Leave call"]',
] as const;

export const CHAT_TOGGLES = [
  'button[aria-label="Chat with everyone"]',
  'button[aria-label*="Chat with everyone"]',
  'button[aria-label*="Open chat"]',
] as const;

export const CHAT_INPUT = [
  'textarea[aria-label="Send a message"]',
  'textarea[aria-label*="Send a message"]',
  'textarea[placeholder*="Send a message"]',
] as const;

export const CHAT_SEND_BUTTONS = [
  'button[aria-label="Send a message"]',
  'button[aria-label*="Send message"]',
] as const;

export const PEOPLE_TOGGLES = [
  'button[aria-label="Show everyone"]',
  'button[aria-label*="People"]',
] as const;

/**
 * Roster scraping. `ROSTER_ITEMS` selects one row per participant;
 * `ROSTER_ID_ATTRIBUTES` and `ROSTER_NAME_NODES` are read relative to a row.
 */
export const ROSTER_ITEMS = [
  '[role="list"] [role="listitem"][data-participant-id]',
  '[data-participant-id][role="listitem"]',
  'div[data-participant-id]',
] as const;

export const ROSTER_ID_ATTRIBUTES = [
  'data-participant-id',
  'data-requested-participant-id',
] as const;

export const ROSTER_NAME_NODES = ['[data-self-name]', '.zWGUib', 'span[jsname]'] as const;

/** A speaking participant is flagged on their tile, not in the roster list. */
export const SPEAKING_MARKERS = [
  '[data-participant-id][data-is-speaking="true"]',
  '[data-participant-id] [class*="speaking"]',
] as const;

/** Every group, keyed for the drift test that asserts none of them is empty. */
export const SELECTOR_GROUPS = {
  NAME_INPUT,
  DISMISS_BUTTONS,
  MUTE_TOGGLES,
  CAMERA_TOGGLES,
  JOIN_BUTTONS,
  IN_MEETING_MARKERS,
  KNOCKING_MARKERS,
  DENIED_MARKERS,
  SIGNIN_MARKERS,
  BOT_BLOCKED_MARKERS,
  MEETING_CLOSED_MARKERS,
  REMOVED_MARKERS,
  LEAVE_BUTTONS,
  CHAT_TOGGLES,
  CHAT_INPUT,
  CHAT_SEND_BUTTONS,
  PEOPLE_TOGGLES,
  ROSTER_ITEMS,
  ROSTER_ID_ATTRIBUTES,
  ROSTER_NAME_NODES,
  SPEAKING_MARKERS,
} as const satisfies Record<string, readonly string[]>;
