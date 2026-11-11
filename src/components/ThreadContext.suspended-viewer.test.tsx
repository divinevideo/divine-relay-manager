// ABOUTME: Pins where the thread panel puts the suspended-content viewer: under the line
// ABOUTME: that says a suspension hides the post or that the cause is unknown, and nowhere else.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadContext } from './ThreadContext';
import type { GoneCause } from '@/lib/goneCause';

const SUSPENDED: GoneCause = { kind: 'suspended', stale: false, line: 'The reported account is suspended.', badge: 'Account Suspended', tone: 'withheld' };
const UNKNOWN: GoneCause = { kind: 'unknown', line: "The reported account is suspended, which hides its posts. Couldn't check whether the event is also banned.", badge: 'Account Suspended', tone: 'unknown' };
const NONE_FOUND: GoneCause = { kind: 'none-found', line: 'Not returned by the relay.', badge: 'Not Found on Relay', tone: 'unknown' };
const DELETED: GoneCause = { kind: 'explained', by: 'delete', line: 'Event has been deleted from the relay', badge: 'Removed by Moderation', tone: 'removal' };

function renderGone(goneCause: GoneCause) {
  return render(
    <ThreadContext
      ancestors={[]}
      reportedEvent={null}
      isEventDeleted
      isUserBanned={false}
      goneCause={goneCause}
      suspendedViewer={<div>viewer slot</div>}
    />,
  );
}

describe('ThreadContext suspended viewer slot', () => {
  it('renders the viewer under the suspended line', () => {
    renderGone(SUSPENDED);

    expect(screen.getByText('The reported account is suspended.')).toBeInTheDocument();
    expect(screen.getByText('viewer slot')).toBeInTheDocument();
  });

  // ReportDetail passes the viewer for this cause only when the suspension is
  // confirmed and a ban could not be checked.
  it('renders the viewer under the unknown-cause line', () => {
    renderGone(UNKNOWN);

    expect(screen.getByText(/Couldn't check whether the event is also banned/)).toBeInTheDocument();
    expect(screen.getByText('viewer slot')).toBeInTheDocument();
  });

  it.each([['none-found', NONE_FOUND], ['explained', DELETED]] as const)('leaves it out for a %s cause', (_kind, cause) => {
    renderGone(cause);

    expect(screen.queryByText('viewer slot')).not.toBeInTheDocument();
  });
});
