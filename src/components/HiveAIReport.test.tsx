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

function methods() {
  return fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
}

describe('HiveAIReport', () => {
  it('shows "Not analyzed yet" with no button when there is no result', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    render(<TestApp><HiveAIReport eventTags={TAGS} /></TestApp>);

    expect(await screen.findByText('Not analyzed yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /analyze/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(methods().every(m => m === 'GET')).toBe(true);
  });

  it('shows an existing result with no re-check button', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      action: 'SAFE', scores: { nudity: 0.8 }, processedAt: '2026-11-01T10:00:00Z',
    }), { status: 200 }));
    render(<TestApp><HiveAIReport eventTags={TAGS} /></TestApp>);

    expect(await screen.findByText('Nudity')).toBeInTheDocument();
    expect(screen.getByText(/Checked:/)).toBeInTheDocument();
    // The only button left is the hash's copy control (the re-check icon had no
    // accessible name, so count rather than look it up by name).
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/moderate-check'))).toBe(false);
    expect(methods().every(m => m === 'GET')).toBe(true);
  });
});
