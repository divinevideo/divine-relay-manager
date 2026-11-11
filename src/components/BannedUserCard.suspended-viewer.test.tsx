// ABOUTME: Pins the account viewer in the user view's suspended list: offered in a suspended
// ABOUTME: card's details, on the user surface, with media hidden until a moderator asks.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { AppProvider } from '@/components/AppProvider';
import { BannedUserCard } from './BannedUserCard';

const PUBKEY = 'a'.repeat(64);

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { req: async function* () { yield ['EOSE', 'sub']; } } }),
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useEventTitles', () => ({ useEventTitles: () => ({ titles: new Map(), isLoading: false }) }));
// The panel has its own tests; here it records what the card handed it.
const viewerProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/suspended/SuspendedContentPanel', () => ({
  SuspendedAccountViewer: (props: Record<string, unknown>) => {
    viewerProps.last = props;
    return <div data-testid="account-viewer" />;
  },
}));

function renderCard(props: Partial<React.ComponentProps<typeof BannedUserCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProvider storageKey="test-app-config" defaultConfig={{ theme: 'light', relayUrl: 'wss://relay.test', apiUrl: 'https://api.test' }}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BannedUserCard pubkey={PUBKEY} {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProvider>,
  );
}

function openDetails() {
  fireEvent.click(screen.getByRole('button', { name: /Toggle details/ }));
}

beforeEach(() => {
  viewerProps.last = null;
});

describe('BannedUserCard suspended-content viewer', () => {
  it('offers the viewer in a suspended card, on the user surface, media hidden by default', () => {
    renderCard({ suspended: true });
    openDetails();

    expect(screen.getByTestId('account-viewer')).toBeInTheDocument();
    expect(viewerProps.last).toMatchObject({ pubkey: PUBKEY, surface: 'user', showMediaByDefault: false });
  });

  it('decodes a stored npub to the hex pubkey it hands the viewer', () => {
    renderCard({ suspended: true, pubkey: nip19.npubEncode(PUBKEY) });
    openDetails();

    expect(viewerProps.last?.pubkey).toBe(PUBKEY);
  });

  it('does not mount the viewer while the details are closed', () => {
    renderCard({ suspended: true });

    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();
  });

  it('leaves it out of a banned card', () => {
    renderCard({ suspended: false });
    openDetails();

    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();
  });

  it('leaves it out when the stored key is not a pubkey', () => {
    renderCard({ suspended: true, pubkey: 'not-a-pubkey' });
    openDetails();

    expect(screen.queryByTestId('account-viewer')).not.toBeInTheDocument();
  });
});
