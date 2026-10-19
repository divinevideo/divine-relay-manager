// ABOUTME: Tests that reporter labels say only what is known (#132) and that reporter
// ABOUTME: cards show category names, the same labels the reports list uses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReporterInline, ReporterList } from './ReporterCard';

const relay = vi.hoisted(() => ({ query: vi.fn(), req: vi.fn() }));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: relay }) }));

const authorState = vi.hoisted(() => ({
  data: undefined as { metadata?: Record<string, string>; isFunnelcakeUser: boolean } | undefined,
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: authorState.data, isLoading: false }),
}));

const appState = vi.hoisted(() => ({ apiUrl: 'https://api.one.example.test' }));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { apiUrl: appState.apiUrl } }) }));

const REPORTER = 'a'.repeat(64);

function reportEvent(n: number): NostrEvent {
  return {
    id: n.toString(16).padStart(64, '0'),
    pubkey: REPORTER,
    kind: 1984,
    content: '',
    tags: [],
    created_at: 1_750_000_000 + n,
    sig: 'f'.repeat(128),
  };
}

/** The reporter's filing history as the relay returns it: events, then EOSE. */
function relayHas(count: number) {
  const events = Array.from({ length: count }, (_, i) => reportEvent(i));
  relay.query.mockResolvedValue(events);
  relay.req.mockImplementation(async function* () {
    for (const e of events) yield ['EVENT', 'sub', e];
    yield ['EOSE', 'sub'];
  });
}

function renderInline(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <ReporterInline pubkey={REPORTER} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  appState.apiUrl = 'https://api.one.example.test';
  relay.query.mockReset();
  relay.req.mockReset();
  relayHas(0);
  authorState.data = { metadata: { name: 'synthetic-reporter' }, isFunnelcakeUser: false };
});

describe('ReporterInline relay-profile badge', () => {
  it('says the profile is on the relay, not that the reporter is a Divine user', () => {
    authorState.data = { metadata: { name: 'synthetic-reporter' }, isFunnelcakeUser: true };
    renderInline();
    expect(screen.getByText('Profile on relay')).toBeInTheDocument();
    expect(screen.queryByText('Divine')).not.toBeInTheDocument();
  });

  it('says no relay profile was found, not that the reporter is a Nostr user', () => {
    renderInline();
    expect(screen.getByText('No relay profile found')).toBeInTheDocument();
    expect(screen.queryByText('Nostr')).not.toBeInTheDocument();
  });

  it('shows no badge when the profile lookup produced no answer', () => {
    authorState.data = undefined;
    renderInline();
    expect(screen.queryByText('Profile on relay')).not.toBeInTheDocument();
    expect(screen.queryByText('No relay profile found')).not.toBeInTheDocument();
  });
});

describe('ReporterInline report count', () => {
  // getTrustLevel used to badge 50+ filings as "Trusted": a count dressed as a
  // judgment of the reporter. Only the count is known.
  it('shows the count of reports filed without a trust label', async () => {
    relayHas(60);
    renderInline();
    expect(await screen.findByText('60 reports filed')).toBeInTheDocument();
    for (const label of ['Trusted', 'Active', 'Regular', 'New', 'First-time']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('marks a count that reached the read limit as a floor', async () => {
    relayHas(100);
    renderInline();
    expect(await screen.findByText('100+ reports filed')).toBeInTheDocument();
  });

  it('does not print a failed read as zero reports', async () => {
    relay.query.mockResolvedValue([]); // NPool.query's answer to a failed read
    relay.req.mockImplementation(async function* () {
      yield ['CLOSED', 'sub', 'error: could not complete query'];
    });
    renderInline();
    // The count query retries once (about a second) before it gives up.
    expect(await screen.findByText('report count unavailable', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(relay.req).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('0 reports filed')).not.toBeInTheDocument();
  });
});

describe('ReporterInline report count cache', () => {
  // One QueryClient serves every environment, and each environment has its own
  // relay, so a cached count must not follow the moderator across a switch.
  it('reads the count again after the environment changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    relayHas(3);
    const first = renderInline(client);
    expect(await screen.findByText('3 reports filed')).toBeInTheDocument();
    first.unmount();

    appState.apiUrl = 'https://api.two.example.test';
    relayHas(7);
    renderInline(client);
    expect(await screen.findByText('7 reports filed')).toBeInTheDocument();
  });
});

describe('ReporterInline nip05', () => {
  it('shows the nip05 the profile claims, marked unverified', () => {
    authorState.data = { metadata: { name: 'synthetic-reporter', nip05: 'synthetic@example.test' }, isFunnelcakeUser: true };
    renderInline();
    expect(screen.getByText('synthetic@example.test')).toBeInTheDocument();
    expect(screen.getByText('(unverified)')).toBeInTheDocument();
  });

  it('shows nothing for a reporter with no nip05', () => {
    renderInline();
    expect(screen.queryByText('(unverified)')).not.toBeInTheDocument();
  });

  it('shows nothing for a reporter with no profile at all', () => {
    authorState.data = { isFunnelcakeUser: false };
    renderInline();
    expect(screen.queryByText('(unverified)')).not.toBeInTheDocument();
    expect(screen.getByText('No relay profile found')).toBeInTheDocument();
  });
});

// The current Divine app's profile CSAM report shape.
function profileReport(idChar: string, reporterChar: string): NostrEvent {
  return {
    id: idChar.repeat(64),
    pubkey: reporterChar.repeat(64),
    created_at: 1751000000,
    kind: 1984,
    tags: [
      ['p', 'd'.repeat(64), 'illegal'],
      ['L', 'social.nos.ontology'],
      ['l', 'NS-csam', 'social.nos.ontology'],
    ],
    content: '',
    sig: 'e'.repeat(128),
  };
}

describe('ReporterList', () => {
  it('shows the category name on a full reporter card', () => {
    render(<ReporterList reports={[profileReport('a', '1')]} />);

    expect(screen.getByText('CSAM')).toBeInTheDocument();
    expect(screen.queryByText('NS-csam')).not.toBeInTheDocument();
  });

  it('shows the category name on compact reporter cards', () => {
    // More than three reporters switches the cards to their compact layout.
    const reports = [
      profileReport('a', '1'),
      profileReport('b', '2'),
      profileReport('c', '3'),
      profileReport('f', '4'),
    ];
    render(<ReporterList reports={reports} />);

    expect(screen.getAllByText('CSAM')).toHaveLength(4);
    expect(screen.queryByText('NS-csam')).not.toBeInTheDocument();
  });
});
