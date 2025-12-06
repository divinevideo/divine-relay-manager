# Events View Enhancement Design

## Problem

The Events tab shows minimal information per event, making it hard to:
1. **Proactive patrol** - spot problems before they're reported
2. **Quick triage** - understand context when coming from Reports tab
3. **Search & investigate** - find specific content or users

Current issues:
- No split-pane layout (Reports tab has this, Events doesn't)
- Reporter identities are truncated pubkeys with no profile info
- Raw JSON shown for kind 0 (profile) and kind 3 (contacts) events
- No way to filter by "has reports", "new users", "has media"
- No search by pubkey or content
- No link between Events and Reports tabs

## Solution

### Layout: Split-Pane with Search

```
┌─────────────────────────────────────────────────────────────────────┐
│  Events & Moderation                                    [Refresh]   │
├─────────────────────────┬───────────────────────────────────────────┤
│  Search + Filters       │   Event Detail (right pane)              │
│  Event List (compact)   │   - Thread context                        │
│                         │   - User profile card                     │
│                         │   - Related reports                       │
│                         │   - Action buttons                        │
└─────────────────────────┴───────────────────────────────────────────┘
```

### Left Pane Components

**Search Bar:**
- Search by pubkey (hex or npub)
- Search by content text
- Search by NIP-05 identifier

**Smart Filters:**
- Kind filter (existing)
- Limit filter (existing)
- NEW: "Has reports" checkbox
- NEW: "New users (<7 days)" checkbox
- NEW: "Has media" checkbox

**Compact Event Cards:**
- Avatar + display name
- Truncated content preview (kind-aware rendering)
- Kind badge
- Timestamp
- Report indicator (flag icon if user/event has reports)
- Selected state highlighting

### Right Pane Components

Reuse existing components from ReportDetail:
- `ThreadContext` - show ancestors for replies
- `UserProfileCard` - full profile with stats
- `AISummary` - if available
- Related reports section with clickable reporters

**New: Clickable Reporter Cards**
```
┌────────────────────────────────────────────────────────┐
│ [avatar] @alice_moderator          Other    12/6/2025 │
│          npub1c9bb91...                                │
│          42 reports filed · trusted reporter           │
│          [View Profile] [View Their Posts]             │
└────────────────────────────────────────────────────────┘
```

Each reporter shows:
- Avatar + display name (via useAuthor)
- npub (truncated, copyable)
- Report count: "X reports filed"
- Trust indicator: new vs established
- Actions: View Profile, View Their Posts

### Action Buttons

- View All by User (filters event list)
- Delete Event
- Ban User
- View in Reports (cross-link)
- Create Label

### Content Rendering by Kind

| Kind | Display |
|------|---------|
| 0 (Profile) | Parse JSON, show name/about/picture fields |
| 1 (Note) | Show content with NoteContent renderer |
| 3 (Contacts) | Show "Following X users" summary |
| 1984 (Report) | Show "Report: [category]" + target |
| 30311 | Show d-tag or first meaningful tag |
| Other | Truncated content or "[No content]" |

## Implementation Plan

1. Create `EventDetail.tsx` - right pane component
2. Create `EventSearch.tsx` - search bar component
3. Create `EventFilters.tsx` - smart filter checkboxes
4. Create `ReporterCard.tsx` - clickable reporter with profile
5. Refactor `EventsList.tsx` to split-pane layout
6. Add `useReporterStats` hook for report counts
7. Update `EventCard` for compact mode + kind-aware content
8. Add cross-linking between Events and Reports tabs

## Components to Reuse

From ReportDetail/Reports:
- `UserProfileCard`
- `ThreadContext`
- `AISummary`
- `ThreadModal`
- `useReportContext` (adapt for events)

## New Hooks Needed

- `useEventReports(eventId | pubkey)` - fetch reports for event/user
- `useReporterStats(pubkey)` - fetch reporter's report history
- `useEventSearch(query, filters)` - search with smart filters
