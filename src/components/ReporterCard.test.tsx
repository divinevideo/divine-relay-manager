// ABOUTME: Reporter cards in an event's related reports show category names,
// ABOUTME: the same labels the reports list uses, in both card layouts

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReporterList } from './ReporterCard';

// The profile lookup is a network read the category badge does not use.
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

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
