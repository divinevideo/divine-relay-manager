// ABOUTME: Integration tests for the Reports deep-link resolver — the gone / found (+ the
// ABOUTME: resulting /reports/:id URL) / unavailable states driven by ?event=/?pubkey= params.

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

// Benign detail pane, so a "found" resolution renders instead of crashing (unlike #158's test).
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: ({ report }: { report: { id: string } | null }) => (
    <div data-testid="report-detail">{report ? report.id : 'none'}</div>
  ),
}));

const EFOUND = '1'.repeat(64);
const MATCHING_ID = '2'.repeat(64);
const PGONE = '3'.repeat(64);
const PUNAVAIL = '4'.repeat(64);
const OTHER_EVENT = '6'.repeat(64);

function ev(id: string, tags: string[][]) {
  return { id, pubkey: 'b'.repeat(64), created_at: 1751000000, kind: 1984, tags, content: '', sig: 'e'.repeat(128) };
}
const OTHER_REPORT = ev('5'.repeat(64), [['e', OTHER_EVENT]]); // in the bulk list, unrelated target
const MATCHING_REPORT = ev(MATCHING_ID, [['e', EFOUND]]); // resolves to event:EFOUND

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let consoleError: MockInstance;

// Bulk /api/reports returns only OTHER_REPORT (so deep-link targets miss the bulk window and
// fall to the targeted lookup). `targeted` controls the ?event=/?pubkey= response per test.
function stubFetch(targeted: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const isTargeted = url.includes('/api/reports') && (url.includes('event=') || url.includes('pubkey='));
    if (isTargeted) return targeted(url);
    if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [OTHER_REPORT] });
    if (url.includes('/api/resolution-labels')) return jsonResponse({ success: true, events: [] });
    if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
    if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: true });
  }));
}

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
  window.history.pushState({}, '', '/');
});

describe('Reports deep-link resolution', () => {
  it('shows the "gone" pane when the relay confirms the target has no report', async () => {
    window.history.pushState({}, '', `/reports?pubkey=${PGONE}`);
    stubFetch(() => jsonResponse({ success: true, events: [] }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(/no longer on the relay/i)).toBeInTheDocument();
    expect(screen.getByText(PGONE)).toBeInTheDocument();
  });

  it('resolves an aged-out target via the targeted fetch and lands on /reports/:id', async () => {
    window.history.pushState({}, '', `/reports?event=${EFOUND}`);
    stubFetch(() => jsonResponse({ success: true, events: [MATCHING_REPORT] }));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    // The fix: navigate to /reports/:id, and the redundant setSearchParams({}) that used to
    // clobber it back to /reports is gone — so the resolved URL is bookmarkable.
    await waitFor(() => expect(window.location.pathname).toBe(`/reports/${MATCHING_ID}`));
    expect(window.location.search).toBe('');
  });

  it('shows the "unavailable" pane (with retry) when the targeted lookup errors', async () => {
    window.history.pushState({}, '', `/reports?pubkey=${PUNAVAIL}`);
    stubFetch(() => jsonResponse({ success: false, error: 'boom' }, 502));

    render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    expect(await screen.findByText(/couldn't reach the relay/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not navigate after unmount while a targeted lookup is in flight', async () => {
    window.history.pushState({}, '', `/reports?event=${EFOUND}`);
    let resolveTargeted!: (r: Response) => void;
    const targetedPromise = new Promise<Response>((res) => { resolveTargeted = res; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/reports') && url.includes('event=')) return targetedPromise;
      if (url.includes('/api/reports')) return jsonResponse({ success: true, events: [OTHER_REPORT] });
      if (url.includes('/api/resolution-labels')) return jsonResponse({ success: true, events: [] });
      if (url.includes('/api/decisions')) return jsonResponse({ success: true, decisions: [] });
      if (url.includes('/api/relay-rpc')) return jsonResponse({ success: true, result: [] });
      return jsonResponse({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <TestApp>
        <Reports relayUrl="wss://relay.example" />
      </TestApp>
    );

    // Wait until the targeted lookup has actually been issued, then unmount before it resolves.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('event='))).toBe(true)
    );
    unmount();

    // The lookup resolves after unmount; the fix must drop it (no late navigate()).
    resolveTargeted(jsonResponse({ success: true, events: [MATCHING_REPORT] }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.pathname).toBe('/reports'); // unchanged — not /reports/:id
  });
});
