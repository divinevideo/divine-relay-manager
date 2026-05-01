# Product + Trust Stats Dashboard Design

## Goal

Give the relay admin team a quick sense of how diVine is going from inside the existing moderation dashboard: product activity, video publishing, views/loops, and current trust workload.

## Constraints

- Do not require changes to `divine-funnelcake`.
- Use existing Funnelcake REST endpoints only.
- Keep missing product telemetry visible but honest. Registrations and logins should not be fabricated.
- Keep the feature inside `divine-relay-manager`; no new app.

## Recommended Approach

Add a relay-manager worker aggregate endpoint, then build two frontend surfaces from that one payload.

The worker endpoint, tentatively `GET /api/dashboard-stats`, will normalize:

- Existing Funnelcake `/api/stats`
- Existing Funnelcake `/api/leaderboard/videos?period=day`
- Existing Funnelcake `/api/leaderboard/creators?period=day`
- Existing relay WebSocket queries for recent video posts
- Existing reports and resolution-label queries for trust workload
- Placeholder metadata for registrations/logins when no source is wired

The frontend should not make multiple low-level stats calls directly. It should call the aggregate endpoint and render a consistent loading/error/partial-data state.

## Dashboard Pulse

Add `DashboardPulse` near the top of the existing admin shell, above tab content. It should summarize:

- Active users: unique pubkeys with recent video publishing activity, plus view activity if a real source is available
- Video posts: last hour and last 24 hours
- Views / loops: last 24 hours from existing Funnelcake leaderboard/stat data where available
- Pending reports: unresolved report targets from the current moderation queue

Each card should show whether its data is live, partial, or unavailable. The top strip links to `/stats`.

## Stats & Trends Page

Add a new in-app tab/route named `Stats & Trends`.

The detailed page should include:

- KPI cards for the same product + trust metrics
- A trend section for hourly/daily buckets when the worker can compute them from existing data
- Top videos today from existing Funnelcake leaderboard data
- Top creators today from existing Funnelcake leaderboard data
- Data source status, including unavailable registrations/logins

This page should be useful even if registration/login telemetry is not wired yet.

## Data Definitions

Video kinds should follow the app's existing NIP-71 convention: `21`, `22`, `34235`, `34236`.

Recent publishing metrics can be computed from relay queries using `since` timestamps.

Active users for v1 means unique pubkeys with recent video publishing activity. If kind `22236` view events are available through the relay without excessive cost, the worker may add unique viewers; otherwise the UI should label the metric as publishing activity.

Views and loops should come from existing Funnelcake responses where they already exist. The relay-manager worker must not infer or backfill them from raw data in a way that changes Funnelcake semantics.

Registrations and logins should render as unavailable until an existing auth telemetry source is identified.

## Error Handling

The aggregate endpoint should return partial results when one upstream source fails. Each metric group should include a status and optional message so the UI can show useful cards instead of a full-page failure.

Suggested statuses:

- `live`
- `partial`
- `unavailable`
- `error`

The UI should keep the moderation dashboard usable when stats fail.

## Testing

Worker tests should cover:

- Proxies existing Funnelcake stats and leaderboards
- Computes recent video post counts from mocked relay responses
- Computes pending trust workload from mocked reports/resolution labels
- Returns partial results when Funnelcake fails
- Marks registrations/logins unavailable without failing the endpoint

Frontend tests should cover:

- Top pulse renders live metrics
- Unavailable metrics render clearly
- `/stats` route is available from the tab list and pulse link
- Detailed page renders top videos/creators and data-source status

## Out Of Scope

- `divine-funnelcake` migrations, handlers, or schema changes
- A separate product analytics app
- New registration/login instrumentation
- Raw ClickHouse access from relay-manager
