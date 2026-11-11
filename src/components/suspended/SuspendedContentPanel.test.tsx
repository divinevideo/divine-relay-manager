// ABOUTME: Pins the suspended-content viewer panels: a click opens them, they are labelled,
// ABOUTME: they follow the screen's media rule, they empty on sign-out, and errors map by code.
import { useLayoutEffect, type ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { MemoryRouter } from 'react-router-dom';
import type { NostrEventJson, SuspendedAccountResponse } from '../../../shared/suspended-content';
import { SuspendedAccountViewer, SuspendedPostViewer } from './SuspendedContentPanel';

const TOKEN = 'moderator-login-token';
const MOD = 'a'.repeat(64);
const AUTHOR = 'c'.repeat(64);
const EVENT_ID = 'd'.repeat(64);
const OLDER_ID = 'e'.repeat(64);
const PICTURE = 'https://example.invalid/avatar.png';

const LABEL = 'Hidden from everyone else by the suspension.';
const RECORDED = 'Your view is recorded under your Divine login.';
const SIGN_IN = 'Sign in with Divine to view.';
const UNVERIFIED = "Your Divine login couldn't be verified. Sign in with Divine to view.";

const ctx = vi.hoisted(() => ({
  isSignedIn: true,
  isResolving: false,
  pubkey: undefined as string | undefined,
  token: undefined as string | undefined,
  startLogin: vi.fn(async () => {}),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example.test', relayUrl: 'wss://relay.example.test' } }),
}));
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({
    isSignedIn: ctx.isSignedIn,
    isResolving: ctx.isResolving,
    pubkey: ctx.pubkey,
    getModeratorToken: () => ctx.token,
    startLogin: ctx.startLogin,
  }),
}));
// The media viewer has its own tests. Here it records the rule it was handed
// and what it was asked to show.
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: (props: { showByDefault?: boolean | null; content?: string; tags?: string[][] }) => (
    <div
      data-testid="media"
      data-show={String(props.showByDefault)}
      data-content={props.content}
      data-tags={props.tags === undefined ? undefined : JSON.stringify(props.tags)}
    />
  ),
}));
// Radix's AvatarImage starts a request just by mounting, so what matters is
// whether it is mounted at all (see UserProfileCard.hide-media.test.tsx).
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) => <img data-testid="avatar-img" src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

function event(id: string, content: string, created_at = 200): NostrEventJson {
  return { id, pubkey: AUTHOR, created_at, kind: 1, tags: [], content, sig: 'f'.repeat(128) };
}

const PROFILE: NostrEventJson = {
  ...event('9'.repeat(64), JSON.stringify({ name: 'hidden-name', about: 'hidden bio', picture: PICTURE })),
  kind: 0,
};

function accountPage(changes: Partial<SuspendedAccountResponse> = {}): SuspendedAccountResponse {
  return {
    success: true, pubkey: AUTHOR, profile: PROFILE, events: [event(EVENT_ID, 'first hidden post')],
    nextUntil: 150, nextUntilId: OLDER_ID, ...changes,
  };
}

const fetchMock = vi.fn();
function answerWith(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () => Response.json(body, { status }));
}

beforeEach(() => {
  ctx.isSignedIn = true;
  ctx.isResolving = false;
  ctx.pubkey = MOD;
  ctx.token = TOKEN;
  ctx.startLogin.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith('/event')
    ? { success: true, event: event(EVENT_ID, 'the hidden post') }
    : accountPage()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(showMediaByDefault: boolean | null = true) {
  return <SuspendedPostViewer eventId={EVENT_ID} surface="report" showMediaByDefault={showMediaByDefault} />;
}
function account(showMediaByDefault: boolean | null = true) {
  return <SuspendedAccountViewer pubkey={AUTHOR} surface="user" showMediaByDefault={showMediaByDefault} />;
}

async function openPost(showMediaByDefault: boolean | null = true) {
  const view = render(post(showMediaByDefault));
  fireEvent.click(screen.getByRole('button', { name: 'View hidden post' }));
  return view;
}

// Records, at every commit of the tree, which moderator the session named and
// whether `text` was in the DOM. A layout effect runs after the commit and
// before paint, so it sees exactly what that render committed: content that
// a later effect clears is still caught (the technique SexualQuarantine.test
// uses for the opened snapshot).
// `viewer` builds a fresh element per render: the session is a mocked hook,
// not a context, so a reused element would skip the viewer's re-render.
function withCommitProbe(viewer: () => ReactElement, text: string) {
  const commits: Array<{ pubkey: string | undefined; shown: boolean }> = [];
  function CommitProbe() {
    useLayoutEffect(() => {
      commits.push({ pubkey: ctx.pubkey, shown: document.body.textContent?.includes(text) ?? false });
    });
    return null;
  }
  return { commits, tree: () => <>{viewer()}<CommitProbe /></> };
}

const MOD_B = 'b'.repeat(64);

describe('SuspendedPostViewer', () => {
  it('starts closed, says viewing is recorded, and requests nothing', async () => {
    render(post());

    expect(screen.getByRole('button', { name: 'View hidden post' })).toBeInTheDocument();
    expect(screen.getByText('Viewing is recorded under your Divine login.')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens on a click, labelled, with the post', async () => {
    await openPost();

    expect(await screen.findByText('the hidden post')).toBeInTheDocument();
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText(RECORDED)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The app has no /t/<tag> or /<nip19> route, so a link there navigates the
  // tab to NotFound, unmounting the open view; reopening is another audited read.
  // Inside a router, so a linkifying renderer would render real links here.
  it('shows the post as plain text, with no links for hashtags, references or URLs', async () => {
    const text = `look #tag nostr:${nip19.noteEncode(EVENT_ID)} https://example.invalid/page`;
    answerWith({ success: true, event: event(EVENT_ID, text) });
    render(<MemoryRouter>{post()}</MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'View hidden post' }));

    const shown = await screen.findByText(/^look/);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(shown).toHaveTextContent(text);
  });

  // The shared NIP-18 rule the user cards follow: a repost shows what it
  // reposted, marked as a repost, never the serialized event.
  it("shows a repost's inner text, marked as reposted, not its JSON, and reads media from the original", async () => {
    const imeta = ['imeta', 'url https://example.invalid/clip.mp4', 'm video/mp4'];
    const original = { ...event('1'.repeat(64), 'the original words'), pubkey: MOD, tags: [imeta] };
    answerWith({
      success: true,
      event: { ...event(EVENT_ID, JSON.stringify(original)), kind: 6, tags: [['e', original.id], ['p', MOD]] },
    });
    await openPost();

    expect(await screen.findByText('the original words')).toBeInTheDocument();
    expect(screen.getByText(/reposted:/)).toBeInTheDocument();
    expect(screen.queryByText(/"sig"/)).not.toBeInTheDocument();
    // As the user cards do: the original's text and tags, not the JSON string,
    // whose quotes and brackets would end up inside the extracted URLs.
    const media = screen.getByTestId('media');
    expect(media.dataset.content).toBe('the original words');
    expect(JSON.parse(media.dataset.tags ?? 'null')).toEqual([imeta]);
  });

  it('names what a repost with no copy of the original reposted', async () => {
    answerWith({ success: true, event: { ...event(EVENT_ID, ''), kind: 6, tags: [['e', '1'.repeat(64)]] } });
    await openPost();

    expect(await screen.findByText(/^reposted /)).toBeInTheDocument();
  });

  it.each([[false], [null], [true]] as const)('hands the media viewer the screen rule (%s)', async (rule) => {
    await openPost(rule);

    await screen.findByText('the hidden post');
    expect(screen.getByTestId('media').dataset.show).toBe(String(rule));
  });

  it('offers sign-in instead of the button when signed out', () => {
    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    render(post());

    expect(screen.getByText(SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View hidden post' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(ctx.startLogin).toHaveBeenCalled();
  });

  it('shows nothing while the session is still resolving, not a sign-in prompt', () => {
    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.isResolving = true;
    const { container } = render(post());

    expect(container).toBeEmptyDOMElement();
  });

  it('a session whose identity did not resolve is asked to sign in again', () => {
    ctx.pubkey = undefined;
    render(post());

    expect(screen.getByText(UNVERIFIED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View hidden post' })).not.toBeInTheDocument();
  });

  it('a credential change removes the fetched post until the pubkey resolves again', async () => {
    const view = await openPost();
    await screen.findByText('the hidden post');

    ctx.pubkey = undefined;
    ctx.isResolving = true;
    view.rerender(post());
    expect(screen.queryByText('the hidden post')).not.toBeInTheDocument();

    ctx.pubkey = MOD;
    ctx.isResolving = false;
    view.rerender(post());
    expect(screen.queryByText('the hidden post')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View hidden post' })).toBeInTheDocument();
  });

  it("warns, as age review does, when the post is not the expected account's", async () => {
    render(<SuspendedPostViewer eventId={EVENT_ID} surface="age-review" showMediaByDefault={false} expectedAuthor={'b'.repeat(64)} />);
    fireEvent.click(screen.getByRole('button', { name: 'View hidden post' }));

    expect(await screen.findByText('the hidden post')).toBeInTheDocument();
    const warning = screen.getByText(/not by this case's subject/);
    expect(warning.textContent).toContain('Do not judge this account by it without confirming the connection.');
  });

  it("gives no warning when the post is the expected account's, however its case", async () => {
    render(<SuspendedPostViewer eventId={EVENT_ID} surface="age-review" showMediaByDefault={false} expectedAuthor={AUTHOR.toUpperCase()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View hidden post' }));

    await screen.findByText('the hidden post');
    expect(screen.queryByText(/not by this case's subject/)).not.toBeInTheDocument();
  });

  it("never commits the previous moderator's post under the next moderator, not even once", async () => {
    const probe = withCommitProbe(() => post(), 'the hidden post');
    const view = render(probe.tree());
    fireEvent.click(screen.getByRole('button', { name: 'View hidden post' }));
    await screen.findByText('the hidden post');

    ctx.pubkey = MOD_B;
    const before = probe.commits.length;
    view.rerender(probe.tree());

    expect(probe.commits.slice(before).find(c => c.pubkey === MOD_B)).toEqual({ pubkey: MOD_B, shown: false });
  });

  it('signing out removes the fetched post from the DOM', async () => {
    const view = await openPost();
    await screen.findByText('the hidden post');

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    view.rerender(post());

    expect(screen.queryByText('the hidden post')).not.toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(SIGN_IN)).toBeInTheDocument();
  });

  it('a bare 404 from an old worker reads as viewer unavailable, not hidden for another reason', async () => {
    fetchMock.mockImplementation(async () => new Response('Not found', { status: 404 }));
    await openPost();

    expect(await screen.findByText("The suspended-content viewer isn't available here yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Hidden for another reason/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('a hidden_for_another_reason 404 says so, with no retry', async () => {
    answerWith({ success: false, error: 'x', code: 'hidden_for_another_reason' }, 404);
    await openPost();

    expect(await screen.findByText("Hidden for another reason (such as deleted or banned), so it can't be shown here either.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it.each([
    ['not_suspended', 409, 'This account is no longer suspended. Its posts show in the usual views.'],
    ['viewer_unsupported', 501, "The suspended-content viewer isn't available here yet."],
    ['invalid_request', 400, "The suspended-content viewer isn't available here yet."],
  ])('%s has its own copy and no retry', async (code, status, copy) => {
    answerWith({ success: false, error: 'x', code }, status);
    await openPost();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it.each([
    ['audit_unavailable', 503, "Couldn't record this view, so nothing is shown. Try again."],
    ['relay_error', 502, "Couldn't read from the relay. Try again."],
  ])('%s offers a retry, which is one more request', async (code, status, copy) => {
    answerWith({ success: false, error: 'x', code }, status);
    await openPost();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    answerWith({ success: true, event: event(EVENT_ID, 'the hidden post') });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('the hidden post')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The worker writes the audit row only when it serves the content, so the
  // header's "recorded" claim, and the suspension label, belong over content.
  it.each([
    ['audit_unavailable', 503, "Couldn't record this view, so nothing is shown. Try again."],
    ['not_suspended', 409, 'This account is no longer suspended. Its posts show in the usual views.'],
  ])('a %s answer shows neither the suspension label nor the recorded note', async (code, status, copy) => {
    answerWith({ success: false, error: 'x', code }, status);
    await openPost();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(RECORDED)).not.toBeInTheDocument();
  });

  it('claims nothing is recorded while the read is still out', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await openPost();

    expect(await screen.findByText('Opening the hidden post…')).toBeInTheDocument();
    expect(screen.queryByText(RECORDED)).not.toBeInTheDocument();
  });

  // The worker's catch-all answers 500 { error: 'Internal error' } with no code,
  // and an edge 502/524 page or a 429 carries none either. The access gate's
  // outage has its own code. All are transient.
  it.each([
    ['the worker catch-all 500', () => Response.json({ success: false, error: 'Internal error' }, { status: 500 })],
    ['an edge 502 page', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['a 429', () => new Response('Too many requests', { status: 429 })],
    ['the access gate\'s access_unavailable 503', () => Response.json({ success: false, error: 'x', code: 'access_unavailable' }, { status: 503 })],
  ])('%s offers a retry, not "unavailable"', async (_name, answer) => {
    fetchMock.mockImplementation(async () => answer());
    await openPost();

    expect(await screen.findByText("The server couldn't answer. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/isn't available here yet/)).not.toBeInTheDocument();
    answerWith({ success: true, event: event(EVENT_ID, 'the hidden post') });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('the hidden post')).toBeInTheDocument();
  });

  it('a code this client does not know still reads as unavailable, even on a 5xx', async () => {
    answerWith({ success: false, error: 'x', code: 'some_future_code' }, 500);
    await openPost();

    expect(await screen.findByText("The suspended-content viewer isn't available here yet.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('a request that never reached the worker offers a retry', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await openPost();

    expect(await screen.findByText("Couldn't reach the server. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a login the worker would not verify asks for sign-in, with a retry', async () => {
    answerWith({ success: false, error: 'Sign in with Divine to continue', code: 'moderator_login_required' }, 401);
    await openPost();

    expect(await screen.findByText("Your Divine login couldn't be verified. Sign in with Divine to view.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('SuspendedAccountViewer', () => {
  async function openAccount(showMediaByDefault: boolean | null = true) {
    const view = render(account(showMediaByDefault));
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));
    await screen.findByText('first hidden post');
    return view;
  }

  it('starts closed and requests nothing', async () => {
    render(account());

    expect(screen.getByRole('button', { name: 'View hidden posts' })).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the label, the profile and the posts once opened', async () => {
    await openAccount();

    expect(screen.getByText(LABEL)).toBeInTheDocument();
    // The name heads the account and each of its posts.
    expect(screen.getAllByText('hidden-name').length).toBeGreaterThan(0);
    expect(screen.getByText('hidden bio')).toBeInTheDocument();
  });

  it.each([[false], [null]] as const)('withholds the avatar image unless media shows by default (%s)', async (rule) => {
    await openAccount(rule);

    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
  });

  it('shows the avatar image when media shows by default', async () => {
    await openAccount(true);

    expect(screen.getByTestId('avatar-img')).toHaveAttribute('src', PICTURE);
  });

  it('a profile failure is a muted line and the posts still show', async () => {
    answerWith(accountPage({ profile: null, profileError: 'relay_error' }));
    await openAccount();

    expect(screen.getByText("Couldn't read the profile.")).toBeInTheDocument();
    expect(screen.getByText('first hidden post')).toBeInTheDocument();
  });

  it('load older appends the next page', async () => {
    await openAccount();
    answerWith(accountPage({ profile: null, events: [event(OLDER_ID, 'older hidden post', 120)], nextUntil: null, nextUntilId: null }));

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText('older hidden post')).toBeInTheDocument();
    expect(screen.getByText('first hidden post')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed older page keeps what is shown and offers a retry', async () => {
    await openAccount();
    answerWith({ success: false, error: 'x', code: 'relay_error' }, 502);

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText("Couldn't read from the relay. Try again.")).toBeInTheDocument();
    expect(screen.getByText('first hidden post')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  // The earlier pages stay on screen, so "nothing is shown" would be wrong.
  it('an older page the audit could not record says that page is not shown, and keeps the rest', async () => {
    await openAccount();
    answerWith({ success: false, error: 'x', code: 'audit_unavailable' }, 503);

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText("Couldn't record this view, so that page isn't shown. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/so nothing is shown/)).not.toBeInTheDocument();
    expect(screen.getByText('first hidden post')).toBeInTheDocument();
    // What is on screen was served and recorded, so its header stays.
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText(RECORDED)).toBeInTheDocument();
  });

  it('a first page that failed shows neither the suspension label nor the recorded note', async () => {
    answerWith({ success: false, error: 'x', code: 'relay_error' }, 502);
    render(account());
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));

    expect(await screen.findByText("Couldn't read from the relay. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(RECORDED)).not.toBeInTheDocument();
  });

  it("never commits the previous moderator's posts under the next moderator, not even once", async () => {
    const probe = withCommitProbe(() => account(), 'first hidden post');
    const view = render(probe.tree());
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));
    await screen.findByText('first hidden post');

    ctx.pubkey = MOD_B;
    const before = probe.commits.length;
    view.rerender(probe.tree());

    expect(probe.commits.slice(before).find(c => c.pubkey === MOD_B)).toEqual({ pubkey: MOD_B, shown: false });
  });

  it('signing out removes every fetched post and the profile from the DOM', async () => {
    const view = await openAccount();

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    view.rerender(account());

    expect(screen.queryByText('first hidden post')).not.toBeInTheDocument();
    expect(screen.queryAllByText('hidden-name')).toHaveLength(0);
    expect(screen.getByText(SIGN_IN)).toBeInTheDocument();
  });

  it('a not-suspended account says so', async () => {
    answerWith({ success: false, error: 'x', code: 'not_suspended' }, 409);
    render(account());
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));

    await waitFor(() => expect(screen.getByText('This account is no longer suspended. Its posts show in the usual views.')).toBeInTheDocument());
  });

  it('says so when the account has nothing to show', async () => {
    answerWith(accountPage({ events: [], nextUntil: null, nextUntilId: null }));
    render(account());
    fireEvent.click(screen.getByRole('button', { name: 'View hidden posts' }));

    expect(await screen.findByText('No hidden posts to show.')).toBeInTheDocument();
  });
});
