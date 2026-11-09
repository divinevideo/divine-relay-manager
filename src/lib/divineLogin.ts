// ABOUTME: Thin wrapper over the @divinevideo/login SDK (OAuth2 + PKCE against
// login.divine.video). The SDK owns PKCE, token storage, refresh and signing;
// this module only configures the client and exposes the flow relay-admin uses.
import { createDivineClient, type StoredCredentials } from '@divinevideo/login';

// Must name the same Keycast as the worker's MODERATOR_LOGIN_URL
// (worker/wrangler.staging.toml and wrangler.prod.toml), which verifies this
// login's token. If they differ, verification fails and attribution silently
// records no moderator.
export const DIVINE_LOGIN_SERVER_URL =
  import.meta.env.VITE_DIVINE_LOGIN_URL || 'https://login.divine.video';
export const DIVINE_LOGIN_CLIENT_ID = 'divine-relay-admin';

// The SDK's OAuth methods (exchangeCode / refreshSession) have no built-in
// request timeout, so a stalled login server would hang the callback or the
// mount-time session resolve forever. Wrap fetch with a whole-request timeout
// (AbortSignal.timeout aborts headers AND body, unlike a manual clearTimeout).
const OAUTH_TIMEOUT_MS = 15_000;
export function timeoutFetch(ms: number): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

const RETURN_PATH_KEY = 'divine-login:return-path';

function callbackUrl(): string {
  return new URL('/auth/callback', window.location.origin).toString();
}

let client: ReturnType<typeof createDivineClient> | null = null;
function getClient() {
  if (!client) {
    client = createDivineClient({
      serverUrl: DIVINE_LOGIN_SERVER_URL,
      clientId: DIVINE_LOGIN_CLIENT_ID,
      redirectUri: callbackUrl(),
      storage: localStorage,
      fetch: timeoutFetch(OAUTH_TIMEOUT_MS),
    });
  }
  return client;
}

/** Begin the OAuth flow: stash where to return, then redirect to the authorize URL. */
export async function startLogin(returnPath?: string): Promise<void> {
  const { url } = await getClient().oauth.getAuthorizationUrl({});
  if (returnPath) localStorage.setItem(RETURN_PATH_KEY, returnPath);
  window.location.assign(url);
}

/** Finish the OAuth flow at the callback. The SDK persists the session to storage. */
export async function completeLogin(callbackHref: string): Promise<{ returnPath: string }> {
  const parsed = getClient().oauth.parseCallback(callbackHref);
  if ('error' in parsed) throw new Error(parsed.description || parsed.error);
  const tokens = await getClient().oauth.exchangeCode(parsed.code); // verifier from SDK storage
  // The REST signer (and thus the moderator pubkey) needs the access token. A
  // response with only a bunker_url would leave a "signed in but no identity"
  // dead state, so surface it as a visible error instead of navigating into it.
  if (!tokens.access_token) {
    throw new Error('Sign-in did not return an access token; try again.');
  }
  const returnPath = localStorage.getItem(RETURN_PATH_KEY) || '/reports';
  localStorage.removeItem(RETURN_PATH_KEY);
  return { returnPath };
}

// Keycast refresh tokens are single use: a second refresh with the same token
// is refused, and the SDK then deletes the stored session, signing the
// moderator out. Refreshes can overlap within a tab (focus and visibilitychange
// fire together when a tab comes back) and across tabs (each tab schedules one
// before expiry). So within a tab, concurrent callers share one call, and across
// tabs the calls run one at a time under a Web Lock: the next one re-reads
// storage, finds the session the previous one saved, and does not refresh again.
const SESSION_LOCK = 'divine-login:session';
// Longest wait for another tab's hold on the lock. A holder that never lets go
// (a hung tab) would otherwise leave this tab resolving forever, with every
// action unattributed. Above the 15 s OAuth timeout, so a healthy holder's
// refresh always finishes first. Past it, read without the lock.
const LOCK_WAIT_MS = 20_000;
let inFlight: Promise<StoredCredentials | null> | null = null;
let sessionGeneration = 0;

function readUnderLock(
  locks: LockManager,
  read: () => Promise<StoredCredentials | null>,
): Promise<StoredCredentials | null> {
  // A timer and an AbortController rather than AbortSignal.timeout, so the wait
  // runs on the page's timers (and the tests' fake ones).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCK_WAIT_MS);
  const locked: Promise<StoredCredentials | null> = locks.request(
    SESSION_LOCK,
    { signal: controller.signal },
    () => {
      clearTimeout(timer);
      return read();
    },
  );
  return locked.catch((err: unknown) => {
    // Only a wait that timed out falls back; a failure inside read() does not.
    if (controller.signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      console.warn('[divine-login] session lock not granted in time; reading without it');
      return read();
    }
    throw err;
  });
}

/** Current session with automatic refresh (SDK-managed). Null when signed out. */
export function getSession(): Promise<StoredCredentials | null> {
  if (inFlight) return inFlight;
  const generation = sessionGeneration;
  const read = async () => {
    if (generation !== sessionGeneration) {
      // A logout landed while this read waited for the lock. The holder's
      // refresh may have saved the old session after the logout cleared it,
      // and nothing here can tell that from a sign-in made meanwhile, so fail
      // closed: clear it. A sign-in that loses this way just signs in again;
      // an old session that survives could attribute a later moderator's
      // actions to the one who signed out.
      getClient().oauth.logout();
      return null;
    }
    const session = await getClient().oauth.getSessionWithRefresh();
    if (generation !== sessionGeneration) {
      // Refresh can re-persist credentials after logout. Clear them before this
      // callback releases the Web Lock, not in a reaction to locks.request():
      // the next holder can otherwise read them before that reaction runs.
      // Only if storage still holds what this read got: anything else there was
      // written since by a sign-in in another tab, and is not this read's to
      // delete. The SDK's logout also drops the PKCE verifier, so a sign-in
      // another tab has started but not finished can still fail here; the
      // moderator signs in again.
      const oauth = getClient().oauth;
      if (session?.accessToken && oauth.getSession()?.accessToken === session.accessToken) oauth.logout();
      return null;
    }
    return session;
  };
  // Web Locks need a secure context; without them, fall back to this tab's
  // single flight only.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const call = locks ? readUnderLock(locks, read) : read();
  const shared = call.finally(() => {
    if (inFlight === shared) inFlight = null;
  });
  inFlight = shared;
  return shared;
}

/** Clear all session data (SDK-managed). */
export function logout(): void {
  sessionGeneration += 1;
  // A later focus/visibility refresh must read the signed-out session, not join
  // a pre-logout read whose result the provider's generation guard will discard.
  // That old call's finally only clears itself, so it cannot clear a newer read.
  inFlight = null;
  getClient().oauth.logout();
}
