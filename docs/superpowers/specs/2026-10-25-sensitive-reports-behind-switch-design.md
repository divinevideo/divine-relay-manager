# Sensitive reports the system didn't act on: avoidable but findable

Status: draft for review. Verified against `origin/main` at `1ef2163`, which matches the deployed frontend for every file named here.

## Intent

The reports queue lets a moderator avoid the most sensitive reports, or deliberately work through them, using one switch: "Pending review (auto-hidden)". Today only one kind of report goes behind it: one where a trusted Divine app filed it, the report watcher hid the content automatically, and no person has confirmed that yet.

Some reports are just as sensitive, but the system never acts on them, so they land in the main list. Often they're also filed under "Other", so they get neither the red badge nor hidden media. These are:

- reports against a **profile**, since auto-hide only acts on posts
- reports against a **list**, which auto-hide skips on purpose
- reports from **other Nostr apps** that do label or describe CSAM, which auto-hide skips because the app isn't trusted
- reports from **older Divine app builds** that put the reason in the report text ("Reason: csam") instead of a label

The goal is to put these reports behind the same switch so moderators can avoid them and still find them, while making them look different from reports the system trusted and acted on. Nothing about them is done automatically. A person decides.

## Goals

- A report whose own content says CSAM goes behind the switch, whatever its target (post, profile, list) and whichever app filed it.
- Every report behind the switch carries a visible label for one of two states:
  - **Hidden automatically**: today's members. The system acted, and a person needs to confirm or reverse.
  - **Not hidden, needs review**: the new members. The system did nothing.
- The badge count includes both kinds, so moderators can see there is something to look at.
- Opening one of these reports from a link (Zendesk, a pasted `/reports/<id>`, `?event=` or `?pubkey=`) turns the switch on, so the open report and the list beside it agree.
- When the report is in a sensitive category, the reported account's profile picture and recent-post media are hidden until clicked, matching how the report pane already treats the reported post's media.
- One shared report classifier replaces the current "first `report` tag, else first `l` tag, else Other" rule in the browser. It reads the NIP-56 report type, every NIP-32 label in Divine's namespace, and the old-build reason line.

## Non-goals

- Changing what the report watcher hides automatically. Its rules, its trusted-app list, and its own category logic stay as they are.
- Fixing the badge that counts auto-hidden items the list can't load. Today the list only loads the newest 200 reports, so the badge can count auto-hidden items the switch can't show. Issue #284 (the screen half of PR #285's paged reads) already tracks this. This change adds no new cases of it, because the new members are counted from loaded reports.
- The "All (N)" tab label showing the total instead of the visible rows while the switch is on (`Reports.tsx:1464`). Small and separate.
- Moving this review into Coop. Coop routes profile CSAM to its own CSAM queue for review only, and keeps bare `illegal` out of that queue. This design follows the same line, so the two tools agree.

## Anti-goals

Any of these makes the change a failure even if it works:

- Any automated action against an account or content because of these reports. Banning an account purges it permanently, so humans decide accounts.
- Writing a CSAM category, label, or decision anywhere because of a report from another app or an old build. Categorizing as CSAM is sticky, one-way, and goes to NCMEC. This change only decides where a person first sees a report. Routing it for review is not the same as categorizing it.
- Sending a bare NIP-56 `illegal` report from another app behind the switch with no further detail. Matt decided these stay in the main list, because "illegal" also covers copyright, drugs and the like.
- A new screen, queue, or second switch. Access works through what already exists.

## What exists today (verified)

- **Switch membership** (`Reports.tsx` ~668-699, ~885-890, ~965-977). This is the set of targets whose latest auto-hide state is `auto_hidden`, `auto_hide_unresolved`, or `auto_hide_restore_failed`, read from `/api/resolution-state` (every auto-hide row in D1). The default view excludes them, and the switch shows only them. The switch is absent when the count is 0. Turning it on turns "Hide resolved" off; turning it off restores the moderator's earlier "Hide resolved" and category filter (`prePendingReviewRef`). A mocked test run on `1ef2163` confirmed each of these.
- **Leaving the switch.** An auto-hidden target leaves the switch when a person confirms or restores it, because its latest auto-hide state is no longer pending. That does not make it resolved. The worker's `getResolvedTargets` excludes every auto-hide action, `auto_hide_confirmed` and `auto_hide_restored` included. A confirmed post usually still counts as resolved because it stays on the banned-events list. A restored post, or a confirmed profile, shows in the default view as unresolved until someone resolves it another way.
- **Classifier** (`src/lib/constants.ts:97`, `getReportCategory`). It takes the first `report` tag, else the first `l` tag in any namespace, else `'other'`. It never reads the NIP-56 type (third entry of the `e`/`p` tag). Every category decision in the browser uses it: the list badge, sort-by-category, filter chips, `ReportDetail`'s `hasHighPriorityReports`, and `EventDetail`'s media gating.
- **Sensitive-category protection** (`HIGH_PRIORITY_CATEGORIES`). A report in one of these categories gets a red badge, and the reported post's media stays hidden until clicked (`MediaPreview showByDefault={!hasHighPriorityReports}`). The set is `sexual_minors`, `csam`, `NS-csam`, `nonconsensual_sexual_content`, `terrorism_extremism`, `credible_threats`, `NS-underageUser`, `NS-childSafety`.
- **Gap in that protection.** `UserProfileCard` always shows the reported account's avatar (line 133). Its recent-posts section opens expanded by default, and the `InlineMediaPreview` inside it starts with media shown (`MediaPreview.tsx:403`). So a sensitive report against a profile shows that account's images as soon as it's opened.
- **Links into a hidden report.** A deep link opens the report pane but leaves the switch off, so the report's row is missing from the list beside it. There is an equivalent rule that turns "Hide resolved" off for a linked resolved report (`Reports.tsx` ~1060), but nothing does this for the switch. A mocked test run on `1ef2163` confirmed this for `?event=` with the report loaded, `?event=` resolved by targeted lookup, and a direct `/reports/<id>`.
- **Report shapes observed in production** (read-only):
  - The current Divine app files a profile CSAM report as a `p` tag with `illegal`, plus `L social.nos.ontology`, `l NS-csam`, `t user-report`, and `client Divine`.
  - Older Divine builds, through early June 2026, used `e`/`p` with `illegal` and `client diVine`. They had no label, and the reason was in the text as a line `Reason: csam` under `CONTENT REPORT - NIP-56`.
  - Other apps mostly send `e`/`p` with a NIP-56 type and free text, and no Divine labels.

## The design

### 1. Shared report classifier (`shared/`)

A pure function that the browser uses everywhere it calls `getReportCategory` today. It returns two separate things:

- **`category`**, for display, filters and sorting. This keeps today's order for the reports that already classify correctly: a `report` tag first, then a label in the `social.nos.ontology` namespace, then any other `l` value. After that it falls back to the NIP-56 type on the target tag, and only then to `'other'`. A report with several Divine labels takes a sensitive one over a non-sensitive one, so the order of the labels can't hide a CSAM label. NIP-56 types already have display labels in `CATEGORY_LABELS`.
- **`csamSignal`**, a yes/no for routing behind the switch. It is yes if any of these hold:
  - a `report` tag or an `l` label in **any** namespace whose value is in the CSAM set (`sexual_minors`, `csam`, `NS-csam`). `NS-childSafety` is left out: the Divine app offers it as "Child Safety Violation: general concerns about minors' safety", a separate choice from "Child Sexual Abuse". It keeps its red badge and hidden media through `HIGH_PRIORITY_CATEGORIES`. Any namespace because the goal covers every app, and the report watcher already reads `MOD`. My call.
  - a `Reason:` line in the report text whose value is `csam` or `sexual_minors` (the old-build format)
  - the report's own text box (the kind 1984 `content`, which the reporter wrote) contains one of `csam`, `child sexual abuse`, or `child porn` (which also catches "child pornography"). Case doesn't matter, and only whole words count. This only reads the report, never the reported post or profile. It is a blunt match: "this is not csam, just spam" matches, and a report written in another language doesn't. A wrong match only moves a report behind the switch, marked "Not hidden", with its images hidden until clicked.

A bare NIP-56 `illegal` never sets `csamSignal`.

`csamSignal` is a routing hint for the browser only. It is never written to D1, the relay, labels, or Zendesk, and nothing acts on it.

The report watcher keeps its own category logic in this change, because what it hides automatically is a non-goal. Moving it onto the shared classifier is a follow-up with its own `TODO(#issue)`.

**Age review stays on the worker's rule.** `UserActions` switches to age-review controls when the category is `NS-underageUser`. The report watcher opens the age case with its own order: `report` tag, then a `social.nos.ontology` label, then a `MOD` label, then the NIP-56 type. The browser keeps a separate helper that copies that order, so the controls and the case can't disagree on reports with several labels. My call.

**`csamSignal` also turns on protection.** The red badge and hidden media (section 5, plus the existing `hasHighPriorityReports` sites in `ReportDetail` and `EventDetail`) apply when the category is high-priority **or** any report on the target has `csamSignal`. Otherwise an old-build report (category `illegal`) or another app's report that only says CSAM in its text would open with its media showing. The badge keeps the report's own category text, for example "Illegal", and is never relabelled CSAM, per the anti-goal. My call.

### 2. Who is behind the switch

The members are the union of two groups:

- **Hidden automatically**: today's set, unchanged.
- **Not hidden, needs review**: any loaded target that meets all three of these:
  - it has at least one report with `csamSignal`
  - it is not already hidden automatically
  - no person has handled it. Handled means it's resolved by the queue's existing rule (`isConsolidatedReportResolved`, which covers resolution labels, decisions, and banned accounts or events), or it has any auto-hide state written by a person (`auto_hide_confirmed`, `auto_hide_restored`, `auto_hide_reversed`).

  The third test matters most for today's members. Nearly all of them were hidden because of a CSAM label. Without it, restoring a post could drop it straight back behind the switch as "Not hidden". The worker's restore path (`ReportWatcher.ts` ~430-520) calls `allowevent` and writes only an `auto_hide_restored` decision, which `getResolvedTargets` excludes. I have not confirmed whether the browser writes a resolution label alongside it. The builder checks that, and the rule above holds either way.

**New reports on an item a person already handled follow the existing pattern.** Everything in relay-manager works by target, not by report:
- `isConsolidatedReportResolved` in the browser, and `isResolvedForReview` / `selectReportsNeedingAttention` in the worker, both treat a handled target as handled however many reports come in later.
- The report watcher never auto-hides a target once `ever_human_reviewed` is set.
- The way to bring a handled target back is a person pressing **Reopen**, which clears its decisions and resolution labels.

So a new CSAM report on a handled target does not put it back behind the switch. It shows with the target's other reports when "Hide resolved" is off.

The default view excludes both groups, and the switch shows both. A target leaves the group once a person handles it, and then appears in the default view under that view's normal resolved rules.

Membership has to be computed from resolution state before the switch's own "Hide resolved" override applies. Turning the switch on turns "Hide resolved" off, so a resolved target must already be out of the group by then, or it will sit behind the switch forever.

**If a resolution read is still loading or has failed,** a target with `csamSignal` stays behind the switch rather than in the default view. The badge may run high until the read lands. This is the safe direction for exposure, and it leaves the existing blocking rules from #221 alone. My call.

### 3. Count and labels

- **The badge is one number**: hidden automatically plus not hidden. The new group is counted from loaded rows, so it always matches what the switch shows.
- **Each row and the report pane** carry a small label: "Hidden automatically" or "Not hidden, needs review". An auto-hidden target in the `auto_hide_unresolved` or `auto_hide_restore_failed` state is one where the hide or the restore may not have landed. The builder picks wording for it that doesn't claim the content is hidden.
- **The switch's text changes** from "Pending review (auto-hidden)", since it no longer covers only auto-hidden reports, to something like "Sensitive: pending review".

### 4. Links turn the switch on

When the selected report came from a deep link, and its target is a switch member while the switch is off, turn the switch on. Use the same path a moderator's click takes, so the earlier "Hide resolved" and category filter are saved and come back when it's turned off. This applies to every entry path that already marks a deep-link selection (`deepLinkSelectedRef`): `?event=`, `?pubkey=`, a targeted lookup, and direct `/reports/<id>`.

It does not apply to a report the moderator clicked in the list. Same scoping reason as the existing resolved rule: un-scoped, it fights the moderator on every poll.

### 5. Hide the reported account's images on sensitive reports

When the report pane's existing `hasHighPriorityReports` is true, `UserProfileCard` hides the reported account's avatar until clicked, and its recent posts hide their media by default, the same way the reported post's media is already hidden. When it's false, behavior is unchanged. Two notes on scope:

- This uses the existing `HIGH_PRIORITY_CATEGORIES` set, not just the CSAM set, because that set already decides media hiding in the pane.
- With the new classifier, it also covers the reports that used to classify as "Other".

## Constraints

- **Repository is public.** Issue, PR, commits and tests use no real report IDs, pubkeys, or case details. Test fixtures copy the real report shapes above, using synthetic IDs.
- **Checks to run:**
  - `npx tsc -p tsconfig.app.json --noEmit`
  - `cd worker && npm run typecheck`, since `shared/` is compiled by both sides
  - `npx eslint src/`
  - `npm run test`
  - `cd worker && npx vitest run`
- **Mutation testing.** Each test that guards a behavior above must go red when that one guard is removed.

## Left to the builder

- Exact wording and placement of the two row labels and the switch text. Match the existing badge styles.
- The name and file of the classifier module, and whether `getReportCategory` becomes a thin wrapper or every call site moves to it.
- How the avatar's "click to show" looks. Reuse the existing hidden-media treatment.

## Decisions

These were settled with Matt or follow existing patterns:

- **Scope is CSAM** (Matt's brief: anything CSAM goes to priority review). The other high-priority categories, child safety included, stay in the main list with the red badge and hidden media.
- **New reports on handled items** follow the existing target-level pattern, with Reopen as the way back (section 2).
- **Free-text matching on reports from other apps**, in the report's own text only. The term list above is short on purpose.
- **One badge number**, rather than splitting it into hidden and not-hidden counts.
- **Renaming the switch.**
