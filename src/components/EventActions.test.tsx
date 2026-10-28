import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventActions } from './EventActions';

// Stable mocks so failure-path tests can control the audit log and assert on toasts.
const api = vi.hoisted(() => ({
  hideEvent: vi.fn(),
  restoreEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moderateMedia: vi.fn(),
  deleteMedia: vi.fn(),
  callRelayRpc: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
// What useToast reports on screen; empty unless a test puts a toast there.
const toastsOnScreen = vi.hoisted(() => ({ value: [] as Array<{ id: string; open: boolean }> }));
const MOD_PUBKEY = 'e'.repeat(64);

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast, toasts: toastsOnScreen.value }),
  getToasts: () => toastsOnScreen.value,
}));
// Logged-in moderator, so audit writes carry attribution (#178).
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  toastsOnScreen.value = [];
  api.hideEvent.mockResolvedValue({ success: true, recorded: true });
  api.restoreEvent.mockResolvedValue({ success: true, recorded: true, reconciled: true });
  api.deleteEvent.mockResolvedValue({ success: true });
  api.moderateMedia.mockResolvedValue({ success: true });
  api.deleteMedia.mockResolvedValue({ success: true });
  api.logDecision.mockResolvedValue(undefined);
});

function renderWithProvider(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

describe('EventActions', () => {
  it('renders ban and delete buttons for events without media', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} />
    );
    expect(screen.getByRole('button', { name: /Ban Event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Event/i })).toBeInTheDocument();
    expect(screen.queryByText(/Block Media/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete Media/i)).not.toBeInTheDocument();
  });

  it('renders media actions when mediaHashes provided', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc123']} />
    );
    expect(screen.getByRole('button', { name: /Block Media/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Age Restrict/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Media/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Event & Media/i })).toBeInTheDocument();
  });

  it('renders restore button when event is banned', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} isEventBanned={true} />
    );
    expect(screen.getByRole('button', { name: /Restore Event/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ban Event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Event$/i })).not.toBeInTheDocument();
  });

  it('routes restore through the recorded moderation endpoint', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} isEventBanned={true} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Restore Event/i }));

    await waitFor(() => expect(api.restoreEvent).toHaveBeenCalledWith(
      'event-1',
      MOD_PUBKEY,
      'Restored by moderator',
    ));
    expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'restore_event' }));
  });

  it('renders unblock when media is blocked', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc']} hasBlockedMedia={true} />
    );
    expect(screen.getByRole('button', { name: /Unblock Media/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Block Media/i })).not.toBeInTheDocument();
  });

  it('renders remove restriction when media is restricted', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={'a'.repeat(64)} mediaHashes={['abc']} hasRestrictedMedia={true} />
    );
    expect(screen.getByRole('button', { name: /Remove Restriction/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Age Restrict/i })).not.toBeInTheDocument();
  });

  it('reports success on Ban Event even when the audit-log write fails', async () => {
    // Regression: logDecision used to be awaited in the mutation, so a failed
    // /api/decisions write made a SUCCEEDED banevent report "Failed to ban event".
    // Audit is now fire-and-forget, so the ban reports success regardless.
    api.logDecision.mockRejectedValue(new Error('audit down'));
    renderWithProvider(<EventActions eventId="event-1" pubkey={'a'.repeat(64)} />);

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(api.hideEvent).toHaveBeenCalledWith('event-1', 'Banned by moderator'));
    // #178: the audit write is attributed to the logged-in moderator.
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ moderatorPubkey: MOD_PUBKEY })),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Event banned from relay' })),
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to ban event' }),
    );
    // and the audit failure surfaces as a non-blocking toast, not an action failure
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/audit log not recorded/i) })),
    );
  });

  it('warns when Ban Event lands at the relay but its review state is not recorded', async () => {
    api.hideEvent.mockResolvedValue({ success: true, recorded: false });
    renderWithProvider(<EventActions eventId="event-1" pubkey={'a'.repeat(64)} />);

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Event banned; review state not recorded',
      variant: 'destructive',
    })));
  });

  it('does not fire-and-forget when the audit write never settles — ban still reports success', async () => {
    // A hung /api/decisions write must not stall or fail the action.
    api.logDecision.mockReturnValue(new Promise(() => {})); // never settles
    renderWithProvider(<EventActions eventId="event-1" pubkey={'a'.repeat(64)} />);

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Event banned from relay' })),
    );
    expect(api.hideEvent).toHaveBeenCalledTimes(1);
  });
});

describe('EventActions: a video thumbnail never breaks the video action', () => {
  // Full-length 64-char hex hashes, never truncated.
  const VIDEO = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
  const THUMB = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';
  const PUBKEY = 'a'.repeat(64);

  // #66: a thumbnail the media server has no record of answers "not found", and
  // used to fail the whole button.
  const thumbnailNotFound = (hash: string) =>
    hash === THUMB ? Promise.reject(new Error('Blob not found')) : Promise.resolve({ success: true });

  // What the moderator's screen receives when the media server refuses a file:
  // the worker wraps the moderation service's 502 (worker/src/index.ts), which
  // wraps the media server's own reply (blossomFailureResponse, notifyBlossom).
  // A 404 body is the media server's "Blob not found" (handle_admin_moderate).
  const workerError = (status: number) => {
    const mediaServer = status === 404
      ? JSON.stringify({ success: false, sha256: THUMB, error: 'Blob not found' })
      : 'upstream timeout';
    return `Moderation service error: 502 - ${JSON.stringify({
      success: false,
      sha256: THUMB,
      action: 'AGE_RESTRICTED',
      blossom_notified: false,
      error: `Moderation recorded but media server did not confirm: HTTP ${status}: ${mediaServer}`,
    })}`;
  };

  it('acts on the video first, then the thumbnail, and counts both', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(2));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, THUMB]);
    expect(api.moderateMedia).toHaveBeenCalledWith(THUMB, 'AGE_RESTRICTED', 'Age restricted by moderator');
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Age restricted 2 media file(s)' }));
  });

  it('still reports Age Restrict done and logs it when the thumbnail fails', async () => {
    api.moderateMedia.mockImplementation(thumbnailNotFound);
    const onActionComplete = vi.fn();
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        onActionComplete={onActionComplete} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Age restricted 1 media file(s)',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to age restrict' }));
    expect(onActionComplete).toHaveBeenCalled();
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'age_restrict_media',
      reason: 'Age restricted 1 media file(s); thumbnail not changed: Blob not found',
    })));
  });

  it('fails as before when the video itself fails, without touching the thumbnail', async () => {
    api.moderateMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to age restrict',
      description: 'moderation down',
    })));
    expect(api.moderateMedia).toHaveBeenCalledTimes(1);
    expect(api.moderateMedia).toHaveBeenCalledWith(VIDEO, 'AGE_RESTRICTED', 'Age restricted by moderator');
  });

  it('still reports Block Media done when the thumbnail fails', async () => {
    api.moderateMedia.mockImplementation(thumbnailNotFound);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Block Media (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Blocked 1 media file(s)',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, THUMB]);
  });

  it('still reports Delete Media done when the thumbnail fails', async () => {
    api.deleteMedia.mockImplementation(thumbnailNotFound);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Media (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Deleted 1 media file(s)',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(api.deleteMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, THUMB]);
  });

  it('does not call a thumbnail failure a partial Delete Event & Media', async () => {
    api.deleteMedia.mockImplementation(thumbnailNotFound);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Event and media permanently deleted',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Partially completed' }));
  });

  it('removes the restriction from the video only, and offers the thumbnail its own button', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Remove thumbnail restriction (1)' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Restriction' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Restriction removed',
      description: 'Thumbnail left restricted',
    }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Restriction removed by moderator']]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'remove_restriction',
      reason: 'Removed restriction from 1 media file(s); thumbnail left restricted',
    })));
    expect(api.logDecision).toHaveBeenCalledTimes(1);
  });

  it('unblocks the video only, and offers the thumbnail its own button', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Unblock thumbnail (1)' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail left blocked',
    }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Unblocked by moderator']]);
  });

  it.each([
    ['Unblock thumbnail (1)', { isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
      'Unblocked by moderator', 'Thumbnail unblocked', 'unblock_media', 'Unblocked 1 thumbnail(s)'],
    ['Remove thumbnail restriction (1)', { isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
      'Restriction removed by moderator', 'Restriction removed from thumbnail', 'remove_restriction', 'Removed restriction from 1 thumbnail(s)'],
  ] as const)('%s lifts the thumbnail alone, once a person asks', async (button, state, apiReason, title, action, reason) => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, ...state },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title }));
    expect(api.moderateMedia.mock.calls).toEqual([[THUMB, 'SAFE', apiReason]]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action, reason })));
    expect(api.logDecision).toHaveBeenCalledTimes(1);
  });

  it('fails a thumbnail undo out loud, since the thumbnail is the whole action', async () => {
    api.moderateMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock thumbnail (1)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Failed to unblock thumbnail',
      description: 'moderation down',
      variant: 'destructive',
    }));
  });

  it('records the thumbnails it lifted when a later one fails, and says so', async () => {
    const SECOND_THUMB = 'c3d0f1a2b4e5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9';
    api.moderateMedia.mockImplementation((hash: string) =>
      hash === SECOND_THUMB ? Promise.reject(new Error('moderation down')) : Promise.resolve({ success: true }));
    const onActionComplete = vi.fn();
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, SECOND_THUMB]}
        onActionComplete={onActionComplete}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock thumbnail (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Failed to unblock thumbnail',
      description: '1 of 2 lifted, then: moderation down',
      variant: 'destructive',
      duration: 10000,
    }));
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unblock_media',
      reason: 'Unblocked 1 thumbnail(s); 1 of 2 lifted, then: moderation down',
    })));
    expect(api.logDecision).toHaveBeenCalledTimes(1);
    // Something changed, so the screen checks the media status again.
    expect(onActionComplete).toHaveBeenCalled();
  });

  it('adds a failed audit write to the partial-undo warning instead of replacing it', async () => {
    const SECOND_THUMB = 'c3d0f1a2b4e5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9';
    api.moderateMedia.mockImplementation((hash: string) =>
      hash === SECOND_THUMB ? Promise.reject(new Error('moderation down')) : Promise.resolve({ success: true }));
    api.logDecision.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('audit down')), 20)));
    toastsOnScreen.value = [{ id: 'partial-toast', open: true }];
    const shown = { id: 'partial-toast', update: vi.fn(), dismiss: vi.fn() };
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, SECOND_THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock thumbnail (2)' }));

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith({
      id: 'partial-toast',
      title: 'Failed to unblock thumbnail',
      description: '1 of 2 lifted, then: moderation down; audit log not recorded',
      variant: 'destructive',
      duration: 10000,
    }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('records the video files it lifted when a later one fails, and says so', async () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    api.moderateMedia.mockImplementation((hash: string) =>
      hash === SECOND_VIDEO ? Promise.reject(new Error('moderation down')) : Promise.resolve({ success: true }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: SECOND_VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Restriction' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Failed to remove restriction',
      description: '1 of 2 lifted, then: moderation down',
      variant: 'destructive',
      duration: 10000,
    }));
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'remove_restriction',
      reason: 'Removed restriction from 1 media file(s); 1 of 2 lifted, then: moderation down',
    })));
    expect(api.logDecision).toHaveBeenCalledTimes(1);
  });

  it('leaves a thumbnail that was 18+ on its own blocked when the video it was blocked with is unblocked', async () => {
    // Block overwrites the thumbnail's 18+ gate, and its stored action then matches
    // the video's, so only a person can tell the two apart.
    const statuses = (video: string, thumb: string) => [
      { hash: VIDEO, isBlocked: video === 'PERMANENT_BAN', isRestricted: false, action: video },
      { hash: THUMB, isBlocked: thumb === 'PERMANENT_BAN', isRestricted: thumb === 'AGE_RESTRICTED', action: thumb },
    ];
    const ui = (video: string, thumb: string) => (
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
            hasBlockedMedia={video === 'PERMANENT_BAN'} mediaHashStatuses={statuses(video, thumb)} />
        </TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui('SAFE', 'AGE_RESTRICTED'));

    fireEvent.click(screen.getByRole('button', { name: 'Block Media (2)' }));
    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(2));

    // The status check answers again after the action.
    rerender(ui('PERMANENT_BAN', 'PERMANENT_BAN'));
    api.moderateMedia.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(1));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Unblocked by moderator']]);
  });

  it('reports the thumbnail failure in the words the worker sends', async () => {
    api.moderateMedia.mockImplementation((hash: string) =>
      hash === THUMB ? Promise.reject(new Error(workerError(404))) : Promise.resolve({ success: true }));
    const wrapped = workerError(404);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Age restricted 1 media file(s)',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    // The audit log keeps the full text.
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: `Age restricted 1 media file(s); thumbnail not changed: ${wrapped}`,
    })));
  });

  it('fails Remove Restriction as before when the video fails, without touching the thumbnail', async () => {
    api.moderateMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Restriction' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to remove restriction',
      description: 'moderation down',
    })));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO]);
  });
});

describe('EventActions: a thumbnail left open is a warning, and can be redone', () => {
  // Full-length 64-char hex hashes, never truncated.
  const VIDEO = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
  const THUMB = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';
  const OTHER_THUMB = 'c3d0f1a2b4e5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9';
  const PUBKEY = 'a'.repeat(64);

  // Same shape as the worker's error text, as in the block above.
  const workerError = (hash: string, status: number) => {
    const mediaServer = status === 404
      ? JSON.stringify({ success: false, sha256: hash, error: 'Blob not found' })
      : 'upstream timeout';
    return `Moderation service error: 502 - ${JSON.stringify({
      success: false,
      sha256: hash,
      action: 'AGE_RESTRICTED',
      blossom_notified: false,
      error: `Moderation recorded but media server did not confirm: HTTP ${status}: ${mediaServer}`,
    })}`;
  };
  const failing = (byHash: Record<string, number>) => (hash: string) =>
    byHash[hash] ? Promise.reject(new Error(workerError(hash, byHash[hash]))) : Promise.resolve({ success: true });

  it('warns in red when Age Restrict leaves the thumbnail open for any reason but not found', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    const onActionComplete = vi.fn();
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        onActionComplete={onActionComplete} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Video age restricted; thumbnail NOT age restricted',
      description: workerError(THUMB, 500),
      variant: 'destructive',
      duration: 10000,
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Age restricted 1 media file(s)' }));
    // The video did change, so the screen refreshes to show it.
    expect(onActionComplete).toHaveBeenCalled();
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'age_restrict_media',
      reason: `Age restricted 1 media file(s); thumbnail not changed: ${workerError(THUMB, 500)}`,
    })));
  });

  // One toast shows at a time (TOAST_LIMIT is 1), and the audit write settles
  // after the action's own toast, so a failure toast of its own would replace the
  // warning. While the warning is open, it is added to the warning instead.
  const slowAuditFailure = () => new Promise((_, reject) => setTimeout(() => reject(new Error('audit down')), 20));
  const warningHandle = (open = true) => {
    toastsOnScreen.value = [{ id: 'warning-toast', open }];
    return { id: 'warning-toast', update: vi.fn(), dismiss: vi.fn() };
  };

  it('adds a failed audit write to the warning instead of replacing it', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    api.logDecision.mockImplementation(slowAuditFailure);
    const shown = warningHandle();
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith({
      id: 'warning-toast',
      title: 'Video age restricted; thumbnail NOT age restricted',
      description: `${workerError(THUMB, 500)}; audit log not recorded`,
      variant: 'destructive',
      duration: 10000,
    }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  // An audit failure the test releases once the screen has moved on.
  const heldAuditFailure = () => {
    let release = () => {};
    const write = () => new Promise((_, reject) => { release = () => reject(new Error('audit down')); });
    return { write, release: () => release() };
  };
  const tree = (qc: QueryClient) => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
      </TooltipProvider>
    </QueryClientProvider>
  );

  it('reads the toasts on screen when the audit write fails, not as they were at the action', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    const audit = heldAuditFailure();
    api.logDecision.mockImplementation(audit.write);
    const shown = { id: 'warning-toast', update: vi.fn(), dismiss: vi.fn() };
    toast.mockReturnValueOnce(shown);
    const qc = new QueryClient();
    const { rerender } = render(tree(qc));

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    // The warning reaches the screen after the action rendered.
    toastsOnScreen.value = [{ id: 'warning-toast', open: true }];
    rerender(tree(qc));
    audit.release();

    await waitFor(() => expect(shown.update).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('still adds a failed audit write to the warning after the screen that showed it is gone', async () => {
    // The moderator moved on to another report, but the warning is still up.
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    const audit = heldAuditFailure();
    api.logDecision.mockImplementation(audit.write);
    const shown = warningHandle();
    toast.mockReturnValueOnce(shown);
    const { unmount } = render(tree(new QueryClient()));

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    unmount();
    audit.release();

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith(expect.objectContaining({
      description: `${workerError(THUMB, 500)}; audit log not recorded`,
    })));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('puts an audit failure that lands before the toast shows on that toast', async () => {
    // The combined delete's first audit write goes out before the media deletes.
    api.logDecision.mockRejectedValue(new Error('audit down'));
    api.deleteMedia.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 30)));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Event and media permanently deleted',
      description: 'Audit log not recorded',
    }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("adds a failed audit write to a partial Delete Event & Media's warning", async () => {
    api.deleteMedia.mockRejectedValue(new Error('moderation down'));
    api.logDecision.mockImplementation(slowAuditFailure);
    const shown = { id: 'partial-toast', update: vi.fn(), dismiss: vi.fn() };
    toastsOnScreen.value = [{ id: 'partial-toast', open: true }];
    toast.mockReturnValueOnce(shown);
    const onActionComplete = vi.fn();
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        onActionComplete={onActionComplete} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Partially completed',
      variant: 'destructive',
      description: expect.stringMatching(/; audit log not recorded$/),
    })));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(onActionComplete).toHaveBeenCalled();
  });

  it('reports a failed audit write on its own once the warning is closed', async () => {
    // The moderator has read and closed it, or a later toast replaced it, so it
    // is not brought back.
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    api.logDecision.mockImplementation(slowAuditFailure);
    const shown = warningHandle(false);
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: 'Action applied; audit log not recorded' }));
    expect(shown.update).not.toHaveBeenCalled();
  });

  it('reports a failed audit write on its own once a later toast replaced the warning', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    api.logDecision.mockImplementation(slowAuditFailure);
    const shown = { id: 'warning-toast', update: vi.fn(), dismiss: vi.fn() };
    toastsOnScreen.value = [{ id: 'later-toast', open: true }];
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: 'Action applied; audit log not recorded' }));
    expect(shown.update).not.toHaveBeenCalled();
  });

  it("adds the combined delete's first audit failure to its warning too", async () => {
    // The event's own audit write starts before the media is deleted, so it can
    // settle after the warning.
    api.deleteMedia.mockImplementation(failing({ [THUMB]: 500 }));
    api.logDecision.mockImplementation((params: { action: string }) =>
      params.action === 'delete_event' ? slowAuditFailure() : Promise.resolve());
    const shown = warningHandle();
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Event and video deleted; thumbnail NOT deleted',
      description: expect.stringMatching(/; audit log not recorded$/),
    })));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('still reports a failed audit write after a plain success', async () => {
    api.logDecision.mockImplementation(slowAuditFailure);
    // The success toast is still open: only a warning takes the failure in place.
    const shown = warningHandle();
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: 'Action applied; audit log not recorded' }));
    expect(shown.update).not.toHaveBeenCalled();
  });

  it('keeps a not-found thumbnail a quiet note, in the real worker wording', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 404 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Age restricted 1 media file(s)',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('warns when one of two thumbnails fails for real, even if the other was only not found', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 404, [OTHER_THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (3)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Video age restricted; thumbnail NOT age restricted',
      variant: 'destructive',
      duration: 10000,
    })));
  });

  it('counts the thumbnails left open when more than one fails for real', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500, [OTHER_THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (3)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Video age restricted; 2 thumbnails NOT age restricted',
      variant: 'destructive',
      duration: 10000,
    })));
  });

  it.each([
    ['Block Media (2)', 'Video blocked; thumbnail NOT blocked', 'moderateMedia', false],
    ['Delete Media (2)', 'Video deleted; thumbnail NOT deleted', 'deleteMedia', true],
    ['Delete Event & Media', 'Event and video deleted; thumbnail NOT deleted', 'deleteMedia', true],
  ] as const)('warns in red when %s leaves the thumbnail', async (button, title, call, confirm) => {
    api[call].mockImplementation(failing({ [THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: button }));
    if (confirm) fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title,
      description: workerError(THUMB, 500),
      variant: 'destructive',
      duration: 10000,
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Partially completed' }));
  });

  it.each([
    ['Block Media (2)', 'Video blocked; thumbnail NOT blocked', 'moderateMedia', false, 1],
    ['Delete Media (2)', 'Video deleted; thumbnail NOT deleted', 'deleteMedia', true, 1],
    ['Delete Event & Media', 'Event and video deleted; thumbnail NOT deleted', 'deleteMedia', true, 2],
  ] as const)('adds a failed audit write to the warning %s shows', async (button, title, call, confirm, writes) => {
    api[call].mockImplementation(failing({ [THUMB]: 500 }));
    api.logDecision.mockImplementation(slowAuditFailure);
    const shown = warningHandle();
    toast.mockReturnValueOnce(shown);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: button }));
    if (confirm) fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(shown.update).toHaveBeenCalledWith({
      id: 'warning-toast',
      title,
      description: `${workerError(THUMB, 500)}; audit log not recorded`,
      variant: 'destructive',
      duration: 10000,
    }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(api.logDecision).toHaveBeenCalledTimes(writes);
  });

  it('offers Age Restrict again on a restricted video with a thumbnail, and it reaches the thumbnail', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: THUMB, isBlocked: false, isRestricted: false },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Remove Restriction' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Age Restrict (2)' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict again (2)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(2));
    expect(api.moderateMedia.mock.calls).toEqual([
      [VIDEO, 'AGE_RESTRICTED', 'Age restricted by moderator'],
      [THUMB, 'AGE_RESTRICTED', 'Age restricted by moderator'],
    ]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Age restricted 2 media file(s)' }));
  });

  it('offers Block again on a blocked video with a thumbnail, and never Age Restrict again', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true} hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    // A blocked video must never be offered something weaker.
    expect(screen.queryByRole('button', { name: /Age Restrict again/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Block again (2)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(2));
    expect(api.moderateMedia.mock.calls).toEqual([
      [VIDEO, 'PERMANENT_BAN', 'Blocked by moderator'],
      [THUMB, 'PERMANENT_BAN', 'Blocked by moderator'],
    ]);
  });

  it('offers no Block again on a video age review hid, so a hide never becomes a permanent ban', () => {
    // Age review un-hides on clear only what is hidden (worker/src/bulk-moderate.ts
    // MAY_CHANGE_FROM.SAFE), so a ban sent here would outlive the case.
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Unblock Media' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
  });

  it('offers Block again when one video file is blocked and another is open, and it reaches both', async () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_VIDEO, isBlocked: false, isRestricted: false, action: null },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Block again (3)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(3));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, SECOND_VIDEO, THUMB]);
  });

  it.each([
    ['deleted', { isBlocked: false, isRestricted: false, action: 'DELETE' }],
    ['unreadable', { isBlocked: false, isRestricted: false, action: null, unreadable: true }],
  ] as const)('offers no Block again when another video file is %s', (_, state) => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_VIDEO, ...state },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
  });

  it('offers no Block again when another video file has no status yet', () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
  });

  it('offers no Block again when another video file is an age-review hide', () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_VIDEO, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
  });

  it('offers no Age Restrict again when the only thumbnail is already blocked', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Age Restrict again/ })).not.toBeInTheDocument();
  });

  it('holds every media button until the status check answers, so a blocked file cannot read as open', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaStatusLoading={true} />
    );

    for (const name of ['Block Media (2)', 'Age Restrict (2)', 'Delete Media (2)', 'Delete Event & Media']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    // The event's own buttons do not depend on media status.
    expect(screen.getByRole('button', { name: 'Ban Event' })).toBeEnabled();
  });

  it('holds the undo and again buttons too until the status check answers', () => {
    const { unmount } = renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true} mediaStatusLoading={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: THUMB, isBlocked: false, isRestricted: false },
        ]} />
    );
    expect(screen.getByRole('button', { name: 'Remove Restriction' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Age Restrict again (2)' })).toBeDisabled();
    unmount();

    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true} mediaStatusLoading={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: false },
        ]} />
    );
    expect(screen.getByRole('button', { name: 'Unblock Media' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Block again (2)' })).toBeDisabled();
  });

  it("holds the thumbnail's own undo buttons until the status check answers", () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        mediaStatusLoading={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: OTHER_THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Unblock thumbnail (1)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove thumbnail restriction (1)' })).toBeDisabled();
  });

  it('fails Unblock Media as before when the video fails, without touching the thumbnail', async () => {
    api.moderateMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to unblock media',
      description: 'moderation down',
    })));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO]);
  });

  it('reports a partial Delete Event & Media when the video fails, without touching the thumbnail', async () => {
    api.deleteMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Partially completed',
      variant: 'destructive',
    })));
    expect(api.deleteMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO]);
  });

  it('offers no one-click lift for a thumbnail the automated checks hid, and says it stayed blocked', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          // Quarantined by the automated checks, not by a moderator on this screen.
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Unblock thumbnail/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail left blocked',
    }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Unblocked by moderator']]);
  });

  it('offers the thumbnail button only for the thumbnails this screen gates, and lifts only those', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: OTHER_THUMB, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock thumbnail (1)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(1));
    expect(api.moderateMedia.mock.calls).toEqual([[THUMB, 'SAFE', 'Unblocked by moderator']]);
  });

  it('removes the restriction from the restricted thumbnail only, never a blocked one', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: OTHER_THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove thumbnail restriction (1)' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(1));
    expect(api.moderateMedia.mock.calls).toEqual([[THUMB, 'SAFE', 'Restriction removed by moderator']]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledTimes(1));
  });

  it('removes the restriction only from the restricted video file, never a blocked one', async () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]}
        hasRestrictedMedia={true} hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: SECOND_VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Restriction' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(1));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Restriction removed by moderator']]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledTimes(1));
  });

  it('offers no Block again on a video that is not blocked', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'SAFE' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Block Media (2)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
  });

  it('offers no Block again when the only thumbnail was deleted, and counts only what it blocks', () => {
    const { unmount } = renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: 'DELETE' },
        ]} />
    );
    expect(screen.queryByRole('button', { name: /Block again/ })).not.toBeInTheDocument();
    unmount();

    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: 'DELETE' },
          { hash: OTHER_THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );
    expect(screen.getByRole('button', { name: 'Block again (2)' })).toBeInTheDocument();
  });

  it('offers a deleted video no Block or Age Restrict, which would restore it', () => {
    // Any status but DELETE moves a deleted file out of Deleted on the media server
    // (divine-blossom handle_admin_moderate), so any status here would bring it back.
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: 'DELETE' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Block Media (deleted)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Age Restrict (deleted)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^(Block Media|Age Restrict) \(\d+\)/ })).not.toBeInTheDocument();
    // Deleting again changes nothing the media server would serve.
    expect(screen.getByRole('button', { name: 'Delete Media (2)' })).toBeEnabled();
  });

  it('offers no Age Restrict again when one of the video files was deleted', () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: SECOND_VIDEO, isBlocked: false, isRestricted: false, action: 'DELETE' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Age Restrict again/ })).not.toBeInTheDocument();
  });

  it('never blocks a thumbnail that was deleted', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: 'DELETE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Block Media (1)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Blocked 1 media file(s)' }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'PERMANENT_BAN', 'Blocked by moderator']]);
  });

  it('leaves a thumbnail whose status could not be read when the video is unblocked', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null, unreadable: true },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail skipped: its status could not be read',
    }));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO]);
  });

  it('offers no Age Restrict again when another of the video files could not be read', () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          // Might be blocked: re-sending Age Restrict to it could weaken it.
          { hash: SECOND_VIDEO, isBlocked: false, isRestricted: false, action: null, unreadable: true },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Age Restrict again/ })).not.toBeInTheDocument();
  });

  it('withholds Block and Age Restrict when the video status could not be read', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: null, unreadable: true },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null, unreadable: false },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Age Restrict (status unknown)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Age Restrict \(\d+\)/ })).not.toBeInTheDocument();
    // An unknown video may be an age-review hide, which a block would outlast,
    // or deleted, which a block would bring back. So Block waits too.
    expect(screen.getByRole('button', { name: 'Block Media (status unknown)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Block Media \(\d+\)/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Media (2)' })).toBeEnabled();
  });

  it('offers no thumbnail lift while a video is hidden, so a thumbnail never opens under an age-review hide', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: OTHER_THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Unblock Media' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unblock thumbnail/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove thumbnail restriction/ })).not.toBeInTheDocument();
  });

  it('offers no thumbnail lift while a video status could not be read, since the video may be hidden', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: null, unreadable: true },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    expect(screen.queryByRole('button', { name: /Unblock thumbnail/ })).not.toBeInTheDocument();
  });

  it('keeps the partial-failure warnings up for 10 seconds too', async () => {
    api.deleteMedia.mockRejectedValue(new Error('moderation down'));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Event & Media' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Partially completed',
      duration: 10000,
    })));
  });

  it('keeps a red thumbnail warning up for 10 seconds', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Video age restricted; thumbnail NOT age restricted',
      variant: 'destructive',
      duration: 10000,
    })));
  });

  it('skips a thumbnail whose status could not be read when age restricting, and warns it may be open', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: null, unreadable: false },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null, unreadable: true },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (1)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Video age restricted; thumbnail NOT age restricted',
      description: 'Thumbnail skipped: its status could not be read',
      variant: 'destructive',
      duration: 10000,
    }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'AGE_RESTRICTED', 'Age restricted by moderator']]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'Age restricted 1 media file(s); thumbnail skipped: its status could not be read',
    })));
  });

  it('counts an unreadable thumbnail with one that failed for real', async () => {
    api.moderateMedia.mockImplementation(failing({ [OTHER_THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: null },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null, unreadable: true },
          { hash: OTHER_THUMB, isBlocked: false, isRestricted: false, action: null },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (2)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Video age restricted; 2 thumbnails NOT age restricted',
      description: `${workerError(OTHER_THUMB, 500)}; thumbnail skipped: its status could not be read`,
      variant: 'destructive',
      duration: 10000,
    }));
  });

  it('says it is checking while the media buttons wait for the status check', () => {
    const { unmount } = renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} mediaStatusLoading={true} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Checking media status…');
    unmount();

    renderWithProvider(<EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} />);
    expect(screen.queryByText('Checking media status…')).not.toBeInTheDocument();
  });

  it('shows no again button on a video without its own thumbnail', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]}
        hasRestrictedMedia={true} hasBlockedMedia={false}
        mediaHashStatuses={[{ hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' }]} />
    );

    expect(screen.queryByRole('button', { name: /again/ })).not.toBeInTheDocument();
  });

  it('never age restricts a thumbnail that is already blocked', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    // The count says what it will touch.
    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (1)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Age restricted 1 media file(s)' }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'AGE_RESTRICTED', 'Age restricted by moderator']]);
  });

  it('never age restricts a thumbnail that was deleted', async () => {
    // Any status but DELETE moves a deleted file out of Deleted on the media server
    // (divine-blossom handle_admin_moderate), so this would bring it back.
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: 'DELETE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Age Restrict (1)' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Age restricted 1 media file(s)' }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'AGE_RESTRICTED', 'Age restricted by moderator']]);
  });
});

