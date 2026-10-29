# Quarantine review closeout

> **For agentic workers:** Use the existing isolated worktrees and test-driven fixes. The user authorized incorporating developer work and finishing this stream.

**Goal:** Incorporate review fixes without changing the two-reporter policy or activating production enforcement.

**Architecture:** Retain independent revisioned event/media holds. Separate recorded human intent, public verification, and review delivery. Preserve existing contributor commits.

**Tech stack:** Cloudflare Durable Objects/D1, React, Blossom, Funnelcake.

**Spec:** `docs/superpowers/specs/2026-10-29-sexual-quarantine.md` and the existing rollout contract.

## Constraints and decisions

- No comments, account actions, harassment, behavior analysis, or watchlists.
- No new dependencies or deployment changes. Safe synthetic fixtures only.
- A single unconfirmed report still creates review without hiding.
- Generic Reports actions cannot decide an unresolved quarantine. After a versioned Restore is verified and recorded, a separate Allow can lift the independent base event ban.
- Confirmed absent targets are archived and alerted without blocking the whole replay window; transport uncertainty retains the cursor.
- Human intent is recorded after acknowledged scoped commands; incomplete public verification stays visibly pending.
- Media eligibility requires authenticated ownership metadata. Unresolved mappings remain review evidence.
- New hide intent receives a fresh 15-minute deadline; first-report timestamps remain unchanged.

## Tasks

- [x] Reproduce and fix canonical child-safety routing, stale generic decisions, absent-target replay, typed decision failures and normalized reviewer attribution.
- [x] Reproduce and fix media eligibility, complete signed-hash candidates, unapplied capacity responses and restoration/reviewer contracts.
- [x] Reproduce and fix separate delivery scheduling, bounded retry history, human-intent projection and cursor-based priority review.
- [x] Wire queue paging, honest verification/recording status and the separate-base-ban workflow into the UI; refresh synthetic screenshots.
- [ ] Incorporate Blossom capacity changes and Funnelcake main changes without rewriting contributors; independently review final results.
- [ ] Run relevant full suites and current-head CI, publish review dispositions, and retain any unmet production/performance gates.

## Review focus

Missing targets versus failed reads; stale moderator views; mixed-case child categories; media with incomplete eligibility; public verification failure after a human decision; COOP outage under enforcement load; multiple queue pages; independent restrictions surviving Restore.
