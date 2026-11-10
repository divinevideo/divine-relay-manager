// ABOUTME: The Hive AI card only shows results. Its Analyze and re-check buttons posted to a
// ABOUTME: route the worker never had, so they were removed (#406); the card must only read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';

import { TestApp } from '@/test/TestApp';
import { HiveAIReport } from './HiveAIReport';

const SHA = 'a'.repeat(64);
// A video event: hash and a playable URL, the two things the old buttons needed.
const TAGS = [['x', SHA], ['imeta', `url https://media.divine.video/${SHA}.mp4`, `x ${SHA}`]];

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A fresh Response per call: a body can be read only once, so a shared instance
// would fail any second fetch (a refetch, a second reader) for the wrong reason.
function respond(status: number, body: string) {
  fetchMock.mockImplementation(async () => new Response(body, { status }));
}

// Every request the card sent, whether it passed a Request or a URL and init.
function requests() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: input instanceof Request ? input.url : String(input),
    method: (init as RequestInit | undefined)?.method ?? (input instanceof Request ? input.method : 'GET'),
  }));
}

function expectOnlyReads() {
  expect(fetchMock).toHaveBeenCalled();
  for (const { url, method } of requests()) {
    expect(method).toBe('GET');
    expect(url).not.toContain('/api/moderate-check');
  }
}

describe('HiveAIReport', () => {
  it('shows "Not analyzed yet" with no button when there is no result', async () => {
    respond(404, 'not found');
    render(<TestApp><HiveAIReport eventTags={TAGS} /></TestApp>);

    expect(await screen.findByText('Not analyzed yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /analyze/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expectOnlyReads();
  });

  it('shows an existing result with no re-check button', async () => {
    respond(200, JSON.stringify({
      action: 'SAFE', scores: { nudity: 0.8 }, processedAt: '2026-11-01T10:00:00Z',
    }));
    render(<TestApp><HiveAIReport eventTags={TAGS} /></TestApp>);

    expect(await screen.findByText('Nudity')).toBeInTheDocument();
    expect(screen.getByText(/Checked:/)).toBeInTheDocument();
    // The only button left is the hash's copy control (the re-check icon had no
    // accessible name, so count rather than look it up by name).
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expectOnlyReads();
  });

  it('bounds the read with the API timeout', async () => {
    vi.useFakeTimers();
    // A read that never answers: it ends only when its signal aborts.
    fetchMock.mockImplementation((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    render(<TestApp><HiveAIReport eventTags={TAGS} /></TestApp>);

    // Still loading just inside the 30s bound; past it the read has ended and
    // the card has left its skeleton (the hash shows in every other state).
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.queryByText(/sha256:/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText(/sha256:/)).toBeInTheDocument();
  });

  it('shows the new state once a moderation action invalidates media-status', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    respond(200, JSON.stringify({ sha256: SHA, action: 'SAFE', scores: {} }));
    render(<TestApp queryClient={queryClient}><HiveAIReport eventTags={TAGS} /></TestApp>);
    expect(await screen.findByText('Safe')).toBeInTheDocument();

    // What ReportDetail and EventActions run after every media action.
    respond(200, JSON.stringify({ sha256: SHA, action: 'QUARANTINE', scores: {} }));
    await act(() => queryClient.invalidateQueries({ queryKey: ['media-status'] }));

    expect(await screen.findByText('Quarantined')).toBeInTheDocument();
  });
});
