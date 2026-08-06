# Reports queue: resolution-state completeness (issue #221)

Date: 2026-08-05
Issue: #221
Branch: `fix/221-resolution-state-completeness`
Related: PR #186 (issue #185), which this supersedes in one place (see "Relationship to PR #186")

## Problem

The reports queue hides a target when it appears in `resolvedTargets`
(`src/components/Reports.tsx`), a set built from four independent polled queries:
resolution labels, NIP-86 banned pubkeys, NIP-86 banned events, and D1 moderation
decisions. Every one uses `retry: false` and every one contributes nothing when it is
missing, empty, or errored.

`resolvedTargets` is subtractive. It hides work already handled. A source that fails
therefore does not make the queue smaller and safer, it makes it bigger and wrong.
Nothing in the current UI distinguishes "this target has no resolution" from "I could
not load the resolution state," so handled targets present as pending and moderators
re-clear work they already did.

Three concrete holes remain after PR #186:

1. **First-load race.** `placeholderData: (prev) => prev` protects mid-session
   refreshes and gives nothing on a fresh mount. Reports resolve from the relay in
   roughly 3s while `/api/decisions` returns ~147KB over 1000 rows; whichever has not
   landed contributes nothing and the queue renders unfiltered meanwhile. Only
   `decisionsLoading` gates the render today, so the other three sources race freely.
2. **Error with no prior data.** On a fresh mount an error leaves a source empty until
   a later 15s poll succeeds. The `decisionsLoading` guard covers loading only, so the
   auto-hidden-content protection it exists to provide does not hold on a decisions
   *error*.
3. **Silent row caps.** `/api/decisions` returns the newest 1000 rows; `/api/resolution-labels`
   the newest 500. Neither binds today, but a target whose only resolution signal ages
   out of both un-hides permanently, and the caps are silent so nothing says so.

## Policy

Ratified with Matt on 2026-08-05, after considering never-block-always-banner,
block-on-any-incompleteness, and render-only-known-unresolved.

**Cold mount** (a source has no data at all): the queue does not render a
`resolvedTargets`-filtered list. Still loading shows the existing skeleton; errored
shows a pane naming which sources are unavailable, with Retry and an explicit
override.

**Warm refresh** (a source errored but still holds previous data): the list renders,
filtered by the stale set, with a banner naming the source and its last-updated time.
Blocking here would cost availability for no safety gain, because the stale set still
hides the handled work.

**Override.** The blocked pane offers "Show the queue without resolution filtering."
Taking it renders the unfiltered list under a persistent warning that resolution state
is unknown and handled work may be listed. The override is component-local state, not
persisted: it survives polls within the mount so a moderator is not thrown back to the
blocked pane every 15s, and it resets on reload. When decisions is the failed source,
the override also forgoes the `pendingReviewTargets` filter, so auto-hidden content can
appear; the warning says so, because a silent version of that is the same class of bug
this issue is about. Rationale: a blocked queue is its own
moderator-facing failure, and blocking inherits the combined failure probability of
four independent queries on every cold load. The measured rate for the heaviest source
(resolution labels, limit 500 over a 1420-label corpus) is 1 timeout in 45 trials; the
other three are unmeasured. No combined figure is claimed. The override plus one retry
per source is what makes blocking payable.

## Design

### 1. One source descriptor

The four queries drift because each was patched independently. Build a single derived
array, one entry per resolution source: `key`, `label`, `data`, `error`,
`dataUpdatedAt`, `isPending`. The gate and the banners are written once against it, so
a fifth source cannot be added with the hole re-introduced.

`retry: 1` on banned pubkeys, banned events, and decisions, matching what PR #186 chose
for labels. The cold-start comment at `Reports.tsx:443` is updated rather than removed:
its reasoning about not stacking retries on cold-start timeouts still holds, it just no
longer justifies zero retries now that an empty source is known-harmful.

### 2. Gate

The sources are not equal.

`allDecisions` feeds both `resolvedTargets` and `pendingReviewTargets`, and
`pendingReviewTargets` is applied on every path: the list is filtered *to* it when the
pending-review view is on and filtered *out* of it otherwise. Decisions therefore
blocks unconditionally on loading or cold error. That is what the existing gate already
does for loading; this extends it to error.

Labels, banned pubkeys, and banned events only matter while `resolvedTargets` is
actually applied, so they block only when `hideResolved && !showPendingReview`.

### 3. Banners

Per source, when it has errored but still holds previous data: keep filtering with the
stale set, render a banner naming the source and its last-updated time (each query's
own `dataUpdatedAt`, not the reports query's).

Truncation banners are separate and non-blocking: the data is present and nearly
complete, so the queue renders and says how far back resolution history reaches.

### 4. Truncation signalling

`/api/decisions` queries `LIMIT 1001`, returns the newest 1000, and sets `truncated`
plus `oldest_covered` from the last kept row. One query, no extra `COUNT`.

`/api/resolution-labels` sets `truncated` when the relay returns exactly its 500-event
limit, with `oldest_covered` from the oldest event returned. This over-warns in the
exact-500 case, which is the correct direction to be wrong.

`getAllDecisions` and `fetchResolutionLabels` change from returning bare arrays to an
object carrying the rows plus `truncated` and `oldestCovered`. Non-test callers are
`Reports.tsx` and `DebugPanel.tsx`.

## Relationship to PR #186

PR #186 (issue #185) made `queryRelay` fail on timeout, close-before-EOSE, and NIP-01
CLOSED, so both bulk endpoints 502 rather than returning truncated lists as success. It
also added a labels-only banner on `labelsError && !resolutionLabels` and `retry: 1` on
that query.

That banner condition is exactly the cold-error case this design blocks. Labels joins
the other three under the unified policy: cold error blocks, warm error banners. The
banner text moves to the warm branch rather than being deleted. This is the general
policy overriding the narrow one, which is what #221 was scoped to decide.

This branch is cut from `origin/main`, not stacked on #186. It rebases once #186 lands.

## Out of scope

- **A relay returning a genuinely empty EOSE after an internal failure.** That is
  protocol-indistinguishable from a real empty result and cannot be fixed in this repo.
  Nothing here assumes relay reads are complete.
- **Making the row caps stop binding.** This design signals truncation; scoping the
  resolution queries to the queue's report window is a separate change.

## Testing

For every source, a control test first: with the source present and resolving a target,
the target is absent from the list. Only then the real test, so the assertion measures
an actual un-hide rather than a target that was never filtered.

Per source:

- Control: source resolves the target, target hidden.
- Cold error: no data, queue blocked, target not presented as pending.
- Warm error: stale data retained, target still hidden, banner rendered.
- No error: no banner (pinning the negative).

Override: taking it renders the target and keeps the persistent warning.

Worker: truncation flags in `worker/src/index.test.ts`, and the decisions cap in the D1
suite, since it touches a D1 read.

Each guard must die to exactly one mutation and no other. Mutations are applied one at
a time; a coarse mutation that removes two routes to the same outcome certifies an inert
test.

`src/test/TestApp.tsx` needs `retryDelay: 0`. Any query given a `retry` value otherwise
reinstates React Query's 1000ms default backoff, pushing error-state assertions past the
1000ms `findBy` timeout. PR #186 adds the same line, so the rebase resolves to identical
content.

## Validation

All four gates, because they disagree:

```
npm run test                     # tsc(app) + eslint + vitest + build
cd worker && npm run typecheck   # separate CI gate
cd worker && npx vitest run      # excludes *.d1.test.ts and *.e2e.test.ts
cd worker && npm run test:d1     # D1 is touched
```
