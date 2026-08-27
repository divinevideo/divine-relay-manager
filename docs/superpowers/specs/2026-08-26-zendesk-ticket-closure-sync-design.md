# Zendesk ticket closure from relay-manager actions — design

**Date:** 2026-08-26
**Status:** Design approved, pending spec review
**Author:** Matt (with Claude)

## Problem

Moderators report that taking an action on a report in Relay Manager — most
visibly "ban all of a user's content" — does not close the corresponding
Zendesk ticket, and the report can linger in the queue as unhandled. Raised by
Aleysha; confirmed in code.

Investigation traced this to **two independent mechanisms that share one root
theme: pubkey-level enforcement does not propagate to event-scoped tracking.**

### Mechanism A — Zendesk ticket does not close

`syncZendeskAfterAction` (`worker/src/zendesk-sync.ts`) closes a ticket only
when a `zendesk_tickets` row matches the action's exact scope:

- pubkey-targeted action → `WHERE author_pubkey = ? AND status='open'`
- event-targeted action → `WHERE event_id = ? AND status='open'`

That row is populated by regex-parsing the original Zendesk ticket description
in `handleParseReport` (`worker/src/index.ts`), where both `Event ID` and
`(Author|Reported) Pubkey` are optional and must be **64-hex**.

Failure modes:

1. **`author_pubkey` is NULL** when the description carried only an event id, or
   carried the pubkey as an npub (bech32, so the hex regex misses it), or used a
   differently-labeled field. A whole-account action (`ban_pubkey` /
   bulk `delete_event` pubkey sync) then matches nothing and the ticket stays open.
   The "Ban User" (`banpubkey`) path does **no** per-event sync at all — pure
   account-level — so an event-linked ticket only closes via `author_pubkey`.
2. **`.first()`** — the query closes only ONE matching open ticket. With the
   consolidation model (many reports/tickets per piece of content), a video with
   three tickets gets one closed.
3. **Event-id casing** — `handleParseReport` stores `event_id` as captured
   (case-insensitive regex, no lowercasing); the sync query is an exact match with
   no normalization, while the delete paths lowercase their ids. An uppercase-hex
   id in a description never matches.

### Mechanism B — report stays "unhandled" in the queue

`Reports.tsx` builds a `resolvedTargets` set and filters by exact
`${type}:${value}` key. A whole-account ban adds only `pubkey:<pubkey>` (from
`listbannedpubkeys` and the `ban_user` decision row). Most content reports carry
an `e` tag, so they are consolidated as `event:<id>` (`getReportTarget`). There
is **no cross-scope rule** that resolves an event-scoped report when its author
is banned, so those reports linger. `banpubkey` purges rows (hides content from
queries) but does not register each event in `listbannedevents`, and "Ban User"
writes only a single pubkey-scoped decision row — so nothing clears the
event-scoped reports.

### Confirmed enabling facts

- Reports carry **both** `e` and `p` tags: `getReportTargetIds` returns
  `{eventId, pubkey}`. An event-scoped report already knows its author — the
  queue fix needs no extra fetch.
- `handleParseReport` already fetches the reported event for note enrichment, so
  the event's author is available at parse time at no extra cost.
- The frontend currently has **no** read path from a report to its linked ticket;
  `zendesk_tickets` lives only in the worker's D1.

## Decisions (approved)

- **Auto-close policy: whole-account + exact-event.** Whole-account actions (ban
  user, delete all) close any ticket for that author (event- or pubkey-linked);
  per-event actions close only their own event's ticket(s). Manual button covers
  the residue.
- **UI: always-present linked-ticket panel** in the report detail. Never a
  disabled "Close" button — each state reads as its own clear thing.
- **Status source: D1-first.** Read status from `zendesk_tickets`; accept that a
  ticket closed directly in Zendesk may show stale until the next sync. The Close
  action does a live Zendesk PUT, which reconciles. The ticket # always links to
  the Zendesk ticket as an escape hatch.
- **Manual close is Zendesk-only.** Closing a ticket closes the ticket (Zendesk
  status + internal note + D1 status). It does NOT write a `moderation_decisions`
  row — closing a ticket is not the same as actioning content, and conflating
  them would mark content "handled" that was never moderated.
- **Consolidation model confirmed.** Relay Manager works reports per *target*, not
  per report. One action on a target resolves every report about it. Retroactively,
  any open ticket pointing at actioned content (or its author) is a handled report.

## Scope

In scope: three independent live fixes, shipped as three scoped PRs (per the
repo's "don't mix worker/UI" rule).

Out of scope: the **one-time retroactive Zendesk cleanup**. Matt runs that ad hoc
through Zendesk tooling once the live work makes ongoing closure reliable. It
reuses the same "is this target handled?" predicate but derives what it needs at
run time (re-parsing descriptions, deriving authors from events, enumerating open
tickets from the Zendesk API directly), so it is not blocked on anything shipped
here. Documented separately when undertaken.

## Design

### Fix 1 — Worker: reliable ticket linkage + closure (Zendesk half)

**1a. Always populate `author_pubkey` at parse time** (`handleParseReport`).
When the description yields an `event_id` but no hex `author_pubkey`, derive the
author from the reported event already fetched for enrichment, and store it.
Store `event_id` and `author_pubkey` lowercased.

- If the enrichment event fetch fails or returns nothing, `author_pubkey` stays
  null — best-effort, never blocks ticket-row creation. (The retroactive sweep
  and future re-syncs can still re-derive.)

**1b. Close ALL matching open tickets, not `.first()`** (`syncZendeskAfterAction`).
Select all open tickets for the target and resolve each (internal note +
`status='solved'` PUT + D1 status update). Normalize the target id to lowercase
in the query to match stored casing.

**Net effect:** with `author_pubkey` reliably present and casing normalized, a
whole-account action's existing `WHERE author_pubkey = ?` sync closes every ticket
for that author (event- and pubkey-linked); per-event actions close that event's
ticket(s). The approved policy falls out of the data fix — no new branching in the
action handlers.

**Not doing:** backfilling existing rows' `author_pubkey` as part of the live
work. Existing rows are handled by the one-time sweep (which re-derives). Keeping
the live PR to forward-looking behavior avoids a migration in scope.

### Fix 2 — Frontend: event reports clear when their author is resolved (queue half)

In `Reports.tsx`, an event-scoped report also counts as resolved when its author
pubkey — read from the report's `p` tag via `getReportTargetIds` — is in the
relay's **banned-pubkey set** (`bannedPubkeys`).

- The only real gap is "Ban User" (`banpubkey`): it purges the account's events
  without registering each one in `listbannedevents`, so the event key never
  appears in the resolved set. Bulk "Delete All Content" already `banevent`s each
  event (they land in `listbannedevents`), so those event reports already resolve
  today — no change needed there.
- Keying on `bannedPubkeys` specifically excludes *suspend* by construction:
  suspension lives on a separate list, so a reversible holding action never
  cross-resolves. No need to reason about which decision-log actions count.
- Implemented as a pure helper used by every resolved check (the hide-resolved
  filter, the detail pane's resolved check, and the counts).

### Fix 3 — UI: linked-ticket panel + manual close (visibility + fallback)

**Worker read endpoint:** `GET /api/tickets?event=<id>&pubkey=<pk>` →
`{ tickets: [{ ticket_id, status, url }] }`. Registered **after** the
`verifyAdminAccess()` gate (alongside `/api/decisions`) — NOT under `/api/zendesk/*`,
which bypasses the admin gate. Queries `zendesk_tickets` by event_id and/or
author_pubkey. Builds the ticket URL from the resolved Zendesk subdomain.

**Worker close endpoint:** `POST /api/tickets/:id/close` (admin-gated) → resolves
that specific ticket: `addZendeskInternalNote(ticketId, note, env, true)` + D1
`status='resolved'`. Records the moderator in the note. Does **not** write a
`moderation_decisions` row.

**Frontend panel** in `ReportDetail`, always present, driven by D1 status:

| State | Display | Close affordance |
|---|---|---|
| Linked, open | `Zendesk #NNNN · Open` (links to Zendesk) | Active "Close ticket" button |
| Linked, closed | `Zendesk #NNNN · Closed ✓` + who closed it | No button — affirmative badge |
| No link | `No linked Zendesk ticket found` | None |
| Multiple | one row per ticket, rules per row | active button only on open rows |

- The panel refetches on `onActionComplete` (same hook that already refetches
  decisions), so after an action that auto-closes, it flips to `Closed ✓`
  immediately. Because closure is awaited server-side before the action returns,
  the D1 status is already correct by the refetch.
- **Never a disabled Close button.** Closed shows as a done badge; open shows an
  active button; no-link shows informational text.

## Data flow

```
Action taken (ReportDetail → UserActions/EventActions → /api/moderate | /api/bulk-moderate)
  → relay RPC (critical)
  → syncZendeskAfterAction (non-critical, awaited): closes ALL matching open tickets
  → onActionComplete: refetch decisions + linked-ticket panel
Panel load: GET /api/zendesk/tickets?event&pubkey → D1 rows → render state
Manual close: POST /api/zendesk/tickets/:id/close → Zendesk PUT + D1 status → refetch panel
Queue resolution (Reports.tsx): resolvedTargets now cross-resolves event reports
  whose author pubkey is resolved at the account level
```

## Error handling

- Ticket closure stays a **non-critical** side effect of moderation actions:
  awaited inside try/catch, logged on failure, never blocks the primary action
  (per the `handleModerate` side-effect contract). A failed auto-close leaves the
  ticket `open`, so the panel shows an active Close button — the fallback engages
  by design.
- The read endpoint degrades to "no linked ticket" on DB error rather than
  blocking the report view.
- The manual close endpoint surfaces failure to the UI (toast) and leaves D1
  status unchanged so the button stays available for retry.
- `author_pubkey` derivation failure at parse time is swallowed (best-effort);
  the ticket row is still created.

## Testing

- **Fix 1 (D1-backed, `npm run test:d1`):** parse-time author derivation from an
  event when the description has no hex pubkey; casing normalization on store and
  query; multi-ticket close (three tickets on one target all resolve); whole-account
  action closes an event-only-linked ticket once `author_pubkey` is derived;
  per-event action does not close a pubkey-linked (account-level) ticket.
- **Fix 2 (frontend):** an event-scoped report resolves when its author pubkey is
  in the banned/decision resolved set; a suspend or pending auto-hide does NOT
  cross-resolve; a report with no `p` tag is unaffected.
- **Fix 3:** panel renders each of the four states; refetch flips open→closed after
  an auto-closing action; manual close calls the endpoint and updates the panel;
  read endpoint returns multiple linked tickets; close endpoint writes note +
  status and no `moderation_decisions` row.
- Mutation-check the load-bearing guards (one guard per mutation), per repo review
  conventions.

## Open verification items (live data, not code)

These do not block design but should be confirmed before/while implementing:

1. Real content-report ticket description format — does it carry
   `Author Pubkey:` / `Reported Pubkey:` as 64-hex, an npub, or nothing? Decides
   how often Fix 1a's derivation is the thing that saves closure.
2. Whether funnelcake `banpubkey` registers events in `listbannedevents`
   (cross-repo). If it does, Mechanism B is partially self-healing; Fix 2 is still
   correct and cheaper than relying on relay state.
3. Coverage of `zendesk_tickets` vs. all open Zendesk tickets (informs the one-time
   sweep, not the live fixes).

## Rollout

Three scoped PRs, each independently valuable and independently testable:

1. Fix 1 (worker linkage + closure) — highest impact on the reported symptom.
2. Fix 2 (queue cross-resolution) — the "does not register as handled" half.
3. Fix 3 (panel + manual close) — visibility + fallback.

Staging-first validation for the worker changes (D1 + Zendesk sync can't be fully
exercised locally). Log each deploy via `support-trust-safety/scripts/log-deploy.sh`.
