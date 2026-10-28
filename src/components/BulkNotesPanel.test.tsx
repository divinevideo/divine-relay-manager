import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkNotesPanel } from './BulkNotesPanel';
import { ApiError, type BulkNote } from '@/lib/adminApi';

const api = vi.hoisted(() => ({
  moderateMedia: vi.fn(),
  logDecision: vi.fn(),
  getActiveAgeReviewCase: vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api, useApiUrl: () => 'https://api.test' }));
const MOD_PUBKEY = 'e'.repeat(64);
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const ACCOUNT = 'a1'.repeat(32);
const HIDDEN_A = '1'.repeat(64);
const HIDDEN_B = '2'.repeat(64);
const THEIRS = '3'.repeat(64);
const OWNER = 'b2'.repeat(32);
const NOTES: BulkNote[] = [
  { kind: 'still-hidden', sha256: HIDDEN_A },
  { kind: 'still-hidden', sha256: HIDDEN_B },
  { kind: 'not-owned', sha256: THEIRS, owner: OWNER },
];
const CLEARED = { kind: 'age-review' as const, state: 'cleared' as const, at: '2026-10-14T09:30:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.moderateMedia.mockResolvedValue({ success: true });
  api.logDecision.mockResolvedValue(undefined);
  api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: null });
});

function renderPanel(props: Partial<React.ComponentProps<typeof BulkNotesPanel>> = {}) {
  const onDismiss = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BulkNotesPanel pubkey={ACCOUNT} origin={CLEARED} failures={[]} notes={NOTES} onDismiss={onDismiss} {...props} />
    </QueryClientProvider>,
  );
  return { onDismiss, qc };
}

function rowFor(hash: string): HTMLElement {
  return screen.getAllByText(hash)[0].closest('li') as HTMLElement;
}

async function confirmRestore(hash: string) {
  const button = within(rowFor(hash)).getByRole('button', { name: `Restore file ${hash}` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /restore file/i }));
  return dialog;
}

describe('BulkNotesPanel', () => {
  it('lists every note with its full hash, and the owner of another account\'s file in full, opening that account in a new tab', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: /files to check \(3\)/i })).toBeInTheDocument();
    for (const hash of [HIDDEN_A, HIDDEN_B, THEIRS]) expect(screen.getByText(hash)).toBeInTheDocument();
    const owner = within(rowFor(THEIRS)).getByRole('link', { name: OWNER });
    expect(owner).toHaveAttribute('href', `/users/${OWNER}`);
    expect(owner).toHaveAttribute('target', '_blank');
    expect(owner).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('lists failures above the notes, as problems, counting a "+N more" marker as the problems it stands for', () => {
    renderPanel({ failures: [`media:${HIDDEN_A}:Moderation service returned 500`, 'enumeration:x:the list could not be read', '+4 more'] });
    const problems = screen.getByRole('heading', { name: /problems \(6\)/i });
    const files = screen.getByRole('heading', { name: /files to check \(3\)/i });
    expect(problems.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(`File ${HIDDEN_A} could not be changed: Moderation service returned 500.`)).toBeInTheDocument();
    expect(screen.getByText('The list could not be read.')).toBeInTheDocument();
    expect(screen.getByText('4 more problems were not stored.')).toBeInTheDocument();
  });

  it('counts the "not saved" marker as the rows it stands for, like "+N more"', () => {
    renderPanel({ failures: ['enumeration:x:y', `enumeration:${ACCOUNT}:4321 more file(s) or problem(s) from this step were not saved`] });
    expect(screen.getByRole('heading', { name: /problems \(4322\)/i })).toBeInTheDocument();
    expect(screen.getByText('4321 more files or problems from this step were not saved.')).toBeInTheDocument();
  });

  it('says a problem in plain words, with the line as the worker wrote it to hand', () => {
    const raw = `enumeration:${ACCOUNT}:HTTP 500; files were chosen from the relay's list only, so the count of files left as they were may be off`;
    renderPanel({ failures: [raw] });
    const item = screen.getByText("The media server's list of this account's files could not be read (HTTP 500), so its files were chosen from the relay's list only, and the count of files left as they were may be off.").closest('li') as HTMLElement;
    fireEvent.click(within(item).getByText('As recorded'));
    expect(within(item).getByText(raw)).toBeVisible();
  });

  it("words an age-review step's fallback line without a count it does not show", () => {
    const raw = `enumeration:${ACCOUNT}:HTTP 500; files were chosen from the relay's list only`;
    renderPanel({ failures: [raw] });
    expect(screen.getByText("The media server's list of this account's files could not be read (HTTP 500), so its files were chosen from the relay's list only.")).toBeInTheDocument();
    expect(screen.queryByText(/left as they were/)).toBeNull();
  });

  it.each([
    [{ kind: 'job' as const, status: 'done' as const }, /The job finished\./],
    [{ kind: 'job' as const, status: 'failed' as const }, /The job stopped before it finished\./],
    [CLEARED, /When this case was cleared/],
    [{ kind: 'age-review' as const, state: 'restricted_pending_user_response' as const }, /When this case was restricted/],
  ])('says where its entries came from (%o)', (origin, text) => {
    renderPanel({ origin });
    expect(screen.getByRole('region', { name: /results to look at/i })).toHaveTextContent(text);
  });

  it('never names "Un-age-restrict All"', () => {
    renderPanel();
    expect(document.body.textContent).not.toMatch(/un-age-restrict/i);
  });

  it('restores only after a confirm that names the file and says to check why, sending the account with the guarded request', async () => {
    renderPanel();
    const button = within(rowFor(HIDDEN_A)).getByRole('button', { name: `Restore file ${HIDDEN_A}` });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(HIDDEN_A);
    expect(dialog).toHaveTextContent(/this age review, or another decision/i);
    expect(dialog).toHaveTextContent(/check why it was hidden before you restore it/i);
    expect(api.moderateMedia).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /restore file/i }));
    await waitFor(() => expect(api.moderateMedia).toHaveBeenCalledWith(
      HIDDEN_A, 'SAFE', 'Restriction removed by moderator', 'QUARANTINE', ACCOUNT,
    ));
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText('Restored')).toBeInTheDocument();
    expect(within(row).queryByText(/still hidden/i)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
    expect(within(row).getByText('Restored').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'media', targetId: HIDDEN_A, action: 'remove_restriction', moderatorPubkey: MOD_PUBKEY,
    })));
  });

  it('shows a file a restore already made public as Restored, with no Restore', () => {
    renderPanel({ notes: [{ kind: 'still-hidden', sha256: HIDDEN_A, restoredAt: '2026-10-14T10:00:00.000Z' }] });
    const row = rowFor(HIDDEN_A);
    expect(within(row).getByText('Restored')).toBeInTheDocument();
    expect(within(row).queryByText(/still hidden/i)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  // The record can say SAFE while the media server still hides the file: the
  // worker says so, and that file is not restored.
  it.each([
    ['restricted', 'shows this file as hidden'],
    ['banned', 'shows this file as blocked'],
    ['age_restricted', 'shows this file behind the 18+ gate'],
    ['deleted', 'shows this file as deleted'],
  ])('says when the record reads public but the media server has the file %s, without Restore', async (mediaServer, words) => {
    api.moderateMedia.mockRejectedValue(new ApiError('Refusing SAFE', 409, 'Conflict', 'state_mismatch', undefined, 'SAFE', mediaServer));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText(
      `Not restored: the moderation record says public, but the media server ${words}. Check it by hand.`,
    )).toBeInTheDocument();
    expect(within(row).queryByText(/already restored/i)).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('href', `https://api.test/media/${HIDDEN_A}`);
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  // The record still reads hidden, but the media server now blocks, deletes or
  // 18+-gates the file (set in its own admin): the worker refuses the SAFE.
  it.each([
    ['banned', 'shows this file as blocked'],
    ['age_restricted', 'shows this file behind the 18+ gate'],
    ['deleted', 'shows this file as deleted'],
  ])('says when the media server now has the file %s, without Restore', async (mediaServer, words) => {
    api.moderateMedia.mockRejectedValue(new ApiError('Refusing SAFE', 409, 'Conflict', 'media_server_state', undefined, undefined, mediaServer));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText(`Not restored: the media server now ${words}. Check it by hand.`)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('href', `https://api.test/media/${HIDDEN_A}`);
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  it('lets the full hash in the Restore confirm wrap inside the dialog', async () => {
    renderPanel();
    const button = within(rowFor(HIDDEN_A)).getByRole('button', { name: `Restore file ${HIDDEN_A}` });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(new RegExp(HIDDEN_A)).className).toMatch(/overflow-wrap:anywhere/);
  });

  it.each([
    ['restored', () => api.moderateMedia.mockResolvedValue({ success: true }), 'Restored'],
    ['already public', () => api.moderateMedia.mockRejectedValue(new ApiError('x', 409, 'Conflict', 'state_mismatch', undefined, 'SAFE')), 'Already restored.'],
    ['refused for good', () => api.moderateMedia.mockRejectedValue(new ApiError('x', 409, 'Conflict', 'owner_mismatch')), /another account owns this file/],
  ])('moves focus to the row\'s result once a Restore is %s, not to the page', async (_label, arrange, text) => {
    arrange();
    renderPanel();
    await confirmRestore(HIDDEN_A);
    await within(rowFor(HIDDEN_A)).findByText(text);
    await waitFor(() => expect(document.activeElement).toBe(within(rowFor(HIDDEN_A)).getByRole('status')));
  });

  it('refreshes the kept results once a Restore settles, so a reopened panel reads the file as restored', async () => {
    const { qc } = renderPanel();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await confirmRestore(HIDDEN_A);
    await within(rowFor(HIDDEN_A)).findByText('Restored');
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['age-review-bulk-notes'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bulk-job-notes'] });
    });
  });

  // The worker marks the notes on an already-public refusal too, so that
  // refusal refreshes the kept results as a landed restore does.
  it('refreshes the kept results after a refusal because the file is already public', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('x', 409, 'Conflict', 'state_mismatch', undefined, 'SAFE'));
    const { qc } = renderPanel();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await confirmRestore(HIDDEN_A);
    await within(rowFor(HIDDEN_A)).findByText('Already restored.');
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['age-review-bulk-notes'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bulk-job-notes'] });
    });
  });

  it('reads a refusal because the file is already public as "Already restored", not as an error', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('Refusing SAFE', 409, 'Conflict', 'state_mismatch', undefined, 'SAFE'));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const message = await within(rowFor(HIDDEN_A)).findByText('Already restored.');
    expect(message.className).not.toMatch(/red/);
    expect(within(rowFor(HIDDEN_A)).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  it.each([
    ['PERMANENT_BAN', 'Not restored: this file is now blocked. Check it by hand.'],
    ['AGE_RESTRICTED', 'Not restored: this file is now behind the 18+ gate. Check it by hand.'],
    ['UNKNOWN', "Not restored: this file has no moderation record now (it may have been hidden in the media server's own admin). Check it by hand."],
  ])('says in plain words what a changed file is now (%s), with a link to open it and no Restore to retry', async (current, text) => {
    api.moderateMedia.mockRejectedValue(new ApiError('Refusing SAFE', 409, 'Conflict', 'state_mismatch', undefined, current));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText(text)).toBeInTheDocument();
    // The worker would refuse a retry the same way: the file is no longer hidden as the note said.
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('href', `https://api.test/media/${HIDDEN_A}`);
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('target', '_blank');
    // On a phone the link would otherwise break across two lines.
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveClass('whitespace-nowrap');
  });

  // The worker sends these for an outage, and also for answers a retry never
  // changes (the media server has no such file, a key is not bound), so the
  // row offers both: Restore again, and the file to check by hand.
  it.each([
    [new ApiError('x', 503, 'Service Unavailable', 'state_unreadable'),
      "Not restored: the moderation service did not return this file's current state. Try again; if it keeps failing, check it by hand."],
    [new ApiError('x', 503, 'Service Unavailable', 'owner_unreadable'),
      'Not restored: the media server did not say who owns this file. Try again; if it keeps failing, check it by hand.'],
    [new Error('Moderation service error: 503'),
      'Not restored: the request failed (Moderation service error: 503). Try again; if it keeps failing, check it by hand.'],
  ])('says why a restore was refused (%s) and what to do, on that row only, with Restore and the file beside it', async (error, text) => {
    api.moderateMedia.mockRejectedValue(error);
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText(text)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `Restore file ${HIDDEN_A}` })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('href', `https://api.test/media/${HIDDEN_A}`);
    expect(within(rowFor(HIDDEN_B)).queryByText(text)).not.toBeInTheDocument();
  });

  // Only the open-review lookup fails this way, so a retry is the whole answer.
  it('says to try again after the open-review check failed, and keeps Restore without a file link', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('x', 503, 'Service Unavailable', 'age_review_check_failed'));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText('Not restored: this account could not be checked for an open age review. Try again.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `Restore file ${HIDDEN_A}` })).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /open the file/i })).not.toBeInTheDocument();
  });

  // Permanent refusals: a retry would be refused the same way, so the row
  // keeps the message and a way to look at the file, and no Restore.
  it.each([
    [new ApiError('not yours', 409, 'Conflict', 'owner_mismatch'), 'Not restored: another account owns this file. Check it by hand.'],
    [new ApiError('bad', 400, 'Bad Request', 'invalid_pubkey'), 'Not restored: the request was refused as invalid (bad). Check it by hand.'],
    [new ApiError('bad', 400, 'Bad Request', 'invalid_sha256'), 'Not restored: the request was refused as invalid (bad). Check it by hand.'],
  ])('drops Restore after a refusal a retry cannot change (%s), keeping the message and the link', async (error, text) => {
    api.moderateMedia.mockRejectedValue(error);
    renderPanel();
    await confirmRestore(HIDDEN_A);
    const row = rowFor(HIDDEN_A);
    expect(await within(row).findByText(text)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /open the file/i })).toHaveAttribute('href', `https://api.test/media/${HIDDEN_A}`);
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  // The pre-check found no open review, but one opened before the worker
  // looked: the row names and links it, and Restore pauses as the panel's
  // own check would have made it.
  it('names and links the open age review a refusal names, and pauses Restore', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('held', 409, 'Conflict', 'age_review_active', undefined, undefined, undefined, 'case-raced'));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: { id: 'case-raced' } });
    const row = rowFor(HIDDEN_A);
    const link = await within(row).findByRole('link', { name: 'case case-raced' });
    expect(link).toHaveAttribute('href', '/age-review?case=case-raced');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.closest('[role=status]')).toHaveTextContent(
      "Not restored: this account has an open age review (case case-raced). That case handles the account's files; Restore here works once it closes.",
    );
    await waitFor(() => expect(within(rowFor(HIDDEN_B)).getByRole('button', { name: `Restore file ${HIDDEN_B}` })).toBeDisabled());
    expect(within(rowFor(HIDDEN_A)).getByRole('button', { name: `Restore file ${HIDDEN_A}` })).toBeDisabled();
    expect(api.getActiveAgeReviewCase).toHaveBeenCalledTimes(2);
  });

  // The re-read pauses every Restore, the one the dialog handed focus back to
  // included: focus goes to the row's message, whose case link is next.
  it("moves focus to the row's message after a refusal that names an open age review, not to the page", async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('held', 409, 'Conflict', 'age_review_active', undefined, undefined, undefined, 'case-raced'));
    renderPanel();
    await confirmRestore(HIDDEN_A);
    api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: { id: 'case-raced' } });
    await within(rowFor(HIDDEN_A)).findByRole('link', { name: 'case case-raced' });
    await waitFor(() => expect(within(rowFor(HIDDEN_A)).getByRole('button', { name: `Restore file ${HIDDEN_A}` })).toBeDisabled());
    await waitFor(() => expect(document.activeElement).toBe(within(rowFor(HIDDEN_A)).getByRole('status')));
  });

  // The worker marks the notes on an "already restored" refusal, and the
  // re-read brings that mark back: the row still says one thing.
  it('says only "Already restored" when the re-read also marks the file restored', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('x', 409, 'Conflict', 'state_mismatch', undefined, 'SAFE'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const panel = (notes: BulkNote[]) => (
      <QueryClientProvider client={qc}>
        <BulkNotesPanel pubkey={ACCOUNT} origin={CLEARED} failures={[]} notes={notes} onDismiss={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(panel(NOTES));
    await confirmRestore(HIDDEN_A);
    await within(rowFor(HIDDEN_A)).findByText('Already restored.');
    rerender(panel(NOTES.map((note) => (note.sha256 === HIDDEN_A ? { ...note, restoredAt: '2026-10-14T10:00:00.000Z' } : note))));
    const status = within(rowFor(HIDDEN_A)).getByRole('status');
    expect(status).toHaveTextContent(/^Already restored\.$/);
  });

  // A refusal that could be retried, then a mark from elsewhere (another
  // moderator restored it): the row says Restored, and only that.
  it('says only "Restored" when a mark arrives after a refusal that could be retried', async () => {
    api.moderateMedia.mockRejectedValue(new ApiError('x', 503, 'Service Unavailable', 'state_unreadable'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const panel = (notes: BulkNote[]) => (
      <QueryClientProvider client={qc}>
        <BulkNotesPanel pubkey={ACCOUNT} origin={CLEARED} failures={[]} notes={notes} onDismiss={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(panel(NOTES));
    await confirmRestore(HIDDEN_A);
    await within(rowFor(HIDDEN_A)).findByText(/did not return this file's current state/);
    rerender(panel(NOTES.map((note) => (note.sha256 === HIDDEN_A ? { ...note, restoredAt: '2026-10-14T10:00:00.000Z' } : note))));
    expect(within(rowFor(HIDDEN_A)).getByRole('status')).toHaveTextContent(/^\s*Restored$/);
  });

  it('says a problem whose cause the worker names in plain words', () => {
    renderPanel({ failures: [`media:${HIDDEN_A}:status sources disagree (blossom restricted, moderation-service SAFE), left unchanged`] });
    expect(screen.getByText(
      `File ${HIDDEN_A} was left unchanged: the media server shows it as hidden but the moderation record says public.`,
    )).toBeInTheDocument();
  });

  it('names and links the open age review that pauses Restore', async () => {
    api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: { id: 'case-open' } });
    renderPanel();
    const link = await screen.findByRole('link', { name: 'case case-open' });
    expect(link).toHaveAttribute('href', '/age-review?case=case-open');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.closest('p')).toHaveTextContent(
      "This account has an open age review (case case-open). That case handles the account's files; Restore here works once it closes.",
    );
  });

  it.each([
    ['has an open age review', () => api.getActiveAgeReviewCase.mockResolvedValue({ success: true, case: { id: 'case-open' } }),
      /This account has an open age review \(case case-open\)\. That case handles the account's files; Restore here works once it closes\./],
    ['cannot be checked for one', () => api.getActiveAgeReviewCase.mockRejectedValue(new Error('down')),
      /Could not check this account for an open age review, so Restore is unavailable\./],
    // Before the check answers, a Restore could race a review it has not seen.
    ['is still being checked for one', () => api.getActiveAgeReviewCase.mockReturnValue(new Promise(() => {})),
      /^Checking this account for an open age review\.\.\.$/],
  ])('disables Restore, saying why, while the account %s', async (_label, arrange, reason) => {
    arrange();
    renderPanel();
    expect(await screen.findAllByText((_content, element) => element?.tagName === 'P' && reason.test(element.textContent ?? ''))).toHaveLength(1);
    for (const hash of [HIDDEN_A, HIDDEN_B]) {
      expect(within(rowFor(hash)).getByRole('button', { name: `Restore file ${hash}` })).toBeDisabled();
    }
    expect(api.getActiveAgeReviewCase).toHaveBeenCalledWith(ACCOUNT);
  });

  it('does not ask about an open age review when there is nothing to restore', () => {
    renderPanel({ notes: [{ kind: 'not-owned', sha256: THEIRS, owner: OWNER }] });
    expect(api.getActiveAgeReviewCase).not.toHaveBeenCalled();
  });

  it('stays until the moderator dismisses it', () => {
    const { onDismiss } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says the files are loading, with no count yet', () => {
    renderPanel({ notes: [], failures: ['enumeration:x:y'], notesLoading: true });
    expect(screen.getByText(/loading the files to check/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Files to check' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\(0\)/);
  });

  it('shows a load error for the files with a retry, and no count', () => {
    const onRetry = vi.fn();
    renderPanel({ notes: [], failures: ['enumeration:x:y'], notesError: 'HTTP 500: Internal Server Error', onRetry });
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\(0\)/);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
