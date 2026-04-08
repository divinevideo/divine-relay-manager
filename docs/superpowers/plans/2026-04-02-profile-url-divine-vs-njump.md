# Profile URL Routing: divine.video vs njump.me

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop linking to empty `divine.video/profile/{npub}` pages for Nostr users who never used Divine. Route to `njump.me/{npub}` when we can't confirm the user is on Divine; route to `divine.video/profile/{npub}` when we can.

---

## Background & Research

### The problem

`getDivineProfileUrl(npub)` always returns `https://divine.video/profile/{npub}`. When a report comes from a Nostr user who has never used Divine (e.g., spam from a foreign relay, or a reporter who uses another client), that profile URL is blank. Moderators click through and see nothing.

This was surfaced during report context analysis (Apr 2, 2026) while reviewing Aleysha's batch of flagged reports.

### Why Funnelcake hit is the right signal

Funnelcake's `/api/users/{pubkey}` endpoint queries `user_profiles_latest_data`, which is populated from kind 0 events stored in `events_local` (the relay's own event store). A Funnelcake hit means:

- The user's profile event is on the relay
- Their profile data is available and usable

It is **not** a guarantee the user is a Divine app user (kind 0s can arrive via gossip), but it's the strongest practical signal we have without a dedicated registration table.

**NIP-05 domain check alone is insufficient** because:
- Divine users can set a non-`divine.video` NIP-05
- Divine users may have no NIP-05 at all
- NIP-05 verification is async and may lag

**Rule:** If `useAuthor` resolved via Funnelcake REST (i.e., Funnelcake has their profile), link to `divine.video/profile/{npub}`. Otherwise fall back to `njump.me/{npub}`.

This is a graceful degradation — we're not trying to be 100% precise about "real Divine users". We're trying to avoid sending moderators to empty pages.

### Existing infrastructure

- `useAuthor` already tries Funnelcake REST first (`fetchFunnelcakeUser`), then falls back to WebSocket
- It does **not** currently expose which path succeeded
- `getDivineProfileUrl` is called in 11 call sites across 9 components — all unconditional

---

## Implementation Plan

### Step 1 — Extend `useAuthor` return type

**File:** `src/hooks/useAuthor.ts`

Add `isFunnelcakeUser: boolean` to the return type. Set to `true` when the Funnelcake REST path succeeds, `false` otherwise.

```ts
// Return type changes from:
{ event?: NostrEvent; metadata?: NostrMetadata }
// to:
{ event?: NostrEvent; metadata?: NostrMetadata; isFunnelcakeUser: boolean }
```

Implementation diff (sketch):

```ts
// Try REST first for speed
if (apiUrl) {
  const restResult = await fetchFunnelcakeUser(apiUrl, pubkey);
  if (restResult) {
    return { event: undefined, metadata: restResult.metadata as NostrMetadata, isFunnelcakeUser: true };
  }
}

// Fall back to WebSocket
// ...existing code...
return { metadata, event, isFunnelcakeUser: false };

// Also in empty/error cases:
return { isFunnelcakeUser: false };
```

### Step 2 — Add `getProfileUrl` helper to `constants.ts`

**File:** `src/lib/constants.ts`

Add a new helper alongside `getDivineProfileUrl` (keep the old one for places that don't have `isFunnelcakeUser`):

```ts
export const NJUMP_PROFILE_URL = "https://njump.me";

/**
 * Returns a profile URL for display in the moderation UI.
 * Prefers divine.video when we can confirm the user is indexed by Funnelcake
 * (i.e., their profile exists on the relay). Falls back to njump.me for
 * Nostr users we can't confirm are Divine users, to avoid linking to empty pages.
 */
export function getProfileUrl(npub: string, isFunnelcakeUser: boolean): string {
  return isFunnelcakeUser
    ? `${DIVINE_PROFILE_URL}/${npub}`
    : `${NJUMP_PROFILE_URL}/${npub}`;
}
```

### Step 3 — Update call sites

The 11 call sites fall into two categories:

**Category A: Components that use `useAuthor`** (have access to `isFunnelcakeUser`):
- `UserIdentifier.tsx` — line 86, line 328
- `ReporterInfo.tsx` — line 49, line 97
- `ReporterCard.tsx` — line 48, line 298
- `UserProfilePreview.tsx` — line 40

For these: replace `getDivineProfileUrl(npub)` with `getProfileUrl(npub, isFunnelcakeUser)` using the value from `useAuthor()`.

**Category B: Components that receive pubkey/metadata props but don't call `useAuthor` directly**:
- `UserProfileCard.tsx` — line 104
- `BannedUserCard.tsx` — line 86
- `ThreadModal.tsx` — line 81
- `EventsList.tsx` — line 128
- `ThreadContext.tsx` — line 76

For these: two options:
1. Add `isFunnelcakeUser?: boolean` prop, defaulting to `false` (conservative — shows njump for unknowns)
2. Leave as `divine.video` (current behavior, no regression)

**Recommendation:** Start with Category A only. That covers the report detail and reporter views — exactly where Aleysha is hitting empty pages. Category B components (thread, events list, banned user cards) are lower priority and have different contexts; update separately.

### Step 4 — Test

- Add a test to `useAuthor` confirming that a successful Funnelcake REST response sets `isFunnelcakeUser: true`
- Add a test confirming that a WebSocket fallback sets `isFunnelcakeUser: false`
- `getProfileUrl` is pure — no test needed beyond a sanity check

---

## Out of Scope (noted, not doing now)

- **Reporter client detection** (Divine app vs. external relay): separate feature, requires inspecting the relay origin in the NIP-56 event or the source relay tag
- **Events not on our relay**: the "reported event isn't on our relay" warning — separate indicator, separate work
- **Funnelcake user registration table**: if Sam ever adds a `registered_users` table to ClickHouse, the signal could be stronger; for now, Funnelcake profile hit is good enough
- **NIP-05 badge on profile links**: showing a `divine.video` NIP-05 badge alongside the link — lower priority, easy add-on

---

## Files to Change

| File | Change |
|------|--------|
| `src/hooks/useAuthor.ts` | Add `isFunnelcakeUser: boolean` to return |
| `src/lib/constants.ts` | Add `getProfileUrl(npub, isFunnelcakeUser)` |
| `src/components/UserIdentifier.tsx` | Use `getProfileUrl` with `isFunnelcakeUser` |
| `src/components/ReporterInfo.tsx` | Use `getProfileUrl` with `isFunnelcakeUser` |
| `src/components/ReporterCard.tsx` | Use `getProfileUrl` with `isFunnelcakeUser` |
| `src/components/UserProfilePreview.tsx` | Use `getProfileUrl` with `isFunnelcakeUser` |
| `src/hooks/useAuthor.test.ts` | Add tests for `isFunnelcakeUser` flag |
