// ABOUTME: Pins the account viewer in report detail's user card: only for a suspended account,
// ABOUTME: on the surface it is given, under the card's media rule, and nothing sent before a click.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UserProfileCard } from './UserProfileCard';

const PUBKEY = 'a'.repeat(64);
const VIEWER_URL = 'https://api.example.test/api/suspended-content/account';

vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example.test', relayUrl: 'wss://relay.example.test' } }),
}));
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({
    isSignedIn: true, isResolving: false, pubkey: 'b'.repeat(64),
    getModeratorToken: () => 'moderator-login-token', startLogin: async () => {},
  }),
}));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));
vi.mock('@/components/MediaPreview', () => ({
  InlineMediaPreview: () => null,
  MediaPreview: (props: { showByDefault?: boolean | null }) => <div data-testid="viewer-media" data-show={String(props.showByDefault)} />,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({
    success: true, pubkey: PUBKEY, profile: null, nextUntil: null, nextUntilId: null,
    events: [{ id: 'c'.repeat(64), pubkey: PUBKEY, created_at: 1, kind: 1, tags: [], content: 'hidden https://example.invalid/v.mp4', sig: 'f'.repeat(128) }],
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderCard(props: Partial<React.ComponentProps<typeof UserProfileCard>>) {
  return render(
    <MemoryRouter>
      <UserProfileCard pubkey={PUBKEY} isSuspended suspendedViewerSurface="report" {...props} />
    </MemoryRouter>,
  );
}

const viewerCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === VIEWER_URL);

describe('UserProfileCard suspended-content viewer', () => {
  it('offers the viewer for a suspended account, and sends nothing until clicked', async () => {
    renderCard({});
    await new Promise(r => setTimeout(r, 0));

    expect(viewerCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));

    expect(await screen.findByText(/^hidden/)).toBeInTheDocument();
    expect(viewerCalls()).toHaveLength(1);
    expect(JSON.parse(viewerCalls()[0][1].body as string)).toMatchObject({ pubkey: PUBKEY, surface: 'report' });
  });

  it.each([[null], [false]] as const)('leaves it out when the suspension is not confirmed (%s)', (isSuspended) => {
    renderCard({ isSuspended });

    expect(screen.queryByRole('button', { name: 'View hidden posts' })).not.toBeInTheDocument();
  });

  // Report detail's pubkey comes from the report's own p tag.
  it('leaves it out when the pubkey is not 64 hex', () => {
    renderCard({ pubkey: 'not-a-pubkey' });

    expect(screen.queryByRole('button', { name: 'View hidden posts' })).not.toBeInTheDocument();
  });

  it('leaves it out when no surface is given', () => {
    renderCard({ suspendedViewerSurface: undefined });

    expect(screen.queryByRole('button', { name: 'View hidden posts' })).not.toBeInTheDocument();
  });

  it.each([
    [true, 'false'],
    [null, 'null'],
    [false, 'true'],
  ] as const)('applies the card media rule (hideMediaByDefault %s)', async (hide, shown) => {
    renderCard({ hideMediaByDefault: hide });
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));

    await screen.findByText(/^hidden/);
    expect(screen.getByTestId('viewer-media').dataset.show).toBe(shown);
  });
});
