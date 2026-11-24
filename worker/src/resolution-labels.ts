// ABOUTME: Reduces kind-1985 moderation/resolution labels to the distinct
// ABOUTME: targets they handled, each dated by its newest label.

import { pageByUntil } from '../../shared/relay-pager';
import { relayPageFetcher } from './relay-profile';
import { getAdminPubkey, type Nip86Env } from './nip86';

export interface LabelTarget {
  type: 'event' | 'pubkey';
  value: string;
  // Unix seconds of the newest label on this target: when a person last
  // resolved it, which the handled-before rule compares reports with (#324).
  at: number;
}

export interface ResolutionLabelEvent {
  id: string;
  // The signer. Present on every real relay event; read only to check it
  // against the worker's own key, never to attribute the label.
  pubkey?: string;
  created_at: number;
  tags: string[][];
}

export interface PagedLabelTargets {
  targets: LabelTarget[];
  truncated: boolean;
  oldestCovered: number | null;
}

export type LabelPageFetcher = (until: number | undefined) => Promise<ResolutionLabelEvent[]>;

// Sized against the client's budget, not the relay's comfort. The frontend caps
// the whole label read at RESOLUTION_READ_TIMEOUT_MS (8s), and queryRelay opens a
// fresh socket per page, so round trips -- not payload -- are what spend it.
// Measured against production 2026-09-14: a 500-event page costs ~1.07s end to
// end, while a single request returning all 2298 labels costs ~1.6s. At 500 the
// read needed five round trips (~5.4s typical, ~6.9s tail) and gained one every
// ~1.7 months, which crosses 8s within months; at 2000 it needs two (~2.5s) and
// gains one every ~6.7 months.
//
// That budget is the reason this matters: a read that times out does not degrade
// to partial history, it fails the source, and a failed resolution source blocks
// the queue (#221). Raising this is cheaper and more honest than widening the
// timeout, which would just let the queue hang longer before blocking.
//
// Relies on the relay treating `limit` as a maximum and returning what it has,
// which is the NIP-01 contract and what the 500 here already assumed. Verified
// on funnelcake: `limit 3000` returns all 2298. A relay that silently capped
// BELOW this would make a capped page look like a short one, which the pager
// reads as exhaustion.
export const LABEL_PAGE_SIZE = 2000;
export const LABEL_MAX_PAGES = 20;

// Walks the relay's resolution labels back through time with an `until` cursor
// until they run out, then projects the whole set down to distinct targets.
//
// Deliberately simpler than the pager in bulk-moderate.ts, which carries a
// saturated-second guard and a strict step-past. That machinery earns its keep
// there because bulk-moderate DELETES, so an event skipped by a stuck cursor is
// destroyed unreviewed. Here the read is projection-only: a label this never
// reaches means its target reads as pending, which is the queue's status quo and
// is disclosed by `truncated` rather than hidden. So a stuck cursor stops and
// reports instead of trying to subdivide the second.
//
// `truncated` is the same safety valve #221 installed: coverage is bounded, but
// a bounded read must never claim to be complete.
export async function pageResolutionLabels(
  fetchPage: LabelPageFetcher,
  signer: string,
  opts?: { pageSize?: number; maxPages?: number }
): Promise<PagedLabelTargets> {
  const { events, truncated, oldestCovered } = await pageByUntil(fetchPage, {
    pageSize: opts?.pageSize ?? LABEL_PAGE_SIZE,
    maxPages: opts?.maxPages ?? LABEL_MAX_PAGES,
  });
  // The shared pager de-duplicates by id. For labels that is redundant with
  // reduceLabelsToTargets, which keys by target; it is load-bearing for the
  // report reads that share the pager.
  return { targets: reduceLabelsToTargets(events, signer), truncated, oldestCovered };
}

export const SIGNER_UNAVAILABLE = 'Worker signing key unavailable: cannot verify resolution labels';

// The one relay read for resolution-label targets: kind 1985, tagged
// `moderation/resolution`. /api/resolution-label-targets (the client's label
// source) and the worker's needs-attention and resolved-history reads (via
// readResolutionKeys) all call this, so the reads that decide what a label
// resolved cannot drift apart. The legacy
// raw endpoint /api/resolution-labels queries the relay separately.
//
// Only labels signed by the worker's own key count (`signer`). Relay Manager
// publishes every resolution label itself, so a label from any other account is
// not a moderator's decision, and trusting it would let anyone who can publish
// a kind 1985 remove reports from the queue. A null signer means the key could
// not be resolved, so no label can be verified: that is a failed label source
// and throws like one (the routes answer 502 and the queue blocks, #221) rather
// than reading as "nothing is resolved". No relay query is made, since its
// result could not be used.
export async function readResolutionLabelTargets(
  relayUrl: string,
  signer: string | null,
  paging?: { pageSize?: number; maxPages?: number },
): Promise<PagedLabelTargets> {
  if (!signer) throw new Error(SIGNER_UNAVAILABLE);
  const pageSize = paging?.pageSize ?? LABEL_PAGE_SIZE;
  const fetchPage = relayPageFetcher<ResolutionLabelEvent>(
    relayUrl,
    { kinds: [1985], authors: [signer], '#L': ['moderation/resolution'] },
    pageSize,
  );
  return pageResolutionLabels(fetchPage, signer, { pageSize, maxPages: paging?.maxPages });
}

// A label may name an event, an author, or both, and both count independently:
// Reports.tsx added each without preferring one, so an event-scoped resolution
// also resolves its author. Stopping at the first match would quietly stop
// resolving that author side.
//
// Relay payloads are untrusted, so a tag without a value is dropped rather than
// becoming a target key of `event:undefined` that matches nothing.
//
// `at` is the newest label's created_at. It takes the maximum rather than the
// first label seen, so it does not lean on the relay's order. A label with no
// usable created_at dates at 0: it still names a handled target, but covers no
// report, since hiding one is the costly mistake.
//
// A label not signed by `signer` is skipped. The relay checks event signatures
// and the filter already asks for the signer's labels only; this re-checks that
// the relay honoured the `authors` filter, where the decision is made. It
// compares the pubkey field, it does not verify signatures. An empty or
// non-string signer would match an event with no pubkey, so it throws.
export function reduceLabelsToTargets(events: ResolutionLabelEvent[], signer: string): LabelTarget[] {
  if (typeof signer !== 'string' || signer.length === 0) throw new Error(SIGNER_UNAVAILABLE);
  const byKey = new Map<string, LabelTarget>();

  const add = (type: LabelTarget['type'], value: unknown, at: number) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const key = `${type}:${value}`;
    const target = byKey.get(key);
    if (!target) byKey.set(key, { type, value, at });
    else if (at > target.at) target.at = at;
  };

  for (const event of events) {
    if (event?.pubkey !== signer) continue;
    const tags = Array.isArray(event?.tags) ? event.tags : [];
    const at = Number.isFinite(event?.created_at) ? event.created_at : 0;
    add('event', tags.find((t) => t[0] === 'e')?.[1], at);
    add('pubkey', tags.find((t) => t[0] === 'p')?.[1], at);
  }

  return [...byKey.values()];
}

// The pubkey resolution labels must be signed by: the worker's own, derived
// from NOSTR_NSEC the way publishing derives it (handles a Secrets Store
// binding). Never throws; null is the answer the reads treat as a failed label
// source (see readResolutionLabelTargets).
//
// Rotating NOSTR_NSEC makes every existing resolution label stop counting: they
// are signed by the old key. A rotation therefore needs a re-label, or a
// deliberate allowlist of the old key, or handled reports reappear in the queue.
//
// The failure is logged without the secret or its error text, which can echo
// the value.
export async function resolveLabelSigner(env: Pick<Nip86Env, 'NOSTR_NSEC'>): Promise<string | null> {
  try {
    return await getAdminPubkey(env);
  } catch {
    console.error('[resolution-labels] could not resolve the worker signing key; trusting no resolution labels');
    return null;
  }
}
