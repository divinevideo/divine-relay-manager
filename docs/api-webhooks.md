# Divine Relay Manager - Webhook & API Documentation

## Overview

The Divine Relay Manager exposes several API endpoints for integration with external systems like Zendesk (ticket report parsing, decision sync, age-review replies). Note: Zendesk does **not** execute moderation actions. Moderation is performed in Relay Manager; Zendesk only receives decision updates back. The former inbound moderation-execution path has been retired (see the note under `POST /api/zendesk/webhook`).

Protected-minor deletion and replacement service endpoints are documented in [protected-minor-registry.md](protected-minor-registry.md). They use a dedicated bearer credential and are not authorized by moderator/browser credentials.

**Base URL:** `https://api-relay-prod.divine.video` (production) or `https://api-relay-staging.divine.video` (staging)

## Authentication

### Cloudflare Zero Trust (Recommended)

All endpoints are protected by Cloudflare Access. External services need service tokens:

```
CF-Access-Client-Id: <your-client-id>
CF-Access-Client-Secret: <your-client-secret>
```

### Webhook Signature Verification

For Zendesk webhooks, requests are verified using HMAC-SHA256:

```
X-Zendesk-Webhook-Signature: t=<timestamp>,v0=<signature>
```

---

## Mobile-facing account endpoints

These `/v1/*` endpoints use [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
HTTP authentication. The signed event's pubkey identifies the account; moderator,
Cloudflare Access, and API-key credentials do not authorize access to another
account's review data.

### GET /v1/account/moderation-status

Returns the authenticated account's restriction state. An unrestricted account,
an account without a surfaced review case, or a request handled while the D1
database binding is unavailable receives:

```json
{
  "restriction": { "status": "active" }
}
```

The database-unavailable response is deliberately fail-open and contains no case.
Clients must not interpret it as proof that an earlier restriction was cleared.

A surfaced minor-review case receives:

```json
{
  "restriction": { "status": "restricted_minor_review" },
  "minorReviewCase": {
    "id": "case-id",
    "state": "restricted_pending_user_response",
    "suspectedAgeBand": "age_13_15",
    "allowedResolution": "parent_video_or_email",
    "instructions": null,
    "supportEmail": "contact@divine.video",
    "moderationConversationPubkey": null,
    "moderationConversationId": null,
    "responseDeadline": {
      "clock": "running",
      "serverNow": "2026-08-26T14:30:00.000Z",
      "deadlineAt": "2026-09-10T14:30:00.000Z",
      "pausedAt": null,
      "remainingDaysWhenPaused": null
    }
  }
}
```

`responseDeadline.clock` has these stable values:

| Value | Meaning |
|-------|---------|
| `running` | The user-response window is active. `deadlineAt` is present. |
| `paused` | The response window applies but is suspended. `pausedAt` and `remainingDaysWhenPaused` are present; `deadlineAt` is null because the stored deadline is stale until resume. |
| `expired` | The response deadline has passed but the scheduled closure has not completed yet. `deadlineAt` is present. |
| `not_applicable` | The case state does not currently require a timed user response. Case timing fields are null. |
| `unknown` | Stored timing data is missing, malformed, or inconsistent. Case timing fields are null; clients must not invent a default deadline. |

All returned timestamps are absolute UTC ISO-8601 values serialized with
milliseconds as `YYYY-MM-DDTHH:mm:ss.sssZ`. `deadlineAt` is non-null only for
`running` and `expired`. `serverNow` is captured from the same server clock used
to classify the deadline and is present for every valid response calculation.
Clients should use it to offset the device clock before deriving display text
from `deadlineAt`, and must use `clock` to decide whether a countdown applies.

---

## Moderation Action Endpoints

### POST /api/moderate

Execute a moderation action directly.

**Request:**
```json
{
  "action": "ban_pubkey" | "allow_pubkey" | "delete_event" | "hide_event" | "allow_event",
  "pubkey": "hex-pubkey",      // Required for ban/allow
  "eventId": "hex-event-id",   // Required for delete/hide/allow_event; must be 64 hex chars
  "reason": "Spam account"     // Optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Action executed successfully",
  "recorded": true             // hide_event / allow_event only — see below
}
```

**Actions:**
| Action | Description |
|--------|-------------|
| `ban_pubkey` | Ban a user from posting to the relay |
| `allow_pubkey` | Remove a user from the ban list |
| `delete_event` | Delete a specific event from the relay, and DM the creator `PERMANENT_BAN` |
| `hide_event` | Hide an event. Same relay operation as `delete_event`, but **no DM** |
| `allow_event` | Un-hide an event |

### `recorded`, and why `hide_event` / `allow_event` exist

These two do more than the relay change, which was already available over
`/api/relay-rpc`. They also mark the event human-reviewed in `moderation_targets`.
ReportWatcher skips auto-hide for any event carrying that mark, so **without it a
moderator's restore is silently undone by the next report** — csam is an immediate,
threshold-1 tier.

`recorded` reports whether that mark actually landed. It is returned on a **200**, not an
error status, because the relay change did apply and a retry would enforce twice. A caller
seeing `recorded: false` should treat the decision as **applied but unprotected** and
surface it: the content is hidden or restored as asked, but the automation may reverse it.

Event visibility changes and their direction-bearing human marks are serialized through the
ReportWatcher Durable Object. Auto-hide uses the same coordination gate, rechecks human-review
state before mutating the relay, and rechecks explicit restore direction after banning.
Resolution statuses such as `dismissed`, `no-action`, and `false-positive` set the human-review
bit through that gate. They restore an active auto-hide so the content stays up as promised by
the review UI, but do not restore content with a later manual hide/delete direction. The restore
is recorded as `auto_hide_restored` without overwriting that human direction.

An `allow_event` response also carries `reconciled`. It is true when the coordinated restore
and human-review mark completed. If it is false, callers should surface the same degraded
state as `recorded: false`: the relay restore landed, but automation protection did not.
Zendesk still receives the final human decision in this case.

Both actions are final human decisions for linked Zendesk reports, so they add an internal
note and resolve the open ticket.

`eventId` is validated as 64 hex characters and lowercased before use. `moderation_targets`
is BINARY-collated and ReportWatcher looks the event up by its lowercase id, so an uppercase
id would write a row nothing can read while the API reported success.

---

### POST /api/relay-rpc

Execute NIP-86 relay management commands. This is the low-level interface used by the admin UI.

**Request:**
```json
{
  "method": "banpubkey",
  "params": ["<hex-pubkey>", "Reason for ban"]
}
```

**Available Methods:**
| Method | Params | Description |
|--------|--------|-------------|
| `banpubkey` | `[pubkey, reason?]` | Ban a pubkey |
| `allowpubkey` | `[pubkey, reason?]` | Add to allowlist |
| `listbannedpubkeys` | `[]` | Get all banned pubkeys |
| `listallowedpubkeys` | `[]` | Get all allowed pubkeys |
| `deleteevents` | `[eventId, reason?]` | Delete events |

**Response:**
```json
{
  "success": true,
  "result": { ... }
}
```

---

### POST /api/moderate-media

Moderate media content (images/videos) by SHA-256 hash.

**Request:**
```json
{
  "sha256": "abc123...",
  "action": "SAFE" | "REVIEW" | "QUARANTINE" | "AGE_RESTRICTED" | "PERMANENT_BAN" | "DELETE",
  "reason": "CSAM content",
  "from": "AGE_RESTRICTED"
}
```

**`from` (optional): declare the state you expect to be changing.**

This endpoint sets state; it does not describe a transition. `SAFE` means "make
this Active", not "undo the age-restriction I applied", so a caller reversing its
own action and a caller clearing an age-review quarantine on a minor's content
send the identical request.

`from` lets a caller declare the state it believes it is changing. The current
state is read first and the action is refused unless it matches, so a button can
only reverse the thing it is named for. Omit `from` and the state check does
not run: no state read, no new failure mode from it.

It guards a cooperating caller against its own bug. It is not a security
boundary, since the caller supplies the value and omitting it skips the check.
The age-review lift guard below is the one that does not depend on the caller.

Sending `from` also requires `sha256` to be 64 hex characters, because it becomes
part of an upstream URL. Without `from`, `sha256` is forwarded as-is and
validated upstream, except for a `SAFE` or `AGE_RESTRICTED`, which the
age-review lift guard below validates and lowercases, and a request that sends
`pubkey`, which the account check validates and lowercases.

**Refusals when `from` is present:**

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `invalid_from` | `from` was present but empty, whitespace, null, or not a string. Omit it to skip the check. |
| 400 | `invalid_sha256` | `sha256` is not 64 hex characters. |
| 409 | `state_mismatch` | Current state is not the declared one. The body carries `from` and `current`. |
| 503 | `state_unreadable` | Current state could not be read. Retryable, and deliberately not a success. |

A 409 names both states because "refused" alone reads as transient and gets
retried. `state_unreadable` is 503 rather than 409 because "could not check" is a
different answer from "no conflict".

What is compared is moderation-service's recorded result. Actions taken directly
through Blossom's own admin UI do not write there, so they are not reflected.

**Age-review lift guard (#335).** While the file's owner has an open age
review, a `SAFE` is refused, and so is an `AGE_RESTRICTED` over a file that is
hidden, blocked or deleted: the 18+ gate would show it to signed-in adults. An
`AGE_RESTRICTED` over a public or already-gated file only tightens and goes
through. Hidden means the media server shows it so, or moderation-service's
record does (the media server's status can be up to 5 minutes stale; the
record is not). Both are consulted only during an open case, and the record is
read only then; the media server is read on every `SAFE` and `AGE_RESTRICTED`,
since that read names the owner. Once the case has
restricted the account (a `restricted_pending_*` state), its withhold has
hidden the files, and every `AGE_RESTRICTED` is refused. `PERMANENT_BAN`,
`QUARANTINE`, `DELETE` and `REVIEW` are not checked. The worker reads the owner
from the media server itself, so the caller does not need to name the
account; a request that sends `pubkey` gets the account check instead, on
that account (a bulk note's Restore), which refuses every action during a
case. It runs before the `from` check. The action is compared
in any case here (`"safe"` is a `SAFE`, as moderation-service reads it), and
an action that is not a string is refused (400 `invalid_action`).

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `invalid_sha256` | `sha256` is not 64 hex characters. |
| 409 | `age_review_active` | The owner has an open age review. The body carries `caseId` and `state`. |
| 409 | `media_record_missing` | The media server has no record of the file, so the owner cannot be checked. Not retryable. |
| 503 | `owner_unreadable` | The media server could not be read for the owner. Retryable. |
| 503 | `age_review_check_failed` | The open-case lookup could not run. Retryable. |
| 503 | `state_unreadable` | An `AGE_RESTRICTED` during an open case, and moderation-service's record could not be read: the read failed or took longer than 10 seconds, or, on the lift check below, this worker's credentials for moderation-service could not be built. Retryable. |

**Response:**
```json
{
  "success": true,
  "sha256": "abc123...",
  "action": "PERMANENT_BAN"
}
```

**Actions:**
| Action | Description |
|--------|-------------|
| `PERMANENT_BAN` | Block this media hash permanently |
| `SAFE` | Mark as safe, allow serving |
| `QUARANTINE` | Withhold this media hash while preserving reversibility |
| `AGE_RESTRICTED` | Allow but flag as adult content |
| `REVIEW` | Queue for manual review |
| `DELETE` | Delete this media hash |

---

### POST /api/moderate-media/lift-check

Asks whether a `SAFE` or `AGE_RESTRICTED` may go ahead. It writes no media
decision and makes no moderation change of its own. Like every route that
reads age-review cases, the first request a worker instance serves may run the
idempotent schema setup first, and that setup also backfills fields on older
age-review rows (case closure times and two protected-minor fields). It runs the age-review lift guard of
`POST /api/moderate-media` above, the same code, so the two give the same
answer on that guard. It checks nothing else: `pubkey` and `from` are ignored
here, so `/api/moderate-media` can still refuse a request this allows, for
example with `state_mismatch`. It is for a caller that writes media decisions
itself and must not restate the rules, such as moderation-service's
dashboard.

In addition to the credentials described under Authentication above, it
accepts moderation-service's relay key, sent in the `X-Admin-Key` header (the
worker's `MOD_RELAY_ADMIN_KEY` binding), as `POST /api/relay-rpc` does.
`/api/moderate-media` still refuses that key.

**Request:**
```json
{
  "sha256": "abc123...",
  "action": "SAFE"
}
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{ "success": true, "allowed": true, "checked": true, "sha256": "..." }` | The lift may go ahead. `sha256` is the hash, lowercased; write that one. |
| 200 | `{ "success": true, "allowed": true, "checked": false }` | The action is not one the guard checks (`PERMANENT_BAN`, `QUARANTINE`, `DELETE`, `REVIEW`). Nothing was read. |
| 400 | `code: "invalid_action"` | `action` is missing, not a string, or not one of the six actions above. |
| 400 | no `code` | `sha256` is missing. |
| 409, 503, 400 | the lift guard's refusal | Exactly what `/api/moderate-media` would answer, from the table above. |
| 500 | | The body is not JSON, or is `null`. |

Anything but a 200 with `"allowed": true` is a refusal.

The answer is a check, not a lock: a case opened between it and the caller's
write is not seen, as with `/api/moderate-media`'s own check and write. A caller
that cannot get an answer should refuse the lift.

---

### POST /api/internal/private-reports

moderation-service's handoff of a private report: one a user sent the moderation
account as an encrypted direct message instead of a public kind-1984 event. The
route puts the reported account in front of a moderator and does nothing else.

- `underage_user` opens an age-review case for the reported account, through the
  same routine a kind-1984 under-16 report uses: one active case per account, and
  an approved minor is recorded as already cleared. The case has `created_via =
  'private_report'`, the reporter in `reporter_pubkey`, and no `report_id`, since
  there is no report event to look up. The decision log row carries the
  `reportId` but not the reporter. If the account already has a family's
  Greenlight case with no report on it, the report is attached there instead:
  the reporter, still with no `report_id`. The case pane labels both shapes as
  an unverified private report. A later public under-16 report attaches over a
  private one, as it would have before; a second private report does not
  replace the first.
- Every other type becomes a Coop `nostr_user` item, routed by `report_reason`:

  | `reportType` | `report_reason` |
  |---|---|
  | `csam` | `csam` |
  | `child_safety` | `child_safety` |
  | `sexual_content` | `nudity` |
  | `violence` | `violence` |
  | `harassment` | `harassment` |
  | `spam` | `spam` |
  | `ai_generated` | `ai_generated` |
  | anything else | `other` |

  Coop gives the first five their own queues, CSAM and Child Safety first, and
  sends the rest to General Review. The item carries only the account and the
  reason: `{"items":[{"id": <pubkey>, "typeId": COOP_USER_TYPE_ID, "data":
  {"pubkey": <pubkey>, "report_reason": <token>}}]}`.

Nothing is published to a relay, no Zendesk ticket is filed, and nothing is
hidden, restricted or banned. The reported message and the reporter's note never
reach this worker: moderation-service keeps them.

**Authentication.** The admin gate. moderation-service reaches the route in one
of two ways, as its other relay-admin calls do:

- *Over its `RELAY_ADMIN` service binding,* with its relay key in the
  `X-Admin-Key` header (this worker's `MOD_RELAY_ADMIN_KEY` binding). A service
  binding does not pass through Cloudflare Access, so the key is what the gate
  checks. It is accepted on `POST` only, as for `POST /api/relay-rpc` and
  `POST /api/moderate-media/lift-check`, and opens no other route.
- *Over the public edge at `RELAY_ADMIN_URL`,* its fallback when the binding is
  unavailable, with its Cloudflare Access service token
  (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) and no `X-Admin-Key`.
  Access admits the token and adds a `Cf-Access-Jwt-Assertion`, which the gate
  verifies against the API's Access application (`API_ACCESS_AUD`). No
  path-scoped Access application covers this path, so it falls under the
  hostname-wide one, whose policy must allow the token, as relay-rpc's
  fallback already requires.

`ADMIN_API_KEY` and a moderator's Access login are accepted too, as on every
admin route.

**Request:**
```json
{
  "reportId": "6f1c2b9e-3d4a-4f8b-9c2d-1e5f7a8b9c0d",
  "reportedPubkey": "<64 hex>",
  "reporterPubkey": "<64 hex>",
  "reportType": "csam",
  "reportedAt": "2026-11-07T10:00:00.000Z",
  "hasExcerpt": true,
  "giftWrapId": "<64 hex>"
}
```

`reportId` is a UUID, or the 64-hex gift wrap id when the report carried none.
Identifiers are stored and sent lowercase. `reportType` is moderation-service's
lowercase report type.
The worker converts a hex `reportId` to a domain-separated SHA-256 lookup token
before storage or logging, including the decision log. UUID lookup keys are
unchanged. A retry uses the same original request id and derives the same token.

**Idempotency.** The key is the reporter and `reportId` together, as
moderation-service keys its own intake. A report that completed answers again
with its stored outcome and `duplicate: true`, and nothing is redone. While the
first row still names its reporter, another reporter's report under the same
`reportId` is a report of its own: it gets a Coop submission, or
`age_review_exists` when the account already has a case. Once retention has
redacted that row (see Retention below), it no longer names a reporter, so any
report with the same `reportId`, account and type, from whoever sends it,
answers `duplicate: true` with the stored outcome; a different account or type
under that `reportId` is still a new report.

One that failed is retried by the next request. A request for a report another
request is still handling answers `503` `attempt_in_progress`, and the
attempt's lease lapses after two minutes if it never finishes. One gap remains: if Coop accepts
the item and the write recording that then fails, the retry submits it again.
An unfinished handoff older than a year is redacted by retention and answers
later retries with `400 report_expired`, without restoring its reporter link.

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{ "success": true, "outcome": "queued_in_coop" \| "age_review_opened" \| "age_review_exists", "duplicate": false }` | Handed over. `age_review_opened` includes an approved minor's case, opened already cleared. |
| 200 | the same, with `"duplicate": true` | This reporter's `reportId` already completed, or a redacted row with the same `reportId`, account and type did; the stored outcome. |
| 400 | `code: "invalid_body"` | The body is not a JSON object, or a field is missing or malformed. Do not retry. |
| 400 | `code: "report_id_conflict"` | This reporter already used this `reportId` for a different account or type. Do not retry. |
| 400 | `code: "report_expired"` | An unfinished handoff expired a year after first receipt. Do not retry; no reporter link is restored. |
| 401 | | Missing or wrong key. |
| 503 | `code: "coop_not_configured"` | A Coop setting below is missing, its credentials cannot be used, or `COOP_URL` is not HTTPS. Retry. |
| 503 | `code: "coop_unreachable"`, `"coop_status_<n>"` | Coop could not be reached, or did not answer 2xx (a redirect is not followed). Retry. |
| 503 | `code: "age_review_failed"`, `"db_unavailable"`, `"attempt_in_progress"` | Retry. |

**Configuration.** Per environment, for the Coop handoff:

- `COOP_URL`, Coop's base URL. It must be `https://` for this route, whether or
  not an Access pair is bound, because the item names an account and a reason
  such as `csam` and the request carries the ingestion key. Only a loopback
  host (`localhost`, `127.0.0.0/8`, `[::1]`) may use `http://`, for the local
  stack. The sexual-quarantine handoff keeps its own rule.
- `COOP_API_KEY`, the ingestion key, a secret.
- `COOP_USER_TYPE_ID`, Coop's id for the `nostr_user` item type (the value
  Osprey has as `DIVINE_COOP_USER_TYPE_ID`).
- When Coop is behind Cloudflare Access, the dedicated `COOP_ACCESS_CLIENT_ID`
  and `COOP_ACCESS_CLIENT_SECRET` pair. They are sent only over HTTPS, and only
  when both are bound.

These are the sexual-quarantine handoff's settings (see
[sexual-quarantine-rollout.md](sexual-quarantine-rollout.md)) plus
`COOP_USER_TYPE_ID`. Under-16 reports need none of them.

**Binding `COOP_URL` and `COOP_USER_TYPE_ID`.** No `wrangler.*.toml` declares
either, and their values belong to whoever runs each environment. Bind each one
as a Worker secret (`npx wrangler secret put COOP_URL --config
wrangler.<env>.toml`, and the same for `COOP_USER_TYPE_ID`), or have whoever
deploys add it to that environment's `[vars]` in `wrangler.<env>.toml`. Do not
set either as a plaintext variable in the Cloudflare dashboard: the configs do
not set `keep_vars = true`, so the next `wrangler deploy` drops dashboard
variables. Secrets survive a deploy.

Until both are bound, every private report except `underage_user` gets `503`
`coop_not_configured` and stays pending, and moderation-service retries it.
That shows up in three places:

- the worker's log line `[private-reports] Coop handoff not configured:
  COOP_URL, COOP_USER_TYPE_ID unset`, naming whichever are missing (`npx
  wrangler tail --config wrangler.<env>.toml`);
- the report's `private_report_intake` row, with `last_error =
  'coop_not_configured'` and `completed_at` still NULL;
- moderation-service's own log of the 503 and its code.

**Storage.** One `private_report_intake` row per reporter and `reportId`: the
reported and reporting accounts, the type, the gift wrap id, whether an excerpt
exists, the outcome and case id, and attempt timestamps.

**Retention.** The hourly retention run clears the reporter link
(`reporter_pubkey` and `gift_wrap_id`) from completed and expired unfinished rows, on the
schedules below. A redacted row keeps `reportId`, the reported account, the
type and the outcome, which is what answers a late resend (see Idempotency);
nothing is written back. An unfinished row keeps its link for at most 365 days
from first receipt. The retained `reportId` is the lookup token described above,
not a gift-wrap event id.

- *An under-16 report's row follows its age-review case.* The
  `private-report-redaction` stage clears the link once the case is redacted,
  30 days after it closes, or no longer exists. A legal hold that keeps the
  case's detail keeps the link too.
- *A Coop handoff's link is cleared a year after the handoff completed.* The
  `private-report-coop-redaction` stage does this (`RETENTION_DAYS.privateReportCoopLink`),
  as moderation-service deletes its own DM copy after a year. The review item
  is in Coop, so there is no case here to follow, and `retention_legal_holds`
  has no record type for these rows, so no legal hold can keep one.
- *An unfinished handoff expires a year after first receipt.* The
  `private-report-pending-redaction` stage clears its reporter and gift-wrap
  link, retaining a tombstone. A late resend answers `400 report_expired`
  instead of queueing it or writing its reporter back. This stage has no legal
  hold record type, as for the Coop-link stage.
- *The decision log never names a private reporter.* The
  `age_review_case_created` row an under-16 private report writes carries the
  `reportId` and no `reporter_pubkey`. `moderation_decisions` has no disposal
  stage, so it must not hold a link retention is meant to clear. A kind-1984
  report's row still records its reporter, whose report is public on the relay.

---

### GET /api/check-result/:sha256

Check the moderation status of a media file. The worker passes moderation-service's answer through.

**Response, with a decision** (an excerpt; the full record also carries `blocked`, `quarantined`, `age_restricted`, `needs_review`, `provider`, `scores`, `categories`, `videoseal` and `moderated_at`):
```json
{
  "sha256": "<64-char hex>",
  "status": "permanent_ban",
  "moderated": true,
  "action": "PERMANENT_BAN",
  "reviewed_by": "...",
  "reviewed_at": "..."
}
```

**Response, with no decision:** a 200 with no `action`.
```json
{
  "sha256": "<64-char hex>",
  "status": "unknown",
  "moderated": false,
  "blocked": false,
  "age_restricted": false
}
```

**Errors**, all `{ "success": false, "error": "..." }`:

| Status | When |
|--------|------|
| 400 | `Invalid sha256`: the path is not a 64-character hex hash. |
| 502 | `Moderation service error: 404`: moderation-service rejected the request (for example an unknown host). It returns 404 only then, never for "no decision". |
| Upstream status | `Moderation service error: <status>`: any other moderation-service error, passed through. |
| 500 | The error's message: the call failed, or the reply was not JSON. |

A caller must treat any error as "status unknown", never as "no decision": read as open, a blocked file would be offered Age Restrict, which weakens it.

---

## Zendesk Integration

### POST /api/zendesk/webhook

> **Retired (#103).** This inbound moderation-execution endpoint has been removed from the worker. Moderation happens in Relay Manager, not Zendesk. The Zendesk-side trigger, webhook, and `action_requested`/`action_status` fields have been deactivated. The detail below is kept for historical context only.

Receives webhook events from Zendesk when ticket custom fields are updated.

**Headers:**
```
Content-Type: application/json
X-Zendesk-Webhook-Signature: t=1704067200,v0=abc123...
```

**Request:**
```json
{
  "ticket_id": 12345,
  "action_requested": "ban_user",
  "nostr_pubkey": "abc123...",
  "nostr_event_id": "def456...",
  "agent_email": "agent@example.com"
}
```

**Supported Actions:**
| action_requested | Description |
|------------------|-------------|
| `ban_user` | Ban the pubkey from the relay |
| `allow_user` | Remove the pubkey from ban list |
| `delete_event` | Delete the specified event |
| `mark_safe` | Mark media as safe |
| `age_restrict` | Mark media as age-restricted |

**Response:**
```json
{
  "success": true,
  "action": "ban_user",
  "message": "User banned successfully"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Invalid signature"
}
```

---

### GET /api/zendesk/context

Get moderation context for a user (used by Zendesk sidebar app).

**Query Params:**
- `pubkey` - The Nostr pubkey to look up

**Headers:**
```
Authorization: Bearer <zendesk-jwt-token>
```

**Response:**
```json
{
  "success": true,
  "pubkey": "abc123...",
  "is_banned": false,
  "ban_reason": null,
  "decision_history": [
    {
      "action": "delete_event",
      "reason": "Spam",
      "created_at": "2025-01-04T10:00:00Z"
    }
  ],
  "report_count": 3,
  "recent_events_count": 42
}
```

---

### POST /api/zendesk/action

> **Retired (#103).** This inbound moderation-execution endpoint (Zendesk sidebar) has been removed from the worker. The detail below is kept for historical context only.

Execute moderation action from Zendesk sidebar (JWT authenticated).

**Headers:**
```
Authorization: Bearer <zendesk-jwt-token>
Content-Type: application/json
```

**Request:**
```json
{
  "action": "ban_user",
  "pubkey": "abc123...",
  "event_id": "def456...",
  "ticket_id": 12345,
  "reason": "Multiple spam reports"
}
```

**Response:**
```json
{
  "success": true,
  "action": "ban_user",
  "logged": true
}
```

---

## Decision Logging

### POST /api/decisions

Log a moderation decision (called automatically by action endpoints).

**Request:**
```json
{
  "targetType": "pubkey" | "event" | "media",
  "targetId": "abc123...",
  "action": "ban_user",
  "reason": "Spam account",
  "moderatorPubkey": "<64-character hex pubkey>",
  "reportId": "report-id...",
  "zendeskTicketId": 12345
}
```

`moderatorPubkey` is optional: send a 64-character hex string, or omit it and the decision is recorded with no moderator. Any other value gets a `400`, including the worker's own `auto` marker.

---

### GET /api/decisions/:targetId

Get all decisions for a target.

**Response:**
```json
{
  "success": true,
  "decisions": [
    {
      "id": 1,
      "target_type": "pubkey",
      "target_id": "abc123...",
      "action": "ban_user",
      "reason": "Spam",
      "moderator_email": "agent@example.com",
      "created_at": "2025-01-05T12:00:00Z"
    }
  ]
}
```

---

### DELETE /api/decisions/:targetId

Delete all decisions for a target (reopen a dismissed report), and remove the
target's relay-side resolution labels (kind 1985, `L=moderation/resolution`).

**Query parameters:**

| Name | Values | Default |
|------|--------|---------|
| `targetType` | `event` \| `pubkey` | both label tags are queried |

A resolution label carries an `e` tag for an event target or a `p` tag for a
pubkey target, never both, so naming the type skips the query that could not
match. Any other value — absent, empty, wrong case, junk — falls back to
querying both, which is what an older frontend gets.

**Response:**
```json
{
  "success": true,
  "deleted": 2,
  "labelsDeleted": 1,
  "labelCleanupFailed": false
}
```

The D1 decision rows are deleted unconditionally; the relay-side label cleanup
is best-effort. `labelCleanupFailed: true` means at least one resolution label
may have survived — the label read failed, it filled its page so there may be
more beyond it, or a label was read but could not be removed. A surviving label
keeps the report hidden even though its decisions are gone, so callers must
surface this rather than reporting a clean reopen.

---

## Setting Up Zendesk Webhooks

> **Retired (#103).** The inbound moderation-execution wiring described below (the `action_requested`/`action_status` fields, the `relay moderation action` trigger, and the `relay-management` webhook) has been deactivated in Zendesk and removed from the worker. This section is kept for historical context only. The decision-reporting direction (Relay Manager → Zendesk auto-solve + internal notes) and the still-active `parse-report` / `age-review-reply` integrations are unaffected.

### 1. Create Custom Ticket Fields

In Zendesk Admin > Objects and rules > Tickets > Fields:

| Field Name | Type | Options |
|------------|------|---------|
| `nostr_pubkey` | Text | - |
| `nostr_event_id` | Text | - |
| `action_requested` | Dropdown | none, ban_user, allow_user, delete_event, mark_safe, age_restrict |
| `action_status` | Dropdown | pending, in_progress, executed, failed |
| `risk_level` | Dropdown | low, medium, high, critical |

### 2. Create Webhook

In Zendesk Admin > Apps and integrations > Webhooks:

- **Endpoint URL:** `https://api-relay-prod.divine.video/api/zendesk/webhook`
- **Request method:** POST
- **Request format:** JSON
- **Authentication:** None (signature verification used instead)

### 3. Create Trigger

In Zendesk Admin > Objects and rules > Business rules > Triggers:

**Conditions:**
- Ticket > action_requested > Changed
- Ticket > action_requested > Is not > none

**Actions:**
- Notify webhook with JSON body:

```json
{
  "ticket_id": {{ticket.id}},
  "action_requested": "{{ticket.ticket_field_<action_requested_id>}}",
  "nostr_pubkey": "{{ticket.ticket_field_<nostr_pubkey_id>}}",
  "nostr_event_id": "{{ticket.ticket_field_<nostr_event_id_id>}}",
  "agent_email": "{{current_user.email}}"
}
```

### 4. Set Environment Variables

In the per-environment `worker/wrangler.{local,staging,prod}.toml` or the
Cloudflare dashboard:

```bash
npx wrangler secret put ZENDESK_WEBHOOK_SECRET --config wrangler.prod.toml
# Enter the signing secret from Zendesk webhook settings

npx wrangler secret put ZENDESK_JWT_SECRET --config wrangler.prod.toml
# Enter a shared secret for JWT tokens (for sidebar app)
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad request - missing or invalid parameters |
| 401 | Unauthorized - invalid or missing authentication |
| 403 | Forbidden - valid auth but insufficient permissions |
| 404 | Not found - resource doesn't exist |
| 500 | Internal error - check logs |

---

## Rate Limits

Currently no rate limits are enforced, but aggressive use may trigger Cloudflare protection.

---

## Example: Curl Commands

**Ban a user:**
```bash
curl -X POST https://api-relay-prod.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "ban_pubkey", "pubkey": "abc123...", "reason": "Spam"}'
```

**Check media status:**
```bash
curl https://api-relay-prod.divine.video/api/check-result/abc123... \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET"
```

**Delete an event:**
```bash
curl -X POST https://api-relay-prod.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "delete_event", "eventId": "def456..."}'
```
