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

// A failed poll must not blank a loaded queue. The worker now 502s when the
// relay times out / closes before EOSE (instead of returning an empty success);
// the list keeps rendering its last good data with a stale-data warning rather
// than replacing the whole pane with the error alert. Surfaced by a slow
// staging backend; applies to any slow relay in production.
describe('Reports stale-data resilience', () => {
  it('keeps the last loaded queue visible with a warning when a refresh fails', async () => {
    let reportsCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports')) {
        reportsCalls++;
        if (reportsCalls === 1) return jsonResponse({ success: true, events: [REPORT] });
        return new Response(JSON.stringify({ success: false, error: 'Relay query timed out before EOSE' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/resolution-labels')) return jsonResponse({ success: true, events: [] });
      if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(/1 report$/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/last updated|refresh/i));

    // Warning appears; the queue row is still there (not blanked, no full-pane error).
    expect(await screen.findByText(/refresh is failing/i)).toBeInTheDocument();
    expect(screen.getByText(/1 report$/)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load reports/i)).not.toBeInTheDocument();
  });

  it('still shows the full error pane when the first load fails (no stale data to fall back on)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports')) {
        return new Response(JSON.stringify({ success: false, error: 'Relay query timed out before EOSE' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse({ success: true, events: [], decisions: [], result: [] });
    }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(/failed to load reports/i)).toBeInTheDocument();
  });
});

// resolvedTargets is subtractive: it hides work a moderator already handled.
// When a source of it fails, the queue does not get smaller and safer, it gets
// bigger and wrong, re-presenting handled targets as pending (#221). The list
// still renders (a moderator with no queue can do nothing), but it must not
// claim to be complete when the resolution state behind it is missing.
describe('Reports resolution-state availability', () => {
  const RESOLUTION_LABEL = {
    id: '1'.repeat(64),
    pubkey: '2'.repeat(64),
    created_at: 1751000200,
    kind: 1985,
    tags: [['L', 'moderation/resolution'], ['e', 'c'.repeat(64)]],
    content: '',
    sig: 'e'.repeat(128),
  };

  function stubFetch(labelsResponse: () => Response) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/resolution-labels')) return labelsResponse();
      if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [REPORT] });
      if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    }));
  }

  // The pending count sits in a node with a sibling span, so match on the
  // element's own normalized text rather than a bare string.
  const pendingCount = (n: number) => (_: string, el: Element | null) =>
    el?.tagName === 'P' && (el.textContent ?? '').trim().startsWith(`${n} pending`);

  // Control: proves the label genuinely hides the target, so the test below is
  // measuring a real un-hide rather than a report that was never filtered.
  it('hides a target that a resolution label has already resolved', async () => {
    stubFetch(() => jsonResponse({ success: true, events: [RESOLUTION_LABEL] }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(pendingCount(0))).toBeInTheDocument();
    expect(screen.queryByText(/1 report$/)).not.toBeInTheDocument();
    // Pins the negative side: a warning that is always on is a warning nobody
    // reads, and an unconditional banner would otherwise pass every test here.
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
  });

  it('warns that resolution state is unavailable when the labels query fails on first load', async () => {
    stubFetch(() => new Response(JSON.stringify({ success: false, error: 'Relay query timed out before EOSE' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    // The previously-resolved target is back in the list. That is tolerable
    // only because the moderator is told the filter behind it is incomplete.
    expect(await screen.findByText(pendingCount(1))).toBeInTheDocument();
    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
  });

  // The warning claims handled work may be listed as pending, which is only
  // true while resolvedTargets is actually filtering the list. With hide
  // resolved off nothing is filtered by it, so the claim does not apply and
  // the banner must stand down rather than cry wolf.
  it('drops the warning when resolved targets are not being filtered anyway', async () => {
    stubFetch(() => new Response(JSON.stringify({ success: false, error: 'Relay query timed out before EOSE' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /hide resolved/i }));

    await waitFor(() =>
      expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument()
    );
  });
});
