// ABOUTME: Tests that the reporting-app line flags a named app as self-declared,
// ABOUTME: so "Filed via X" is never read as proof the report came from X.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReportClientText } from './ReportClientText';

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
    const line = screen.getByText('Filed via Example App');
    expect(line).toHaveAttribute('title', expect.stringContaining('not verified'));
  });

  it('carries no verification caveat when no app is named', () => {
    render(<ReportClientText reports={[report([])]} />);
    expect(screen.getByText('No app named')).toHaveAttribute('title', 'No app named');
  });
});
