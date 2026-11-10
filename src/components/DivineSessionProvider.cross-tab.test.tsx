// Two tabs of the app in one jsdom: each tab is its own module instance of the
// provider and the real login wrapper (lib/divineLogin), and they share only
// what real tabs share: localStorage, the session Web Lock and the
// BroadcastChannel. The SDK is faked over that shared storage, as the real one
// works: a refresh saves before it resolves, logout removes the session.
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = 'divine_session';
const REVISION = 'divine-login:session-revision';

const { sdk, store, getPublicKey } = vi.hoisted(() => {
  // Storage with injectable failures, keyed 'get:<key>', 'set:<key>' or
  // 'remove:<key>'.
  const data = new Map<string, string>();
  const failing = new Set<string>();
  const fail = (op: string, key: string) => {
    if (failing.has(`${op}:${key}`)) throw new DOMException('denied', 'SecurityError');
  };
  const store = {
    data,
    failing,
    api: {
      getItem: (k: string) => { fail('get', k); return data.get(k) ?? null; },
      setItem: (k: string, v: string) => { fail('set', k); data.set(k, v); },
      removeItem: (k: string) => { fail('remove', k); data.delete(k); },
      clear: () => data.clear(),
    },
  };
  // Through the storage API, so an injected read failure reaches the SDK too.
  const read = () => {
    const raw = store.api.getItem('divine_session');
    return raw ? JSON.parse(raw) : null;
  };
  const sdk = {
    holdNextRefresh: false,
    refreshCalls: 0,
    releaseRefresh: (_token: string) => {},
    oauth: () => ({
      getSession: read,
      getSessionWithRefresh: () => {
        sdk.refreshCalls += 1;
        const current = read();
        if (!current) return Promise.resolve(null);
        if (!sdk.holdNextRefresh) return Promise.resolve(current);
        sdk.holdNextRefresh = false;
        return new Promise((resolve) => {
          sdk.releaseRefresh = (token: string) => {
            const next = { ...current, accessToken: token };
            store.api.setItem('divine_session', JSON.stringify(next));
            resolve(next);
          };
        });
      },
      logout: () => {
        store.api.removeItem('divine_session');
        store.api.removeItem('divine_auth_handle');
        store.api.removeItem('divine_pkce');
      },
    }),
  };
  return { sdk, store, getPublicKey: vi.fn() };
});
vi.mock('@divinevideo/login', () => ({ createDivineClient: () => ({ oauth: sdk.oauth() }) }));
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey })),
}));

// A message reaches every other open channel of the same name, never the
// sender, asynchronously. With `hold`, messages wait for deliverHeld().
class FakeChannel {
  static open: FakeChannel[] = [];
  static hold = false;
  static held: (() => void)[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open) {
      if (other === this || other.name !== this.name) continue;
      const deliver = () => other.onmessage?.(new MessageEvent('message', { data }));
      if (FakeChannel.hold) FakeChannel.held.push(deliver);
      else queueMicrotask(deliver);
    }
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

// One lock shared by every tab, granted in request order.
function fifoLock() {
  let tail: Promise<unknown> = Promise.resolve();
  const request = (_name: string, _opts: LockOptions, cb: () => Promise<unknown>) => {
    const run = tail.then(() => cb());
    tail = run.catch(() => {});
    return run;
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

type Session = { isSignedIn: boolean; credentials: { accessToken?: string } | null; logout: () => void; refresh: () => Promise<void> };

async function openTab() {
  vi.resetModules();
  const { DivineSessionProvider } = await import('./DivineSessionProvider');
  const { useDivineSession } = await import('@/hooks/useDivineSession');
  const tab = { session: null as Session | null };
  function Probe() {
    tab.session = useDivineSession() as unknown as Session;
    return null;
  }
  render(<DivineSessionProvider><Probe /></DivineSessionProvider>);
  const s = () => tab.session!;
  await waitFor(() => expect(s().credentials !== undefined).toBe(true));
  await act(async () => { await flush(); });
  return {
    signedIn: () => s().isSignedIn,
    token: () => s().credentials?.accessToken,
    logout: () => s().logout(),
    refresh: () => s().refresh(),
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function seed(token: string) {
  store.data.set(SESSION, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: token }));
}
// A session with no access token: the provider still counts it as signed in.
const BUNKER_SECRET = 'bunker-secret-value';
function seedBunkerOnly() {
  store.data.set(SESSION, JSON.stringify({ bunkerUrl: `bunker://${'b'.repeat(64)}?secret=${BUNKER_SECRET}` }));
}
const storedToken = () => {
  const raw = store.data.get(SESSION);
  return raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : null;
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  store.data.clear();
  store.failing.clear();
  FakeChannel.open = [];
  FakeChannel.hold = false;
  FakeChannel.held = [];
  sdk.holdNextRefresh = false;
  sdk.refreshCalls = 0;
  Object.defineProperty(window, 'localStorage', { value: store.api, writable: true, configurable: true });
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  fifoLock();
  getPublicKey.mockResolvedValue('a'.repeat(64));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
  delete (navigator as { locks?: unknown }).locks;
});

describe('a sign-out whose session removal fails', () => {
  it('stays signed out on later reads, and cleanup is retried', async () => {
    seed('tok-a');
    const a = await openTab();
    expect(a.signedIn()).toBe(true);

    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      try { a.logout(); } catch { /* the sign-out goes ahead either way */ }
    });
    expect(a.signedIn()).toBe(false);
    expect(storedToken()).toBe('tok-a'); // the removal failed

    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);

    store.failing.clear();
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);
    expect(storedToken()).toBeNull(); // the retry removed it
  });

  it('a reloaded tab refuses the session the sign-out could not remove', async () => {
    seed('tok-a');
    const a = await openTab();
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      try { a.logout(); } catch { /* as above */ }
    });
    const reloaded = await openTab();
    expect(reloaded.signedIn()).toBe(false);
  });

  it('with storage writes failing too, the same tab still refuses it', async () => {
    seed('tok-a');
    const a = await openTab();
    store.failing.add(`remove:${SESSION}`);
    store.failing.add(`set:${REVISION}`);
    await act(async () => {
      try { a.logout(); } catch { /* as above */ }
    });
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);
  });

  it('accepts a new sign-in afterwards', async () => {
    seed('tok-a');
    const a = await openTab();
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      try { a.logout(); } catch { /* as above */ }
    });
    store.failing.clear();
    seed('tok-new'); // what the callback page's sign-in saves
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(true);
    expect(a.token()).toBe('tok-new');
  });
});

describe('another tab signs out', () => {
  // The sender's revision write fails, so this tab's refresh in flight passes
  // both revision checks. The broadcast has to stop it.
  it('with its revision write failing, a refresh in flight here cannot save the session back', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    expect(b.signedIn()).toBe(true);

    sdk.holdNextRefresh = true;
    let pending!: Promise<void>;
    await act(async () => {
      pending = b.refresh();
      await flush();
    });
    store.failing.add(`set:${REVISION}`);
    await act(async () => {
      a.logout();
      await flush();
    });
    await act(async () => {
      sdk.releaseRefresh('tok-refreshed');
      await pending;
      await flush();
    });
    expect(storedToken()).toBeNull();
    expect(a.signedIn()).toBe(false);
    expect(b.signedIn()).toBe(false);
  });

  // Once the message ends this tab's read in flight, the next read must start
  // fresh rather than join it: joined, it would get the ended read's null and
  // miss a sign-in saved meanwhile.
  it('after the message, a new read does not join the ended one', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    sdk.holdNextRefresh = true;
    let first!: Promise<void>;
    await act(async () => {
      first = b.refresh();
      await flush();
    });
    store.failing.add(`set:${REVISION}`);
    await act(async () => {
      a.logout();
      await flush();
    });
    let second!: Promise<void>;
    await act(async () => {
      second = b.refresh();
      sdk.releaseRefresh('tok-refreshed');
      seed('tok-new'); // a sign-in saved before the ended read checks
      await first;
      await second;
      await flush();
    });
    expect(b.token()).toBe('tok-new');
    expect(storedToken()).toBe('tok-new');
  });

  // Storage reaches other tabs a moment late: this tab's refresh was accepted
  // before the sign-out's revision showed up here, and its save landed after
  // the sender's clear.
  it('a refresh this tab saved after the sender\'s clear is cleared', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    sdk.holdNextRefresh = true;
    let pending!: Promise<void>;
    await act(async () => {
      pending = b.refresh();
      await flush();
      sdk.releaseRefresh('tok-refreshed');
      await pending;
      await flush();
    });
    expect(b.token()).toBe('tok-refreshed');

    FakeChannel.hold = true;
    await act(async () => { a.logout(); });
    seed('tok-refreshed'); // the late save
    await act(async () => {
      FakeChannel.held.forEach((deliver) => deliver());
      await flush();
    });
    expect(b.signedIn()).toBe(false);
    expect(storedToken()).toBeNull();
  });

  it('a delayed message leaves alone a newer sign-in this tab already applied', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    FakeChannel.hold = true;
    await act(async () => { a.logout(); });
    seed('tok-new'); // a new sign-in, saved before the message lands here
    await act(async () => { await b.refresh(); });
    expect(b.token()).toBe('tok-new');

    await act(async () => {
      FakeChannel.held.forEach((deliver) => deliver());
      await flush();
    });
    expect(b.signedIn()).toBe(true);
    expect(b.token()).toBe('tok-new');
    expect(storedToken()).toBe('tok-new');
  });

  // The same delay, but this tab's read of the newer sign-in is still in
  // flight when the message lands: it began after the sign-out, so it is not
  // the ended session's to invalidate.
  it('a delayed message leaves alone a newer sign-in this tab is still reading', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    FakeChannel.hold = true;
    await act(async () => { a.logout(); });
    seed('tok-new');
    sdk.holdNextRefresh = true;
    let pending!: Promise<void>;
    await act(async () => {
      pending = b.refresh();
      await flush();
    });
    await act(async () => {
      FakeChannel.held.forEach((deliver) => deliver());
      await flush();
      sdk.releaseRefresh('tok-new-refreshed');
      await pending;
      await flush();
    });
    expect(b.token()).toBe('tok-new-refreshed');
    expect(storedToken()).toBe('tok-new-refreshed');
  });

  // The sender's library threw before it could name the session it ended.
  it('a message that cannot name the ended session ends the one this tab holds', async () => {
    seed('tok-a');
    const b = await openTab();
    const other = new FakeChannel('divine-login');
    await act(async () => {
      other.postMessage({ type: 'signed-out' });
      await flush();
    });
    expect(b.signedIn()).toBe(false);
    expect(storedToken()).toBeNull();
  });

  it('a message that is not a sign-out changes nothing', async () => {
    seed('tok-a');
    const b = await openTab();
    const other = new FakeChannel('divine-login');
    for (const data of ['signed-out', { type: 'other' }, null, 42]) {
      await act(async () => {
        other.postMessage(data);
        await flush();
      });
    }
    expect(b.signedIn()).toBe(true);
    expect(storedToken()).toBe('tok-a');
  });
});

describe('round 2', () => {
  // B's refresh lands after A's sign-out, and its own cleanup cannot remove
  // it. The cleanup's fence has to outlive this tab.
  it('a refreshed session the cleanup could not remove stays refused after a reload', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    sdk.holdNextRefresh = true;
    let pending!: Promise<void>;
    await act(async () => {
      pending = b.refresh();
      await flush();
    });
    await act(async () => {
      a.logout();
      await flush();
    });
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      sdk.releaseRefresh('tok-refreshed');
      await pending;
      await flush();
    });
    expect(storedToken()).toBe('tok-refreshed'); // the cleanup's removal failed
    const reloaded = await openTab();
    expect(reloaded.signedIn()).toBe(false);
  });

  // The sender cannot read the revision, so it cannot name the session it
  // ended. That must read as unknown (end whatever you hold), not as "no
  // revision yet", which a receiver in a real era would reject.
  it('an unreadable revision at sign-out still ends the other tabs\' session', async () => {
    store.data.set(REVISION, 'rev-1');
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    store.failing.add(`get:${REVISION}`);
    await act(async () => {
      a.logout();
      await flush();
    });
    store.failing.clear();
    expect(b.signedIn()).toBe(false);
    expect(storedToken()).toBeNull();
  });

  // The same from the receiving side: a tab that could not read the revision
  // when it read its session cannot tell its era, so a sign-out ends it.
  it('a session read with an unreadable revision is ended by any sign-out', async () => {
    store.data.set(REVISION, 'rev-1');
    seed('tok-a');
    const a = await openTab();
    store.failing.add(`get:${REVISION}`);
    const b = await openTab();
    store.failing.clear();
    expect(b.signedIn()).toBe(true);
    await act(async () => {
      a.logout();
      await flush();
    });
    expect(b.signedIn()).toBe(false);
  });

  // A fence list this tab cannot read is not overwritten: that would drop the
  // sessions other tabs fenced there.
  it('a fence list that cannot be read is left as it is', async () => {
    store.data.set('divine-login:ended-sessions', JSON.stringify(['fenced-by-another-tab']));
    seed('tok-a');
    const a = await openTab();
    store.failing.add('get:divine-login:ended-sessions');
    await act(async () => { a.logout(); });
    store.failing.clear();
    expect(JSON.parse(store.data.get('divine-login:ended-sessions')!)).toEqual(['fenced-by-another-tab']);
    expect(a.signedIn()).toBe(false);
  });

  it('a bunker-only session the sign-out could not remove stays refused, here and after a reload', async () => {
    seedBunkerOnly();
    const a = await openTab();
    expect(a.signedIn()).toBe(true);
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      try { a.logout(); } catch { /* the sign-out goes ahead either way */ }
    });
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);
    const reloaded = await openTab();
    expect(reloaded.signedIn()).toBe(false);
    // The fence names the bunker credentials without storing them.
    for (const [key, value] of store.data) {
      if (key !== SESSION) expect(value).not.toContain(BUNKER_SECRET);
    }
  });

  // B waits for the lock behind H's refresh. A signs out and broadcasts, and
  // another tab signs in before B gets the lock. B's read is stale, but the
  // new session is not the one it started with, so it must survive.
  it('a read queued behind the lock leaves alone a sign-in saved while it waited', async () => {
    seed('tok-a');
    const a = await openTab();
    const b = await openTab();
    const h = await openTab();
    sdk.holdNextRefresh = true;
    let holder!: Promise<void>;
    let queued!: Promise<void>;
    await act(async () => {
      holder = h.refresh();
      await flush();
      queued = b.refresh();
      await flush();
    });
    await act(async () => {
      a.logout();
      await flush();
    });
    await act(async () => {
      sdk.releaseRefresh('tok-h-refreshed');
      seed('tok-new'); // the new sign-in, saved before B gets the lock
      await holder;
      await queued;
      await flush();
    });
    expect(storedToken()).toBe('tok-new');
  });
});

describe('round 3', () => {
  // A storage hiccup during sign-out: the session can be neither read nor
  // removed. The tab still knows which session it held, and fences that.
  it('a sign-out during a storage failure that hides the session still holds once storage recovers', async () => {
    seed('tok-a');
    const a = await openTab();
    expect(a.signedIn()).toBe(true);
    store.failing.add(`get:${SESSION}`);
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      try { a.logout(); } catch { /* the sign-out goes ahead either way */ }
    });
    store.failing.clear();
    expect(storedToken()).toBe('tok-a');
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);
    expect(storedToken()).toBeNull(); // removed once storage recovered
  });

  // The fence cannot be read, so this read cannot tell whether the stored
  // session was ended. It refuses without refreshing, and without removing a
  // session that may be fine: the next read, once the fence is readable,
  // decides.
  it('an unreadable fence refuses the read without refreshing or removing', async () => {
    seed('tok-a');
    const a = await openTab();
    expect(a.signedIn()).toBe(true);
    store.failing.add('get:divine-login:ended-sessions');
    const before = sdk.refreshCalls;
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(false);
    expect(sdk.refreshCalls).toBe(before);
    expect(storedToken()).toBe('tok-a');

    store.failing.clear();
    await act(async () => { await a.refresh(); });
    expect(a.signedIn()).toBe(true);
    expect(a.token()).toBe('tok-a');
  });

  // A known logout outranks an unreadable fence. B is still mounting: its read
  // starts from S and waits for the lock, so it has no applied session for the
  // broadcast to fence. The fence then becomes unreadable and the removal
  // fails. When B gets the lock, it must still fence S, the session it
  // started from, or its next read accepts S once storage recovers.
  it('a read that learns of a logout fences its start session even when the fence is unreadable', async () => {
    seed('tok-s');
    const a = await openTab();
    let releaseLock!: () => void;
    void navigator.locks.request('divine-login:session', {}, () => new Promise<void>((resolve) => { releaseLock = resolve; }));
    const b = await openTab(); // its mount read is queued behind the lock
    expect(b.signedIn()).toBe(false);

    store.failing.add('get:divine-login:ended-sessions');
    store.failing.add(`remove:${SESSION}`);
    await act(async () => {
      a.logout();
      await flush();
    });
    await act(async () => {
      releaseLock();
      await flush();
    });
    expect(b.signedIn()).toBe(false);

    store.failing.clear();
    expect(storedToken()).toBe('tok-s');
    await act(async () => { await b.refresh(); });
    expect(b.signedIn()).toBe(false);
    expect(storedToken()).toBeNull();
  });
});
