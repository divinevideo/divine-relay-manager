# Moderator Identity via divine-login (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give moderators an in-tool Divine-account login so `useCurrentUser` yields their real Nostr pubkey, lighting up attribution on moderation actions and the keycast audit — with no worker changes.

**Architecture:** Depend on the `@divinevideo/login` SDK directly for OAuth2+PKCE, token storage, refresh, and the REST signing RPC. Own only thin glue: a config module, a ~40-line `NostrSigner` adapter over the SDK's `DivineRpc`, a session context, an `/auth/callback` page, a sign-in button, and a rewrite of `useCurrentUser` to source the current user from that session. CF Access remains the authorization gate; the login is attribution only.

**Tech Stack:** React 18 + TypeScript + Vite, `@nostrify/nostrify` (NostrSigner), `@divinevideo/login@^1.0.0`, TanStack Query, React Router, Vitest.

## Global Constraints

- Frontend only. **No worker changes.** The worker already validates and persists `moderator_pubkey` (canonical lowercase 64-hex, PR #176) and `moderatorPubkey` (UserManagement).
- The resolved pubkey MUST be canonical lowercase 64-hex (`/^[0-9a-f]{64}$/`); a non-matching value is treated as unresolved (no user).
- SDK config: `serverUrl` = `import.meta.env.VITE_DIVINE_LOGIN_URL || 'https://login.divine.video'`; `clientId` = `'divine-relay-admin'`; `redirectUri` = `${window.location.origin}/auth/callback`; `storage: localStorage`.
- Do NOT copy divine-web app glue (its `useDivineSession` refresh scheduler, cross-subdomain cookie, multi-account precedence). Lean on the SDK's `getSessionWithRefresh()`.
- Typecheck with `npx tsc -p tsconfig.app.json --noEmit` (bare `tsc` is a false green). Full gate: `npm run test`.
- No em dashes in commit messages; no Co-Authored-By.
- The signer adapter carries `TODO(#178): replace with @divinevideo/divine-signer when published`.

---

### Task 1: SDK dependency, config module, dupe cleanup

**Files:**
- Modify: `package.json` (add `@divinevideo/login@^1.0.0`)
- Delete: `src/components/auth/LoginArea 2.tsx`, `src/components/auth/SignupDialog 2.tsx`, `src/components/auth/SignupDialog 3.tsx`, `src/hooks/useLoggedInAccounts 2.ts`
- Create: `src/lib/divineLogin.ts`
- Test: `src/lib/divineLogin.test.ts`

**Interfaces:**
- Produces:
  - `DIVINE_LOGIN_SERVER_URL: string`
  - `DIVINE_LOGIN_CLIENT_ID = 'divine-relay-admin'`
  - `startLogin(returnPath?: string): Promise<void>`
  - `completeLogin(callbackHref: string): Promise<{ returnPath: string }>`
  - `getSession(): Promise<StoredCredentials | null>`
  - `logout(): void`

- [ ] **Step 1: Install the SDK and delete the Finder-copy dupes**

```bash
npm install @divinevideo/login@^1.0.0
git rm "src/components/auth/LoginArea 2.tsx" "src/components/auth/SignupDialog 2.tsx" "src/components/auth/SignupDialog 3.tsx" "src/hooks/useLoggedInAccounts 2.ts"
```

Expected: `package.json`/`package-lock.json` updated; four files removed.

- [ ] **Step 2: Write the failing test**

Create `src/lib/divineLogin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the module under test.
const oauth = {
  getAuthorizationUrl: vi.fn(),
  parseCallback: vi.fn(),
  exchangeCode: vi.fn(),
  getSessionWithRefresh: vi.fn(),
  logout: vi.fn(),
};
const createDivineClient = vi.fn(() => ({ oauth, createRpc: vi.fn() }));
vi.mock('@divinevideo/login', () => ({ createDivineClient }));

import {
  DIVINE_LOGIN_CLIENT_ID,
  startLogin,
  completeLogin,
  getSession,
  logout,
} from './divineLogin';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // jsdom default origin is http://localhost:3000
  oauth.getAuthorizationUrl.mockResolvedValue({ url: 'https://login.divine.video/api/oauth/authorize?x=1', pkce: { verifier: 'v', challenge: 'c' } });
});

describe('divineLogin', () => {
  it('configures the client with the relay-admin client id and origin callback', async () => {
    await startLogin();
    expect(createDivineClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: DIVINE_LOGIN_CLIENT_ID,
        redirectUri: `${window.location.origin}/auth/callback`,
        storage: localStorage,
      }),
    );
  });

  it('startLogin stores the return path and redirects to the authorize url', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
    await startLogin('/age-review');
    expect(assign).toHaveBeenCalledWith('https://login.divine.video/api/oauth/authorize?x=1');
  });

  it('completeLogin exchanges the code and returns the stored return path', async () => {
    localStorage.setItem('divine-login:return-path', '/age-review');
    oauth.parseCallback.mockReturnValue({ code: 'abc' });
    oauth.exchangeCode.mockResolvedValue({ access_token: 't', bunker_url: 'bunker://x', token_type: 'Bearer', expires_in: 3600 });
    const result = await completeLogin('https://relay.admin.divine.video/auth/callback?code=abc');
    expect(oauth.exchangeCode).toHaveBeenCalledWith('abc');
    expect(result).toEqual({ returnPath: '/age-review' });
  });

  it('completeLogin defaults the return path to /reports', async () => {
    oauth.parseCallback.mockReturnValue({ code: 'abc' });
    oauth.exchangeCode.mockResolvedValue({ bunker_url: 'bunker://x', token_type: 'Bearer', expires_in: 3600 });
    const result = await completeLogin('https://relay.admin.divine.video/auth/callback?code=abc');
    expect(result).toEqual({ returnPath: '/reports' });
  });

  it('completeLogin throws on an OAuth error callback', async () => {
    oauth.parseCallback.mockReturnValue({ error: 'access_denied', description: 'user cancelled' });
    await expect(completeLogin('https://relay.admin.divine.video/auth/callback?error=access_denied'))
      .rejects.toThrow('user cancelled');
  });

  it('getSession delegates to getSessionWithRefresh', async () => {
    oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 't' });
    expect(await getSession()).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
  });

  it('logout delegates to the SDK', () => {
    logout();
    expect(oauth.logout).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/divineLogin.test.ts`
Expected: FAIL (`Cannot find module './divineLogin'`).

- [ ] **Step 4: Write the implementation**

Create `src/lib/divineLogin.ts`:

```ts
// ABOUTME: Thin wrapper over the @divinevideo/login SDK (OAuth2 + PKCE against
// login.divine.video). The SDK owns PKCE, token storage, refresh and signing;
// this module only configures the client and exposes the flow relay-admin uses.
import { createDivineClient, type StoredCredentials } from '@divinevideo/login';

export const DIVINE_LOGIN_SERVER_URL =
  import.meta.env.VITE_DIVINE_LOGIN_URL || 'https://login.divine.video';
export const DIVINE_LOGIN_CLIENT_ID = 'divine-relay-admin';

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
  await getClient().oauth.exchangeCode(parsed.code); // verifier is pulled from SDK storage
  const returnPath = localStorage.getItem(RETURN_PATH_KEY) || '/reports';
  localStorage.removeItem(RETURN_PATH_KEY);
  return { returnPath };
}

/** Current session with automatic refresh (SDK-managed). Null when signed out. */
export function getSession(): Promise<StoredCredentials | null> {
  return getClient().oauth.getSessionWithRefresh();
}

/** Clear all session data (SDK-managed). */
export function logout(): void {
  getClient().oauth.logout();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/divineLogin.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

```bash
git add package.json package-lock.json src/lib/divineLogin.ts src/lib/divineLogin.test.ts
git commit -m "feat(auth): add @divinevideo/login SDK wrapper and drop dupe auth files (#178)"
```

---

### Task 2: NostrSigner adapter (`DivineRpcSigner`)

**Files:**
- Create: `src/lib/divineSigner.ts`
- Test: `src/lib/divineSigner.test.ts`

**Interfaces:**
- Consumes: `DIVINE_LOGIN_SERVER_URL` from Task 1; `DivineRpc` from `@divinevideo/login`.
- Produces: `class DivineRpcSigner implements NostrSigner`, constructed as `new DivineRpcSigner(getAccessToken: () => string | undefined, serverUrl?: string, timeoutMs?: number)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/divineSigner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcInstance = {
  getPublicKey: vi.fn(),
  signEvent: vi.fn(),
  nip04Encrypt: vi.fn(),
  nip04Decrypt: vi.fn(),
  nip44Encrypt: vi.fn(),
  nip44Decrypt: vi.fn(),
};
const DivineRpc = vi.fn(() => rpcInstance);
vi.mock('@divinevideo/login', () => ({ DivineRpc }));

import { DivineRpcSigner } from './divineSigner';

const PUBKEY = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  rpcInstance.getPublicKey.mockResolvedValue(PUBKEY);
  rpcInstance.signEvent.mockImplementation(async (e) => ({ ...e, id: 'id', sig: 'sig' }));
});

describe('DivineRpcSigner', () => {
  it('builds the RPC with the current access token and /api/nostr endpoint', async () => {
    const signer = new DivineRpcSigner(() => 'tok', 'https://login.test');
    await signer.getPublicKey();
    expect(DivineRpc).toHaveBeenCalledWith(
      expect.objectContaining({ nostrApi: 'https://login.test/api/nostr', accessToken: 'tok' }),
    );
  });

  it('caches the public key after the first resolve', async () => {
    const signer = new DivineRpcSigner(() => 'tok');
    await signer.getPublicKey();
    await signer.getPublicKey();
    expect(rpcInstance.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it('throws when there is no access token', async () => {
    const signer = new DivineRpcSigner(() => undefined);
    await expect(signer.getPublicKey()).rejects.toThrow(/no access token/);
  });

  it('signEvent stamps the pubkey and returns the signed event', async () => {
    const signer = new DivineRpcSigner(() => 'tok');
    const signed = await signer.signEvent({ kind: 1, content: 'hi', tags: [], created_at: 5 });
    expect(rpcInstance.signEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 1, content: 'hi', pubkey: PUBKEY }),
    );
    expect(signed).toMatchObject({ id: 'id', sig: 'sig', pubkey: PUBKEY });
  });

  it('delegates nip44 encrypt/decrypt to the RPC', async () => {
    rpcInstance.nip44Encrypt.mockResolvedValue('ct');
    const signer = new DivineRpcSigner(() => 'tok');
    expect(await signer.nip44.encrypt('peer', 'pt')).toBe('ct');
    expect(rpcInstance.nip44Encrypt).toHaveBeenCalledWith('peer', 'pt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/divineSigner.test.ts`
Expected: FAIL (`Cannot find module './divineSigner'`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/divineSigner.ts`:

```ts
// ABOUTME: Thin NostrSigner adapter over the @divinevideo/login DivineRpc REST
// signer, so a divine-login session plugs into @nostrify's signer abstraction.
// TODO(#178): replace with @divinevideo/divine-signer when it is published --
// that package will be the maintained nostrify adapter. This is the only
// divine-login glue we own; keep it thin and lean on the SDK for session/refresh.
import { DivineRpc, type UnsignedEvent } from '@divinevideo/login';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { DIVINE_LOGIN_SERVER_URL } from './divineLogin';

export class DivineRpcSigner implements NostrSigner {
  private cachedPubkey: string | null = null;

  constructor(
    private readonly getAccessToken: () => string | undefined,
    private readonly serverUrl: string = DIVINE_LOGIN_SERVER_URL,
    private readonly timeoutMs = 10_000,
  ) {}

  private readonly fetchWithTimeout: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  private rpc(): DivineRpc {
    const token = this.getAccessToken();
    if (!token) throw new Error('divine-login: no access token');
    return new DivineRpc({
      nostrApi: `${this.serverUrl}/api/nostr`,
      accessToken: token,
      fetch: this.fetchWithTimeout,
    });
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const pubkey = await this.rpc().getPublicKey();
    this.cachedPubkey = pubkey;
    return pubkey;
  }

  async signEvent(event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();
    const unsigned: UnsignedEvent = { ...event, pubkey };
    const signed = await this.rpc().signEvent(unsigned);
    return signed as NostrEvent;
  }

  async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    return {};
  }

  readonly nip04 = {
    encrypt: (pubkey: string, plaintext: string) => this.rpc().nip04Encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.rpc().nip04Decrypt(pubkey, ciphertext),
  };

  readonly nip44 = {
    encrypt: (pubkey: string, plaintext: string) => this.rpc().nip44Encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.rpc().nip44Decrypt(pubkey, ciphertext),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/divineSigner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

```bash
git add src/lib/divineSigner.ts src/lib/divineSigner.test.ts
git commit -m "feat(auth): add DivineRpcSigner nostrify adapter over the login RPC (#178)"
```

---

### Task 3: Session context + `useDivineSession`

**Files:**
- Create: `src/contexts/DivineSessionContext.tsx` (context + provider + hook)
- Test: `src/hooks/useDivineSession.test.tsx`

**Interfaces:**
- Consumes: `getSession`, `logout`, `startLogin` from Task 1.
- Produces:
  - `DivineSessionProvider` (React component)
  - `useDivineSession(): { credentials: StoredCredentials | null; isResolving: boolean; startLogin: (returnPath?: string) => Promise<void>; logout: () => void; refresh: () => Promise<void> }`
  - Default context value = signed-out (`credentials: null`, `isResolving: false`, no-op actions) so components render logged-out without a provider (test ergonomics).

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useDivineSession.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const getSession = vi.fn();
const logout = vi.fn();
const startLogin = vi.fn();
vi.mock('@/lib/divineLogin', () => ({ getSession, logout, startLogin }));

import { DivineSessionProvider, useDivineSession } from '@/contexts/DivineSessionContext';

function Probe() {
  const { credentials, isResolving, logout } = useDivineSession();
  return (
    <div>
      <span data-testid="state">{isResolving ? 'resolving' : credentials ? credentials.accessToken : 'none'}</span>
      <button onClick={logout}>logout</button>
    </div>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('useDivineSession', () => {
  it('resolves the session on mount', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    render(<DivineSessionProvider><Probe /></DivineSessionProvider>);
    expect(screen.getByTestId('state')).toHaveTextContent('resolving');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('tok'));
  });

  it('logout clears credentials and calls the SDK', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    render(<DivineSessionProvider><Probe /></DivineSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('tok'));
    fireEvent.click(screen.getByText('logout'));
    expect(logout).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('none'));
  });

  it('defaults to signed-out with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useDivineSession.test.tsx`
Expected: FAIL (`Cannot find module '@/contexts/DivineSessionContext'`).

- [ ] **Step 3: Write the implementation**

Create `src/contexts/DivineSessionContext.tsx`:

```tsx
// ABOUTME: Single source of truth for the divine-login session. The SDK owns
// storage/refresh; this context holds the resolved credentials for the app.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import { getSession, logout as sdkLogout, startLogin as sdkStartLogin } from '@/lib/divineLogin';

export interface DivineSessionValue {
  credentials: StoredCredentials | null;
  isResolving: boolean;
  startLogin: (returnPath?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const defaultValue: DivineSessionValue = {
  credentials: null,
  isResolving: false,
  startLogin: sdkStartLogin,
  logout: () => {},
  refresh: async () => {},
};

const DivineSessionContext = createContext<DivineSessionValue>(defaultValue);

export function DivineSessionProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<StoredCredentials | null>(null);
  const [isResolving, setIsResolving] = useState(true);

  const refresh = useCallback(async () => {
    const creds = await getSession();
    setCredentials(creds);
    setIsResolving(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const creds = await getSession();
      if (!cancelled) {
        setCredentials(creds);
        setIsResolving(false);
      }
    })();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const logout = useCallback(() => {
    sdkLogout();
    setCredentials(null);
  }, []);

  return (
    <DivineSessionContext.Provider
      value={{ credentials, isResolving, startLogin: sdkStartLogin, logout, refresh }}
    >
      {children}
    </DivineSessionContext.Provider>
  );
}

export function useDivineSession(): DivineSessionValue {
  return useContext(DivineSessionContext);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useDivineSession.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

```bash
git add src/contexts/DivineSessionContext.tsx src/hooks/useDivineSession.test.tsx
git commit -m "feat(auth): add DivineSession context as the single session source (#178)"
```

---

### Task 4: Rewire `useCurrentUser` to the divine-login session

**Files:**
- Modify: `src/hooks/useCurrentUser.ts` (full rewrite)
- Modify: `src/test/TestApp.tsx` (wrap children in `DivineSessionProvider`)
- Test: `src/hooks/useCurrentUser.test.tsx`

**Interfaces:**
- Consumes: `useDivineSession` (Task 3), `DivineRpcSigner` (Task 2), `useAuthor`.
- Produces: `useCurrentUser(): { user: { pubkey: string; signer: NostrSigner } | undefined; users: Array<{ pubkey: string; signer: NostrSigner }>; [authorFields] }`. Return shape preserves `user`, `users`, and the spread `...author.data` that existing consumers rely on.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useCurrentUser.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const useDivineSession = vi.fn();
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession }));
vi.mock('@/contexts/DivineSessionContext', () => ({ useDivineSession }));

const getPublicKey = vi.fn();
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey, signEvent: vi.fn() })),
}));

vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: { metadata: { name: 'Mod' } } }) }));

import { useCurrentUser } from './useCurrentUser';

const PUBKEY = 'b'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  getPublicKey.mockResolvedValue(PUBKEY);
});

describe('useCurrentUser', () => {
  it('returns undefined user with no session', () => {
    useDivineSession.mockReturnValue({ credentials: null });
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toBeUndefined();
  });

  it('resolves the moderator pubkey from the session token', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.user?.pubkey).toBe(PUBKEY));
    expect(result.current.metadata).toEqual({ name: 'Mod' });
  });

  it('yields no user when getPublicKey returns a non-canonical pubkey', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    getPublicKey.mockResolvedValue('NOT-HEX');
    const { result } = renderHook(() => useCurrentUser());
    // give the effect a tick; user must stay undefined
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.user).toBeUndefined();
  });

  it('yields no user when getPublicKey rejects', async () => {
    useDivineSession.mockReturnValue({ credentials: { accessToken: 'tok', bunkerUrl: 'bunker://x' } });
    getPublicKey.mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useCurrentUser());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.user).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useCurrentUser.test.tsx`
Expected: FAIL (assertions fail against the old nostrify-login implementation).

- [ ] **Step 3: Write the implementation**

Replace `src/hooks/useCurrentUser.ts` entirely with:

```ts
// ABOUTME: Current moderator identity, sourced from the divine-login session.
// Builds a DivineRpcSigner from the session token and resolves the pubkey via
// the login RPC. CF Access is the access gate; this is attribution only.
import { useEffect, useMemo, useState } from 'react';
import type { NostrSigner } from '@nostrify/nostrify';

import { useDivineSession } from './useDivineSession';
import { DivineRpcSigner } from '@/lib/divineSigner';
import { useAuthor } from './useAuthor.ts';

const HEX_64 = /^[0-9a-f]{64}$/;

export interface CurrentUser {
  pubkey: string;
  signer: NostrSigner;
}

export function useCurrentUser() {
  const { credentials } = useDivineSession();
  const accessToken = credentials?.accessToken;

  // A new signer per token is correct: token rotation on refresh resets the
  // pubkey cache. Refreshes are infrequent (near expiry) so the re-resolve cost
  // is negligible.
  const signer = useMemo(
    () => (accessToken ? new DivineRpcSigner(() => accessToken) : null),
    [accessToken],
  );

  const [pubkey, setPubkey] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setPubkey(undefined);
      return;
    }
    signer
      .getPublicKey()
      // Keep the prior pubkey on a re-resolve (token refresh) to avoid flapping
      // logged-in -> out -> in. The worker rejects non-canonical pubkeys, so we
      // only accept lowercase 64-hex.
      .then((pk) => { if (!cancelled) setPubkey((prev) => (HEX_64.test(pk) ? pk : prev)); })
      .catch(() => { /* attribution degrades to null; never block on identity */ });
    return () => { cancelled = true; };
  }, [signer]);

  const user = useMemo<CurrentUser | undefined>(
    () => (signer && pubkey ? { pubkey, signer } : undefined),
    [signer, pubkey],
  );

  const users = useMemo(() => (user ? [user] : []), [user]);

  const author = useAuthor(user?.pubkey);

  return {
    user,
    users,
    ...author.data,
  };
}
```

- [ ] **Step 4: Wrap TestApp in the session provider**

Modify `src/test/TestApp.tsx`: import `DivineSessionProvider` and wrap it just inside `NostrProvider` (so `useCurrentUser` -> `useDivineSession` has a provider and `useAuthor` still has Nostr):

```tsx
import { DivineSessionProvider } from '@/contexts/DivineSessionContext';
// ...
// inside the provider tree, replace:
//   <NostrProvider>{children}</NostrProvider>
// with:
//   <NostrProvider><DivineSessionProvider>{children}</DivineSessionProvider></NostrProvider>
```

(Read the file first; place `<DivineSessionProvider>` as the direct wrapper of `{children}` inside `<NostrProvider>`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useCurrentUser.test.tsx`
Expected: PASS (4 tests).

Then run the full suite to confirm no regressions from the return-shape change:
Run: `npx vitest run`
Expected: all pass (baseline 290 + new).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean. (If a consumer used a removed `NUser` field like `.method`, fix by reading `user.pubkey`/`user.signer`; report any such site.)

```bash
git add src/hooks/useCurrentUser.ts src/hooks/useCurrentUser.test.tsx src/test/TestApp.tsx
git commit -m "feat(auth): source useCurrentUser from the divine-login session (#178)"
```

---

### Task 5: `/auth/callback` page + route

**Files:**
- Create: `src/pages/AuthCallback.tsx`
- Modify: `src/AppRouter.tsx` (add route)
- Test: `src/pages/AuthCallback.test.tsx`

**Interfaces:**
- Consumes: `completeLogin` (Task 1), `useDivineSession().refresh` (Task 3).
- Produces: default-exported `AuthCallback` component; route `/auth/callback`.

- [ ] **Step 1: Write the failing test**

Create `src/pages/AuthCallback.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const completeLogin = vi.fn();
vi.mock('@/lib/divineLogin', () => ({ completeLogin }));

const refresh = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession: () => ({ refresh }) }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import AuthCallback from './AuthCallback';

beforeEach(() => vi.clearAllMocks());

describe('AuthCallback', () => {
  it('completes login and navigates to the return path', async () => {
    completeLogin.mockResolvedValue({ returnPath: '/age-review' });
    render(<AuthCallback />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/age-review', { replace: true }));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an error and does not navigate on failure', async () => {
    completeLogin.mockRejectedValue(new Error('user cancelled'));
    render(<AuthCallback />);
    await waitFor(() => expect(screen.getByText(/user cancelled/i)).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/AuthCallback.test.tsx`
Expected: FAIL (`Cannot find module './AuthCallback'`).

- [ ] **Step 3: Write the implementation**

Create `src/pages/AuthCallback.tsx`:

```tsx
// ABOUTME: OAuth callback landing. Exchanges the code via the SDK, refreshes the
// session, and returns the moderator to where they started signing in.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { completeLogin } from '@/lib/divineLogin';
import { useDivineSession } from '@/hooks/useDivineSession';

export default function AuthCallback() {
  const navigate = useNavigate();
  const { refresh } = useDivineSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { returnPath } = await completeLogin(window.location.href);
        await refresh();
        if (!cancelled) navigate(returnPath, { replace: true });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Sign-in failed');
      }
    })();
    return () => { cancelled = true; };
  }, [navigate, refresh]);

  return (
    <div className="flex h-screen items-center justify-center">
      {error ? (
        <div className="max-w-md text-center space-y-3">
          <p className="text-destructive font-medium">Sign-in failed</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <a href="/reports" className="text-sm text-primary hover:underline">Return to the tool</a>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Signing you in...</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

Modify `src/AppRouter.tsx`: import the page and add the route above the catch-all `*`:

```tsx
import AuthCallback from "./pages/AuthCallback";
// ...
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/pages/AuthCallback.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

```bash
git add src/pages/AuthCallback.tsx src/AppRouter.tsx src/pages/AuthCallback.test.tsx
git commit -m "feat(auth): add /auth/callback route to complete divine-login (#178)"
```

---

### Task 6: Sign-in button + provider wiring in the shell

**Files:**
- Create: `src/components/auth/DivineLoginButton.tsx`
- Modify: `src/App.tsx` (mount `DivineSessionProvider`)
- Modify: `src/components/RelayManager.tsx` (render `<DivineLoginButton />` in the header)
- Test: `src/components/auth/DivineLoginButton.test.tsx`

**Interfaces:**
- Consumes: `useCurrentUser` (Task 4), `useDivineSession` (Task 3).
- Produces: named export `DivineLoginButton`.

- [ ] **Step 1: Write the failing test**

Create `src/components/auth/DivineLoginButton.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const useCurrentUser = vi.fn();
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser }));

const startLogin = vi.fn();
const logout = vi.fn();
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({ startLogin, logout, isResolving: false }),
}));

import { DivineLoginButton } from './DivineLoginButton';

const PUBKEY = 'c'.repeat(64);

beforeEach(() => vi.clearAllMocks());

describe('DivineLoginButton', () => {
  it('shows a sign-in button when signed out and starts login with the current path', () => {
    useCurrentUser.mockReturnValue({ user: undefined });
    render(<DivineLoginButton />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(startLogin).toHaveBeenCalled();
  });

  it('shows the signed-in moderator and a sign-out control', () => {
    useCurrentUser.mockReturnValue({ user: { pubkey: PUBKEY }, metadata: { name: 'Mod Squad' } });
    render(<DivineLoginButton />);
    expect(screen.getByText('Mod Squad')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/auth/DivineLoginButton.test.tsx`
Expected: FAIL (`Cannot find module './DivineLoginButton'`).

- [ ] **Step 3: Write the implementation**

Create `src/components/auth/DivineLoginButton.tsx`:

```tsx
// ABOUTME: Sign-in surface for the shell header. Signed out -> "Sign in";
// signed in -> the moderator's name/pubkey + "Sign out". Attribution only;
// CF Access remains the access gate.
import { LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';

function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
}

export function DivineLoginButton() {
  const { user, metadata } = useCurrentUser() as { user?: { pubkey: string }; metadata?: { name?: string } };
  const { startLogin, logout, isResolving } = useDivineSession();

  if (isResolving) {
    return <div className="h-9 w-24 animate-pulse rounded-md bg-muted" aria-hidden />;
  }

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium max-w-[12rem] truncate" title={user.pubkey}>
          {metadata?.name || shortPubkey(user.pubkey)}
        </span>
        <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
          <LogOut className="h-4 w-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      onClick={() => startLogin(`${window.location.pathname}${window.location.search}`)}
    >
      <LogIn className="h-4 w-4 mr-2" />
      Sign in
    </Button>
  );
}
```

- [ ] **Step 4: Mount the provider in `App.tsx`**

Modify `src/App.tsx`: import `DivineSessionProvider` and wrap `AppRouter` (inside `NostrProvider`, so `useAuthor` inside `useCurrentUser` still has Nostr):

```tsx
import { DivineSessionProvider } from '@/contexts/DivineSessionContext';
// ...
          <NostrProvider>
            <DivineSessionProvider>
              <TooltipProvider>
                <Toaster />
                <Sonner />
                <Suspense>
                  <AppRouter />
                </Suspense>
              </TooltipProvider>
            </DivineSessionProvider>
          </NostrProvider>
```

- [ ] **Step 5: Render the button in the header**

Modify `src/components/RelayManager.tsx`: import the button and place it in the header's right-side cluster next to `EnvironmentSelector`:

```tsx
import { DivineLoginButton } from "@/components/auth/DivineLoginButton";
// ...
            <div className="flex items-center gap-3">
              <DivineLoginButton />
              <EnvironmentSelector />
            </div>
```

(Replace the bare `<EnvironmentSelector />` at the end of the header row with the wrapped cluster above.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/components/auth/DivineLoginButton.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Full gate and commit**

Run: `npm run test`
Expected: tsc clean, eslint clean, all vitest pass, vite build succeeds.

```bash
git add src/components/auth/DivineLoginButton.tsx src/components/auth/DivineLoginButton.test.tsx src/App.tsx src/components/RelayManager.tsx
git commit -m "feat(auth): mount divine-login sign-in in the shell header (#178)"
```

---

### Task 7: End-to-end acceptance verification + PR draft

**Files:** none (verification + docs). Produces screenshots under `docs/screenshots/` and a drafted PR body (held for Matt's go).

**Interfaces:** Consumes the whole feature.

- [ ] **Step 1: Bring up the local stack**

Run: `./scripts/dev-local.sh` (Worker on 8787, Caddy 8788, Vite 5173). Select "Local" in the environment selector.

- [ ] **Step 2: Drive the real path with Playwright, from a fresh profile**

- Load `https://localhost:5173`, confirm the header shows "Sign in".
- Click "Sign in" -> redirected to `login.divine.video` (or the configured `VITE_DIVINE_LOGIN_URL`). Note: this needs a reachable login server; if local login is unavailable, run this leg against staging (see Step 4).
- After auth, confirm redirect to `/auth/callback` then back to the return path, and the header now shows the moderator name/pubkey.
- Go to Age Review, open a case, click "Restrict Account".
- Verify the PATCH payload carries `moderator_pubkey` = the signed-in pubkey (network tab), and the case row persists it.

- [ ] **Step 3: Capture screenshots**

Save signed-out header, signed-in header, and the age-review action to `docs/screenshots/` for the PR (UI-change guardrail).

- [ ] **Step 4: Verify against staging (login-server reachability)**

Because phase 1 depends on `login.divine.video` accepting the unregistered `divine-relay-admin` client_id, run the sign-in leg against staging (`VITE_DIVINE_LOGIN_URL` default). Confirm the authorize + token + `/api/nostr` getPublicKey round-trips succeed and the returned pubkey is canonical 64-hex. If the login server rejects the unregistered client, STOP and flag the client-registration dependency to Matt (external, Daniel).

- [ ] **Step 5: Draft the PR (do NOT open until Matt says go)**

Draft the PR body per the repo guardrails (summary, motivation, linked issue #178, manual validation plan, screenshots, "no worker change" note). Open as **draft, no reviewers**, only after Matt's explicit go.

---

## Self-Review

**Spec coverage:**
- Login surface (spec "Components" DivineLoginButton) -> Task 6. ✓
- SDK-direct dependency + config -> Task 1. ✓
- Thin NostrSigner adapter with TODO(#178) -> Task 2. ✓
- Session single-source + refresh via SDK -> Task 3. ✓
- useCurrentUser yields pubkey, canonical-hex guard, degrade-on-error -> Task 4. ✓
- /auth/callback route + page, error state -> Task 5. ✓
- Dupe file deletion -> Task 1. ✓
- Acceptance (fresh-profile real path) + screenshots + staging login-server check -> Task 7. ✓
- Admin gate: none (CF Access) -> reflected by absence; no task adds a gate. ✓
- Out of scope (worker verify, NIP-98, dormant retire) -> no tasks. ✓

**Placeholder scan:** No TBD/TODO except the intentional `TODO(#178)` code marker (a real, required marker). Every code step shows complete code. ✓

**Type consistency:**
- `startLogin`/`completeLogin`/`getSession`/`logout` signatures identical across Tasks 1, 3, 5. ✓
- `DivineRpcSigner(getAccessToken, serverUrl?, timeoutMs?)` used consistently in Tasks 2 and 4. ✓
- `useDivineSession()` value shape `{credentials, isResolving, startLogin, logout, refresh}` consistent across Tasks 3, 4, 5, 6. ✓
- `useCurrentUser()` return `{user, users, ...author.data}` with `user.{pubkey,signer}` matches consumers (UserManagement, AgeReviewDetail, useNostrPublish, useUploadFile). ✓
- `StoredCredentials.accessToken` (SDK type) used as the token source consistently. ✓

## Risks flagged for the executor

- **Login-server reachability (Task 7 Step 4):** the only real external unknown. If `login.divine.video` rejects the unregistered `divine-relay-admin` client_id, phase 1 is blocked on keycast client registration (Daniel). Verify early.
- **CF Access callback interplay:** the `/auth/callback` redirect must pass CF Access (moderator already holds a CF Access cookie). Verify on staging, not just local.
- **`useCurrentUser` return-shape change:** run the FULL suite after Task 4; report any consumer that used an `NUser`-only field.
