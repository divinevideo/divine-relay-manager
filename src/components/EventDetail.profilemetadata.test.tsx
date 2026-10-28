// ABOUTME: Pins that the Events explorer's Profile Metadata card shows only the profile
// ABOUTME: fields that are text, and links the website only for an http(s) address.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

const AUTHOR = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({}) }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn(async () => []) } }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }) };
});
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

function profileEvent(content: string): NostrEvent {
  return {
    id: 'c'.repeat(64),
    pubkey: AUTHOR,
    created_at: 1751000000,
    kind: 0,
    tags: [],
    content,
    sig: 'c'.repeat(128),
  };
}

function renderProfile(content: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={profileEvent(content)} />
    </QueryClientProvider>,
  );
}

describe('EventDetail profile metadata card', () => {
  // Profile JSON is whatever its author wrote, so a field can hold any JSON value.
  it('shows the fields that are text and leaves out the ones that are not', () => {
    renderProfile(JSON.stringify({
      name: 'synthetic-name',
      display_name: { nested: true },
      about: ['not', 'text'],
      nip05: 42,
      website: 7,
      lud16: { address: 'x' },
      picture: { url: 'x' },
    }));
    expect(screen.getByText('@synthetic-name')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /profile images/ })).not.toBeInTheDocument();
  });

  it.each(['null', '"just a string"', '["not", "an object"]'])('shows the raw content when it is JSON but not an object (%s)', (content) => {
    renderProfile(content);
    expect(screen.getByText(content)).toBeInTheDocument();
  });

  it('links a website that is an https address', () => {
    renderProfile(JSON.stringify({ name: 'synthetic-name', website: 'https://example.test/me' }));
    expect(screen.getByRole('link', { name: 'example.test/me' })).toHaveAttribute('href', 'https://example.test/me');
  });

  it('shows a website that is not an http or https address as text, not a link', () => {
    renderProfile(JSON.stringify({ name: 'synthetic-name', website: 'ftp://files.example.test/me' }));
    expect(screen.getByText('ftp://files.example.test/me')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /files\.example\.test/ })).not.toBeInTheDocument();
  });
});
