/**
 * Roster and active-speaker scraping.
 *
 * The DOM half is one `page.evaluate` that returns plain data; everything that
 * decides what the daemon sees — identity, capping, change detection — is pure
 * and unit-tested here, because a roster that churns ids reattributes every
 * line of the transcript.
 */

import { createHash } from 'node:crypto';

import { ROSTER_MAX, type Participant } from '../protocol.js';
import {
  ROSTER_ID_ATTRIBUTES,
  ROSTER_ITEMS,
  ROSTER_NAME_NODES,
  SPEAKING_MARKERS,
} from './selectors.js';

/** What one `page.evaluate` pass returns. */
export interface RosterScrape {
  participants: RawParticipant[];
  speakingId: string | null;
}

export interface RawParticipant {
  id: string | null;
  name: string | null;
}

/**
 * A stable participant id.
 *
 * Meet's own `data-participant-id` is preferred; when a row has none we hash
 * the display name so the same person keeps the same id across snapshots
 * within a meeting. Ids are opaque to the daemon — only their stability
 * matters.
 */
export function stableId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new RangeError('cannot derive a participant id from an empty string');
  }
  return `p_${createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 8)}`;
}

/**
 * Turns a raw scrape into the wire shape: named entries only, one row per id,
 * capped at the daemon's limit, in a deterministic order.
 */
export function normalizeParticipants(rows: readonly RawParticipant[]): Participant[] {
  const seen = new Map<string, Participant>();

  for (const row of rows) {
    const name = (row.name ?? '').trim();
    if (name === '') {
      continue;
    }
    const id = row.id !== null && row.id.trim() !== '' ? stableId(row.id) : stableId(name);
    if (!seen.has(id)) {
      seen.set(id, { id, name });
    }
  }

  return [...seen.values()].slice(0, ROSTER_MAX);
}

/** True when the membership changed; a `roster` frame is a full snapshot per change. */
export function rosterChanged(
  previous: readonly Participant[] | null,
  next: readonly Participant[],
): boolean {
  if (previous === null || previous.length !== next.length) {
    return true;
  }
  return previous.some((entry, index) => {
    const other = next[index];
    return other === undefined || other.id !== entry.id || other.name !== entry.name;
  });
}

/** Maps a raw speaking id onto the normalized roster, or null when unknown. */
export function resolveSpeaker(
  speakingId: string | null,
  participants: readonly Participant[],
): string | null {
  if (speakingId === null || speakingId.trim() === '') {
    return null;
  }
  const id = stableId(speakingId);
  return participants.some((participant) => participant.id === id) ? id : null;
}

/**
 * The in-page scraper. Serialized into Chromium by `page.evaluate`, so it may
 * not close over anything outside its argument.
 */
export function scrapeRoster(config: {
  itemSelectors: readonly string[];
  idAttributes: readonly string[];
  nameSelectors: readonly string[];
  speakingSelectors: readonly string[];
}): RosterScrape {
  const rows: RawParticipant[] = [];
  const seenNodes = new Set<Element>();

  for (const selector of config.itemSelectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (seenNodes.has(node)) {
        continue;
      }
      seenNodes.add(node);

      let id: string | null = null;
      for (const attribute of config.idAttributes) {
        id = node.getAttribute(attribute);
        if (id !== null && id !== '') {
          break;
        }
      }

      let name: string | null = null;
      for (const nameSelector of config.nameSelectors) {
        const child = node.querySelector(nameSelector);
        if (child !== null && (child.textContent ?? '').trim() !== '') {
          name = child.textContent;
          break;
        }
      }
      if (name === null) {
        name = node.getAttribute('aria-label') ?? node.textContent;
      }

      rows.push({ id, name });
    }
    if (rows.length > 0) {
      break;
    }
  }

  let speakingId: string | null = null;
  for (const selector of config.speakingSelectors) {
    const node = document.querySelector(selector);
    if (node !== null) {
      speakingId = node.getAttribute('data-participant-id') ?? null;
      if (speakingId !== null) {
        break;
      }
    }
  }

  return { participants: rows, speakingId };
}

/** The argument `scrapeRoster` is invoked with. Keeps selectors in one file. */
export const SCRAPE_CONFIG = {
  itemSelectors: ROSTER_ITEMS,
  idAttributes: ROSTER_ID_ATTRIBUTES,
  nameSelectors: ROSTER_NAME_NODES,
  speakingSelectors: SPEAKING_MARKERS,
} as const;
