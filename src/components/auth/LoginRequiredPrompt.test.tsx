// ABOUTME: When the worker refuses a write for want of a Divine login, the app
// ABOUTME: says so once, app-wide, and offers sign-in. The moderator retries the action.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { moderateAction } from '@/lib/adminApi';
import { useDivineSession } from '@/hooks/useDivineSession';
import { announceModeratorLoginRequired } from '@/lib/moderatorLoginRequired';
import { LoginRequiredPrompt } from './LoginRequiredPrompt';

const session = vi.hoisted(() => ({
  getSession: vi.fn(),
  startLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({
  getSession: session.getSession,
  startLogin: session.startLogin,
  logout: session.logout,
  acceptSignOutFromOtherTab: vi.fn(() => false),
  completeLogin: vi.fn(),
  DIVINE_LOGIN_SERVER_URL: 'https://login.example.test',
  DIVINE_LOGIN_CLIENT_ID: 'divine-relay-admin',
}));

const getPublicKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: class {
    getPublicKey = getPublicKey;
    signEvent = vi.fn();
    getRelays = vi.fn();
  },
}));

const MESSAGE = 'You need to be signed in with Divine to do this.';

function Settled() {
  const { isResolving, pubkey } = useDivineSession();
  return <div data-testid='state'>{isResolving ? 'resolving' : `settled:${!!pubkey}`}</div>;
}

function renderPrompt() {
  return render(
    <DivineSessionProvider>
      <LoginRequiredPrompt />
      <Settled />
    </DivineSessionProvider>,
  );
}

const refuseAWrite = () => act(() => announceModeratorLoginRequired());

// Lets the session settle first, so its own updates land before the test acts.
async function renderSettled() {
  renderPrompt();
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
}

beforeEach(() => {
  session.getSession.mockReset();
  session.getSession.mockResolvedValue(null);
  session.startLogin.mockReset();
  session.startLogin.mockResolvedValue(undefined);
  getPublicKey.mockReset();
});

describe('LoginRequiredPrompt', () => {
  it('stays hidden until a write is refused', async () => {
    renderPrompt();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('says why the action was refused and what to do', async () => {
    await renderSettled();

    refuseAWrite();

    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('Sign in, then try the action again.')).toBeInTheDocument();
  });

  it('starts sign-in from its button', async () => {
    const user = userEvent.setup();
    await renderSettled();
    refuseAWrite();

    await user.click(await screen.findByRole('button', { name: /^sign in$/i }));

    expect(session.startLogin).toHaveBeenCalledTimes(1);
  });

  it('closes when dismissed and returns on the next refusal', async () => {
    const user = userEvent.setup();
    await renderSettled();
    refuseAWrite();

    await user.click(await screen.findByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());

    refuseAWrite();
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  });

  // A session that looks signed in can still be refused: a revoked login, or
  // one Keycast no longer honours. Signing in again is the fix, so the prompt
  // is not hidden for a moderator the app believes is signed in.
  it('shows even while the session looks signed in', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue('a'.repeat(64));
    renderPrompt();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:true'));

    refuseAWrite();

    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  });
});

// The most common place a write is refused is inside a confirm dialog, which
// stays open after a failed action so the moderator can retry. A Radix modal
// makes everything outside it unclickable (body pointer-events: none), hidden
// from assistive technology (aria-hidden), and out of keyboard reach (focus
// trap), so the prompt has to be reachable over it. user-event, not fireEvent:
// fireEvent ignores pointer-events and would click through.
describe('LoginRequiredPrompt over an open confirm dialog', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: 'Sign in with Divine to continue', code: 'moderator_login_required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderWithConfirm() {
    render(
      <DivineSessionProvider>
        <LoginRequiredPrompt />
        <Settled />
        <ConfirmDialog
          trigger={<button>Hide event</button>}
          title='Hide this event?'
          summary='It stops showing in feeds.'
          confirmLabel='Hide'
          onConfirm={async () => {
            await moderateAction('https://api.example.test', { action: 'hide_event', eventId: 'e'.repeat(64) });
          }}
        />
      </DivineSessionProvider>,
    );
  }

  // Refuses the confirm's action and waits for the prompt to be in the page.
  // Found by text, so that each test below fails on its own defect: hidden from
  // assistive technology, unclickable, or out of keyboard reach.
  async function refuseInsideTheDialog(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
    await user.click(screen.getByRole('button', { name: 'Hide event' }));
    await user.click(await screen.findByRole('button', { name: 'Hide' }));
    await screen.findByText(MESSAGE);
  }
  const buttonByText = (text: RegExp) => screen.getByText(text).closest('button')!;

  it('is announced to assistive technology', async () => {
    const user = userEvent.setup();
    renderWithConfirm();

    await refuseInsideTheDialog(user);

    // Not aria-hidden: reachable in the accessibility tree at all.
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    const prompt = screen.getByRole('alertdialog', { name: MESSAGE });
    expect(within(prompt).getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(within(prompt).getByText('Sign in, then try the action again.')).toBeInTheDocument();
  });

  it('starts sign-in from a click', async () => {
    const user = userEvent.setup();
    renderWithConfirm();
    await refuseInsideTheDialog(user);

    await user.click(buttonByText(/^sign in$/i));

    expect(session.startLogin).toHaveBeenCalledTimes(1);
  });

  it('starts sign-in from the keyboard', async () => {
    const user = userEvent.setup();
    renderWithConfirm();
    await refuseInsideTheDialog(user);
    const signIn = buttonByText(/^sign in$/i);

    for (let i = 0; i < 4 && document.activeElement !== signIn; i++) await user.tab();
    expect(signIn).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(session.startLogin).toHaveBeenCalledTimes(1);
  });

  it('dismisses by a click and leaves the confirm dialog open to retry', async () => {
    const user = userEvent.setup();
    renderWithConfirm();
    await refuseInsideTheDialog(user);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Open and closable the way the label publisher's is: it starts open and
  // closes when Radix asks it to.
  function PublishDialog({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(true);
    return <Dialog open={open} onOpenChange={setOpen}><DialogContent>{children}</DialogContent></Dialog>;
  }

  // A plain Radix Dialog (the label publisher's) closes on a click outside it,
  // so a prompt that is not the top modal layer would close it with Dismiss.
  it('leaves a plain dialog beneath it open when dismissed', async () => {
    const user = userEvent.setup();
    render(
      <DivineSessionProvider>
        <LoginRequiredPrompt />
        <Settled />
        <PublishDialog>
            <DialogTitle>Publish label</DialogTitle>
            <DialogDescription>Labels the account.</DialogDescription>
            <button onClick={() => {
              moderateAction('https://api.example.test', { action: 'hide_event', eventId: 'e'.repeat(64) }).catch(() => {});
            }}>Publish</button>
        </PublishDialog>
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText(MESSAGE);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Publish label' })).toBeInTheDocument();
  });

  // Opened from code, the prompt has no trigger for Radix to return focus to,
  // so without help focus falls to <body> on close and a keyboard or screen
  // reader user loses their place. It goes back to where it was at the refusal.
  describe('focus when the prompt closes', () => {
    it('returns to the confirm button after Dismiss', async () => {
      const user = userEvent.setup();
      renderWithConfirm();
      await refuseInsideTheDialog(user);

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
      expect(screen.getByRole('button', { name: 'Hide' })).toHaveFocus();
    });

    it('returns to the confirm button after Escape, leaving the confirm open', async () => {
      const user = userEvent.setup();
      renderWithConfirm();
      await refuseInsideTheDialog(user);

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
      expect(screen.getByRole('button', { name: 'Hide' })).toHaveFocus();
    });

    it('returns to the button that ran the action when no dialog was open', async () => {
      const user = userEvent.setup();
      render(
        <DivineSessionProvider>
          <LoginRequiredPrompt />
          <Settled />
          <button onClick={() => {
            moderateAction('https://api.example.test', { action: 'hide_event', eventId: 'e'.repeat(64) }).catch(() => {});
          }}>Save</button>
        </DivineSessionProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText(MESSAGE);

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
      expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    });

    it('returns to the plain dialog button after Escape', async () => {
      const user = userEvent.setup();
      render(
        <DivineSessionProvider>
          <LoginRequiredPrompt />
          <Settled />
          <PublishDialog>
            <DialogTitle>Publish label</DialogTitle>
            <DialogDescription>Labels the account.</DialogDescription>
            <button onClick={() => {
              moderateAction('https://api.example.test', { action: 'hide_event', eventId: 'e'.repeat(64) }).catch(() => {});
            }}>Publish</button>
          </PublishDialog>
        </DivineSessionProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
      await user.click(screen.getByRole('button', { name: 'Publish' }));
      await screen.findByText(MESSAGE);

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
      expect(screen.getByRole('dialog', { name: 'Publish label' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    });
  });
});
