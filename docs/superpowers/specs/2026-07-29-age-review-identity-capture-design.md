# Age-review identity capture: make tickets and contacts say who they are about

**Date:** 2026-07-29
**Status:** Approved design (brainstormed with Matt; every load-bearing claim verified against prod this session)
**Related:** #190 (link-and-sync — shares the hostile-requester privacy principle) · #200 (render target content — sets the ceiling on backfill) · Zendesk trigger/tag/view changes already landed in `divine-zendesk-tooling@2c23520`

## Motivation

A parent wrote in asking when they would be let back into the app. Their ticket carried a placeholder contact name, an empty body, and nothing identifying which Divine account it concerned. Recovering that took a manual pivot through the requester's other tickets, which revealed they were the parent on an existing case — one where they had already confirmed themselves days earlier and never received a reply.

The linking was not the defect. **We never capture a human-readable identifier for any account.** Every table is pubkey-keyed, so even a perfectly linked ticket could only ever name a hex pubkey.

And the one readable signal that exists — the kind-0 profile — is destroyed by our own enforcement. `suspendpubkey` hides an account's content, so by the time a moderator opens the case there is nothing left to look at. Both current parent-contact cases return no kind-0 on the prod relay.

## Verified facts this design rests on

| Claim | How verified |
|---|---|
| Zendesk captures a From display name **only** at contact creation | 8 cold-email parents have real names; contacts we pre-created do not |
| Zendesk **never** updates an existing contact's name from later inbound mail, even when the stored name is just the email address | Controlled test, 2026-07-29: seeded `name == email`, sent real mail with display name `Test Account`, `name` and `updated_at` both unchanged |
| We *can* write `name` and `notes` ourselves | `PUT /api/v2/users/{id}` — both set successfully in the same test |
| `notes` renders in the agent sidebar with no setup | Observed in the agent UI; zero user fields defined in the account |
| The raw From name is retained but unreachable by API token | `/raw_email/…` and `/tickets/{id}/comments/{cid}/original` both 301 to the help centre; agent session only |
| Neither current case resolves to a name | kind-0 query against `wss://relay.divine.video` returned nothing for both pubkeys |
| Zendesk renders the stored contact name into the `To:` header of outbound mail | Auto-ack received at a disposable test alias carried the stored name in `To:` |

## Privacy constraint (load-bearing — do not relax without re-deciding)

**The contact name carries the handle only after the parent has replied.**

The contact name is requester-visible, and not only through templates. Zendesk renders it into the `To:` header of every outbound email — verified against a real auto-ack. So a contact named `Claimed parent of someuser` discloses that handle to whoever holds the address, permanently.

That matters because the parent email is supplied by the **teen** and is never verified. The outreach email is sent *before* anyone has confirmed the address is even correct, so it is the message most likely to reach a stranger.

Hence the split:

- **At attach time** the name is the email address alone. The outreach goes out carrying no handle.
- **On the parent's first reply** the name is rewritten to `Claimed parent of <handle>`. By then the address is demonstrably live and held by someone engaging with the review.

`handleAgeReviewReplyWebhook` is the natural hook — it already fires on that reply and resolves ticket → case → handle.

"Claimed" is deliberate: whether they are the parent is precisely what the review exists to establish, and the name must not assert it as fact.

Note the asymmetry that makes the timing matter: the existing subject already discloses `Age review: parental verification needed [<case-uuid>]` to that address. A UUID is meaningless to a stranger; **a handle identifies a person.** Adding the handle is an escalation the UUID is not, which is why it waits for a reply.

Separately, the active macro *"Customer not responding"* posts `Hello {{ticket.requester.name}}.` as a public comment. Once names carry handles, that macro will render one into an email body. Reword it or keep it off age-review tickets.

This mirrors the principle #190 was hardened on: artifacts reachable by a requester must be worthless to a hostile one.

## Ratified behavior

### 1. Capture at case creation, before enforcement

Three creation paths:

- `ReportWatcher.ts:955` — main report-driven creation. Fetch kind-0, parse, store.
- `ReportWatcher.ts:929` — verified-minor auto-clear path. Same.
- `age-review.ts:547` — `handleCreateMinorAccount` already receives `username` and `display_name` in the request body. No relay fetch.

**Ordering is the whole point.** Capture must complete before any enforcement leg fires, because suspension hides the profile. Best-effort and wrapped: a relay failure logs and continues, never blocking case creation (graceful-degradation rule — the case is the critical path, enrichment is not).

Reuse `parseKind0Profile()` from `report-note.ts`. It already extracts `display_name || name`, `nip05`, `isVineImport` and `vineUsername`, and already runs every field through `sanitizeInline` (80-char cap, control characters stripped). These are attacker-controlled strings landing in agent-visible fields; do not hand-roll a second parser.

### 2. Schema — four columns on `age_review_cases`

```
account_name           TEXT   -- display_name || name
account_nip05          TEXT
account_vine_username  TEXT
identity_captured_at   TEXT
```

Added via `ensureSchema` in `db.ts` using the existing idempotent `try { ALTER TABLE … ADD COLUMN } catch {}` pattern. **Never run `wrangler d1 migrations apply` against this database** — schema is applied at runtime.

`identity_captured_at` distinguishes "we looked and found nothing" from "we never looked." Without it the backfill cannot tell which rows to retry.

Handle resolution order: `display_name → name → vine_username → nip05 → none`.

### 3. Decoration points

| Surface | Carries | Visibility |
|---|---|---|
| Contact `name`, at attach | email address alone | requester-visible, incl. `To:` header |
| Contact `name`, after first reply | `Claimed parent of <handle>` | requester-visible — see privacy constraint |
| Contact `notes` | case deeplink, handle, npub, pubkey, origin ticket | agent-only |
| Case ticket internal note | same block | agent-only |

The name upgrade is why the ticket *list* becomes readable: the Requester column renders the name and nothing else, so an agent scanning the queue sees which account each ticket concerns without opening anything.

Contact-record writes happen **only** when a real parent email is attached. On the no-parent path the ticket requester falls back to the API caller, which is an admin account on the large majority of existing case tickets, so an unguarded write would scribble case data onto a live admin profile.

`notes` is a single free-text field, so writes must compose rather than clobber whatever a human put there.

Case deeplink format: `https://relay.admin.divine.video/age-review?case=<id>`.

### 4. Backfill

One pass over cases with a null `identity_captured_at`, stamping the timestamp regardless of whether anything resolved.

**Be honest about the yield.** Suspended accounts' profiles are hidden, so this recovers names only where the account is still visible — roughly the `cleared` and `open_reported` rows. The ~98 `restricted_pending_user_response` cases, precisely the ones where a parent might write in, are the ones that cannot be recovered. Both of today's real cases returned empty for exactly this reason.

Recovering those depends on #200.

## Non-goals

- **No template changes.** Not asking parents for their name, and not adding a case ID to the Greenlight mailto. That screen serves two populations — restricted teens and families with no account yet — and is reachable signed-out, so it often has no case to reference.
- **No attempt to recover the real From name.** Unreachable by API; an agent can read it via view-original and edit the profile by hand, and that sticks.
- **No email→case lookup endpoint.** Zendesk's Interaction History already answers it: every case with a parent email also has a ticket, and the case ID is in that ticket's subject.

## Risks

- `account_name` is attacker-controlled. An account may name itself anything, so a note could read "Claimed parent of Divine Support". `sanitizeInline` caps and strips; keep the handle out of anything that reads as authoritative.
- Capture adds a relay round-trip to case creation. Must not become a failure mode for the case itself.
- Backfill against ~319 rows is a bulk relay read; batch it.
