# NIP-22 comment context on moderation surfaces (issue #164)

Date: 2026-07-10
Branch: `feat/comment-context` (PR #165)
Closes: issue #164

## Motivation

Divine comments are NIP-22 kind-1111 events. The moderation surfaces load and
label those rows now (issues #156/#157/#159), but the context around a comment is
still thin in two independent spots, and a real T&S spam report made both gaps
visible:

- From a report, a moderator cannot tell whether an account sprayed one comment
  across many videos or held a single conversation.
- A video-level report does not list the comments left on that video at all.

Issue #164 asks for two independently useful improvements. This spec covers both
in one PR (the scope decision on #164), finishing the work already started on the
branch.

## Current state on the branch

Two commits are already in place:

- `buildThreadReplyFilters()` (`src/lib/threadFilters.ts`), wired into `useThread`,
  builds NIP-10 kind-1 reply filters plus NIP-22 kind-1111 comment filters scoped
  by root `E` (event id) and, for addressable videos (34235/34236), `A` (address
  coordinate). Unit-tested.
- `CommentsSection` in `ThreadContext` renders the comments on the reported event
  newest-first, flags the reported user's own rows with a "By reported user"
  badge, and shows a count. `ReportDetail` passes the data through.
- `commentActivity.ts` (`getCommentTarget`, `summarizeCommentActivity`) provides
  the roll-up logic. Unit-tested, but not yet wired into any component.

So the report-page half of B is done. What remains is the "Full Thread" modal for
B, and all of A.

## Scope

### B. Reported-content context: `ThreadModal` NIP-22 support

The "Full Thread" modal (`ThreadModal`) still fetches `kinds:[1]` by a NIP-10 root
e-tag and nests replies via lowercase `e` reply-markers. Addressable video roots
have no `e root` tag, so their threads do not build. Changes:

1. Query: replace the hand-rolled `kinds:[1]` query with the existing
   `buildThreadReplyFilters(rootEvent, limit)` so kind-1111 comments load.
2. Root-finding: derive the root from the NIP-10 `e root` tag when present, else
   the event itself; for addressable roots also compute the `A` coordinate so
   comments scoped by address attach.
3. `buildThreadTree`: extend nesting so a kind-1111 whose immediate parent
   (lowercase `e` / `a`) matches a node attaches there; comments with no in-set
   parent hang under root.

`buildThreadTree` is a pure function and the trickiest correctness piece. It is
tested directly: NIP-22 nesting, mixed NIP-10 + NIP-22 threads, and an
addressable root.

### A. Recent-content context

On the reported user's recent content (`UserProfileCard`, `BannedUserCard`, and
kind-1111 rows in the Events list), answer "what has this account been doing, and
where."

#### A1. Batched parent-title resolution: `useEventTitles` hook (new)

- Input: the distinct comment targets from `getCommentTarget` (`E` event ids and
  `A` address coordinates).
- One batched `nostr.query`: event ids via `{ ids }`, address coordinates via a
  per-coordinate `{ kinds, authors, '#d' }` filter.
- Per target returns `{ title, encoded, rootKind }`. Title comes from the video
  `title` tag, else a content snippet, degrading to the short id / coordinate when
  the target is not found.
- `staleTime` so resolutions survive report navigation.
- The pure pieces (target grouping, title extraction, encoding) are unit-tested.
  The hook wrapper stays thin.

#### A2. Per-row "on \<parent\>" link: `CommentParentLink` (new shared component)

- One shared component consumed by every surface that renders a 1111 row, so the
  three cards do not drift. (Decision: shared component + shared hook over inline
  per-card copies. Inline duplication is already tracked as a smell in issue
  #162.)
- Renders `on <resolved title>` linking to `/events?event=<nevent|naddr>`
  (internal), degrading to coordinate text but still linkable.

#### A3. Per-card roll-up spray signal

- `summarizeCommentActivity(recentPosts)` on `UserProfileCard` and
  `BannedUserCard`.
- Renders instantly from tags, no network: "8 comments across 7 videos" (spray)
  vs "8 comments on 1 video" (conversation). When the same comment text hit
  multiple targets (`repeatedAcrossTargets >= 2`), it flags that explicitly.
- Noun is driven off the root-kind `K` tag (offline): "videos" when every
  comment's root kind is a video kind, else the generic "posts" (simplified in
  implementation from the three-way videos/posts/mixed split sketched here —
  "posts" reads fine for mixed sets and avoids a third branch).

#### A4. Events-list rows and internal-navigation plumbing

- The same `CommentParentLink` on kind-1111 rows in `EventsList`.
- Internal navigation: `EventsList` reads a new `?event=<encoded>` param
  (mirroring its existing `?pubkey=` param) and drives its direct-event lookup.
- Extend the direct-event lookup to resolve address coordinates: an naddr /
  address ref queries `{ kinds, authors, '#d' }` instead of `{ ids }`, keeping the
  existing `getbannedevent` RPC fallback.

## Key decision: internal event view for the parent link

The per-row parent link routes to the internal Events tab rather than the public
`divine.video` event page. Rationale:

- `EventsList`'s direct-event lookup already falls back to the `getbannedevent`
  RPC, so it can display a removed or banned parent. That is exactly the content a
  moderator most needs to inspect, and the public page would 404 on it.
- Cross-tab navigation by URL param already exists (`?pubkey=`), and the in-tool
  event viewer (`EventDetail`) already exists. We route to them rather than
  building anything new.
- Cost, accepted: the existing lookup is id-only. Divine's primary content is
  addressable video, so many parents are `A` coordinates. Extending the lookup to
  resolve address coordinates (naddr) is treated as first-class work, not a
  footnote.

### Contract note (narrowed in review)

Banned/removed parent retrieval is guaranteed for **event-id targets only**. The
address (naddr) lookup queries the live relay and degrades to a labeled
not-found state: `getbannedevent` takes an event id and the relay has no
by-coordinate banned lookup, so no in-repo fallback exists for A-only targets.
This is the operative path in practice — `getCommentTarget` prefers the `E`
root tag, both Divine clients always write one (mobile unconditionally, web for
addressable roots too), and a production sample found 257/257 comments carry
`E`, zero A-only. A relay-side by-coordinate banned lookup goes to a
funnelcake follow-up issue to close the residual gap for strict-NIP-22
clients (filed alongside this PR's review round).

## Testing

- `buildThreadTree` NIP-22 nesting (critical, pure): NIP-22 nesting, mixed
  NIP-10 + NIP-22, addressable root.
- `useEventTitles` pure pieces: title extraction, degrade-to-id/coordinate,
  address-vs-id grouping and encoding.
- `EventsList` naddr direct-lookup branch.
- Roll-up line and `CommentParentLink` render tests on the cards.
- Already covered: `commentActivity`, `buildThreadReplyFilters`.

## File footprint

New: `src/hooks/useEventTitles.ts`, `src/components/CommentParentLink.tsx`, plus
tests. Edit: `ThreadModal.tsx`, `UserProfileCard.tsx`, `BannedUserCard.tsx`,
`EventsList.tsx`, and a small display helper in `commentActivity.ts`. Roughly six
source files plus tests. This is a large PR, acknowledged when choosing the
all-in-one scope for issue #164.

## Out of scope

- The public `divine.video` event page showing a comment's parent (divine-web,
  separate repo).
- Archival of already-scrubbed content (separate discussion).
