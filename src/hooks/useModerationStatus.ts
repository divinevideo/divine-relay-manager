// ABOUTME: Unified moderation status hook - checks ban lists + WebSocket event verification
// ABOUTME: Auto-runs on report load; recheck re-runs it, recheckAfterAction after an account action

import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useAdminApi, useApiUrl } from "@/hooks/useAdminApi";
import { useBannedPubkeys, useBannedEvents, useSuspendedPubkeys, listMembership } from "@/hooks/useRelayBanLists";

export interface ModerationStatus {
  /** User's pubkey is in the relay's ban list */
  isUserBanned: boolean | null;
  /** User's pubkey is in the relay's suspended list */
  isUserSuspended: boolean | null;
  /**
   * `isUserBanned` is `true` only because a copy of the ban list that is not
   * current said so: the list's latest refresh failed, or it has not answered
   * since the latest check asked it to re-read. And no live answer stands in
   * for it: no check has answered, the latest could not, or the moderator has
   * since changed the account's status and the check after that is still
   * running. Shown so an undo stays reachable, but it is not a current answer
   * -- right after a moderator's own successful Unban it can be exactly wrong.
   */
  isUserBannedStale: boolean;
  /** As `isUserBannedStale`, for the suspended list. */
  isUserSuspendedStale: boolean;
  /** Event ID is in the relay's ban list */
  isEventBanned: boolean | null;
  /** Event is not queryable from the relay (deleted, banned, or never existed) */
  isEventGone: boolean | null;
  /** Ban list data is still loading */
  isLoading: boolean;
  /**
   * The account's ban/suspend status is still being determined: one of the two
   * ACCOUNT lists has not answered yet (isLoading also covers a re-read of a
   * list that failed with no data), a live check of this pubkey is running, or
   * the latest check asked an account list to re-read and it is still fetching.
   * The banned-events list never counts: it is not an account status. Always
   * false with no pubkey: with no account in view there is nothing to wait on.
   */
  isAccountStatusLoading: boolean;
  /**
   * Something still on its way can settle the BAN: the banned list has not
   * answered yet, a live check of this pubkey is running, or the banned list
   * is re-reading after the latest check. Narrower than isAccountStatusLoading,
   * which also waits on the suspended list: once the banned re-read has failed,
   * a suspended read still out cannot confirm or clear the ban. What a
   * last-known ban's wording ("checking now" vs "could not confirm") follows.
   * Always false with no pubkey.
   */
  isUserBanChecking: boolean;
  /**
   * The live check (verifyPubkeyBanned / verifyEventDeleted) is running. Does
   * not cover the list re-reads it asks for; those are in
   * isAccountStatusLoading.
   */
  isChecking: boolean;
  /** When the latest live check answered */
  checkedAt: Date | null;
  /**
   * Re-run all checks (ban lists + WebSocket verification). For a Re-check
   * button, the check when a report opens, or the check after an action on a
   * post or its media: the previous answer stands until the new one lands, so
   * a routine check does not flicker.
   */
  recheck: () => void;
  /**
   * The check to run once an action that changes the account's status (ban,
   * unban, suspend, unsuspend) has succeeded. A post action leaves the account
   * status as it was and uses recheck. Until its live check answers, nothing
   * from before the action counts as confirmed: the previous answer no longer
   * outranks the lists, and the lists re-read at once and are current only
   * when they answer after this call.
   */
  recheckAfterAction: () => void;
}

// The account lists a check re-reads. Literal keys, matching the definitions
// in useRelayBanLists, because the hook needs the query state behind them.
const BANNED_PUBKEYS_KEY = ['banned-pubkeys'];
const SUSPENDED_PUBKEYS_KEY = ['suspended-pubkeys'];

// A list's query and how many times it has been read successfully. The count
// only increases for as long as that query exists, and only while nothing
// writes these keys with setQueryData, which nothing here does.
// queryClient.clear() replaces the query with a new one that counts from zero:
// on an environment switch, and also when the moderator re-selects the
// environment already in use, with no apiUrl change. So a count means nothing
// without the query it belongs to.
interface ListReads {
  query: Query | undefined;
  reads: number;
}
function successfulReads(client: QueryClient, key: string[]): ListReads {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  return { query, reads: query?.state.dataUpdateCount ?? 0 };
}

// Where one account list stands relative to the latest check's request to
// re-read it, judged by React Query's count of successful reads of that list.
//
// Not by the reload's promise: a reload can pause (offline, or a retry
// waiting for the tab to regain focus), and another screen can cancel it and
// start a replacement. And not by clock time: a read that finished just
// before the request and one that finished just after it can share a
// millisecond. The count rises only on a successful read (see successfulReads
// for when that holds). A mark taken on a query that has since been replaced
// is void: every read the new query has counted started after it existed, so
// after the mark.
// runCheck cancels any account-list read already in flight before taking the
// mark, so every read counted after it started after the check asked. A check
// after an account action asks twice, when it starts and again once its live
// check answers; any other check asks once, after its answer.
//
// `current`: the copy on screen can be taken as the list's present answer. It
// is not after a failed refresh, and not while the list is behind the latest
// check's mark.
// `rereading`: behind the mark, with the re-read still out. The status is
// still being checked.
function sinceReRead(
  query: { fetchStatus: string; isError: boolean },
  now: ListReads,
  atRequest: ListReads | null,
): { current: boolean; rereading: boolean } {
  if (atRequest === null || now.query !== atRequest.query || now.reads > atRequest.reads) {
    return { current: !query.isError, rereading: false };
  }
  // Not answered since the check asked, so the copy on screen predates the
  // moderator's latest action or Re-check. That is true whether the re-read is
  // still out, paused (offline, or a retry waiting for the tab to regain
  // focus), or idle after failing. Only the first counts as still checking: a
  // paused read resumes only when the browser is back online or the tab
  // regains focus, and after a failure no newer read is on its way. One comes
  // from the next check, from a refetch when the window regains focus once the
  // copy is stale (30s by default), or, for the banned list only, from the
  // reports queue's 15s poll while the queue is mounted. The suspended list is
  // never polled.
  return { current: false, rereading: query.fetchStatus === 'fetching' };
}

export function useModerationStatus(
  pubkey?: string | null,
  eventId?: string | null,
  /** Set true when the event could not be found via normal relay queries or banned event lookup */
  eventNotFound?: boolean,
): ModerationStatus {
  const { verifyEventDeleted, verifyPubkeyBanned } = useAdminApi();
  const apiUrl = useApiUrl();

  // Which live check is the current one. The check's result outranks the
  // lists, so only the latest may answer. Each check takes the next number, and
  // a change of report or environment bumps it too (see the reset effect). A
  // check whose number is no longer current when it lands is dropped: the check
  // that runs after a moderator's action must not be overwritten by one that
  // started before it, and a check for another report or environment must not
  // answer for this one. Switching environment clears the query cache but not
  // this hook's state, and the pane stays mounted through it.
  const generationRef = useRef(0);
  // `undefined` and `null` are different states here and the difference is the
  // point: `undefined` means no live answer applies, so the ban lists are the
  // best evidence available, while `null` means a check ran and could not
  // answer. Falling back to the lists in the second case would turn "we could
  // not reach the relay" into a definite "not banned". No answer applies when
  // no check has run, or when an action on the account has superseded the last
  // one and the check after the action has not answered yet.
  const [wsResult, setWsResult] = useState<{
    userBanned: boolean | null | undefined;
    eventGone: boolean | null | undefined;
    checkedAt: Date | null;
    isChecking: boolean;
  }>({ userBanned: undefined, eventGone: undefined, checkedAt: null, isChecking: false });

  // Each account list's query and successful-read count when the latest check
  // asked it to re-read. A list that has not read successfully since then
  // predates the moderator's latest action or Re-check. Null until a check has
  // asked.
  //
  // Kept when the REPORT changes: it describes the lists, which every report
  // shares, so a re-read still running or paused when the moderator moves on
  // leaves the next report's status just as unconfirmed. Void once
  // queryClient.clear() has replaced a list's query (see sinceReRead), which
  // covers an environment switch without a reset of its own.
  const [reReadMarks, setReReadMarks] = useState<{ banned: ListReads; suspended: ListReads } | null>(null);
  const queryClient = useQueryClient();

  // Track which report we've auto-checked to avoid re-running on every render
  const autoCheckedRef = useRef<string | null>(null);

  // Defined once in useRelayBanLists. These keys are shared with the reports
  // queue, and React Query runs the queryFn of whichever observer triggers the
  // fetch, so two local copies could -- and did -- disagree about what a failed
  // read means. See the note in that module.
  const bannedPubkeys = useBannedPubkeys();
  const bannedEvents = useBannedEvents();
  const suspendedPubkeys = useSuspendedPubkeys();

  // Derive ban/suspend list status. `listMembership` rather than `data` alone:
  // after a failed refresh `data` still holds the previous list, and absence
  // from that stale copy must not read as a confirmed negative. See its doc for
  // why presence is treated differently.
  //
  // After a check has asked the account lists to re-read, a copy that has not
  // answered since then is not current, even while the re-read is still out,
  // and is treated like a failed refresh (see sinceReRead).
  // The counts are read from the query state, not the observers. A list that
  // is behind its mark has its fetchStatus read inside sinceReRead, which
  // subscribes this component to it, so the settle that passes the mark
  // re-renders. Before a mark exists the count is not consulted at all.
  const bannedReRead = sinceReRead(bannedPubkeys, successfulReads(queryClient, BANNED_PUBKEYS_KEY), reReadMarks?.banned ?? null);
  const suspendedReRead = sinceReRead(suspendedPubkeys, successfulReads(queryClient, SUSPENDED_PUBKEYS_KEY), reReadMarks?.suspended ?? null);
  const isUserBannedFromList = pubkey
    ? listMembership({ isError: !bannedReRead.current, data: bannedPubkeys.data }, entry => entry.pubkey === pubkey)
    : null;
  const isUserSuspendedFromList = pubkey
    ? listMembership({ isError: !suspendedReRead.current, data: suspendedPubkeys.data }, entry => entry.pubkey === pubkey)
    : null;
  const isEventBannedFromList = eventId
    ? listMembership(bannedEvents, e => e.id === eventId)
    : null;
  // A positive carried over from a copy that is not current: the latest
  // refresh failed, or the list has not answered since the latest check.
  // listMembership keeps presence from such a copy on purpose; these say when
  // that is what is being shown.
  const isUserSuspendedStale = isUserSuspendedFromList === true && !suspendedReRead.current;
  const bannedFromStaleList = isUserBannedFromList === true && !bannedReRead.current;

  const banListsLoading = bannedPubkeys.isLoading || bannedEvents.isLoading || suspendedPubkeys.isLoading;

  // WebSocket + fresh ban list verification
  const runCheck = useCallback(async ({ afterAction }: { afterAction: boolean }) => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    // A read already in flight when a check asks for a re-read is JOINED, not
    // replaced, while its list has no data yet (React Query only cancels an
    // in-flight fetch that has data to fall back on). That read may have
    // started before the moderator's action, and its answer would pass for the
    // re-read. Cancelling the account lists' in-flight reads first means every
    // read counted after the mark taken next started after this point.
    //
    // `revert: true` (React Query's default, stated so it cannot drift): undo
    // the cancelled read rather than record it as a failure. A recorded failure
    // on the banned list with no data trips the reports queue's cold-failure
    // pane, which shares its key, until the replacement read lands.
    const cancelAccountListReads = () => Promise.all([
      queryClient.cancelQueries({ queryKey: BANNED_PUBKEYS_KEY, exact: true }, { revert: true }),
      // The queue's cold-failure pane reads only the banned list; revert is kept here for symmetry.
      queryClient.cancelQueries({ queryKey: SUSPENDED_PUBKEYS_KEY, exact: true }, { revert: true }),
    ]);
    const markAccountLists = () => setReReadMarks({
      banned: successfulReads(queryClient, BANNED_PUBKEYS_KEY),
      suspended: successfulReads(queryClient, SUSPENDED_PUBKEYS_KEY),
    });
    setWsResult(prev => ({ ...prev, isChecking: true }));
    try {
      if (afterAction) {
        // The lists on screen and the previous check's answer both predate the
        // account action. Drop the answer, so it no longer outranks the lists,
        // and re-read the lists now rather than after the live check: a read
        // that answers after this mark is current even while the live check is
        // still out, and one that has not is last known (presence) or unknown
        // (absence). The account-action handlers leave the account lists to
        // this re-read; an invalidation of their own would only be cancelled
        // here.
        //
        // Not gated on isCurrent(): the action happened whichever check is now
        // current, so the answer from before it goes and the lists re-read
        // either way. A newer check only replaces what this one would answer.
        await cancelAccountListReads();
        setWsResult(prev => ({ ...prev, userBanned: undefined }));
        markAccountLists();
        bannedPubkeys.refetch();
        suspendedPubkeys.refetch();
      }

      const results: {
        userBanned: boolean | null | undefined;
        eventGone: boolean | null | undefined;
      } = {
        userBanned: undefined,
        eventGone: undefined,
      };

      if (pubkey) {
        results.userBanned = await verifyPubkeyBanned(pubkey);
      }

      if (eventId) {
        results.eventGone = await verifyEventDeleted(eventId);
      }

      if (!isCurrent()) return;
      // Cancel before the mark below, as above.
      await cancelAccountListReads();
      // Defensive: the gap is only a few microtasks wide, and no test has made
      // the generation change inside it.
      if (!isCurrent()) return;
      setWsResult({
        userBanned: results.userBanned,
        eventGone: results.eventGone,
        checkedAt: new Date(),
        isChecking: false,
      });
      // Ask the lists to re-read, and mark where each one's read count stood.
      // Right after a moderator's own action the lists still hold the
      // pre-action copy, and a list may be all that answers -- the suspended
      // status only ever comes from one. Until an account list has read
      // successfully past its mark, the account status reports itself as still
      // being checked (sinceReRead). Not awaited: the reload's promise can
      // pause or be replaced by another screen's, and the live check's answer
      // should not wait on it.
      markAccountLists();
      bannedPubkeys.refetch();
      bannedEvents.refetch();
      suspendedPubkeys.refetch();
    } catch (error) {
      console.error('Moderation status check failed:', error);
      if (!isCurrent()) return;
      setWsResult(prev => ({ ...prev, isChecking: false }));
    }
  }, [pubkey, eventId, verifyPubkeyBanned, verifyEventDeleted, bannedPubkeys, bannedEvents, suspendedPubkeys, queryClient]);
  // Take no arguments, so a button can pass either as its onClick.
  const recheck = useCallback(() => { void runCheck({ afterAction: false }); }, [runCheck]);
  const recheckAfterAction = useCallback(() => { void runCheck({ afterAction: true }); }, [runCheck]);

  // Reset when the report or the environment changes. Declared BEFORE the
  // auto-check below on purpose: effects run in declaration order, and running
  // after it would wipe the marker the auto-check just set, so a second check
  // fired for the same report.
  useEffect(() => {
    // Any check still in flight is for the previous report or environment.
    generationRef.current += 1;
    setWsResult({ userBanned: undefined, eventGone: undefined, checkedAt: null, isChecking: false });
    autoCheckedRef.current = null;
  }, [eventId, pubkey, apiUrl]);

  // Auto-check: for events when not found, for users always (just a ban list refresh)
  useEffect(() => {
    const checkKey = `${eventId || ''}:${pubkey || ''}`;
    if (autoCheckedRef.current === checkKey || banListsLoading || wsResult.isChecking) return;

    const shouldAutoCheck =
      // Event not found via normal queries: run WebSocket verification
      (eventNotFound && eventId) ||
      // User report (no event): check ban status
      (pubkey && !eventId);

    if (shouldAutoCheck) {
      autoCheckedRef.current = checkKey;
      runCheck({ afterAction: false });
    }
  }, [eventNotFound, eventId, pubkey, banListsLoading, wsResult.isChecking, runCheck]);


  // A later successful list read that contains the pubkey is newer than a
  // live check that said absent. The queue poll and other screens refresh this
  // shared key without starting another live check, so a stored false must not
  // keep hiding that membership.
  const currentListBan = isUserBannedFromList === true && !bannedFromStaleList;
  // A stored "not banned" stays confirmed while its re-read is still out, and
  // in the gap before that re-read's fetchStatus flips (a routine check must
  // not flicker). It stops being confirmed once that read has failed: isError,
  // not fetching, and not a current copy. Absence is then unknown — or last
  // known, if the stale copy still contains the pubkey.
  const liveNegativeUnconfirmed =
    wsResult.userBanned === false
    && bannedPubkeys.isError
    && !bannedReRead.current
    && !bannedReRead.rereading;

  return {
    // User ban: a completed check wins over the ban list, except a later
    // current list that contains the pubkey, and except a stored negative
    // whose list re-read has since failed. When the check could not answer,
    // the list may still settle it — but only positively.
    //
    // A list `false` means the read succeeded and the pubkey is absent: a failed
    // list read throws rather than returning `[]` (see useRelayBanLists). It
    // still does not overrule an inconclusive live check. The live check is
    // verifyPubkeyBanned, the same listbannedpubkeys read, so when it could not
    // complete while a list read did, the relay answered one read and not the
    // other moments apart. Membership is worth surfacing on any evidence;
    // absence is not, so that disagreement resolves to unknown rather than to
    // "not banned". listMembership applies the same rule to the lists. A
    // confirmed-absent list could arguably answer `false` here; the tests
    // deliberately pin the conservative answer.
    isUserBanned: currentListBan
      ? true
      : wsResult.userBanned === undefined
        ? isUserBannedFromList
        : liveNegativeUnconfirmed
          ? (isUserBannedFromList === true ? true : null)
          : wsResult.userBanned === null && isUserBannedFromList === true
            ? true
            : wsResult.userBanned,
    isUserSuspended: isUserSuspendedFromList,
    // Only stale when the list is what answered. A live check that returned
    // true is fresh by definition. A live false is fresh only while the list
    // is still current or still re-reading; after that re-read fails, a
    // leftover presence is last known.
    isUserBannedStale: currentListBan
      ? false
      : (wsResult.userBanned === undefined || wsResult.userBanned === null || liveNegativeUnconfirmed)
        && bannedFromStaleList,
    isUserSuspendedStale,
    // Event in ban list (separate from "gone" — banned events can be retrieved via admin API)
    isEventBanned: isEventBannedFromList,
    // Event gone from relay (WebSocket verified, or known from ban list)
    isEventGone: wsResult.eventGone === undefined
      ? (isEventBannedFromList === true ? true : null)
      : wsResult.eventGone === null && isEventBannedFromList === true
        ? true
        : wsResult.eventGone,
    isLoading: banListsLoading,
    // No account in view means no account status to wait on, whatever the
    // lists are doing: a check of a post alone still asks them to re-read.
    isAccountStatusLoading: !!pubkey && (
      bannedPubkeys.isLoading
      || suspendedPubkeys.isLoading
      || wsResult.isChecking
      || bannedReRead.rereading
      || suspendedReRead.rereading
    ),
    isUserBanChecking: !!pubkey && (
      bannedPubkeys.isLoading
      || wsResult.isChecking
      || bannedReRead.rereading
    ),
    isChecking: wsResult.isChecking,
    checkedAt: wsResult.checkedAt,
    recheck,
    recheckAfterAction,
  };
}
