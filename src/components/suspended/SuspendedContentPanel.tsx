// ABOUTME: Panels that show moderators a suspended account's hidden content: one post, or the
// ABOUTME: account's posts and profile. Opened by a click, audited, emptied on sign-out.

import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { EyeOff, LogIn, RefreshCw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { CopyableId } from '@/components/CopyableId';
import { ForeignAuthorWarning } from '@/components/ForeignAuthorWarning';
import { MediaPreview } from '@/components/MediaPreview';
import { useStartSignIn } from '@/hooks/useStartSignIn';
import { useSuspendedAccount, useSuspendedPost, type ViewerSession } from '@/hooks/useSuspendedContent';
import { ApiError } from '@/lib/adminApi';
import { getKindName } from '@/lib/kindNames';
import { parseRepostForDisplay } from '@/lib/nip18';
import {
  SUSPENDED_CONTENT_CODE,
  type NostrEventJson,
  type SuspendedAccountResponse,
  type SuspendedViewSurface,
} from '../../../shared/suspended-content';

/** The label on everything the viewer shows. */
const SUSPENDED_VIEW_LABEL = 'Hidden from everyone else by the suspension.';
const RECORDED_NOTE = 'Your view is recorded under your Divine login.';
const RECORDED_BEFORE_OPEN = 'Viewing is recorded under your Divine login.';
const SIGN_IN_TO_VIEW = 'Sign in with Divine to view.';
const LOGIN_UNVERIFIED = `Your Divine login couldn't be verified. ${SIGN_IN_TO_VIEW}`;
const MODERATOR_LOGIN_REQUIRED = 'moderator_login_required';

interface ViewerProps {
  surface: SuspendedViewSurface;
  /** The screen's media rule: false or null start media (and the avatar) hidden. */
  showMediaByDefault: boolean | null;
}

// ─── Error copy ────────────────────────────────────────────────────────────

interface ErrorCopy { text: string; retry: boolean; signIn?: boolean }

/**
 * Maps a viewer error by its code, never by its status alone: an old worker
 * without the route answers a bare 404, which must not read as "hidden for
 * another reason".
 */
function viewerErrorCopy(error: unknown, olderPage: boolean): ErrorCopy {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case MODERATOR_LOGIN_REQUIRED:
      return { text: LOGIN_UNVERIFIED, retry: true, signIn: true };
    case SUSPENDED_CONTENT_CODE.notSuspended:
      return { text: 'This account is no longer suspended. Its posts show in the usual views.', retry: false };
    case SUSPENDED_CONTENT_CODE.hiddenForAnotherReason:
      return { text: "Hidden for another reason (such as deleted or banned), so it can't be shown here either.", retry: false };
    case SUSPENDED_CONTENT_CODE.auditUnavailable:
      // For an older page the pages already loaded stay on screen; only the
      // one that could not be recorded is withheld.
      return {
        text: olderPage
          ? "Couldn't record this view, so that page isn't shown. Try again."
          : "Couldn't record this view, so nothing is shown. Try again.",
        retry: true,
      };
    case SUSPENDED_CONTENT_CODE.relayError:
      return { text: "Couldn't read from the relay. Try again.", retry: true };
  }
  // No HTTP answer at all (offline, timed out): the worker may never have seen
  // it, so a retry is worth offering. Any other answer, including a code this
  // client does not know, means the viewer can't serve this here.
  if (!(error instanceof ApiError) || error.statusCode === undefined) {
    return { text: "Couldn't reach the server. Try again.", retry: true };
  }
  return { text: "The suspended-content viewer isn't available here yet.", retry: false };
}

// ─── Shared pieces ─────────────────────────────────────────────────────────

function SignInPrompt({ text = SIGN_IN_TO_VIEW, onRetry }: { text?: string; onRetry?: () => void }) {
  const signIn = useStartSignIn();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{text}</span>
      <Button size="sm" variant="outline" onClick={signIn}>
        <LogIn className="mr-1 h-3 w-3" /> Sign in
      </Button>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw className="mr-1 h-3 w-3" /> Try again
        </Button>
      )}
    </div>
  );
}

function ViewerError({ error, onRetry, olderPage = false }: { error: unknown; onRetry: () => void; olderPage?: boolean }) {
  const copy = viewerErrorCopy(error, olderPage);
  if (copy.signIn) return <SignInPrompt text={copy.text} onRetry={onRetry} />;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
      <span role="alert">{copy.text}</span>
      {copy.retry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="mr-1 h-3 w-3" /> Try again
        </Button>
      )}
    </div>
  );
}

/**
 * What stands in for the viewer until the session is ready. Nothing while it
 * resolves, so a signed-in moderator does not see a sign-in prompt flash at
 * load or on a token refresh.
 */
function SessionGate({ session }: { session: Exclude<ViewerSession, 'ready'> }) {
  if (session === 'signed-out') return <SignInPrompt />;
  if (session === 'unverified') return <SignInPrompt text={LOGIN_UNVERIFIED} />;
  return null;
}

/** Before the click: the action, and the note that it is recorded. */
function OpenButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={onOpen}>
        <EyeOff className="mr-1 h-3 w-3" /> {label}
      </Button>
      <span className="text-xs text-muted-foreground">{RECORDED_BEFORE_OPEN}</span>
    </div>
  );
}

/**
 * The open panel. Over served content it is labelled, so nothing in it reads as
 * public content. Only then: the worker records a view only when it serves one,
 * so while loading, or after a refusal or failure, nothing confirms the
 * "recorded" note (a refusal records nothing at all), and the label would
 * contradict an answer like "no longer suspended".
 */
function Frame({ served, children }: { served: boolean; children: ReactNode }) {
  return (
    <section
      aria-label={served ? SUSPENDED_VIEW_LABEL : undefined}
      className="rounded-md border border-amber-500/40 bg-muted/30 p-3 space-y-3"
    >
      {served && (
        <div className="space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" />
            {SUSPENDED_VIEW_LABEL}
          </p>
          <p className="text-xs text-muted-foreground">{RECORDED_NOTE}</p>
        </div>
      )}
      {children}
    </section>
  );
}

interface ProfileFields { name?: string; about?: string; picture?: string }

function readProfile(profile: NostrEventJson | null): ProfileFields | null {
  if (!profile) return null;
  try {
    const parsed: unknown = JSON.parse(profile.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    return { name: text(p.display_name) ?? text(p.name), about: text(p.about), picture: text(p.picture) };
  } catch {
    return null;
  }
}

/**
 * One hidden post. Not ThreadContext's PostCard: that reads the author through
 * the relay, which hides a suspended account's profile. The author is the hex
 * pubkey, or the name from the viewer's own profile read. The text is plain, as
 * in the other cards: NoteContent links hashtags and mentions to routes this
 * app does not have, and following one would close the view. A repost shows
 * what it reposted, by the NIP-18 rule the user cards share: the original's text
 * and media rather than the serialized copy (an out-of-spec one still shows as
 * text, as evidence).
 */
function HiddenPostCard({ event, showMediaByDefault, authorName }: {
  event: NostrEventJson;
  showMediaByDefault: boolean | null;
  authorName?: string;
}) {
  const nostrEvent = event as NostrEvent;
  const { isRepost, inner, displayContent, targetDescription } = parseRepostForDisplay(event);
  return (
    <div className="rounded-md border bg-background p-2.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{getKindName(event.kind)}</span>
        <span>·</span>
        <span>{new Date(event.created_at * 1000).toLocaleString()}</span>
        <span>·</span>
        {authorName && <span className="font-medium">{authorName}</span>}
        <CopyableId value={event.pubkey} type="hex" />
      </div>
      {displayContent && (
        <p className="text-sm whitespace-pre-wrap break-words">
          {isRepost && (
            <span
              className="text-muted-foreground italic"
              title={inner?.pubkey ? `Reposted from pubkey ${inner.pubkey}` : undefined}
            >
              reposted:{' '}
            </span>
          )}
          {displayContent}
        </p>
      )}
      {isRepost && !displayContent && targetDescription && (
        <p className="text-xs text-muted-foreground italic break-all">reposted {targetDescription}</p>
      )}
      {/* A repost hands over the original's text and tags, as the user cards do:
          read from the JSON string, its quotes would end up inside the URLs. */}
      <MediaPreview
        event={nostrEvent}
        content={displayContent}
        tags={isRepost ? (inner?.tags ?? []) : event.tags}
        showByDefault={showMediaByDefault}
      />
    </div>
  );
}

// ─── One post ──────────────────────────────────────────────────────────────

export function SuspendedPostViewer({ eventId, surface, showMediaByDefault, expectedAuthor, subject }: ViewerProps & {
  eventId: string;
  /**
   * The account the screen is about. The id may come from a report's tags, so
   * the post can belong to someone else; then it carries the same warning
   * age review puts on a foreign target, never presented as this account's.
   */
  expectedAuthor?: string;
  /** How the warning names that account; defaults to age review's wording. */
  subject?: string;
}) {
  const view = useSuspendedPost({ eventId, surface });
  // Checked first, at every render: no ready session shows nothing fetched.
  if (view.session !== 'ready') return <SessionGate session={view.session} />;
  if (view.status === 'idle') return <OpenButton label="View hidden post" onOpen={view.load} />;
  const event = view.data?.event;
  const foreign = !!event && !!expectedAuthor && event.pubkey.toLowerCase() !== expectedAuthor.toLowerCase();
  return (
    <Frame served={!!event}>
      {view.status === 'loading' && <p role="status" className="text-sm text-muted-foreground">Opening the hidden post…</p>}
      {view.status === 'error' && <ViewerError error={view.error} onRetry={view.load} />}
      {foreign && <ForeignAuthorWarning author={event.pubkey} subject={subject} />}
      {event && <HiddenPostCard event={event} showMediaByDefault={showMediaByDefault} />}
    </Frame>
  );
}

// ─── An account ────────────────────────────────────────────────────────────

function AccountHeader({ page, showMediaByDefault }: { page: SuspendedAccountResponse; showMediaByDefault: boolean | null }) {
  const profile = readProfile(page.profile);
  const initials = (profile?.name ?? page.pubkey).slice(0, 2).toUpperCase();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 min-w-0">
        {/* A fresh root per state, as UserProfileCard does: Radix keeps the
            initials hidden once an image loaded. */}
        <Avatar key={showMediaByDefault === true ? 'image' : 'hidden'} className="h-10 w-10 shrink-0">
          {showMediaByDefault === true && profile?.picture && <AvatarImage src={profile.picture} />}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          {profile?.name && <p className="text-sm font-medium truncate">{profile.name}</p>}
          <CopyableId value={page.pubkey} type="hex" />
        </div>
      </div>
      {profile?.about && <p className="text-sm text-muted-foreground break-words">{profile.about}</p>}
      {page.profileError && <p className="text-xs text-muted-foreground">Couldn't read the profile.</p>}
    </div>
  );
}

export function SuspendedAccountViewer({ pubkey, surface, showMediaByDefault }: ViewerProps & { pubkey: string }) {
  const view = useSuspendedAccount({ pubkey, surface });
  // Checked first, at every render: no ready session shows nothing fetched.
  if (view.session !== 'ready') return <SessionGate session={view.session} />;
  if (view.status === 'idle') return <OpenButton label="View hidden posts" onOpen={view.load} />;
  const [first] = view.pages;
  const authorName = first ? readProfile(first.profile)?.name : undefined;
  const events = view.pages.flatMap(p => p.events);
  return (
    <Frame served={!!first}>
      {view.status === 'loading' && <p role="status" className="text-sm text-muted-foreground">Opening the hidden posts…</p>}
      {view.status === 'error' && <ViewerError error={view.error} onRetry={view.load} />}
      {first && (
        <>
          <AccountHeader page={first} showMediaByDefault={showMediaByDefault} />
          {events.length === 0 && <p className="text-sm text-muted-foreground">No hidden posts to show.</p>}
          <div className="space-y-2">
            {events.map(e => (
              <HiddenPostCard key={e.id} event={e} showMediaByDefault={showMediaByDefault} authorName={authorName} />
            ))}
          </div>
          {view.olderStatus === 'error' && <ViewerError error={view.olderError} onRetry={view.loadOlder} olderPage />}
          {view.hasOlder && view.olderStatus !== 'error' && (
            <Button size="sm" variant="outline" onClick={view.loadOlder} disabled={view.olderStatus === 'loading'}>
              {view.olderStatus === 'loading' ? 'Loading older…' : 'Load older'}
            </Button>
          )}
        </>
      )}
    </Frame>
  );
}
