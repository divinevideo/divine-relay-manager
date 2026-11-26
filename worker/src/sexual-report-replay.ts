import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { queryRelay } from './relay-profile';
import { adultSexualCategory } from './sexual-quarantine';
import type { ReportEvent } from './ReportWatcher';
import { CSAM_CATEGORIES } from '../../shared/report-classification';
import { getReportedList } from '../../shared/list-report';
import { canonicalHex64 } from '../../shared/hex-id';

const PAGE = 100;
// Each replay window starts this far before the last one ended.
const REPLAY_OVERLAP_SECONDS = 60;
// With no cursor yet, the first replay reads this far back.
const FIRST_REPLAY_LOOKBACK_SECONDS = 86400;
const CHILD_CATEGORIES = new Map(CSAM_CATEGORIES.map(c => [c.toLowerCase(), c]));

export function reportCategory(tags: string[][]): string {
  const candidates = [...tags.filter(t => t[0] === 'report').map(t => t[1]),
    ...tags.filter(t => t[0] === 'l' && t[2] === 'social.nos.ontology').map(t => t[1]),
    ...tags.filter(t => t[0] === 'l' && t[2] === 'MOD').map(t => t[1]),
    ...tags.filter(t => t[0] === 'e').map(t => t[2]),
    ...tags.filter(t => t[0] === 'p').map(t => t[2])];
  // An explicit child-safety allegation keeps its dedicated owner even when a
  // report also carries an adult-sexual category. No new immediate categories.
  const child = candidates.find(c => c && CHILD_CATEGORIES.has(c.toLowerCase()));
  return (child && CHILD_CATEGORIES.get(child.toLowerCase())) || candidates.find(Boolean) || 'unknown';
}

/**
 * The earliest report created_at the next replay run can read: its open
 * window's start, else the overlap before its last cursor, else the first-run
 * lookback. Storage reads only. Catch-up keeps stopped periods from here on,
 * so the replay can still skip them.
 */
export async function replayReachFloor(
  storage: { get<T>(key: string): Promise<T | undefined> },
  now: number,
): Promise<number> {
  const window = await storage.get<{ from: number }>('sexual-replay-window');
  if (window) return window.from;
  const through = await storage.get<number>('sexual-replay-through');
  return Math.max(0, (through ?? now - FIRST_REPLAY_LOOKBACK_SECONDS) - REPLAY_OVERLAP_SECONDS);
}

export async function replayAdultReports(
  storage: DurableObjectStorage,
  relayUrl: string,
  ingest: (event: ReportEvent, category: string, eventId: string) => Promise<void>,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  let window = await storage.get<{ from: number; through: number; until: number }>('sexual-replay-window');
  if (!window) {
    const through = await storage.get<number>('sexual-replay-through') ?? now - FIRST_REPLAY_LOOKBACK_SECONDS;
    window = { from: Math.max(0, through - REPLAY_OVERLAP_SECONDS), through: now, until: now };
    await storage.put('sexual-replay-window', window);
  }
  const result = await queryRelay({ kinds: [1984], since: window.from, until: window.until, limit: PAGE }, relayUrl);
  if (!result.success) throw new Error('Report replay read incomplete');
  const events = result.events || [];
  const seen = new Set<string>();
  let oldest = window.until;
  for (const raw of events) {
    const event = JSON.parse(JSON.stringify(raw)) as NostrEvent;
    if (seen.has(event.id)) continue;
    if (!verifyEvent(event) || event.kind !== 1984 || event.created_at < window.from || event.created_at > window.until) {
      throw new Error('Report replay returned an invalid event');
    }
    seen.add(event.id);
    oldest = Math.min(oldest, event.created_at);
    const category = reportCategory(event.tags);
    // Lowercased as the live path does (#315); a value that is not a
    // 64-character hex id has nothing to hide.
    const target = canonicalHex64(event.tags.find(t => t[0] === 'e')?.[1]);
    // List reports never enter the quarantine. The live path already logged
    // them for human review; replaying them would repeat that log and alert.
    if (adultSexualCategory(category) && target && !getReportedList(event)) {
      await ingest(event as ReportEvent, category, target);
    }
  }
  if (events.length < PAGE) {
    await storage.put('sexual-replay-through', window.through);
    await storage.delete('sexual-replay-window');
  } else {
    if (oldest === window.until) throw new Error('Report replay page saturated; operator backfill required');
    await storage.put('sexual-replay-window', { ...window, until: oldest });
  }
}
