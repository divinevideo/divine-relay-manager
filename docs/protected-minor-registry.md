# Protected-minor registry

Relay Manager is the durable authority for whether a protected-minor subject is active or cleared. Keycast's `verified_minor` value is an enforcement projection associated with the current hosted account; deleting that account does not clear the subject.

The registry deliberately stores only opaque subject and operation UUIDs, account pubkeys, age-review case provenance, lifecycle state, reasons, and timestamps. It does not copy parent contact, identity-review evidence, usernames, display names, credentials, or recovery material. The approved schedule in support-trust-safety#204 keeps active subjects indefinitely, then retains false-positive clearances for 30 days and other or unclassified clearances for one year. Closed bindings follow the same reason-sensitive floor. Completed projection jobs expire after 30 days. Terminal provisioning detail is compacted after 30 days into a service-keyed, non-directly-linkable replay tombstone; pending work never expires and alerts after 24 hours.

Age-review claim links are cleared at link expiry or case closure. Contact, captured identity, reporter/moderator references, and narrative are redacted 30 days after closure; the minimized decision record expires after one year unless an active classification still depends on it. Scoped legal holds pause only their named disposal stage and do not reset any retention clock or change classification state.

## Approval from age review

Approving a 13-15 age-review case (`PATCH /api/age-review/cases/:id` with `state: "cleared"` and `resolution: "approved_minor"`) records the account as a protected minor, the same state onboarding creates. In the same D1 batch as the case update it creates an active subject bound to the case pubkey, or reuses the active subject that pubkey already holds, and arms that subject's projection job. A `not_minor` clear records nothing. `resolution` is required whenever `state` is `cleared`, and an approval needs the case's pubkey to be 64 lowercase hex.

One projection job per subject carries whatever the subject last became. The job projects an `active` subject as a Keycast `PUT` of `verified_minor` and a `cleared` subject as a `DELETE`, inline right after the write and from the cron for any job still pending. Latest decision wins: a denial's clear leaves the subject active when a newer explicit approval exists for it, and after every projection that lands the worker re-arms the opposite projection if a racing writer left Keycast disagreeing with D1.

Two outcomes settle a job without a Keycast change. An account with no Keycast row (self-custody) has nothing to flag, so nothing retries it; it is still a registry subject, so later under-16 reports auto-clear. A row with no login credentials is refused with `account_unclaimed` until the account is claimed. That job is settled too, so it is not re-sent every tick and never counts as overdue, but it is stamped and the cron tries it again once an hour, for as long as the pubkey is the live binding of an active subject. The flag is therefore set within about an hour of the account being claimed, with no moderator action. When the refusal answers the approval's own call, the moderator is told the flag is not applied yet; when a cron try gets it, it is only logged.

## Service API

All `/api/internal/protected-minors/*` routes accept only `Authorization: Bearer <PROTECTED_MINOR_SERVICE_TOKEN>`. Cloudflare Access browser assertions and `X-Admin-Key` do not authorize them. Funnelcake must also authenticate at the edge with a dedicated Cloudflare Access service token. The Worker bearer remains mandatory defense in depth and must be distinct from both Access token values.

The Access application is scoped only to `/api/internal/protected-minors/*` on each Relay Manager API hostname. Do not attach this service identity to the hostname-wide application and do not add a hostname-wide or path-scoped Bypass policy. The path boundary prevents the deletion coordinator's identity from authorizing unrelated moderator APIs. The configuration owner and operating procedure are recorded in [Protected-minor edge authentication](protected-minor-edge-auth.md).

- `POST /api/internal/protected-minors/resolve` accepts `{"pubkey":"<64 lowercase hex>"}` and returns either `{"classification":"active","subject_ref":"<uuid>","binding_state":"active"}` or `{"classification":"none"}`. Only these HTTP 200 responses are determinate. Database failures return 503, never a false negative.
- `POST /api/internal/protected-minors/bindings/close` accepts `subject_ref`, `pubkey`, and `deletion_attempt_id`. Exact replay returns `{"outcome":"closed"}`. Conflicting operation reuse and stale bindings return stable 409 codes.
- `POST /api/internal/protected-minors/replacements` accepts `subject_ref`, `provisioning_operation_id`, `username`, and optional `display_name`. The previous active binding must already be closed; otherwise the request returns HTTP 409 `stale_binding` without calling Keycast. It is disabled unless `PROTECTED_MINOR_REPLACEMENT_ENABLED=true`. Do not enable it until Keycast #385 is deployed and its replay contract has been verified.

After provisioning detail is compacted, exact operation replays return the stable `provisioning_operation_compacted` outcome without calling Keycast or creating a new account. Reusing the operation ID with different request parameters remains `provisioning_operation_conflict`. The tombstone key is a dedicated `PROTECTED_MINOR_TOMBSTONE_KEY` Secrets Store binding. A plain value is treated as key `v1`; rotation uses `{"active_key_id":"v2","keys":{"v1":"...","v2":"..."}}`, retaining every key ID referenced by a tombstone. Tombstone necessity is reviewed at least annually while operation IDs remain unbounded.

Opaque subject references must never be logged, emitted in analytics, placed in metrics labels, or returned in errors. Resolve's successful active response is the sole intended disclosure to the deletion coordinator.

## Deployment and rollback

1. Create the `PROTECTED_MINOR_SERVICE_TOKEN` Secrets Store entry, then complete the environment's Cloudflare Access and caller configuration in [Protected-minor edge authentication](protected-minor-edge-auth.md).
2. Deploy Keycast #385 before deploying Relay Manager, because onboarding now sends its provisioning operation ID for crash-safe recovery. Deploy Keycast #433 (the `PUT /api/admin/users/:pubkey/verified-minor` route) before moderators approve cases. Relay Manager is safe to deploy first: approvals still record, their set jobs stay pending and converge once the route exists, and a job pending for more than 24 hours alerts.
3. Create the dedicated `PROTECTED_MINOR_TOMBSTONE_KEY` Secrets Store value in staging and production, then deploy Relay Manager with replacement disabled. `ensureSchema()` creates and heals the tables; do not run Wrangler migrations against this database. Missing tombstone key material pauses compaction and alerts rather than deleting replay detail.
4. Invoke `POST /api/admin/protected-minors/backfill` in staging and inspect its counts, then repeat in production. If a row exposes an integrity conflict, resolve it and rerun; committed rows are skipped by source case ID.
5. Deploy and enable Funnelcake #1118 only after resolve/close have been verified.
6. Enable replacement only after the full cross-service flow and retention gate support-trust-safety#204 are approved.

Rollback application code without dropping registry tables or idempotency records. Disabling Funnelcake and replacement callers is safe; dropping or truncating registry data is not. A rollback to a Relay Manager version that does not send provisioning operation IDs also requires confirming Keycast's transitional compatibility remains enabled.
