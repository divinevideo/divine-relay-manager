# Changelog

All notable changes to ManVRelay will be documented in this file.

## [Unreleased]

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
