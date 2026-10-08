// ABOUTME: Pins what a moderator sees for a reported list: its kind, title,
// ABOUTME: description and size, read from the list event's NIP-51 tags.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { ReportedListCard } from './ReportedListCard';

// Full-length hex, never truncated.
const AUTHOR = 'a'.repeat(64);

function listEvent(kind: number, tags: string[][], content = ''): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: AUTHOR,
    created_at: 1751000000,
    kind,
    tags,
    content,
    sig: 'b'.repeat(128),
  };
}

describe('ReportedListCard', () => {
  it('shows a video list with its title, description and video count', () => {
    render(
      <ReportedListCard
        event={listEvent(30005, [
          ['d', 'faves'],
          ['title', 'Best skate clips'],
          ['description', 'Only the good ones'],
          ['e', '1'.repeat(64)],
          ['a', `34236:${AUTHOR}:clip`],
        ])}
      />,
    );

    expect(screen.getByText('Video List')).toBeInTheDocument();
    expect(screen.getByText('Best skate clips')).toBeInTheDocument();
    expect(screen.getByText('Only the good ones')).toBeInTheDocument();
    expect(screen.getByText('2 videos')).toBeInTheDocument();
  });

  it('shows a people list with its member count', () => {
    render(
      <ReportedListCard
        event={listEvent(30000, [
          ['d', 'crew'],
          ['title', 'Crew'],
          ['p', '1'.repeat(64)],
          ['p', '2'.repeat(64)],
          ['p', '3'.repeat(64)],
        ])}
      />,
    );

    expect(screen.getByText('People List')).toBeInTheDocument();
    expect(screen.getByText('3 people')).toBeInTheDocument();
  });

  it('falls back to the d tag when the list has no title', () => {
    render(<ReportedListCard event={listEvent(30000, [['d', 'untitled-crew']])} />);

    expect(screen.getByText('untitled-crew')).toBeInTheDocument();
    expect(screen.getByText('0 people')).toBeInTheDocument();
  });

  it('falls back to the d tag when the title is only whitespace', () => {
    render(<ReportedListCard event={listEvent(30000, [['d', 'crew'], ['title', '   ']])} />);

    expect(screen.getByText('crew')).toBeInTheDocument();
  });

  it('says the count leaves out private items when the list has encrypted content', () => {
    render(
      <ReportedListCard
        event={listEvent(30005, [['d', 'faves'], ['title', 'Faves']], 'encrypted-payload')}
      />,
    );

    expect(screen.getByText('0 videos')).toBeInTheDocument();
    expect(screen.getByText(/private items not shown/i)).toBeInTheDocument();
  });

  it('does not mention private items for a list with no encrypted content', () => {
    render(<ReportedListCard event={listEvent(30005, [['d', 'faves'], ['title', 'Faves']])} />);

    expect(screen.queryByText(/private items/i)).not.toBeInTheDocument();
  });

  it('says so when the list has no description', () => {
    render(<ReportedListCard event={listEvent(30005, [['d', 'faves'], ['title', 'Faves']])} />);

    expect(screen.getByText('No description')).toBeInTheDocument();
  });
});
