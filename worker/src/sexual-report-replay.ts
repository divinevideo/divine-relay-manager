import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { queryRelay } from './relay-profile';
import { adultSexualCategory } from './sexual-quarantine';
import type { ReportEvent } from './ReportWatcher';
import { CSAM_CATEGORIES } from '../../shared/report-classification';
import { getReportedList } from '../../shared/list-report';

const PAGE = 100;
const CHILD_CATEGORIES = new Set(CSAM_CATEGORIES.map(c => c.toLowerCase()));

export function reportCategory(tags: string[][]): string {
  const candidates = [...tags.filter(t => t[0] === 'report').map(t => t[1]),
    ...tags.filter(t => t[0] === 'l' && t[2] === 'social.nos.ontology').map(t => t[1]),
    ...tags.filter(t => t[0] === 'l' && t[2] === 'MOD').map(t => t[1]),
    ...tags.filter(t => t[0] === 'e' || t[0] === 'p').map(t => t[2])];
  // An explicit child-safety allegation keeps its dedicated owner even when a
  // report also carries an adult-sexual category. No new immediate categories.
  return candidates.find(c => c && CHILD_CATEGORIES.has(c.toLowerCase())) || candidates.find(Boolean) || 'unknown';
}

export async function replayAdultReports(
  storage: DurableObjectStorage,
  relayUrl: string,
  ingest: (event: ReportEvent, category: string, eventId: string) => Promise<void>,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  let window = await storage.get<{ from: number; through: number; until: number }>('sexual-replay-window');
  if (!window) {
    const through = await storage.get<number>('sexual-replay-through') ?? now - 86400;
    window = { from: Math.max(0, through - 60), through: now, until: now };
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
    const target = event.tags.find(t => t[0] === 'e')?.[1];
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
