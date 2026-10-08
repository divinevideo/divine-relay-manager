// Recognizes a report filed against a Divine list (a NIP-51 set) from the
// report's own tags, without fetching the reported event.
//
// Divine clients add an `a` tag naming the list's coordinate,
// `<kind>:<author pubkey>:<d tag>` (NIP-01), alongside the NIP-56 `e` and `p`
// tags. NIP-56 does not define `a` on reports; it is a Divine convention, so
// reports from other clients never carry it and are not recognized here.

/** The NIP-51 set kinds Divine lists use. */
export const LIST_KIND = {
  /** Follow set: a people list. */
  people: 30000,
  /** Curation set of videos: a video list. */
  videos: 30005,
} as const;

export type ListKind = (typeof LIST_KIND)[keyof typeof LIST_KIND];

export interface ReportedList {
  kind: ListKind;
  pubkey: string;
  d: string;
}

const LIST_KINDS: ReadonlySet<number> = new Set(Object.values(LIST_KIND));
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
// A kind is a plain decimal integer. Number() alone also accepts `3e4`,
// `0x7535`, ` 30005` and `030005`, none of which name a kind in a coordinate.
const DECIMAL_KIND = /^(0|[1-9]\d*)$/;

/** Whether an event kind is one of the Divine list kinds. */
export function isListKind(kind: number): kind is ListKind {
  return LIST_KINDS.has(kind);
}

/**
 * The list a report names in its `a` tag, or `null` when the report names no
 * list. Only the first two colons separate fields; a `d` tag may contain more.
 */
export function getReportedList(report: { tags: string[][] }): ReportedList | null {
  for (const tag of report.tags) {
    if (tag[0] !== 'a' || typeof tag[1] !== 'string') continue;
    const first = tag[1].indexOf(':');
    const second = first < 0 ? -1 : tag[1].indexOf(':', first + 1);
    if (second < 0) continue;
    const kindText = tag[1].slice(0, first);
    const kind = Number(kindText);
    const pubkey = tag[1].slice(first + 1, second);
    if (!DECIMAL_KIND.test(kindText) || !isListKind(kind) || !HEX_PUBKEY.test(pubkey)) continue;
    return { kind, pubkey, d: tag[1].slice(second + 1) };
  }
  return null;
}
