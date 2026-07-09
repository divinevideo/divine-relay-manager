// ABOUTME: Integration test for #158's acceptance wiring in Reports: a crashing
// ABOUTME: ReportDetail degrades to the inline fallback while the list survives

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

// Stand-in for a detail pane crashed by hostile event data — always throws,
// counting attempts so tests can observe boundary resets re-running it.
const detailRender = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => {
    detailRender.attempts++;
    throw new Error('hostile report data');
  },
}));

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['e', 'c'.repeat(64), 'spam'], ['p', 'd'.repeat(64), 'spam']],
  content: 'comment spam',
  sig: 'e'.repeat(128),
};

// Hostile/malformed shape: tags is not an array. One bad report must not be
// able to take down the whole queue (#161 review).
const MALFORMED_REPORT = {
  id: 'f'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000100,
  kind: 1984,
  tags: null,
  content: 'malformed report',
  sig: 'e'.repeat(128),
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let consoleError: MockInstance;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [REPORT, MALFORMED_REPORT] });
    if (url.includes('/api/resolution-labels')) return jsonResponse({ success: true, events: [] });
    if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('Reports crash degradation (#158)', () => {
  it('degrades a crashing detail pane to the inline fallback while the list stays usable, and a row click retries', async () => {
    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    // Data loaded, mocked ReportDetail threw, scoped boundary caught it.
    expect(await screen.findByText(/this report failed to render/i)).toBeInTheDocument();

    // The list pane survived alongside the fallback. The payload included a
    // report with non-array tags: ingestion normalizes it (no crash, queue
    // intact); target-less, it is skipped from the grouped view per existing
    // consolidation semantics but stays reachable in the individual view.
    const row = await screen.findByText(/1 report$/);
    expect(screen.getByText(/1 pending/i)).toBeInTheDocument();
    expect(screen.getByText('All (2)')).toBeInTheDocument();

    // Clicking the report row re-attempts the detail render (boundary reset)
    // and, with the report now selected, the fallback surfaces its full ids.
    const attemptsBefore = detailRender.attempts;
    fireEvent.click(row);
    await waitFor(() => expect(detailRender.attempts).toBeGreaterThan(attemptsBefore));
    expect(await screen.findByText('c'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('d'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText(/this report failed to render/i)).toBeInTheDocument();

    // Re-clicking the SAME row is also a retry: resetKeys don't change, so
    // this exercises the explicit boundary reset in handleSelectReport.
    const attemptsBeforeSameRow = detailRender.attempts;
    fireEvent.click(row);
    await waitFor(() => expect(detailRender.attempts).toBeGreaterThan(attemptsBeforeSameRow));
    expect(screen.getByText(/this report failed to render/i)).toBeInTheDocument();
  });
});
