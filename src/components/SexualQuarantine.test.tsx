import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SexualCase } from '../../shared/sexual-quarantine';
import { SexualQuarantine } from './SexualQuarantine';

const context = vi.hoisted(() => ({ apiUrl: 'https://api.example.test', relayUrl: 'wss://relay.example.test', token: undefined as string | undefined, pubkey: undefined as string | undefined, identityUnavailable: false }));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: context }) }));
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession: () => ({
  getModeratorToken: () => context.token, identityUnavailable: context.identityUnavailable, isSignedIn: context.token !== undefined, pubkey: context.pubkey,
}) }));
const MOD_TOKEN = 'moderator-login-token';

const EVENT = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const makeCase = (changes: Partial<SexualCase> = {}): SexualCase => ({
  eventId: EVENT, revision: 3, goal: 'hide', state: 'pending', reporters: 2, threshold: 2,
  firstReport: { id: 'c'.repeat(64), pubkey: 'e'.repeat(64), reason: 'sexual-content' },
  createdAt: Date.now() - 1_000_000, updatedAt: Date.now(), deadlineAt: Date.now() - 1,
  attempts: 2, retryAt: Date.now() + 60_000, snapshot: { event: {}, assets: [HASH] },
  lastError: 'Quarantine processing incomplete; retry scheduled', ...changes,
});
let current: SexualCase;
let postStatus: number;
let lastDecision: unknown;
let lastDecisionHeaders: Record<string, string> | undefined;

function renderQueue(path = `/sexual-quarantine/${EVENT}`, after?: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/sexual-quarantine" element={<SexualQuarantine />} />
      <Route path="/sexual-quarantine/:eventId" element={<SexualQuarantine />} /></Routes>
    {after?.()}
  </MemoryRouter></QueryClientProvider>;
  return { ...render(view()), view };
}

beforeEach(() => {
  context.apiUrl = 'https://api.example.test';
  context.token = MOD_TOKEN;
  context.pubkey = 'c'.repeat(64);
  context.identityUnavailable = false;
  current = makeCase(); postStatus = 202; lastDecision = undefined; lastDecisionHeaders = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      lastDecision = JSON.parse(init.body as string);
      lastDecisionHeaders = init.headers as Record<string, string>;
      if (postStatus === 409) {
        current = makeCase({ revision: 9, state: 'hidden' });
        return Response.json({ error: 'Case revision conflict' }, { status: 409 });
      }
      current = makeCase({ revision: 4, goal: 'restore', state: 'pending' });
      return Response.json(current, { status: postStatus });
    }
    if (url.endsWith('/history')) return Response.json([{ at: 1000, action: 'report', reason: 'sexual-content', token: 'never-render-this' }]);
    return Response.json(url.endsWith('/sexual-quarantine') ? { cases: [current] } : current);
  }));
});

describe('Sexual quarantine review', () => {
  it('lets moderators reach later queue pages and return to the first page', async () => {
    const second = 'f'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('cursor=')
      ? { cases: [makeCase({ eventId: second })] }
      : { cases: [current], nextCursor: 'sexual-review-v3:0:0000000000001000:' + EVENT })));
    renderQueue('/sexual-quarantine');
    expect(await screen.findByRole('link', { name: EVENT })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next cases' }));
    expect(await screen.findByRole('link', { name: second })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous cases' }));
    expect(await screen.findByRole('link', { name: EVENT })).toBeInTheDocument();
  });
  it('lists overdue cases with navigable full event IDs and actual pending state', async () => {
    renderQueue('/sexual-quarantine');
    expect(await screen.findByRole('link', { name: EVENT })).toHaveAttribute('href', `/sexual-quarantine/${EVENT}`);
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
  });

  it('blocks case reads and decisions when the review link belongs to another relay', async () => {
    renderQueue(`/sexual-quarantine/${EVENT}?sourceRelay=${encodeURIComponent('wss://staging.example.test')}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('different environment');
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not offer video decisions for a non-video target', async () => {
    current = makeCase({ goal: 'review', state: 'out_of_scope', snapshot: undefined });
    renderQueue();
    expect(await screen.findByText('Outside video scope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('keeps requested hide separate from confirmed state and provides authorized media and safe history', async () => {
    renderQueue();
    expect(await screen.findByText('Pending verification')).toBeInTheDocument();
    expect(screen.getByText('Temporary hide')).toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Review media ${HASH}` })).toHaveAttribute('href', `https://api.example.test/media/${HASH}`);
    expect(await screen.findByText('report')).toBeInTheDocument();
    expect(screen.queryByText(/never-render-this/)).not.toBeInTheDocument();
    expect(screen.getByText(/retry scheduled/)).toBeInTheDocument();
  });

  it('requires a reason and submits the viewed revision with the login token, keeping 202 pending', async () => {
    renderQueue();
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(restore).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: '  No explicit activity  ' } });
    fireEvent.click(restore);
    // No actor in the body: the worker records the moderator it verifies.
    await waitFor(() => expect(lastDecision).toEqual({ revision: 3, decision: 'restore', reason: 'No explicit activity' }));
    expect(lastDecisionHeaders?.['X-Divine-Login-Token']).toBe(MOD_TOKEN);
    expect(await screen.findByText(/decision saved.*verification or reports recording pending/i)).toBeInTheDocument();
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
    expect(screen.queryByText('Restored')).not.toBeInTheDocument();
  });

  it('keeps the revision the moderator began reviewing when a refetch loads a newer one', async () => {
    renderQueue();
    fireEvent.change(await screen.findByLabelText('Decision reason'), { target: { value: 'No explicit activity' } });
    current = makeCase({ revision: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh case' }));
    expect(await screen.findByText('Revision 5')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(lastDecision).toMatchObject({ revision: 3, decision: 'restore' }));
  });

  it('reloads a stale case without automatically replaying the decision', async () => {
    postStatus = 409;
    renderQueue();
    fireEvent.change(await screen.findByLabelText('Decision reason'), { target: { value: 'Explicit activity reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/case changed.*review.*again/i)).toBeInTheDocument();
    expect(await screen.findByText('Revision 9')).toBeInTheDocument();
    expect(lastDecision).toMatchObject({ revision: 3, decision: 'remove' });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps unrecorded human decisions visible as urgent work', async () => {
    current = makeCase({ goal: 'remove', state: 'removed', actor: 'reviewer' });
    renderQueue();
    expect(await screen.findByText('Human decision saved; recording in Reports is pending.')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('warns that a decision may not carry the moderator\'s name when the identity is unavailable', async () => {
    // Not "unattributed": with REQUIRE_MODERATOR_LOGIN on, an unverified decision
    // is refused rather than recorded without a name, and a verified token still
    // attributes it, so the frontend can only say it may not carry the name.
    context.identityUnavailable = true;
    context.pubkey = undefined;
    renderQueue();
    expect(await screen.findByText('Moderator identity unavailable. Your decision may not be recorded under your name.')).toBeInTheDocument();
    expect(screen.queryByText(/attributed as unattributed/i)).toBeNull();
  });

  it('explains remaining restrictions after a restore', async () => {
    current = makeCase({ goal: 'restore', state: 'restored_restricted', actor: 'moderator' });
    renderQueue();
    expect(await screen.findByText('Restored with remaining restrictions')).toBeInTheDocument();
    expect(screen.getByText(/other restrictions still apply/i)).toBeInTheDocument();
  });
});

describe("a suspended author's withheld snapshot", () => {
  const SNAP_HASH = '9'.repeat(64);
  const withheldCase = () => {
    const { snapshot: _s, ...rest } = makeCase();
    return { ...rest, snapshotWithheld: 'suspended' as const };
  };
  let snapshotStatus: number;
  let snapshotBody: unknown;

  function caseFetches(): Array<[string, RequestInit | undefined]> {
    return vi.mocked(fetch).mock.calls
      .map(([url, init]) => [String(url), init as RequestInit | undefined] as [string, RequestInit | undefined])
      .filter(([url]) => url.includes(`/sexual-quarantine/${EVENT}`) && !url.endsWith('/history'));
  }

  beforeEach(() => {
    snapshotStatus = 200;
    snapshotBody = makeCase({ snapshot: { event: {}, assets: [SNAP_HASH] } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/history')) return Response.json([]);
      if (url.endsWith('?snapshot=1')) return Response.json(snapshotBody, { status: snapshotStatus });
      return Response.json(withheldCase());
    }));
  });

  it('polling never requests the snapshot, and shows the button instead of "not available yet"', async () => {
    renderQueue();
    expect(await screen.findByRole('button', { name: /view the reported post \(hidden from everyone else by the suspension\)/i })).toBeInTheDocument();
    expect(screen.queryByText('Media snapshot is not available yet.')).not.toBeInTheDocument();
    expect(caseFetches().every(([url]) => !url.includes('snapshot=1'))).toBe(true);
  });

  it('the button fetches once with the login header and snapshot=1, and shows its media', async () => {
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
    expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    expect(screen.getByText('Hidden from everyone else by the suspension.')).toBeInTheDocument();
    const opens = caseFetches().filter(([url]) => url.endsWith('?snapshot=1'));
    expect(opens).toHaveLength(1);
    expect((opens[0][1]?.headers as Record<string, string>)['X-Divine-Login-Token']).toBe(MOD_TOKEN);
  });

  it('later polls do not replace the opened snapshot', async () => {
    const { rerender, view } = renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
    expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh case' }));
    await waitFor(() => expect(caseFetches().filter(([url]) => !url.includes('snapshot=1')).length).toBeGreaterThan(1));
    rerender(view());
    expect(screen.getByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    expect(caseFetches().filter(([url]) => url.endsWith('?snapshot=1'))).toHaveLength(1);
  });

  it('the snapshot disappears when another moderator takes over the session', async () => {
    // A sibling rendered after the screen reads the DOM in a layout effect,
    // which runs at each commit before any passive effect (such as the screen's
    // own clear-on-session-change). It sees what B's first render committed.
    const commits: Array<{ pubkey: string | undefined; shown: boolean }> = [];
    function CommitProbe() {
      useLayoutEffect(() => {
        commits.push({ pubkey: context.pubkey, shown: document.body.textContent?.includes(`Review media ${SNAP_HASH}`) ?? false });
      });
      return null;
    }
    const { rerender, view } = renderQueue(undefined, () => <CommitProbe />);
    fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
    expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    context.token = 'other-moderator-token';
    context.pubkey = '7'.repeat(64);
    const before = commits.length;
    rerender(view());
    const firstUnderB = commits.slice(before).find(commit => commit.pubkey === '7'.repeat(64));
    expect(firstUnderB).toEqual({ pubkey: '7'.repeat(64), shown: false });
    await waitFor(() => expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument());
    // The new moderator opens it with their own audited request, or not at all.
    expect(screen.getByRole('button', { name: /view the reported post/i })).toBeInTheDocument();
    expect(caseFetches().filter(([url]) => url.endsWith('?snapshot=1'))).toHaveLength(1);
  });

  it('the snapshot disappears on sign-out', async () => {
    const { rerender, view } = renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
    expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    context.token = undefined;
    rerender(view());
    await waitFor(() => expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument());
    expect(screen.getByText('Sign in with Divine to view the reported post.')).toBeInTheDocument();
    // Signing back in does not bring it back without another audited open.
    context.token = MOD_TOKEN;
    rerender(view());
    expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
  });

  describe('a decision whose 202 withholds the snapshot', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Response.json({ ...withheldCase(), revision: 4, goal: 'remove', state: 'pending' }, { status: 202 });
        if (url.endsWith('/history')) return Response.json([]);
        if (url.endsWith('?snapshot=1')) return Response.json(snapshotBody, { status: snapshotStatus });
        return Response.json(withheldCase());
      }));
    });

    async function decide() {
      fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'explicit' } });
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText('Decision saved; verification or Reports recording pending.')).toBeInTheDocument();
    }

    it('keeps the snapshot the moderator already opened, without fetching it again', async () => {
      renderQueue();
      fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
      expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
      await decide();
      expect(screen.getByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
      expect(caseFetches().filter(([url]) => url.endsWith('?snapshot=1'))).toHaveLength(1);
    });

    it('offers the audited open again when none was opened, never "not available yet"', async () => {
      renderQueue();
      await screen.findByRole('button', { name: /view the reported post/i });
      await decide();
      expect(screen.getByRole('button', { name: /view the reported post/i })).toBeInTheDocument();
      expect(screen.queryByText('Media snapshot is not available yet.')).not.toBeInTheDocument();
      expect(caseFetches().some(([url]) => url.endsWith('?snapshot=1'))).toBe(false);
    });
  });

  describe('a snapshot response that arrives after the session changed', () => {
    let release: () => void;
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/history')) return Response.json([]);
        if (url.endsWith('?snapshot=1')) {
          await new Promise<void>(resolve => { release = resolve; });
          return Response.json(snapshotBody);
        }
        return Response.json(withheldCase());
      }));
    });

    async function openAndHold() {
      const view = renderQueue();
      fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
      await waitFor(() => expect(caseFetches().some(([url]) => url.endsWith('?snapshot=1'))).toBe(true));
      return view;
    }

    it('is dropped when the moderator signed out, even after signing back in', async () => {
      const { rerender, view } = await openAndHold();
      context.token = undefined;
      context.pubkey = undefined;
      rerender(view());
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
      context.token = MOD_TOKEN;
      context.pubkey = 'c'.repeat(64);
      rerender(view());
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /view the reported post/i })).toBeInTheDocument();
    });

    it('is dropped when it lands after the same moderator signed out and back in', async () => {
      // The opener matches and the clearing effect has already run, so only
      // the session generation can tell this answer belongs to the old session.
      const { rerender, view } = await openAndHold();
      context.token = undefined;
      context.pubkey = undefined;
      rerender(view());
      context.token = MOD_TOKEN;
      context.pubkey = 'c'.repeat(64);
      rerender(view());
      release();
      await waitFor(() => expect(vi.mocked(fetch).mock.results.length).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
    });

    it('is dropped when another moderator signed in meanwhile', async () => {
      const { rerender, view } = await openAndHold();
      context.token = 'other-moderator-token';
      context.pubkey = '7'.repeat(64);
      rerender(view());
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
    });

    it('is shown when the same session is still signed in', async () => {
      await openAndHold();
      release();
      expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    });
  });

  it("an 'unknown' status says the check failed and offers the audited open", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/history')) return Response.json([]);
      if (url.endsWith('?snapshot=1')) return Response.json(snapshotBody);
      return Response.json({ ...withheldCase(), snapshotWithheld: 'unknown' });
    }));
    renderQueue();
    expect(await screen.findByText("Couldn't check whether this account is suspended, so its media is withheld.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hidden from everyone else by the suspension/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the reported post to check' }));
    expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    expect(screen.queryByText('Hidden from everyone else by the suspension.')).not.toBeInTheDocument();
  });

  describe('a session whose moderator pubkey has not resolved', () => {
    const unresolvedA = () => { context.token = MOD_TOKEN; context.pubkey = undefined; };
    const unresolvedB = () => { context.token = 'other-moderator-token'; context.pubkey = undefined; };
    const NOT_YET = "Your Divine identity hasn't loaded yet, so the reported post can't be opened.";

    it('offers no open and sends no request', async () => {
      unresolvedA();
      renderQueue();
      expect(await screen.findByText(NOT_YET)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view the reported post/i })).not.toBeInTheDocument();
      expect(caseFetches().some(([url]) => url.includes('snapshot=1'))).toBe(false);
    });

    // A opens while unresolved (if the screen lets them), then B's token
    // replaces A's while B is unresolved too: the pubkey stays undefined, so no
    // effect dependency changes. Nothing A opened may show under B.
    it("an already-open snapshot never shows after another unresolved moderator's token takes over", async () => {
      unresolvedA();
      const { rerender, view } = renderQueue();
      await screen.findByText(/Revision 3/);
      const open = screen.queryByRole('button', { name: /view the reported post/i });
      if (open) {
        fireEvent.click(open);
        await waitFor(() => expect(caseFetches().some(([url]) => url.endsWith('?snapshot=1'))).toBe(true));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      unresolvedB();
      rerender(view());
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
    });

    it("a pending open never shows after another unresolved moderator's token takes over", async () => {
      let release = () => {};
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/history')) return Response.json([]);
        if (url.endsWith('?snapshot=1')) {
          await new Promise<void>(resolve => { release = resolve; });
          return Response.json(snapshotBody);
        }
        return Response.json(withheldCase());
      }));
      unresolvedA();
      const { rerender, view } = renderQueue();
      await screen.findByText(/Revision 3/);
      const open = screen.queryByRole('button', { name: /view the reported post/i });
      if (open) {
        fireEvent.click(open);
        await waitFor(() => expect(caseFetches().some(([url]) => url.endsWith('?snapshot=1'))).toBe(true));
      }
      unresolvedB();
      rerender(view());
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
    });
  });

  it('signed out, it asks for a sign-in and makes no request', async () => {
    context.token = undefined;
    renderQueue();
    expect(await screen.findByText('Sign in with Divine to view the reported post.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /view the reported post/i })).not.toBeInTheDocument();
    expect(caseFetches().some(([url]) => url.includes('snapshot=1'))).toBe(false);
  });

  it.each([
    [401, 'moderator_login_required', 'Sign in with Divine to view the reported post.', false],
    [503, 'audit_unavailable', "Couldn't record this view, so nothing is shown.", true],
    [503, 'suspension_status_unavailable', "Couldn't confirm the author's suspension status, so nothing is shown.", true],
  ])('a %i %s answer reads as it should', async (status, code, copy, retry) => {
    snapshotStatus = status;
    snapshotBody = { success: false, error: 'x', code };
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: /view the reported post/i }));
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(`Review media ${SNAP_HASH}`)).not.toBeInTheDocument();
    const again = screen.queryByRole('button', { name: 'Try again' });
    expect(!!again).toBe(retry);
    if (again) {
      snapshotStatus = 200;
      snapshotBody = makeCase({ snapshot: { event: {}, assets: [SNAP_HASH] } });
      fireEvent.click(again);
      expect(await screen.findByText(`Review media ${SNAP_HASH}`)).toBeInTheDocument();
    }
  });
});
