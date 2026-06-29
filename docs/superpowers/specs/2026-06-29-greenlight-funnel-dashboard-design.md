# Greenlight Consent Funnel Dashboard: Design

**Status:** Draft for review
**Date:** 2026-06-29
**Author:** Matthew Bradley
**Tracking:** support-trust-safety#172 (item 2)

---

## Context

Support leadership asked for a baseline on how the Greenlight 13-15 parent/teen onboarding is yielding: how many requests come in, how many verification videos are received, and how many accounts actually get authorized. We have initial ticket counts from Zendesk, but two parts of that funnel are not visible today:

- **The outcome end** (how many requests become approved, onboarded accounts) lives in the moderation tool, not in Zendesk.
- **"Verification video received"** is not recorded anywhere structured. A macro (`consent_video_received`, shipped 2026-06-29) now tags tickets when a video arrives, which makes this countable going forward.

This design adds a single funnel view that shows the whole journey, request through outcome, by combining the two systems that hold the data.

## Goal

Give an at-a-glance funnel for the 13-15 Greenlight cohort, sourced from where the data actually lives, that an admin can read or screenshot for support leadership.

Non-goals for v1: self-serve access for non-admins, perfect 1:1 reconciliation between helpdesk and moderation records, and band-perfect helpdesk counts (see Known Limitations).

## The two-source reality

The funnel spans two systems, and the exploration confirmed a clean way to read each:

- **Helpdesk side (Zendesk)** holds intake and the video signal. A built-in discriminator already runs: third-party in-app *reports* get tagged `age-review` only, while a parent or teen who reaches the helpdesk themselves gets tagged `age-review` **and** `age-review-response`. The new `consent_video_received` tag is the third signal.
- **Moderation side (relay-manager D1, `age_review_cases`)** is authoritative for outcomes. "Approved" is state `cleared`, and it splits into a restored account vs a brand-new approved minor account (`created_via = 'minor_onboarding'`). "Denied/expired" is state `denied_closed`. Keycast only stores per-user status with no aggregates, so D1 is the single outcome source.

The seam: not every helpdesk request becomes a moderation case, and the two sides do not join 1:1. That is expected for a funnel, which shows drop-off rather than a single ledger.

## Funnel stages

| Stage | Plain meaning | Source | Query basis |
|---|---|---|---|
| Reports in (feeder) | someone flagged a possible under-16 account | Zendesk | `tags:age-review -tags:age-review-response` |
| Requests in | a parent or teen reached the helpdesk to verify consent | Zendesk | `tags:age-review-response` |
| Video received | a consent video arrived (attachment or link) | Zendesk | `tags:consent_video_received` |
| In progress | open moderation case, not yet resolved (under review, restricted, or awaiting response) | relay-manager D1 | non-terminal states, band `age_13_15` |
| Approved | account authorized (restored, or new approved minor) | relay-manager D1 | `state = cleared`, split by `created_via` |
| Denied / expired | closed without approval, or 15-day clock lapsed | relay-manager D1 | `state = denied_closed` |

Relevant D1 values (verified): states `open_reported`, `under_moderator_review`, `restricted_pending_user_response`, `restricted_pending_parental_consent`, `restricted_pending_support_email`, `submitted_for_review`, `needs_follow_up`, `cleared`, `denied_closed`; age bands `under_13`, `age_13_15`, `age_16_plus_claimed`; `created_via` of `report` or `minor_onboarding`.

## Architecture

The build separates into three cleanly independent parts. v1 delivers the first two; the third is an additive follow-on.

### 1. Data endpoint (the syndication contract)

`GET /api/age-review/funnel?age_band=age_13_15` in relay-manager.

Relay-manager is the right home because it already holds both ingredients: the `age_review_cases` D1 table and Zendesk API credentials (its existing `zendesk-sync` code). The endpoint assembles counts from both sources and returns a small, self-describing payload. It is guarded like the other admin routes (CF Access JWT, or `X-Admin-Key` matching `ADMIN_API_KEY` for server-to-server callers, the same path moderation-service already uses).

Data assembly:

- **D1 (band-accurate):** one grouped query
  ```sql
  SELECT state, created_via, COUNT(*) AS c
  FROM age_review_cases
  WHERE suspected_age_band = 'age_13_15'
  GROUP BY state, created_via;
  ```
  Bucketed in code: `in_progress` = all non-terminal states; `approved.total` = `cleared`, split into `new_minor` (`created_via = 'minor_onboarding'`) and `restored` (everything else cleared); `denied_expired` = `denied_closed`.
- **Zendesk (Search API counts):** one count query per signal (`age-review-response`, `consent_video_received`, and `age-review -age-review-response` for the feeder).

Response shape:
```json
{
  "success": true,
  "age_band": "age_13_15",
  "helpdesk": {
    "source": "zendesk",
    "band_scope": "all_bands",
    "reports_in": 0,
    "requests_in": 0,
    "video_received": 0
  },
  "moderation": {
    "source": "d1",
    "band_scope": "age_13_15",
    "in_progress": 0,
    "approved": { "total": 0, "restored": 0, "new_minor": 0 },
    "denied_expired": 0
  },
  "generated_at": "2026-06-29T00:00:00Z"
}
```

**Graceful degradation:** if the Zendesk call fails, the endpoint still returns the moderation (D1) section and nulls the helpdesk section, mirroring how the dashboard's existing `collectTrustStats` degrades. The moderation outcome is the more important half and must never be blocked by a Zendesk hiccup.

### 2. v1 renderer: relay.admin.divine.video (relay-manager UI)

A compact funnel panel in the existing Age Review tab (`AgeReview.tsx` header area), rendered from the endpoint above. Reuses the existing shadcn primitives (Card, Badge). Stages shown in order with counts and a light bar indicating relative drop-off, titled so it reads as Greenlight-specific.

This is the surface the owner controls and deploys, so v1 ships and gets acceptance here with a single PR, with no dependency on the admin.divine.video deploy path.

### 3. v2 syndication: admin.divine.video Pulse card (follow-on)

`divine-admin-dashboard` is already a cached fan-out aggregator: it pulls stats from the constituent admin tools and the relay, caches them in its `STATS_CACHE` KV, and renders "Product + Trust Pulse" cards (for example, "Pending reports" is sourced by querying the relay). Syndicating the funnel is additive:

- add the funnel endpoint to the existing fan-out (`collectAdminStats`),
- render a "Greenlight: age-review consent funnel" card next to "Pending reports."

The dashboard worker calls the relay-manager endpoint server-to-server with `X-Admin-Key`, so it needs the relay-manager `ADMIN_API_KEY` as a secret binding (set via `wrangler secret`, not committed). This step is gated only on admin.divine.video deploy access and does not block v1.

## Known limitations (v1)

1. **Helpdesk band ambiguity.** Zendesk does not tag age band, so the three helpdesk stages count all age-review tickets, not strictly 13-15. In practice this is dominated by the 13-15 flow. The moderation stages are band-accurate. Flagged in the payload via `band_scope`.
2. **Top and bottom do not reconcile to one number,** by design. A request and an outcome are not the same record. Presented as funnel drop-off, not a ledger.
3. **Video stage is only as complete as macro use,** including back-fill of already-handled cases. The webform (item 3 below) eventually retires this dependency.
4. **Zendesk Search is eventually consistent and rate-limited.** Acceptable for an admin dashboard; add light caching if call volume warrants.
5. **Admin-gated access.** relay.admin.divine.video is behind CF Access, so this is for admins and screenshots, not self-serve reporting for support leadership.

## Follow-ons

- **Band tags on the three age-review email triggers** (Zendesk trigger ids `16124091415311`, `16124092809743`, `16124126362127`) so the helpdesk stages can filter to 13-15. Fastest path to closing limitation 1.
- **Per-case video join** via the `zendesk_ticket_id` already stored on each case, for a band-accurate video stage.
- **v2 syndication** to the admin.divine.video Pulse card (section 3).
- **Verification webform** (support-trust-safety#172 item 3): structured consent submission that makes intake and video first-class and removes the manual macro dependency.

## Testing

- **relay-manager endpoint:** unit tests for the bucketing logic (state to stage, `created_via` split) against mocked D1 group-by rows, and for graceful degradation when the Zendesk client throws. Follow the existing `worker/src/age-review.test.ts` patterns.
- **relay-manager UI:** a light render test of the panel with a sample payload.
- No exhaustive UI coverage; focus on the aggregation and degradation logic, which is where a regression would actually mislead the numbers.

## Confidence

High. Every piece reuses a verified existing path: the D1 query (relay-manager already lists cases), the Zendesk Search call (relay-manager already calls Zendesk), server-to-server auth (already used by moderation-service), and card rendering plus KV caching on the dashboard side (already done for "Pending reports").
