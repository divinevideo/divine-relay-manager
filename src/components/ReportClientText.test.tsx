// ABOUTME: Tests that the reporting-app line flags a named app as self-declared,
// ABOUTME: so "Filed via X" is never read as proof the report came from X.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReportClientText } from './ReportClientText';
import { appLine } from '@/test/appLine';

function report(tags: string[][]): NostrEvent {
  return {
    id: '1'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: 1984,
    content: '',
    tags,
    created_at: 1_750_000_000,
    sig: 'f'.repeat(128),
  };
}

describe('ReportClientText', () => {
  it('names the app and says on hover that the name is not verified', () => {
    render(<ReportClientText reports={[report([['client', 'Example App']])]} />);
    const line = screen.getByText(appLine('Filed via Example App'));
    expect(line).toHaveAttribute('title', expect.stringContaining('not verified'));
  });

  // A name can carry right-to-left override or other direction controls. Isolated,
  // it can't reorder "Filed via" or the count around it, and the name itself is
  // shown as written rather than stripped.
  it('isolates each app name so its characters cannot reorder the rest of the line', () => {
    const name = 'Evil\u202Eppa';
    const { container } = render(
      <ReportClientText reports={[report([['client', name]]), report([])]} />,
    );
    const isolated = container.querySelectorAll('bdi');
    expect(isolated).toHaveLength(1);
    expect(isolated[0].textContent).toBe(name);
    const line = container.firstElementChild!;
    expect(line.textContent).toBe(`Filed via ${name} · 1 with no app named`);
    expect(line.getAttribute('title')).toContain(`\u2068${name}\u2069`);
  });

  // A terminator inside the name must not close the isolation early and let a
  // following override reverse the rest of the line.
  it('keeps the isolation when the name carries its own isolate terminator', () => {
    const name = 'Evil\u2069\u202Eppa';
    const { container } = render(
      <ReportClientText reports={[report([['client', name]]), report([])]} />,
    );
    const isolated = container.querySelector('bdi')!;
    expect(isolated.textContent).toBe('Evil\u2068\u2069\u202Eppa');
    expect(container.firstElementChild!.getAttribute('title'))
      .toContain('\u2068Evil\u2068\u2069\u202Eppa\u2069 · 1 with no app named');
  });

  it('shows a paragraph break in the name as ¶, so it cannot end the isolation', () => {
    const name = 'Evil\u2029\u202Eppa';
    const { container } = render(
      <ReportClientText reports={[report([['client', name]]), report([])]} />,
    );
    expect(container.querySelector('bdi')!.textContent).toBe('Evil¶\u202Eppa');
    expect(container.firstElementChild!.getAttribute('title'))
      .toContain('\u2068Evil¶\u202Eppa\u2069 · 1 with no app named');
  });

  // Any reporter can set a long app name, and the line truncates it. The count of
  // reports naming no app is ours, so it sits outside the part that truncates.
  it('keeps the no-app count out of the part a long name truncates', () => {
    render(<ReportClientText reports={[report([['client', 'Long App '.repeat(20)]]), report([])]} />);
    const count = screen.getByText('· 1 with no app named');
    expect(count.className).toContain('shrink-0');
    expect(count.closest('.truncate')).toBeNull();
  });

  it('carries no verification caveat when no app is named', () => {
    render(<ReportClientText reports={[report([])]} />);
    expect(screen.getByText('No app named')).toHaveAttribute('title', 'No app named');
  });
});
