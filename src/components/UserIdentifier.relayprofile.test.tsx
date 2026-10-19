// ABOUTME: Tests that UserIdentifier's no-relay-profile globe appears only once the
// ABOUTME: profile lookup has answered "none", never while it is still unresolved (#132).

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { RELAY_PROFILE_BADGE } from '@/lib/constants';
import { UserDisplayName, UserIdentifier } from './UserIdentifier';

const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: true } as {
    data: { metadata?: Record<string, string>; isFunnelcakeUser: boolean } | undefined;
    isLoading: boolean;
  },
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => authorState.result }));

const PUBKEY = 'a'.repeat(64);

// Every UserIdentifier layout that can show the globe (each needs linkToProfile;
// block needs a display name to render its name as a link).
const LAYOUTS: [string, () => ReactElement][] = [
  ['compact', () => <UserIdentifier pubkey={PUBKEY} variant="compact" linkToProfile />],
  ['block', () => <UserIdentifier pubkey={PUBKEY} variant="block" linkToProfile />],
  ['inline', () => <UserIdentifier pubkey={PUBKEY} variant="inline" linkToProfile />],
  ['UserDisplayName', () => <UserDisplayName pubkey={PUBKEY} linkToProfile />],
];

function globe() {
  return screen.queryByRole('img', { name: RELAY_PROFILE_BADGE.absent.title });
}

beforeEach(() => {
  authorState.result = { data: undefined, isLoading: true };
});

// block links (and so shows the globe) only beside a display name, which an
// unresolved lookup cannot supply, so the unresolved case cannot reach its globe.
describe.each(LAYOUTS.filter(([name]) => name !== 'block'))('UserIdentifier unresolved lookup (%s)', (_name, ui) => {
  it('shows no globe while the profile lookup is unresolved', () => {
    render(ui());
    expect(globe()).not.toBeInTheDocument();
  });
});

describe.each(LAYOUTS)('UserIdentifier relay-profile globe (%s)', (_name, ui) => {
  it('shows the globe once the lookup answers that the relay has no profile', () => {
    authorState.result = { data: { metadata: { name: 'synthetic' }, isFunnelcakeUser: false }, isLoading: false };
    render(ui());
    expect(globe()).toBeInTheDocument();
  });

  it('shows no globe when the relay has a profile', () => {
    authorState.result = { data: { metadata: { name: 'synthetic' }, isFunnelcakeUser: true }, isLoading: false };
    render(ui());
    expect(globe()).not.toBeInTheDocument();
  });
});
