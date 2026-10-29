import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SexualCase } from '../../shared/sexual-quarantine';
import { SexualQuarantine } from './SexualQuarantine';

const context = vi.hoisted(() => ({ apiUrl: 'https://api.example.test', relayUrl: 'wss://relay.example.test', identity: vi.fn() }));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: context }) }));
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession: () => ({
  getModeratorPubkey: context.identity, identityUnavailable: false,
}) }));

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

function renderQueue(path = `/sexual-quarantine/${EVENT}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/sexual-quarantine" element={<SexualQuarantine />} />
      <Route path="/sexual-quarantine/:eventId" element={<SexualQuarantine />} /></Routes>
  </MemoryRouter></QueryClientProvider>;
  return { ...render(view()), view };
}

beforeEach(() => {
  context.apiUrl = 'https://api.example.test';
  context.identity.mockResolvedValue('d'.repeat(64));
  current = makeCase(); postStatus = 202; lastDecision = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      lastDecision = JSON.parse(init.body as string);
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

  it('requires a reason and submits the viewed revision with snapshotted identity, keeping 202 pending', async () => {
    renderQueue();
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(restore).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: '  No explicit activity  ' } });
    fireEvent.click(restore);
    await waitFor(() => expect(lastDecision).toEqual({ revision: 3, decision: 'restore', actor: 'd'.repeat(64), reason: 'No explicit activity' }));
    expect(await screen.findByText(/decision recorded.*verification pending/i)).toBeInTheDocument();
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
    expect(screen.queryByText('Restored')).not.toBeInTheDocument();
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

  it('explains remaining restrictions after a restore', async () => {
    current = makeCase({ goal: 'restore', state: 'restored_restricted', actor: 'moderator' });
    renderQueue();
    expect(await screen.findByText('Restored with remaining restrictions')).toBeInTheDocument();
    expect(screen.getByText(/other restrictions still apply/i)).toBeInTheDocument();
  });

  it('does not write an old case after environment changes while identity resolves', async () => {
    let resolveIdentity!: (value: string) => void;
    context.identity.mockReturnValue(new Promise<string>(resolve => { resolveIdentity = resolve; }));
    const view = renderQueue();
    fireEvent.change(await screen.findByLabelText('Decision reason'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(context.identity).toHaveBeenCalled());
    context.apiUrl = 'https://staging.example.test';
    current = makeCase({ revision: 15, state: 'review', goal: 'review', snapshot: undefined });
    view.rerender(view.view());
    expect(await screen.findByText('Revision 15')).toBeInTheDocument();
    resolveIdentity('d'.repeat(64));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled());
    expect(lastDecision).toBeUndefined();
    expect(screen.queryByRole('link', { name: `Review media ${HASH}` })).not.toBeInTheDocument();
  });
});
