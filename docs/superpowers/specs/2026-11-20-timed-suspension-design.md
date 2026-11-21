# Timed suspensions: design

Issue: support-trust-safety #263. Product owner: Matt Bradley. Date: 2026-11-20.

## Intent

Moderators can suspend an account for a set length of time. When the time runs out, the account comes back on its own, exactly as if a moderator had clicked Unsuspend. Today a suspension stays until someone remembers to lift it, so short suspensions either turn into long ones or need a manual follow-up. The person suspended should know when it ends.

## Decisions (made by Matt; build them as stated)

1. **Duration entry.** Free entry of a number of days or hours, guided by the written policy docs. No fixed menu.
2. **Expiry lifts it the normal way.** When the end time passes, the suspension lifts through the same path as a manual Unsuspend: the relay suspension is removed, Keycast is set active, the "account restored" message goes out, and the decision history records it.
3. **Open-ended suspensions remain.** A moderator can still suspend with no end date, for example while a manual decision is pending.
4. **The suspension message states the end time.**
5. **Moderators can change the end date directly**, longer or shorter, without unsuspending and suspending again.
6. **A changed end date sends the person a short message with the new end time.**
7. **An end date can be added to an open-ended suspension**, using the same edit action and the same message.
8. **A ban wins.** If the account is banned during the suspension, the timer does nothing when it runs out. No unsuspend, no "restored" message, and no Keycast change.
9. **A failed automatic lift fails closed.** The account stays suspended, the lift is retried, and someone is alerted if it keeps failing. It never reports a lift that didn't happen.
10. **The timer lives in Relay Manager** (working assumption; challenge it if the build shows a better home).
11. **Early lift.** A manual Unsuspend before the end time cancels the timer.
12. **Age review mid-suspension: wait, then lift on schedule.** While an age-review case is open, the timer does not act. If age review clears the account before the end date, the account comes back early (today's age-review behaviour). When the end time later passes, the timer sees the account is no longer suspended, marks itself done, and sends no second "restored" message. If age review denies, the account is banned (decision 8).
13. **Ban, then unban: the moderator decides.** A ban blocks the lift while it is in place. When a moderator unbans an account that has a running timed suspension, the unban asks them to: resume to the original end date, end the suspension now, or keep it suspended with no end date. Today an unban sets Keycast active but leaves the relay suspension, so the unban flow has to apply whichever choice is made to both.
14. **When a timed lift counts as done** (Claude's call, agreed by Matt): when the relay lift succeeds, the same as a manual Unsuspend today. If the Keycast step fails, the timer retries only that step until it succeeds, and alerts if it keeps failing. The "restored" message is sent once, after the relay lift, never again on a Keycast retry. Manual Unsuspend keeps its behaviour with one change, agreed by Matt on 2026-11-21 after the whole-branch review: on an account the relay ban list shows as banned, it sends no restored message and leaves Keycast as it is; if the ban list can't be read, it does neither and alerts Slack.

## Goals

- A moderator can suspend for N days or N hours, or with no end date.
- The account shows "Suspended until <date and time>" wherever its suspension is shown to moderators.
- The suspension lifts within one scheduler tick of its end time (today's tick is every 5 minutes).
- Every set, change, lift and cancel is recorded in the decision history.

## Non-goals

- Per-policy duration presets, escalation ladders, or strike counting.
- Timed bans.
- Self-service appeals or showing the end time inside the app (the message carries it).

## Anti-goals (would make this a failure even if it technically works)

- An automatic lift that undoes a ban, in Keycast or on the relay.
- An automatic lift that removes an age-review suspension.
- The person being told an end time that isn't true (after an edit, a ban, or a failed lift).
- A lift that silently fails and leaves no trace.

## What exists today (verified in code; file:line on main 100785e7)

- **Suspend and unsuspend are not in `handleModerate`.** They are NIP-86 calls through `POST /api/relay-rpc`: `handleRelayRpc` and `runRelayRpc`, worker/src/index.ts ~1675-1899.
  - The relay call is critical: a failure returns an error and no side effects run.
  - The Keycast leg (`suspendUser`/`unsuspendUser`) and the user message (`notifyAccountState` with ACCOUNT_SUSPENDED / ACCOUNT_RESTORED) are best-effort `waitUntil` work.
  - The decision row is written separately: the browser posts `/api/decisions` (`handleLogDecision`, ~2104), which also calls `markHumanReviewed`.
  - Zendesk sync is not triggered for suspend or unsuspend, by design (zendesk-sync.ts ~224-241).
- **The UI.** `UserActions.tsx` ~169-212 suspends on click with no dialog, using the hardcoded reason "Suspended by moderator". `UserManagement.tsx` can only unsuspend.
- **No end time is stored anywhere:** not D1, not the relay, not Keycast. The relay's `suspended_pubkeys` table holds one row per pubkey (ReplacingMergeTree by pubkey), and `unsuspendpubkey` deletes it with no owner or reason check (funnelcake crates/clickhouse/src/management.rs ~483-536).
- **Keycast has a single status** (active | suspended | banned). `unsuspendUser` sets active, which would also lift a ban (keycast-client.ts ~138-145).
- **The relay ban list and the relay suspended list are independent.** A ban doesn't remove the suspended row.
- **Age review** suspends and lifts the same relay row directly (age-review.ts ~642-690, reason `age_review`), not through `/api/relay-rpc`. `runRelayRpc` already refuses a moderator suspend or unsuspend while an age-review case is open (`ageReviewActiveGuard`, ~1780-1808; it fails closed for unsuspend).
- **Messages are sent by divine-moderation-service** (`POST /api/v1/notify`, src/index.mjs ~4254-4323; NIP-17 DMs from src/nostr/dm-sender.mjs). The ACCOUNT_* templates take no arguments today, the `reason` field is ignored for them, and there is no field for an end time. The service rate-limits DMs to 5 per minute per recipient and fails open.
- **Scheduling.** The worker has one cron, every 5 minutes (wrangler.*.toml ~196), and a `scheduled()` handler (index.ts ~1043-1112) that already runs `checkAgeReviewDeadlines` (age-review.ts ~2643).
  - That function is the closest precedent: a due-time query, a version compare-and-swap so it can't race a moderator, per-row isolation, and Slack alerts deduplicated with `last_alerted_at`.
  - Retention has a once-a-day alert throttle (`retention_alert_state`).
- **Schema** is applied by `ensureSchema()` in worker/src/db.ts, with a matching SQL file in worker/migrations kept in sync by hand.

## Shape of the solution

### State
A D1 record per suspended account that has an end time, keyed by pubkey, holding at least:
- the end time;
- who set it and when;
- the latest change;
- a status (active, lifted, cancelled by an unsuspend, cancelled by a ban, superseded);
- retry bookkeeping (attempts, last error, last alerted).

Open-ended suspensions need no record, or a record with no end time; the builder chooses. Re-suspending an already-suspended account replaces the record.

### Setting a duration
Suspend gets a dialog, where today it suspends on click:
- duration as a number plus a unit (days or hours), or "No end date";
- the same reason handling as today.

The worker validates the duration: positive, with a sensible maximum the builder proposes. It stores the end time only after the relay suspension succeeds, so a record never exists for a suspension that didn't happen.

### Changing the end date
A "Change end date" action wherever a suspended account is shown with its suspension: the report pane's account controls and the Suspended tab card. It sets a new end time, or adds one to an open-ended suspension.
- An end time already in the past means "lift now", through the normal lift path.
- It writes a decision row and sends the "new end time" message.

### Unban against a changed timer ("ask again if it changed")
(Matt, 2026-11-21, from PR #444 review.) The unban prompt's options are built from a timer read that can be up to 30 seconds old. A choice is only applied to the timer the moderator saw.
- The timers list carries each record's version. The prompt sends back the version it showed, or `null` when it showed no timer. It waits for the timers' first read before allowing Confirm. If that read failed, nothing was shown to compare against, so it sends no version and keeps decision 13's unknown-end default (resume as it is).
- If the record has changed since, the unban is refused before the relay is touched: the account stays banned, and the timer, Keycast and the person's messages are untouched. The prompt re-reads the timers, says the suspension changed, and asks again against the current end. Any version change counts, including the scheduler's own bookkeeping.
- A change landing during the relay unban itself leaves the unban standing and applies no choice. The timer is left as it was and Keycast stays banned, which is the stricter side. For End now, a change landing during the relay unsuspend, or a record that can't be checked afterwards, sends no restored message, leaves Keycast as it is, and alerts for a hand check.
- Callers that send no version (moderation-service `allow_pubkey`, Coop) keep decision 13 unchanged.

### The automatic lift
On each scheduler tick, for each record whose end time has passed:
1. **Ban check first** (a ban wins). Check the relay ban list and Keycast's status. If banned, mark the record cancelled by ban and do nothing else.
2. **Age-review check (decision 12).** If an age-review case is open for the account, don't lift; check again next tick. No alert just for waiting on a case. If the account is no longer suspended on the relay when the timer acts (for example, age review cleared it), mark the record done with no message and no Keycast change.
3. **Otherwise lift exactly as a manual Unsuspend does:**
   - relay unsuspend;
   - Keycast active;
   - the ACCOUNT_RESTORED message;
   - a decision row (`unsuspend_user`, reason "Timed suspension ended", no moderator recorded, never the `auto` marker). Whether that row should count as human handling for the queue is for the builder to check and justify.
4. Use a compare-and-swap on the record, so a moderator's concurrent edit or unsuspend wins and the tick doesn't double-lift.
5. **On failure:** leave the account suspended and the record due, count the attempt, and alert Slack after repeated failures (deduplicated, following the age-review or retention pattern).

A manual Unsuspend marks the record cancelled. A ban does not end the record; the lift-time ban check blocks the lift while the ban is in place. An unban of an account with a running timed suspension follows decision 13.

### Messages (needs a divine-moderation-service change)
- **ACCOUNT_SUSPENDED** gains an optional end time. "Until <date>" when set, today's wording when not.
- **A new message for a changed end time:** "Your suspension now ends on <date>."
- The worker's `notifyModerationService` passes the end time.

Dates should be unambiguous to a reader anywhere: UTC with the date written out, or the builder proposes better. Message delivery stays best-effort, as today. A rate-limited or failed message must not block the suspension, the edit or the lift. Log it.

### Showing it to moderators
"Suspended until <date and time>" (or "Suspended, no end date"):
- on the report pane's account status;
- on `UserActions`;
- on the Suspended tab cards in User Management.

This needs a worker read of the end-time records, because the relay list can't carry it.

## Constraints

- No new dependency. Follows the repo's worker patterns: critical vs best-effort side effects per AGENTS.md "Integration Contracts", no fire-and-forget, `ensureSchema` plus a migration file.
- Read from the relay's lists, not caches, when deciding to lift: the ban check must be fresh.
- Two deploys are involved: Relay Manager (worker and Pages) and divine-moderation-service. Order them so neither side breaks if the other lands first. For example, the service ignores an unknown field, and the worker tolerates the old service.

## Left to the builder (decide, and mark it as your call in the plan)

- Record schema and names; whether open-ended suspensions get a record.
- The maximum duration and input validation details.
- The exact message wording, keeping it short and in the style of the existing templates. Matt approves final copy in review.
- The failure alert threshold (relay lift and Keycast retry).
- Whether to export `runRelayRpc`'s unsuspend leg or factor a shared lift function, as long as manual and automatic lifts run the same code.
- The unban prompt's placement and wording (decision 13), within the existing unban flows.
- Where the decision rows for set and edit are written: worker-side (preferred, so they can't be lost) or the browser as today.
