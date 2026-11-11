// ABOUTME: Hooks for the audited suspended-content viewer: one hidden post, or an account's
// ABOUTME: hidden posts page by page. Every read is a click, and a session change drops them.

import { useCallback, useRef, useState } from 'react';
import { useAdminApi, useApiUrl } from '@/hooks/useAdminApi';
import { useDivineSession } from '@/hooks/useDivineSession';
import { ApiError } from '@/lib/adminApi';
import { RECENT_CONTENT_KINDS } from '@/lib/constants';
import type {
  SuspendedAccountRequest,
  SuspendedAccountResponse,
  SuspendedEventResponse,
  SuspendedViewSurface,
} from '../../shared/suspended-content';

// Why these hold state themselves rather than using TanStack Query: the worker
// writes one audit row per request, so a request nobody clicked for is a false
// entry in that log. A query refetches on mount, focus and reconnect unless
// every one is turned off, and `enabled: open && signedIn` refetches on its own
// when a moderator signs back in. Here the only thing that sends a request is
// load() or loadOlder(), and nothing is cached past the component.
//
// The view belongs to one session identity: the resolved moderator pubkey in
// one environment. A sign-out, an unresolved or different pubkey, another
// environment or another target ends it. What was loaded is dropped during
// that render (so it is never committed alongside the new session), and an
// answer from an earlier session is discarded before it touches any state.
// That follows the session generation in SexualQuarantine.tsx.

export type SuspendedViewStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Where the session stands for the viewer:
 * - resolving: the session or its pubkey is still being read (at load, and
 *   after any credential change, a token refresh included);
 * - signed-out: no session;
 * - unverified: a session whose moderator identity did not resolve, which the
 *   worker could not verify either;
 * - ready: a resolved moderator. Only then does load() send anything.
 */
export type ViewerSession = 'resolving' | 'signed-out' | 'unverified' | 'ready';

const MODERATOR_LOGIN_REQUIRED = 'moderator_login_required';

/** What load() reports when the session has no usable token: no request is sent. */
function loginRequired(): ApiError {
  return new ApiError('Sign in with Divine to view', 401, undefined, MODERATOR_LOGIN_REQUIRED);
}

/**
 * A counter that moves whenever the view's session or target changes. State is
 * tagged with the epoch it was loaded under and shown only while it matches.
 */
function useViewerEpoch(target: string) {
  const session = useDivineSession();
  const apiUrl = useApiUrl();
  // The provider clears the pubkey on every credential change while
  // isSignedIn stays true, so an unresolved pubkey may be a token refresh or
  // another moderator's session replacing this one. Nothing here can tell
  // which, so no view outlives it: a refresh costs a click, never a leak.
  const pubkey = session.isSignedIn ? session.pubkey : undefined;
  const viewer: ViewerSession = pubkey ? 'ready'
    : session.isResolving ? 'resolving'
    : session.isSignedIn ? 'unverified'
    : 'signed-out';
  const ref = useRef({ key: '', epoch: 0 });
  const key = JSON.stringify([apiUrl, pubkey ?? null, target]);
  // Written during render on purpose: an effect would commit one render of the
  // old view under the new session first. Idempotent for a repeated render.
  if (ref.current.key !== key) ref.current = { key, epoch: ref.current.epoch + 1 };
  return { session: viewer, epoch: ref.current.epoch, epochRef: ref, getModeratorToken: session.getModeratorToken };
}

interface Tagged<T> { epoch: number; value: T }

export interface SuspendedPostView {
  /** load() sends only when this is 'ready'. */
  session: ViewerSession;
  status: SuspendedViewStatus;
  data: SuspendedEventResponse | undefined;
  error: unknown;
  /** The moderator's click: one audited read. Also the retry. */
  load: () => void;
}

type PostState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: SuspendedEventResponse }
  | { status: 'error'; error: unknown };

const IDLE: PostState = { status: 'idle' };

export function useSuspendedPost({ eventId, surface }: { eventId: string; surface: SuspendedViewSurface }): SuspendedPostView {
  const api = useAdminApi();
  const { session, epoch, epochRef, getModeratorToken } = useViewerEpoch(`event:${eventId}:${surface}`);
  const [tagged, setTagged] = useState<Tagged<PostState>>({ epoch, value: IDLE });
  // Another session's or target's view, including an answer that landed after
  // the session changed, is dropped before this render commits.
  if (tagged.epoch !== epoch && tagged.value !== IDLE) setTagged({ epoch, value: IDLE });
  const state = tagged.value;

  const load = useCallback(() => {
    if (session !== 'ready') return;
    // An answer from an earlier session is rejected before it changes any
    // state: installing it, even briefly, would replace a newer view.
    const started = epochRef.current.epoch;
    const set = (value: PostState) => {
      if (epochRef.current.epoch === started) setTagged({ epoch: started, value });
    };
    const token = getModeratorToken(); // taken at the click
    if (!token) { set({ status: 'error', error: loginRequired() }); return; }
    set({ status: 'loading' });
    api.asModerator(token).viewSuspendedPost({ eventId, surface }).then(
      data => set({ status: 'success', data }),
      error => set({ status: 'error', error }),
    );
  }, [api, session, epochRef, getModeratorToken, eventId, surface]);

  return {
    session,
    status: state.status,
    data: state.status === 'success' ? state.data : undefined,
    error: state.status === 'error' ? state.error : undefined,
    load,
  };
}

export interface SuspendedAccountView {
  /** load() and loadOlder() send only when this is 'ready'. */
  session: ViewerSession;
  /** The first page's read. */
  status: SuspendedViewStatus;
  error: unknown;
  /** Every page loaded so far, newest first. The first carries the profile. */
  pages: SuspendedAccountResponse[];
  /** The moderator's click for the first page. Also its retry. */
  load: () => void;
  hasOlder: boolean;
  /** The moderator's click for the next page: one more audited read. */
  loadOlder: () => void;
  olderStatus: SuspendedViewStatus;
  olderError: unknown;
}

interface AccountState {
  status: SuspendedViewStatus;
  error?: unknown;
  pages: SuspendedAccountResponse[];
  olderStatus: SuspendedViewStatus;
  olderError?: unknown;
}

const ACCOUNT_IDLE: AccountState = { status: 'idle', pages: [], olderStatus: 'idle' };

// The posts the user cards count, without the profile: the worker reads kind 0
// separately on the first page.
const ACCOUNT_KINDS = [...RECENT_CONTENT_KINDS];

export function useSuspendedAccount({ pubkey, surface }: { pubkey: string; surface: SuspendedViewSurface }): SuspendedAccountView {
  const api = useAdminApi();
  const { session, epoch, epochRef, getModeratorToken } = useViewerEpoch(`account:${pubkey}:${surface}`);
  const [tagged, setTagged] = useState<Tagged<AccountState>>({ epoch, value: ACCOUNT_IDLE });
  if (tagged.epoch !== epoch && tagged.value !== ACCOUNT_IDLE) setTagged({ epoch, value: ACCOUNT_IDLE });
  const state = tagged.value;
  const last = state.pages[state.pages.length - 1];
  const hasOlder = last?.nextUntil != null;

  const request = useCallback((page: Pick<SuspendedAccountRequest, 'until' | 'untilId'>, older: boolean) => {
    if (session !== 'ready') return;
    // As in useSuspendedPost: an answer from an earlier session is rejected
    // before it changes any state.
    const started = epochRef.current.epoch;
    const update = (change: (s: AccountState) => AccountState) => {
      if (epochRef.current.epoch !== started) return;
      setTagged(t => ({ epoch: started, value: change(t.epoch === started ? t.value : ACCOUNT_IDLE) }));
    };
    const fail = (error: unknown) => update(s => older
      ? { ...s, olderStatus: 'error', olderError: error }
      : { ...ACCOUNT_IDLE, status: 'error', error });
    const token = getModeratorToken(); // taken at the click
    if (!token) { fail(loginRequired()); return; }
    update(s => older ? { ...s, olderStatus: 'loading', olderError: undefined } : { ...ACCOUNT_IDLE, status: 'loading' });
    api.asModerator(token).viewSuspendedAccount({ pubkey, surface, kinds: ACCOUNT_KINDS, ...page }).then(
      data => update(s => older
        ? { ...s, pages: [...s.pages, data], olderStatus: 'idle', olderError: undefined }
        : { ...ACCOUNT_IDLE, status: 'success', pages: [data] }),
      fail,
    );
  }, [api, session, epochRef, getModeratorToken, pubkey, surface]);

  const load = useCallback(() => request({}, false), [request]);
  const loadOlder = useCallback(() => {
    if (!last || last.nextUntil == null || state.olderStatus === 'loading') return;
    request({ until: last.nextUntil, ...(last.nextUntilId ? { untilId: last.nextUntilId } : {}) }, true);
  }, [request, last, state.olderStatus]);

  return {
    session,
    status: state.status,
    error: state.error,
    pages: state.pages,
    load,
    hasOlder,
    loadOlder,
    olderStatus: state.olderStatus,
    olderError: state.olderError,
  };
}
