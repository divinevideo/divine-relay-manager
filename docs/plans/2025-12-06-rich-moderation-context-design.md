# Rich Moderation Context Design

## Overview

Enhance the Reports tab to provide moderators with comprehensive context for making informed decisions. Currently the Reports view shows minimal information (category, truncated ID, date). This design adds full context about the reported content, user history, thread context, and AI-powered behavioral summaries.

## Goals

1. Show moderators everything they need to make a decision without leaving the Reports view
2. Provide context about both the reporter and reported user
3. Display thread context (3 levels) with option to view full thread
4. Surface user history, previous reports, and existing labels
5. Generate AI summaries of user behavior patterns

## Layout

Split-pane layout similar to email clients:
- Left pane: Scrollable list of reports (compact cards)
- Right pane: Detail view with full context for selected report

```
┌──────────────────────────┬──────────────────────────────────────────┐
│  REPORT LIST             │  DETAIL PANE                             │
│  (scrollable)            │  - Thread Context (3 levels)             │
│                          │  - Reported User Profile + Stats         │
│                          │  - AI Summary                            │
│                          │  - Recent Posts                          │
│                          │  - Reporter Info                         │
│                          │  - Action Buttons                        │
└──────────────────────────┴──────────────────────────────────────────┘
```

## Components

### 1. ReportsList (left pane)
Compact list of reports showing:
- Category badge (Spam, CSAM, Hate, etc.)
- Target type badge (Event/User)
- Truncated target ID
- Date
- Visual indicator when selected

### 2. ReportDetail (right pane)
Full context view with sections:

#### 2a. ThreadContext
- Shows 3 levels of thread ancestry (grandparent → parent → reported post)
- Reported post highlighted with warning styling
- "View Full Thread" link opens ThreadModal

#### 2b. UserProfile
- Avatar, display name, NIP-05 verification
- Bio (truncated with expand)
- Stats: total posts, report count, label count
- Existing labels displayed as colored badges

#### 2c. AISummary
- 2-3 sentence behavioral summary
- Risk level indicator (low/medium/high/critical)
- Generated via worker endpoint
- Cached per pubkey (1hr TTL)

#### 2d. RecentPosts
- Last 5-10 posts from reported user
- Scrollable list
- Each post shows content preview, date, engagement

#### 2e. ReporterInfo
- Avatar, name
- Total reports filed (credibility signal)
- Optional: reporter trustworthiness score

#### 2f. ActionBar
- Ban User button (destructive, with confirmation)
- Create Label button (opens inline form)
- Dismiss Report button
- View on Relay link (external)

### 3. ThreadModal
Full conversation view when "View Full Thread" clicked:
- Complete thread from root to all replies
- Reported post highlighted
- Nested reply structure preserved

## Data Fetching

When a report is selected, fetch in parallel:

| Data | Nostr Query | Purpose |
|------|-------------|---------|
| Reported event | `kinds: [1], ids: [eventId]` | Show the actual content |
| Thread ancestors | Follow `e` tags with `reply` marker, 3 levels | Context |
| Reported user profile | `kinds: [0], authors: [pubkey]` | Identity |
| User's recent posts | `kinds: [1], authors: [pubkey], limit: 10` | Behavior pattern |
| Labels on user | `kinds: [1985], #p: [pubkey]` | Prior moderation |
| Reports on user | `kinds: [1984], #p: [pubkey]` | Prior flags |
| Reporter profile | `kinds: [0], authors: [reporter]` | Reporter identity |

## Worker Endpoints

### POST /api/summarize-user

Generate AI behavioral summary.

**Request:**
```typescript
{
  pubkey: string,
  recentPosts: NostrEvent[],
  existingLabels: NostrEvent[],
  reportHistory: NostrEvent[]
}
```

**Response:**
```typescript
{
  summary: string,      // 2-3 sentences
  riskLevel: "low" | "medium" | "high" | "critical"
}
```

**Implementation:**
- Uses Claude API (key stored in CF secrets)
- System prompt focuses on T&S analysis
- Caches responses in KV with 1hr TTL
- Falls back gracefully if AI unavailable

## New Hooks

### useReportContext(report: NostrEvent)
Fetches all context data for a selected report. Returns:
```typescript
{
  reportedEvent: NostrEvent | null,
  threadAncestors: NostrEvent[],
  reportedUser: { profile: NostrMetadata, stats: UserStats },
  recentPosts: NostrEvent[],
  existingLabels: NostrEvent[],
  previousReports: NostrEvent[],
  reporter: { profile: NostrMetadata, reportCount: number },
  isLoading: boolean,
  error: Error | null
}
```

### useThread(eventId: string)
Fetches complete thread for an event. Returns:
```typescript
{
  root: NostrEvent,
  replies: NostrEvent[],  // flattened with depth metadata
  isLoading: boolean
}
```

### useUserSummary(pubkey: string, posts: NostrEvent[], labels: NostrEvent[])
Fetches AI summary from worker. Returns:
```typescript
{
  summary: string,
  riskLevel: string,
  isLoading: boolean,
  error: Error | null
}
```

## File Structure

```
src/
├── components/
│   ├── Reports.tsx           # Refactor to split-pane layout
│   ├── ReportsList.tsx       # Left pane list component
│   ├── ReportDetail.tsx      # Right pane detail view
│   ├── ThreadContext.tsx     # 3-level thread display
│   ├── ThreadModal.tsx       # Full thread modal
│   ├── UserProfile.tsx       # User info + stats card
│   ├── AISummary.tsx         # AI summary display
│   ├── RecentPosts.tsx       # User's recent posts list
│   └── ReporterInfo.tsx      # Reporter details
├── hooks/
│   ├── useReportContext.ts   # All context for a report
│   ├── useThread.ts          # Full thread fetching
│   └── useUserSummary.ts     # AI summary hook
worker/
└── src/
    └── index.ts              # Add /api/summarize-user endpoint
```

## UI States

1. **No report selected**: Show placeholder in detail pane
2. **Loading**: Skeleton loaders in detail pane sections
3. **Error**: Error alert with retry option
4. **AI loading**: Spinner in summary section, rest of UI functional
5. **AI unavailable**: Graceful fallback showing "Summary unavailable"

## Future Enhancements

- Bulk actions (select multiple reports)
- Keyboard navigation (j/k to navigate, b to ban, l to label)
- Filter reports by category, date range, user
- Export moderation decisions for audit log
- Reporter reputation scoring based on accuracy
