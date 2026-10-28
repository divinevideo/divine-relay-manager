// ABOUTME: Tests UserProfilePreview's relay-profile badge: it says whether our relay
// ABOUTME: returned a profile, never that the account signed up with Divine (#132).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserProfilePreview } from './UserProfilePreview';

vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { query: async () => [] } }) }));
vi.mock('@/hooks/useAdminApi', () => ({ useApiUrl: () => 'https://api.example.test' }));

const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false } as {
    data: { metadata?: Record<string, string>; isFunnelcakeUser: boolean } | undefined;
    isLoading: boolean;
  },
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => authorState.result }));

const PUBKEY = 'a'.repeat(64);

function renderPreview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UserProfilePreview pubkey={PUBKEY} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authorState.result = { data: undefined, isLoading: false };
});

describe('UserProfilePreview relay-profile badge', () => {
  it('says the profile is on the relay when Funnelcake returned one', () => {
    authorState.result = { data: { metadata: { name: 'synthetic' }, isFunnelcakeUser: true }, isLoading: false };
    renderPreview();
    expect(screen.getByText('Profile on relay')).toBeInTheDocument();
    // Neutral, so neither state reads as a trust signal (green for good, a colour for other).
    expect(screen.getByText('Profile on relay').className).not.toMatch(/green|purple/);
    expect(screen.queryByText('Divine')).not.toBeInTheDocument();
  });

  it('says no relay profile was found when Funnelcake returned none', () => {
    authorState.result = { data: { metadata: { name: 'synthetic' }, isFunnelcakeUser: false }, isLoading: false };
    renderPreview();
    expect(screen.getByText('No relay profile found')).toBeInTheDocument();
    // Neutral, so neither state reads as a trust signal (green for good, a colour for other).
    expect(screen.getByText('No relay profile found').className).not.toMatch(/green|purple/);
    expect(screen.queryByText('Nostr')).not.toBeInTheDocument();
  });

  // The name's link may shrink, so a long name truncates; the badge's link may not,
  // so the multi-word badge keeps one line instead of wrapping into a tall pill.
  it('truncates a long name instead of squeezing the badge', () => {
    const name = 'Synthetic Creator With A Rather Long Display Name';
    authorState.result = { data: { metadata: { name }, isFunnelcakeUser: false }, isLoading: false };
    renderPreview();
    expect(screen.getByText(name).closest('a')!.className).toContain('min-w-0');
    expect(screen.getByText('No relay profile found').closest('a')!.className).toContain('shrink-0');
  });

  it('shows no badge when the profile lookup produced no answer', () => {
    renderPreview();
    expect(screen.queryByText('Profile on relay')).not.toBeInTheDocument();
    expect(screen.queryByText('No relay profile found')).not.toBeInTheDocument();
  });
});

describe('UserProfilePreview claimed nip05', () => {
  it('marks it unverified', () => {
    authorState.result = { data: { metadata: { name: 'synthetic', nip05: 'synthetic@example.test' }, isFunnelcakeUser: false }, isLoading: false };
    renderPreview();
    expect(screen.getByText('synthetic@example.test').parentElement).toHaveTextContent('(unverified)');
  });
});
