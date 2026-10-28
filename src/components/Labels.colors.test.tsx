// ABOUTME: Label badges take a colour only from the known labels; any other
// ABOUTME: label, including one named like an inherited object key, is gray

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { Labels } from './Labels';

const query = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ banPubkey: vi.fn(), verifyPubkeyBanned: vi.fn() }) }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { query } }) }));
// Children are irrelevant to the badge colours and drag in their own dependencies.
vi.mock('@/components/LabelPublisher', () => ({ LabelPublisher: () => null }));
vi.mock('@/components/EventContentPreview', () => ({ EventContentPreview: () => null }));
vi.mock('@/components/UserProfilePreview', () => ({ UserProfilePreview: () => null }));
vi.mock('@/components/ReporterInfo', () => ({ ReportedBy: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null, UserDisplayName: () => null }));

/** One kind 1985 event carrying a known label and two named like inherited object keys. */
const LABEL_EVENT = {
  id: 'b'.repeat(64),
  pubkey: 'c'.repeat(64),
  created_at: 1_700_000_000,
  kind: 1985,
  tags: [
    ['L', 'dtsp'],
    ['l', 'spam', 'dtsp'],
    ['l', 'constructor', 'dtsp'],
    ['l', '__proto__', 'dtsp'],
    ['p', 'a'.repeat(64)],
  ],
  content: '',
  sig: 'd'.repeat(128),
};

describe('Labels badge colours', () => {
  it('colours a known label and leaves labels named like inherited object keys gray', async () => {
    query.mockResolvedValue([LABEL_EVENT]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Labels relayUrl="wss://relay.test" />
      </QueryClientProvider>,
    );

    expect((await screen.findByText('spam')).className).toContain('bg-yellow-500');
    expect(screen.getByText('constructor').className).toContain('bg-gray-500');
    expect(screen.getByText('__proto__').className).toContain('bg-gray-500');
  });
});
