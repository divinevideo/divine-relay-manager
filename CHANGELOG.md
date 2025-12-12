# Changelog

All notable changes to ManVRelay will be documented in this file.

## [Unreleased]

### Added
- **Report sorting and filtering** - Comprehensive queue management for moderators
  - Sort by: Most Reports, Most Reporters, Newest, Oldest, By Category
  - Filter by target type: All, Users only, Events only
  - Filter by category with clickable chips
  - High-priority categories (CSAM, threats, terrorism) shown first when sorting by category
- **Priority indicators** - Visual highlighting for urgent reports
  - Red highlighting for high-priority reports (CSAM, threats, terrorism, non-consensual content)
  - Orange highlighting for medium-priority reports (doxxing, malware, illegal goods)
  - Priority badge shown on high-severity reports
- **Repost content display** - Shows original content when report is on a repost (kind 6/16)
  - Fetches and displays the original event that was reposted
  - Shows original author with profile info
  - Includes media from the original post for moderation
  - Media hashes from both repost and original are available for blocking

### Fixed
- **Hide resolved now works** - Fixed multiple issues preventing the filter from working
  - Added error handling to decisions query (was silently failing)
  - Individual "All" view now filters resolved reports (was only filtering Grouped view)
  - Added detailed debug logging for resolved targets breakdown
- **Debug page crash** - Fixed React error when rendering banned pubkeys
  - Relay returns objects `{pubkey, reason}` not strings
  - Added `BannedPubkeyEntry` type to normalize responses
  - Updated DebugPanel and Reports to handle new format

## [0.3.0] - 2025-12-07

### Added
- **Split-pane Reports view** - Master-detail layout for efficient report review
  - Left pane: consolidated report list grouped by target
  - Right pane: full context detail view
  - URL-synced selection for shareable links
- **ReportDetail component** - Comprehensive context for moderation decisions
  - Thread context showing ancestors of reported posts
  - User profile with stats (posts, reports, labels)
  - AI-generated behavioral summary with risk level
  - Related reports across user's content
  - Media preview with Hive AI moderation results
  - Decision history showing past actions on target
- **ThreadModal** - View full conversation thread in modal
- **MediaPreview component** - Display images/videos from events
- **HiveAIReport component** - Show AI content moderation scores
- **AISummary component** - AI-generated user behavioral analysis
- **Decision logging** - Track all moderation actions with timestamps
- **Media moderation** - Block/unblock media via sha256 hash
  - Combined "Block Media & Delete Event" action
  - Verification of moderation success
- **Moderation status hooks** - Check if users/events already handled
- **EventDetail component** - Full event inspection with raw JSON
- **UserIdentifier component** - Consistent pubkey/npub display
- **Kind names database** - Human-readable names for all NIP event kinds

### Changed
- Reports now show truncated npub instead of fake generated names
- Content properly wraps long URLs with `break-all`
- Cards have `overflow-hidden` to prevent layout blowout
- Hide resolved reports toggle (default on)

### Removed
- `genUserName` - removed fake "Adjective Animal" name generation

### Fixed
- Layout overflow issues in Reports detail panel
- Long URLs breaking container widths

## [0.2.0] - 2025-12-05

### Added
- **Reports tab** - View kind 1984 user-submitted content reports
  - Display report category (DTSP categories supported)
  - Show report target (event or pubkey)
  - Ban user directly from report
  - Create label from report
- **Labels tab** - View kind 1985 NIP-32 trust & safety labels
  - Timeline view (chronological)
  - Grouped view (by target)
  - Filter by namespace
  - Color-coded severity badges
- **Label Publisher** - Create kind 1985 labels for moderation
  - Full dialog form with all DTSP categories
  - Inline quick-label form for use in Reports
  - Custom namespace and label support
  - Option to ban pubkey when publishing label
- **Centralized Admin API** (`src/lib/adminApi.ts`)
  - HTTP response validation for all API calls
  - `publishLabel()` for kind 1985 events
  - `publishLabelAndBan()` for combined action
  - `callRelayRpc()` for NIP-86 relay management
  - `banPubkey()`, `unbanPubkey()` convenience functions
- **Cloudflare Worker** for server-side signing
  - NIP-98 HTTP auth for relay RPC
  - NIP-86 relay management support
  - Secure nsec storage in CF secrets

### Changed
- Expanded tabs from 3 to 5 (Events, Users, Reports, Labels, Settings)
- All destructive actions now require confirmation dialog
- Ban actions show loading state and proper error handling
- Query invalidation after bans updates all relevant views

### Fixed
- HTTP response validation before JSON parsing (prevents crashes on network errors)
- Type safety in namespace filtering

## [0.1.0] - 2025-12-05

### Added
- Initial release with NIP-86 relay management
- Events & Moderation tab
- User Management tab (ban/allow pubkeys)
- Relay Settings placeholder
