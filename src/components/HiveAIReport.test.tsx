// ABOUTME: The Hive AI card only shows results. Its Analyze and re-check buttons posted to a
// ABOUTME: route the worker never had, so they were removed (#406); the card must only read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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
afterEach(() => vi.unstubAllGlobals());

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
});
