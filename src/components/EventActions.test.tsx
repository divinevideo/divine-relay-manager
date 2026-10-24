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
const MOD_PUBKEY = 'e'.repeat(64);

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
// Logged-in moderator, so audit writes carry attribution (#178).
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));

beforeEach(() => {
  vi.clearAllMocks();
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

  it('undoes a restricted thumbnail with the video, and a thumbnail failure does not fail the undo', async () => {
    api.moderateMedia.mockImplementation(thumbnailNotFound);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasRestrictedMedia={true}
        mediaHashStatuses={[
          { hash: THUMB, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
          { hash: VIDEO, isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Restriction' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Restriction removed',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    // The video goes first even when the status list names the thumbnail first.
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, THUMB]);
  });

  it('unblocks a blocked thumbnail with the video, and a thumbnail failure does not fail the unblock', async () => {
    api.moderateMedia.mockImplementation(thumbnailNotFound);
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail not changed: not found on the media server',
    }));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, THUMB]);
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
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Age restricted 1 media file(s)' }));
    // The video did change, so the screen refreshes to show it.
    expect(onActionComplete).toHaveBeenCalled();
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'age_restrict_media',
      reason: `Age restricted 1 media file(s); thumbnail not changed: ${workerError(THUMB, 500)}`,
    })));
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
    }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Partially completed' }));
  });

  it.each([
    ['Remove Restriction', 'Restriction removed from video; thumbnail still restricted', { isBlocked: false, isRestricted: true, action: 'AGE_RESTRICTED' }],
    ['Unblock Media', 'Video unblocked; thumbnail still blocked', { isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' }],
  ] as const)('warns in red when %s leaves the thumbnail gated', async (button, title, state) => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={state.isBlocked} hasRestrictedMedia={state.isRestricted}
        mediaHashStatuses={[{ hash: VIDEO, ...state }, { hash: THUMB, ...state }]} />
    );

    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title,
      description: workerError(THUMB, 500),
      variant: 'destructive',
    }));
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

  it('leaves a thumbnail blocked separately when the video is unblocked, and says so', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          // Quarantined by the automated checks, not by this moderator.
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail left blocked: it was blocked separately',
    }));
    expect(api.moderateMedia.mock.calls).toEqual([[VIDEO, 'SAFE', 'Unblocked by moderator']]);
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unblock_media',
      reason: 'Unblocked 1 media file(s); thumbnail left blocked: it was blocked separately',
    })));
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

  it('keeps the left-alone note when another thumbnail fails for real', async () => {
    api.moderateMedia.mockImplementation(failing({ [THUMB]: 500 }));
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB, OTHER_THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: OTHER_THUMB, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Video unblocked; thumbnail still blocked',
      description: `${workerError(THUMB, 500)}; thumbnail left blocked: it was blocked separately`,
      variant: 'destructive',
    }));
  });

  it('undoes a thumbnail that matches any of the video files', async () => {
    const SECOND_VIDEO = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3';
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO, SECOND_VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
          { hash: SECOND_VIDEO, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Media unblocked' }));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO, SECOND_VIDEO, THUMB]);
  });

  it('leaves a permanently blocked thumbnail when a quarantined video is unblocked', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false, action: 'QUARANTINE' },
          { hash: THUMB, isBlocked: true, isRestricted: false, action: 'PERMANENT_BAN' },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Media unblocked',
      description: 'Thumbnail left blocked: it was blocked separately',
    }));
    expect(api.moderateMedia.mock.calls.map((call) => call[0])).toEqual([VIDEO]);
  });

  it('leaves a gated thumbnail alone when undo cannot tell which action gated it', async () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        hasBlockedMedia={true}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: true, isRestricted: false },
          { hash: THUMB, isBlocked: true, isRestricted: false },
        ]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Media' }));

    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledTimes(1));
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

  it('withholds Age Restrict when the video status could not be read, so a block is never weakened', () => {
    renderWithProvider(
      <EventActions eventId="event-1" pubkey={PUBKEY} mediaHashes={[VIDEO]} thumbnailHashes={[THUMB]}
        mediaHashStatuses={[
          { hash: VIDEO, isBlocked: false, isRestricted: false, action: null, unreadable: true },
          { hash: THUMB, isBlocked: false, isRestricted: false, action: null, unreadable: false },
        ]} />
    );

    expect(screen.getByRole('button', { name: 'Age Restrict (status unknown)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Age Restrict \(\d+\)/ })).not.toBeInTheDocument();
    // Blocking is never weaker, so it stays available.
    expect(screen.getByRole('button', { name: 'Block Media (2)' })).toBeEnabled();
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
    // The media server restores a soft-deleted file to whatever status it is sent
    // (divine-blossom handle_admin_moderate_action), so this would serve it again.
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

