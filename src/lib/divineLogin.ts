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
// The revision the read in inFlight started at (see SESSION_REVISION_KEY).
let inFlightRevision: Revision = null;
let sessionGeneration = 0;

// sessionGeneration lives in this tab's module, so another tab's logout never
// moves it. This value lives in shared storage and changes on every logout, so
// a read in any tab can tell that a logout landed while it ran. Without it, a
// tab whose refresh is in flight when another tab signs out saves the refreshed
// session back into the storage the logout just cleared, and every tab reads
// as signed in again.
export const SESSION_REVISION_KEY = 'divine-login:session-revision';

// A revision read that threw. Kept apart from null (never written): a logout
// that cannot read the revision cannot name the session era it ends, and a
// session read without one cannot tell which era it belongs to.
const UNREADABLE: unique symbol = Symbol('unreadable revision');
type Revision = string | null | typeof UNREADABLE;

function readSessionRevision(): Revision {
  try {
    return localStorage.getItem(SESSION_REVISION_KEY);
  } catch {
    // A read counts as stale only when this value differs from the one taken
    // at its start, so a browser whose storage always throws keeps the
    // same-tab generation check alone.
    return UNREADABLE;
  }
}

// Logged by name only, never a value. Read the name off the object: a
// DOMException is not an Error in every runtime.
function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : typeof err;
}

function bumpSessionRevision(): void {
  try {
    // Only has to differ from the last value. randomUUID needs a secure context;
    // the fallback keeps the bump working without one.
    const revision =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(SESSION_REVISION_KEY, revision);
  } catch (err) {
    // The sign-out itself still goes ahead.
    console.warn('[divine-login] could not record the sign-out for other tabs:', errorName(err));
  }
}

// The signed-out fence. A session that a logout, or a read cleaning up after
// one, ends but cannot remove stays in storage, and a later read, which starts
// at the new revision, would accept it: the sign-out would last until the next
// focus or reload. So every session ended is fenced by a fingerprint, and
// every read refuses a stored session behind the fence and retries the
// removal. The fence is kept in this tab and, best effort, in storage, so a
// reloaded tab honours it too. It names ended sessions only, so a new sign-in,
// which carries a new token, is never refused.
export const ENDED_SESSIONS_KEY = 'divine-login:ended-sessions';
// Enough for every session a burst of sign-outs and refreshes can end; older
// ones are long gone from storage.
// Accepted limit: if more than 20 tabs of one session era fence at once, the
// cap can evict the fingerprint of a session still in storage, and a reloaded
// tab would then accept it. Each tab that fenced it still refuses it from
// memory. It needs that many tabs ending sessions in the same moment.
const MAX_PERSISTED_FENCE = 20;
const fencedFingerprints = new Set<string>();
// The session this tab last accepted. A logout fences it even when storage
// cannot say what it holds: a read that fails during the sign-out would
// otherwise fence nothing, and if the removal failed too, the next read, once
// storage recovers, would accept the old session again.
let lastSessionKey: string | undefined;

// What identifies a stored session: its access token, or for a session with
// none (the provider still counts that shape as signed in), its bunker URL.
// Only ever stored as a fingerprint, since both carry secrets.
function sessionKey(creds: StoredCredentials | null | undefined): string | undefined {
  if (creds?.accessToken) return `access:${creds.accessToken}`;
  if (creds?.bunkerUrl) return `bunker:${creds.bunkerUrl}`;
  return undefined;
}

// FNV-1a over two lanes: a stable name for a session that does not reveal it
// (synchronous, since logout is). A collision only refuses one session, whose
// moderator signs in again.
function fingerprint(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

// Undefined when storage cannot be read.
function readPersistedFence(): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ENDED_SESSIONS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((fp): fp is string => typeof fp === 'string') : [];
  } catch {
    return undefined;
  }
}

function fence(key: string): void {
  const fp = fingerprint(key);
  fencedFingerprints.add(fp);
  // Not written over a list that could not be read: that would drop the
  // fingerprints other tabs put there.
  const persisted = readPersistedFence();
  if (!persisted) return;
  try {
    const next = [...persisted.filter((other) => other !== fp), fp].slice(-MAX_PERSISTED_FENCE);
    localStorage.setItem(ENDED_SESSIONS_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[divine-login] could not record the ended session for other tabs:', errorName(err));
  }
}

// 'unknown' when the persisted fence cannot be read: the caller must not
// treat that as clear (fail closed).
function fenceState(key: string): 'fenced' | 'clear' | 'unknown' {
  const fp = fingerprint(key);
  if (fencedFingerprints.has(fp)) return 'fenced';
  const persisted = readPersistedFence();
  if (!persisted) return 'unknown';
  return persisted.includes(fp) ? 'fenced' : 'clear';
}

function storedSessionKey(): string | undefined {
  try {
    return sessionKey(getClient().oauth.getSession());
  } catch {
    return undefined;
  }
}

// Fence a session this tab is ending, then remove it if storage still holds
// it. Only that session: a newer sign-in is another session and survives, and
// empty storage may hold another tab's sign-in in progress (its PKCE
// verifier), which the SDK's logout would delete.
function endSession(key: string | undefined): void {
  if (!key) return;
  fence(key);
  if (storedSessionKey() !== key) return;
  try {
    getClient().oauth.logout();
  } catch (err) {
    console.warn('[divine-login] could not remove the ended session; later reads refuse it:', errorName(err));
  }
}

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
  const revision = readSessionRevision();
  // The session in storage when this read started.
  const startKey = storedSessionKey();
  // A logout since this read started, in this tab or another one. Deliberately
  // fail closed: a revision that was unreadable when the read started and is
  // readable now also counts, since an unknown change cannot be told apart
  // from a real logout. After two storage faults in sequence, a valid session
  // can be fenced and removed this way, and the moderator signs in again.
  const loggedOutSince = () => generation !== sessionGeneration || readSessionRevision() !== revision;
  const read = async () => {
    const stored = storedSessionKey();
    const fenced = stored ? fenceState(stored) : 'clear';
    if (fenced === 'fenced') {
      // A session a logout ended but could not remove. Refuse it before any
      // refresh, which would mint tokens the fence does not name, and retry
      // the removal.
      endSession(stored);
      return null;
    }
    if (loggedOutSince()) {
      // A logout landed while this read waited for the lock, so the session it
      // started from is ended: fence it, and remove it if storage still holds
      // it. Anything else there now is a sign-in made since, and survives. A
      // session the lock's holder refreshed after the logout is the holder's
      // to remove (its post-refresh check below, or the sign-out message).
      // Before the unreadable-fence check below: a known logout is a decision,
      // and deferring it would leave the start session unfenced.
      endSession(startKey);
      return null;
    }
    if (fenced === 'unknown') {
      // No logout is known, but the fence cannot be read, so this read cannot
      // tell whether the stored session was ended. Refuse it without
      // refreshing, but leave it in place and unfenced: it may be fine, and
      // the next read decides once the fence can be read again.
      return null;
    }
    // Accepted limit: the SDK saves a refresh before this read can check it.
    // If another tab completes an OAuth sign-in in that same window, this save
    // overwrites it, and the check below then removes the refreshed session
    // (storage holds it), so the moderator signs in again. Fails closed.
    const session = await getClient().oauth.getSessionWithRefresh();
    if (loggedOutSince()) {
      // Refresh can re-persist credentials after logout. Clear them before this
      // callback releases the Web Lock, not in a reaction to locks.request():
      // the next holder can otherwise read them before that reaction runs.
      // Only if storage still holds what this read got: anything else there was
      // written since by a sign-in in another tab, and is not this read's to
      // delete. The SDK's logout also drops the PKCE verifier, so a sign-in
      // another tab has started but not finished can still fail here; the
      // moderator signs in again.
      endSession(sessionKey(session));
      return null;
    }
    if (session) {
      sessionRevisions.set(session, revision);
      lastSessionKey = sessionKey(session);
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
  inFlightRevision = revision;
  return shared;
}

// The revision each returned session's read started at: the session era it
// belongs to. A sign-out message names the era it ended, so a tab can tell a
// session from that era from a newer sign-in it has applied since.
const sessionRevisions = new WeakMap<StoredCredentials, Revision>();

/** What a tab broadcasts when it signs out: the revision its logout ended. */
export interface SignOutMessage {
  type: 'signed-out';
  // Absent when the sender could not tell; a receiver then treats every
  // session it holds as ended (fail closed).
  endedRevision?: string | null;
}

function isSignOutMessage(data: unknown): data is SignOutMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'signed-out';
}

/**
 * Handle another tab's sign-out message. Ends this tab's read in flight and
 * its applied session if they belong to the session era the message ended,
 * without broadcasting and without touching a newer sign-in. Returns true when
 * the applied session was ended, so the caller signs out its UI.
 */
export function acceptSignOutFromOtherTab(data: unknown, applied: StoredCredentials | null): boolean {
  if (!isSignOutMessage(data)) return false;
  const known = 'endedRevision' in data;
  // An unknown era on either side ends the session (fail closed): the sender
  // could not name it, or this tab could not tell which era it read.
  const fromEndedEra = (era: Revision | undefined) => !known || era === UNREADABLE || era === data.endedRevision;
  // A read in flight from the ended era: invalidate and detach it. Its own
  // post-refresh check then removes what its refresh saved. Needed even when
  // the revision bump reached storage, since it may not have reached it in
  // time, and essential when the sender's revision write failed.
  if (inFlight && fromEndedEra(inFlightRevision)) {
    sessionGeneration += 1;
    inFlight = null;
  }
  if (!applied || !fromEndedEra(sessionRevisions.get(applied))) return false;
  // Storage reaches other tabs a moment late, so this tab's refresh may have
  // saved this session after the sender's clear.
  endSession(sessionKey(applied));
  return true;
}

/**
 * Sign out: fence and clear the stored session, and return the message to
 * broadcast to the app's other tabs. Never throws: a removal that fails is
 * logged by name, and the fence makes later reads refuse the session.
 */
export function logout(): SignOutMessage {
  sessionGeneration += 1;
  const endedRevision = readSessionRevision();
  const ended = storedSessionKey();
  if (ended) fence(ended);
  // Also the session this tab last accepted, in case storage could not be
  // read just now. Fencing it when storage did name a session is harmless:
  // it belongs to this sign-out either way.
  if (lastSessionKey && lastSessionKey !== ended) fence(lastSessionKey);
  // Before the clear, not after. Another tab's refresh saves the session and
  // then checks the revision. If its check runs after this bump, it removes
  // what it saved; if before, its save landed before the clear below, which
  // removes it. Bumping after the clear would leave a window where a save lands
  // after the clear and its check still sees the old revision.
  // No Web Lock here, so signing out never waits on another tab's refresh.
  bumpSessionRevision();
  // A later focus/visibility refresh must read the signed-out session, not join
  // a pre-logout read whose result the provider's generation guard will discard.
  // That old call's finally only clears itself, so it cannot clear a newer read.
  inFlight = null;
  try {
    getClient().oauth.logout();
  } catch (err) {
    console.warn('[divine-login] could not remove the session; later reads refuse it:', errorName(err));
  }
  // A revision that could not be read names no era: receivers then end
  // whatever they hold, rather than reading it as "no revision yet".
  return endedRevision === UNREADABLE ? { type: 'signed-out' } : { type: 'signed-out', endedRevision };
}
