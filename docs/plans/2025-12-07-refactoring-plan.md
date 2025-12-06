# ManVRelay Refactoring Plan

**Date:** 2025-12-07
**Status:** In Progress

## Problem Statement

The codebase has accumulated technical debt:
1. **5 files** duplicate `callRelayAPI` instead of using `adminApi.ts`
2. **4 monster components** total 3100+ lines (avg 775 lines each)
3. **CATEGORY_LABELS** duplicated in Reports.tsx and ReportDetail.tsx
4. **3 test files** exist for entire codebase - zero tests for moderation features

## Workstreams

### Workstream A: API Consolidation

**Goal:** Single source of truth for relay API calls

**Files to modify:**
- `src/components/EventsList.tsx` (lines 72-106: remove callRelayAPI)
- `src/components/UserManagement.tsx` (lines 16-52: remove WORKER_URL + callRelayAPI)
- `src/components/EventModeration.tsx` (lines 16-52: remove WORKER_URL + callRelayAPI)
- `src/components/RelayStats.tsx` (remove callRelayAPI)
- `src/components/RelaySettings.tsx` (remove callRelayAPI)

**New exports needed in adminApi.ts:**
```typescript
// Already exists, just need to export and use
export { callRelayRpc } from '@/lib/adminApi';
```

**Pattern:** Replace local `callRelayAPI(relayUrl, method, params)` with `callRelayRpc(method, params)`

### Workstream B: Component Extraction

**Goal:** Break monster files into <300 line focused components

**ReportDetail.tsx (827 lines) → Extract:**
- `ReportHeader.tsx` - Badge display, timestamps
- `ReportActions.tsx` - Ban/Delete/Mark OK buttons
- `BanConfirmDialog.tsx` - Ban confirmation with checkboxes
- `DeleteConfirmDialog.tsx` - Delete event confirmation
- `BlockMediaDialog.tsx` - Block media confirmation
- `DecisionHistory.tsx` - Shows past moderation decisions

**EventDetail.tsx (785 lines) → Extract:**
- `EventHeader.tsx` - Kind badges, timestamps
- `AuthorSection.tsx` - Author card + user stats
- `ContentSection.tsx` - Event content + media preview
- `LinkedEventsSection.tsx` - Referenced events/users
- `EventActions.tsx` - Delete/Ban buttons

**EventsList.tsx (730 lines) → Extract:**
- `EventFilters.tsx` - Search, kind filter, smart filters
- `EventCard.tsx` - Already exists inline, extract to file
- `ModerationDialog.tsx` - Moderation action dialog

### Workstream C: Test Coverage

**Goal:** TDD for critical paths

**Priority 1: adminApi.ts tests**
```typescript
// src/lib/adminApi.test.ts
describe('adminApi', () => {
  describe('banPubkey', () => {
    it('should call relay RPC with correct params');
    it('should handle network errors');
  });
  describe('deleteEvent', () => {
    it('should call relay RPC with event ID');
  });
  describe('publishLabel', () => {
    it('should construct correct NIP-32 tags');
  });
  describe('markAsReviewed', () => {
    it('should publish resolution label');
  });
});
```

**Priority 2: useModerationStatus.ts tests**
```typescript
// src/hooks/useModerationStatus.test.ts
describe('useModerationStatus', () => {
  it('should return isBanned=true when pubkey in banned list');
  it('should return isDeleted=true when event in banned events');
  it('should refetch after mutation');
});
```

**Priority 3: useDecisionLog.ts tests**
```typescript
// src/hooks/useDecisionLog.test.ts
describe('useDecisionLog', () => {
  it('should query decisions for target');
  it('should detect ban decisions');
  it('should detect delete decisions');
});
```

## Shared Constants Extraction

Create `src/lib/constants.ts`:
```typescript
// ABOUTME: Shared constants for moderation categories and labels
// ABOUTME: DTSP (Digital Trust & Safety Partnership) category mappings

export const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'nonconsensual_sexual_content': 'Non-consensual',
  // ... rest of categories
};

export const RESOLUTION_STATUSES = ['reviewed', 'dismissed', 'no-action', 'false-positive'] as const;
```

## Success Criteria

1. **Zero duplicate API code** - All relay calls go through adminApi.ts
2. **No file > 400 lines** - Monster components broken up
3. **> 80% coverage on adminApi.ts** - Critical path tested
4. **Build passes** - No regressions
