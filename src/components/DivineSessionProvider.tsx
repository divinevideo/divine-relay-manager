// ABOUTME: Provider that resolves the divine-login session AND the moderator
// identity (pubkey + signer) once, so every useCurrentUser consumer shares it
// (no per-mount RPC). Attribution goes by the login token (getModeratorToken).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import type { NostrSigner } from '@nostrify/nostrify';
import {
  acceptSignOutFromOtherTab,
  getSession,
  logout as sdkLogout,
  startLogin as sdkStartLogin,
  type SignOutMessage,
} from '@/lib/divineLogin';
import { DivineRpcSigner } from '@/lib/divineSigner';
import { DivineSessionContext, type DivineSessionValue } from '@/contexts/DivineSessionContext';

const HEX_64 = /^[0-9a-f]{64}$/;
// Stable "no resolved identity" record, so clearing never allocates a new object
// and re-runs the value memo for nothing.
const NO_IDENTITY = { token: undefined, pubkey: undefined } as const;

// Scheduled refresh runs this long before the access token expires. Inside the
// SDK's own window (getSessionWithRefresh refreshes only within 5 minutes of
// expiry), so the call really refreshes instead of returning the same token.
const REFRESH_LEAD_MS = 4 * 60_000;
// Floor on the scheduled refresh, so a token issued with less than the lead
// left cannot make the schedule refresh in a tight loop.
const MIN_REFRESH_DELAY_MS = 30_000;
// setTimeout runs at once for any delay above 2^31-1 ms (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;
const timerDelay = (ms: number) => Math.min(Math.max(ms, 0), MAX_TIMER_MS);
// How long after expiresAt the one retry runs when the expiry refresh got the
// same token back (see the expiry timer).
const EXPIRY_RETRY_MARGIN_MS = 1_000;
// A sign-out in one tab is announced to the app's other tabs on this channel,
// so each drops to signed out at once rather than on its next focus.
const SIGN_OUT_CHANNEL = 'divine-login';
// Sent when the library could not say which session it ended; receivers then
// end whatever session they hold (fail closed).
const SIGN_OUT_UNKNOWN: SignOutMessage = { type: 'signed-out' };

export function DivineSessionProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<StoredCredentials | null>(null);
  const [credentialsResolved, setCredentialsResolved] = useState(false);
  // The resolved pubkey together with the access token it belongs to, stored as
  // one record so the pair can never drift apart. Matched against the live token
  // during render below.
  const [resolvedIdentity, setResolvedIdentity] = useState<{
    token: string | undefined;
    pubkey: string | undefined;
  }>({ token: undefined, pubkey: undefined });
  // The access token the pubkey-resolution attempt has settled for (success OR
  // failure). Compared against the live token during render so isResolving is
  // derived, not lagged by a post-commit effect (avoids a one-frame "Sign in"
  // flash for an already-signed-in moderator on load).
  const [resolvedForToken, setResolvedForToken] = useState<string | undefined>(undefined);

  // Bumped on logout so an in-flight refresh that started earlier can detect it
  // lost the race and discard its result. getSession clears anything the SDK
  // re-persisted mid-refresh (lib/divineLogin).
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  // The credentials last applied, set as they are applied. A sign-out message
  // is matched against them (lib/divineLogin knows which session era they come
  // from). tokenRef mirrors the token, but from an effect, so a message
  // arriving between a refresh's apply and that effect would see the old one.
  const appliedCredsRef = useRef<StoredCredentials | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The access token now matters for attribution (the worker verifies it on
  // every action, #178 phase 2), so it is refreshed before it expires: on mount,
  // on window focus, when the tab becomes visible, on a timer shortly before
  // expiresAt, and when getModeratorToken finds it expired.
  // Known limitation: getSessionWithRefresh() returns null both for "no
  // session" and "refresh failed", and the SDK deletes the stored session when a
  // refresh throws, so a network blip during a refresh signs the moderator out
  // and they sign in again. That surfaces as the attribution notice rather than
  // as silent unattributed actions. Only a refresh near expiry can hit it.
  // Resolves to the credentials it applied, or undefined when it applied
  // nothing (unmounted, or a logout won the race). The expiry timer reads it.
  const loadSession = useCallback(async (): Promise<StoredCredentials | null | undefined> => {
    const gen = generationRef.current;
    let creds: StoredCredentials | null = null;
    try {
      creds = await getSession();
    } catch {
      // Storage disabled (private mode) or an SDK throw: degrade to signed-out
      // rather than hanging on the loading state forever.
      creds = null;
    }
    if (!mountedRef.current) return undefined;
    if (gen !== generationRef.current) {
      // A logout landed while this resolve was in flight: discard the result.
      // getSession already cleared anything its refresh re-persisted, inside
      // the read (under the session lock, unless the wait for it timed out).
      // Clearing again here would run after the lock is released, and could
      // delete a sign-in another tab has made since.
      return undefined;
    }
    appliedCredsRef.current = creds;
    setCredentials(creds);
    setCredentialsResolved(true);
    return creds;
  }, []);
  const refresh = useCallback(async () => {
    await loadSession();
  }, [loadSession]);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    // A tab brought back from the background may not get a focus event (switching
    // tabs within one window), and its expiry timer may have been throttled.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const accessToken = credentials?.accessToken;
  const expiresAt = credentials?.expiresAt;
  // The access token that reached expiresAt with no refresh replacing it. Set by
  // the expiry timer below or by getModeratorToken; a new token clears it by no
  // longer matching.
  const [expiredToken, setExpiredToken] = useState<string | undefined>(undefined);
  const tokenExpired = !!accessToken && expiredToken === accessToken;
  // Derived during render, like identityResolved below and for the same reason:
  // the signer is rebuilt from the live token immediately, so an effect that
  // cleared a stale pubkey would land one render too late, and for that render
  // the session would hand out the previous token's pubkey paired with the new
  // token's signer. isResolving hides that window in the header, but
  // useCurrentUser does not expose isResolving, so a consumer reading
  // user.pubkey (EditProfileForm loads a profile from it) would see one
  // session's identity attached to another's.
  // An expired token hands out no pubkey either. Keycast refuses the token, so
  // the worker records nobody, and the UI has to say so (AttributionNotice shows
  // when there is no user). The pubkey cannot be re-checked by asking the
  // signer: DivineRpcSigner caches it and would answer from the cache.
  const pubkey = !tokenExpired && resolvedIdentity.token === accessToken ? resolvedIdentity.pubkey : undefined;
  const signer = useMemo<NostrSigner | null>(
    () => (accessToken ? new DivineRpcSigner(() => accessToken) : null),
    [accessToken],
  );
  // Latest access token and its expiry, mirrored in a ref so getModeratorToken
  // is a synchronous read of the live session at call time.
  const tokenRef = useRef<{ token?: string; expiresAt?: number }>({});
  useEffect(() => {
    tokenRef.current = { token: accessToken, expiresAt };
  }, [accessToken, expiresAt]);

  // Stable identity on purpose: it reads the ref, so a caller that took it from
  // an earlier render still sees the current session. The returned string is a
  // value, so a token taken at the click is unaffected by what happens next.
  // Synchronous, so an expired token cannot wait for its refresh: the action
  // gets no token (and records nobody, which Keycast refusing the stale token
  // would have done anyway), the UI is told, and the refresh serves the next one.
  const getModeratorToken = useCallback((): string | undefined => {
    const { token, expiresAt: expiry } = tokenRef.current;
    if (token && expiry !== undefined && expiry <= Date.now()) {
      setExpiredToken(token);
      void refresh();
      return undefined;
    }
    return token;
  }, [refresh]);

  // Refresh shortly before the token expires, so a long session in one focused
  // tab never acts on an expired token. If expiresAt passes anyway (the refresh
  // failed to replace it, or the timer ran late), mark the token expired and try
  // once more; a session that cannot refresh then reads as signed out.
  useEffect(() => {
    if (!accessToken || expiresAt === undefined) return;
    const untilExpiry = expiresAt - Date.now();
    const refreshTimer = setTimeout(() => {
      void refresh();
    }, timerDelay(Math.max(untilExpiry - REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS)));
    // If this timer runs a moment before the SDK's clock reaches expiresAt, a
    // session with no refresh token comes back unchanged and still marked
    // expired, and nothing else would reschedule. So when the same token comes
    // back, retry once just after expiresAt: the SDK then reports it expired
    // and the session settles to signed out (or a fresh token).
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const expiryTimer = setTimeout(() => {
      setExpiredToken(accessToken);
      void loadSession().then((creds) => {
        if (cancelled || creds?.accessToken !== accessToken) return;
        retryTimer = setTimeout(() => {
          void refresh();
        }, timerDelay(expiresAt + EXPIRY_RETRY_MARGIN_MS - Date.now()));
      });
    }, timerDelay(untilExpiry));
    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      clearTimeout(expiryTimer);
      clearTimeout(retryTimer);
    };
  }, [accessToken, expiresAt, refresh, loadSession]);

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setResolvedIdentity(NO_IDENTITY);
      // Also drop the resolved marker. Without it, a token that goes away and
      // comes back identical still matches, so the very next RENDER reads as
      // resolved-with-no-pubkey and commits the error state before the resolve
      // effect below can correct it. One render is enough to flash a red alarm.
      setResolvedForToken(undefined);
      return;
    }
    // Invariant: a resolve attempt that has not settled has resolved nothing.
    // Every path that reaches here today is already covered (a changed token
    // makes identityResolved false on its own, and a token returning after the
    // session dropped is reset in the !signer branch above), so no test pins
    // this line. It is kept so the invariant does not depend on those two
    // coincidences continuing to hold.
    setResolvedForToken(undefined);
    signer
      .getPublicKey()
      .then((pk) => {
        if (cancelled) return;
        // The worker requires canonical lowercase 64-hex. Normalize the common
        // non-canonical shapes (uppercase / whitespace) and warn on anything
        // still invalid rather than degrading silently.
        const normalized = pk.trim().toLowerCase();
        if (HEX_64.test(normalized)) {
          // Recorded against the token it came from, so it is handed out only
          // while that token is still the live one.
          setResolvedIdentity({ token: accessToken, pubkey: normalized });
        } else {
          console.warn('[divine-login] getPublicKey returned a non-canonical pubkey; attribution unavailable', pk);
          // Never carry a previous token's identity forward: a stale pubkey
          // renders as a confident moderator while attribution writes null.
          setResolvedIdentity(NO_IDENTITY);
        }
      })
      .catch((err) => {
        // Attribution degrades to null and never blocks a moderation action, but
        // it must not look like a resolved identity, and the reason has to be
        // diagnosable when a moderator reports the banner.
        if (cancelled) return;
        setResolvedIdentity(NO_IDENTITY);
        console.warn('[divine-login] getPublicKey failed; attribution unavailable', err);
      })
      .finally(() => {
        // Mark this token resolved (success or failure) so isResolving settles.
        if (!cancelled) setResolvedForToken(accessToken);
      });
    return () => {
      cancelled = true;
    };
  }, [signer, accessToken]);

  // This tab's half of a sign-out, shared by logout and by another tab's
  // announcement. No generation bump here: logout bumps it, and a received
  // sign-out must not, since the library has already invalidated any read
  // from the ended session, and a read still in flight is of a newer sign-in.
  const clearLocalSession = useCallback(() => {
    // Drop the token now rather than waiting for the post-commit effect, so a
    // click between logout and the re-render takes no token. An action that
    // already took one keeps its own copy.
    tokenRef.current = {};
    setCredentials(null);
    setResolvedIdentity(NO_IDENTITY);
    setCredentialsResolved(true); // logout is a definitive "signed out" resolution
  }, []);

  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    // Where BroadcastChannel is missing (constructing it throws) or refused,
    // the other tabs still catch up on their next focus or visibility re-read.
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
    } catch {
      return;
    }
    // The library ends this tab's read in flight and applied session if they
    // belong to the session the sender ended, and leaves a newer sign-in
    // alone. A channel never receives its own messages, and this handler posts
    // nothing, so the message does not echo.
    channel.onmessage = (event: MessageEvent) => {
      if (acceptSignOutFromOtherTab(event.data, appliedCredsRef.current)) clearLocalSession();
    };
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [clearLocalSession]);

  const logout = useCallback(() => {
    let message: SignOutMessage = SIGN_OUT_UNKNOWN;
    try {
      // Also bumps the session revision in shared storage and fences the
      // ended session, so neither another tab's refresh in flight nor a failed
      // removal can bring it back (lib/divineLogin).
      message = sdkLogout();
    } finally {
      // Even if the library throws, this tab and the others sign out (Matt,
      // 2026-11-09). The throw still propagates. Without the library's message
      // the other tabs are told the ended session is unknown, and end theirs.
      // The generation bump discards a resolve already in flight in this tab.
      generationRef.current += 1;
      clearLocalSession();
      channelRef.current?.postMessage(message);
    }
  }, [clearLocalSession]);

  // Identity is pending when there's a token we have not finished resolving for.
  // Derived during render so it never lags the token by a frame.
  const identityResolved = !accessToken || resolvedForToken === accessToken;
  const isResolving = !credentialsResolved || !identityResolved;
  // Settled on a token but no pubkey came back: a real session with no moderator
  // identity. Distinct from signed-out, and the UI must not render it as such --
  // without this the header shows "Sign in" with no way to sign out.
  // Keyed on credentials, not the access token: StoredCredentials.accessToken is
  // optional (a bunker-only session), and that shape has no signer at all, so it
  // is the same dead end. With no token, identityResolved is already true.
  const identityUnavailable = !!credentials && identityResolved && !pubkey;
  // Session presence, independent of whether the identity resolved. Relay
  // management is gated on this rather than on the pubkey; see the field doc.
  const isSignedIn = !!credentials;

  const value = useMemo<DivineSessionValue>(
    () => ({
      credentials,
      pubkey,
      signer,
      isSignedIn,
      isResolving,
      identityUnavailable,
      getModeratorToken,
      startLogin: sdkStartLogin,
      logout,
      refresh,
    }),
    [credentials, pubkey, signer, isSignedIn, isResolving, identityUnavailable, getModeratorToken, logout, refresh],
  );

  return <DivineSessionContext.Provider value={value}>{children}</DivineSessionContext.Provider>;
}
