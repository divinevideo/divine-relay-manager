import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReportDetailErrorFallback } from './ReportDetailErrorFallback';

const REPORT_ID = 'a'.repeat(64);
const TARGET_EVENT_ID = 'c'.repeat(64);
const TARGET_PUBKEY = 'd'.repeat(64);

function makeReport(tags: string[][]): NostrEvent {
  return {
    id: REPORT_ID,
    pubkey: 'b'.repeat(64),
    created_at: 1750000000,
    kind: 1984,
    tags,
    content: 'spam',
    sig: 'e'.repeat(128),
  };
}

describe('ReportDetailErrorFallback', () => {
  it('shows full untruncated identifiers from the report event', () => {
    render(
      <ReportDetailErrorFallback
        report={makeReport([['e', TARGET_EVENT_ID, 'spam'], ['p', TARGET_PUBKEY, 'spam']])}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText(REPORT_ID)).toBeInTheDocument();
    expect(screen.getByText(TARGET_EVENT_ID)).toBeInTheDocument();
    expect(screen.getByText(TARGET_PUBKEY)).toBeInTheDocument();
  });

  it("shows the report's own id VERBATIM when it is not canonical hex — a case-folded copy would fail lookups", () => {
    render(
      <ReportDetailErrorFallback
        report={{ ...makeReport([]), id: 'HOSTILE-NonCanonical-Id' }}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText('HOSTILE-NonCanonical-Id')).toBeInTheDocument();
  });

  it('survives a non-string report id without crashing the fallback itself', () => {
    const onRetry = vi.fn();
    render(
      <ReportDetailErrorFallback
        report={{ ...makeReport([]), id: null as unknown as string }}
        onRetry={onRetry}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText(/failed to render/i)).toBeInTheDocument();
    expect(screen.queryByText(/report id/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('accepts uppercase hex from reporter-authored tags and displays it lowercased', () => {
    render(
      <ReportDetailErrorFallback
        report={makeReport([['e', TARGET_EVENT_ID.toUpperCase()]])}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText(TARGET_EVENT_ID)).toBeInTheDocument();
  });

  it('omits identifiers that are not valid 64-char hex (reporter-authored tags)', () => {
    render(
      <ReportDetailErrorFallback
        report={makeReport([['e', 'not-a-hex-id'], ['p', 'F'.repeat(9999)]])}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText(REPORT_ID)).toBeInTheDocument();
    expect(screen.queryByText(/target event/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/target pubkey/i)).not.toBeInTheDocument();
    expect(screen.queryByText('not-a-hex-id')).not.toBeInTheDocument();
  });

  it('retries via the Try again button', () => {
    const onRetry = vi.fn();
    render(
      <ReportDetailErrorFallback report={makeReport([])} onRetry={onRetry} onDismiss={() => {}} />
    );

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('dismisses via the Dismiss button', () => {
    const onDismiss = vi.fn();
    render(
      <ReportDetailErrorFallback report={makeReport([])} onRetry={() => {}} onDismiss={onDismiss} />
    );

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders without a report (crash before selection): retry only, no ids, no dismiss', () => {
    const onRetry = vi.fn();
    render(<ReportDetailErrorFallback report={null} onRetry={onRetry} onDismiss={() => {}} />);

    expect(screen.getByText(/failed to render/i)).toBeInTheDocument();
    expect(screen.queryByText(/report id/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
