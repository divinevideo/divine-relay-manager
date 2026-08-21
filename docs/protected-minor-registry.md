# Protected-minor registry

Relay Manager is the durable authority for whether a protected-minor subject is active or cleared. Keycast's `verified_minor` value is an enforcement projection associated with the current hosted account; deleting that account does not clear the subject.

The registry deliberately stores only opaque subject and operation UUIDs, account pubkeys, age-review case provenance, lifecycle state, reasons, and timestamps. It does not copy parent contact, identity-review evidence, usernames, display names, credentials, or recovery material. Subject state and binding history are retained indefinitely until the retention review in support-trust-safety#204 defines a deletion period. Provisioning and projection-operation records are likewise retained so an old operation cannot create a second account after its idempotency record expires.

## Service API

All `/api/internal/protected-minors/*` routes accept only `Authorization: Bearer <PROTECTED_MINOR_SERVICE_TOKEN>`. Cloudflare Access browser assertions and `X-Admin-Key` do not authorize them. Infrastructure must separately allow the caller through Cloudflare Access using a service token or a path-scoped policy; the Worker bearer remains mandatory defense in depth.

- `POST /api/internal/protected-minors/resolve` accepts `{"pubkey":"<64 lowercase hex>"}` and returns either `{"classification":"active","subject_ref":"<uuid>","binding_state":"active"}` or `{"classification":"none"}`. Only these HTTP 200 responses are determinate. Database failures return 503, never a false negative.
- `POST /api/internal/protected-minors/bindings/close` accepts `subject_ref`, `pubkey`, and `deletion_attempt_id`. Exact replay returns `{"outcome":"closed"}`. Conflicting operation reuse and stale bindings return stable 409 codes.
- `POST /api/internal/protected-minors/replacements` accepts `subject_ref`, `provisioning_operation_id`, `username`, and optional `display_name`. It is disabled unless `PROTECTED_MINOR_REPLACEMENT_ENABLED=true`. Do not enable it until Keycast #385 is deployed and its replay contract has been verified.

Opaque subject references must never be logged, emitted in analytics, placed in metrics labels, or returned in errors. Resolve's successful active response is the sole intended disclosure to the deletion coordinator.

## Deployment and rollback

1. Create the `PROTECTED_MINOR_SERVICE_TOKEN` Secrets Store entry and configure the Cloudflare Access service-token path.
2. Deploy Keycast #385 before deploying Relay Manager, because onboarding now sends its provisioning operation ID for crash-safe recovery.
3. Deploy Relay Manager with replacement disabled. `ensureSchema()` creates the tables; do not run Wrangler migrations against this database.
4. Invoke `POST /api/admin/protected-minors/backfill` once in staging, inspect its counts, then repeat in production.
5. Deploy and enable Funnelcake #1118 only after resolve/close have been verified.
6. Enable replacement only after the full cross-service flow and retention gate support-trust-safety#204 are approved.

Rollback application code without dropping registry tables or idempotency records. Disabling Funnelcake and replacement callers is safe; dropping or truncating registry data is not. A rollback to a Relay Manager version that does not send provisioning operation IDs also requires confirming Keycast's transitional compatibility remains enabled.
