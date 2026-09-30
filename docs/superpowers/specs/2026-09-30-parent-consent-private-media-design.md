# Parent-consent private media design

## Decision and scope

The in-app parent-consent endpoint keeps its mobile contract: `POST /v1/minor-review-cases/{caseId}/parent-consent` with multipart `email` and `video`, authenticated with NIP-98. The video will be stored in a private Cloudflare R2 bucket. Zendesk will receive a private ticket comment with a reviewer link instead of an attachment. The existing email and private-link fallback remains available.

This replaces the 50 MB Zendesk attachment implementation in draft PR #286. The route in divine-router PR #33 remains valid. The mobile recording flag stays off until both routes, storage, reviewer access, and the health probe are deployed and checked.

## Upload and state transition

1. Authenticate the NIP-98 event and load the case by ID and pubkey. Preserve the existing owner, age-band, terminal-state, and transition checks.
2. Accept only multipart `email` and one nonempty `video/*` part. Enforce an 80 MB video cap and an 82 MB request cap. Reject a declared oversize request before reading; count bytes while streaming to enforce the cap when length is absent or false. Parse multipart incrementally and stream the video to R2; never call `request.formData()` on the full recording.
3. Create one D1 submission row and a stable, opaque R2 object key before writing the object. Use a conditional lease so parallel requests cannot upload or comment twice. A retry checks R2 for the existing object and resumes from its recorded stage. On an ambiguous outcome, reconcile against R2 and Zendesk before another write; stop for manual reconciliation if provider idempotency has expired.
4. Put the object into a private R2 bucket with its media type and a bounded size. The bucket has no public domain or public access setting. The object key is random and carries no pubkey, email, or case ID.
5. Create or update the case's Zendesk ticket with a private comment containing an opaque reviewer URL. Verify the ticket comment is present. Only then CAS the case to `submitted_for_review`, pause its clock, and increment its version. Zendesk or R2 failure returns a retryable error and leaves the case in its prior state. Repeated calls after a completed submission return success without creating another object, ticket, or comment.

## Reviewer access

The private comment links to `GET /api/age-review/consent-video/{receiptId}` on the Worker host. A dedicated Cloudflare Access application covers that path and allows only the approved Trust & Safety reviewer group; it must not admit service tokens or the broader relay-admin group. The Worker independently verifies the Access JWT signature, issuer, and exact audience using Cloudflare's rotating JWKS. It does not accept `X-Admin-Key` or mere presence of `Cf-Access-Jwt-Assertion` for this route. An opaque receipt ID selects the D1 row and private R2 object; the URL grants no access without the verified reviewer identity.

The viewer streams the object with bounded Range support for video seeking. It returns `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. It logs no case identifiers, pubkeys, parent email, receipt ID, or signed URL. A deleted or missing object returns 404. The reviewer route is separate from the mobile route and does not pass through divine-router.

## Retention and holds

Delete the R2 object 120 days after the linked case's `closed_at`. The existing hourly retention job processes a bounded batch, deletes the R2 object first, then records disposal in D1; a failed delete remains retryable. The existing `retention_legal_holds` table can pause this stage using `record_type = 'age_review_case'`, the case ID, and `disposal_stage = 'consent_video'` (or `all`). Case deletion must wait until the media row is disposed. Active cases retain their clips until closure. Abandoned, unlinked uploads receive a separate bounded cleanup rule so they cannot remain indefinitely; this rule must not delete a clip that a still-open review relies on. Retention tests cover due, early, held, failed, and retried deletion.

The bucket must not use a fixed age-based lifecycle rule as the primary deletion mechanism: the 120-day clock starts at case closure, not upload. Operational monitoring must alert on overdue objects or repeated deletion failures. The deployment must verify the private bucket setting and the Access reviewer policy before enabling the mobile flag.

## Deployment and verification

Create separate private R2 buckets for staging and production, bind each in its Wrangler config, and configure the dedicated Access path application and JWT audience/issuer. These are deployment prerequisites; a missing binding or JWT configuration must fail closed. Do not expose bucket credentials in the repository.

Add Worker tests for owner and state validation, MIME and both size bounds, a roughly 60 MB streamed upload, R2 failure, ticket creation and update, retry/idempotency, JWT denial and allowance, video Range responses, and retention including legal holds. Keep the router tests from PR #33. Run Worker typecheck, lint, unit tests, D1 tests, and the endpoint health workflow. In staging, submit a real clip larger than 50 MB through `api.divine.video`, confirm that an approved reviewer can play it from the Zendesk private comment, confirm an unapproved account cannot, and confirm the case transition and retention metadata. Keep `FF_MINOR_CONSENT_IN_APP_RECORDING` off until these checks pass.

## Known operational boundary

The current Worker has no R2 binding or case-specific reviewer authorization. Existing generic admin authorization trusts header presence and is unsuitable for this sensitive viewer. The dedicated Access policy and Worker-side JWT verification are required together. A real production review clip must not be accepted before the bucket, access policy, and deletion job are active.
