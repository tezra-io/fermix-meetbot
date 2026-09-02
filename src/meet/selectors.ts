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
  // With no camera permission Meet asks "Do you want people to see you in the
  // meeting?" and hides the join button until this is answered.
  '[role="dialog"] button:has-text("Continue without camera")',
] as const;

/**
 * Meet renders the device controls as real `<button>`s (pre-join and
 * in-call alike). A `div[role="button"]` form never matched, which is how the
 * bot once joined with a live microphone. There is no camera toggle: the bot
 * asks for no camera permission, so Meet has nothing to turn off.
 */
export const MUTE_TOGGLES = [
  'button[aria-label*="Turn off microphone"]',
  'button[data-is-muted="false"][aria-label*="microphone"]',
] as const;

export const JOIN_BUTTONS = [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'div[role="button"]:has-text("Ask to join")',
  'div[role="button"]:has-text("Join now")',
] as const;

/**
 * Present once we are inside the meeting, and only then. `[data-meeting-code]`
 * used to be listed here, but Meet carries it on the pre-join page as well, so
 * it read the lobby as the call and swallowed the knocking state.
 */
export const IN_MEETING_MARKERS = [
  'button[aria-label="Leave call"]',
  'button[aria-label*="Leave call"]',
] as const;

/** The waiting-room state: asked to join, nobody has answered yet. */
export const KNOCKING_MARKERS = [
  'text=/Asking to (join|be let in)/i',
  // Regex so the copy's typographic apostrophe cannot defeat a literal match.
  'text=/You.ll join the call when someone lets you in/i',
] as const;

/**
 * Someone said no. The heading "You can't join this video call" tops EVERY
 * refusal Meet renders, so on the pre-join page it is read together with the
 * subtexts below (`classifyRefusal`); after a knock only a decline or an expiry
 * can produce it, and it stays the lowest-priority "denied" signal there.
 */
export const DENIED_MARKERS = [
  'text=Your request to join was denied',
  'text=/denied your request to join/i',
  "text=You can't join this video call",
] as const;

/** Nobody answered the knock before Meet gave up on it. */
export const KNOCK_EXPIRED_MARKERS = ['text=No one responded to your request to join'] as const;

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

/** Meet's post-call screen reads "You left the meeting" with a Rejoin control. */
export const MEETING_CLOSED_MARKERS = [
  'text=You left the meeting',
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

/**
 * Post-admission dialogs that can sit over the toolbar. Scoped to a dialog on
 * purpose: an unscoped "Close" is the chat panel's own close control.
 */
export const IN_CALL_DIALOG_DISMISS = [
  '[role="dialog"] button:has-text("Got it")',
  '[role="dialog"] button:has-text("Dismiss")',
  '[role="dialog"] button:has-text("OK")',
  '[role="dialog"] button[aria-label="Close"]',
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

/**
 * The display name is the tile's visible `span.notranslate` (observed live).
 * `span[jsname]` matched the icon glyph spans ("frame_person") and the old
 * class never matched, so rows fell through to the tile's whole text.
 */
export const ROSTER_NAME_NODES = ['span.notranslate', '[data-self-name]'] as const;

/**
 * A speaking participant is flagged on their tile, not in the roster list.
 * Meet has no `data-is-speaking`; the tile's audio indicator
 * (`div[jsname="QgSmzd"]`) carries the class `sxlEM` for exactly the span of a
 * speech burst (observed live against a looped speech/silence recording), with
 * the level classes cycling beneath it. `:has()` keeps the tile as the match,
 * so its `data-participant-id` is the speaker.
 */
export const SPEAKING_MARKERS = ['[data-participant-id]:has(div[jsname="QgSmzd"].sxlEM)'] as const;

/** Every group, keyed for the drift test that asserts none of them is empty. */
export const SELECTOR_GROUPS = {
  NAME_INPUT,
  DISMISS_BUTTONS,
  MUTE_TOGGLES,
  JOIN_BUTTONS,
  IN_MEETING_MARKERS,
  KNOCKING_MARKERS,
  DENIED_MARKERS,
  KNOCK_EXPIRED_MARKERS,
  SIGNIN_MARKERS,
  BOT_BLOCKED_MARKERS,
  MEETING_CLOSED_MARKERS,
  REMOVED_MARKERS,
  LEAVE_BUTTONS,
  CHAT_TOGGLES,
  CHAT_INPUT,
  IN_CALL_DIALOG_DISMISS,
  PEOPLE_TOGGLES,
  ROSTER_ITEMS,
  ROSTER_ID_ATTRIBUTES,
  ROSTER_NAME_NODES,
  SPEAKING_MARKERS,
} as const satisfies Record<string, readonly string[]>;
