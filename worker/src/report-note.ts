// ABOUTME: Builds the internal "relay report" note posted into Zendesk content-report tickets
// ABOUTME: Pure helpers (buildReportNote, parseKind0Profile, eventKindLabel) + their types, kept
// ABOUTME: separate from index.ts so the note formatting can be unit-tested without the worker.

import { nip19 } from 'nostr-tools';

/** Profile facts pulled from the reported account's kind-0 event (best-effort enrichment). */
export interface ReportedProfile {
  /** display_name || name from kind-0 content, if any (sanitized for note interpolation). */
  name?: string;
  /** nip05 from kind-0 content, if any (as claimed by the account; not verified here). */
  nip05?: string;
  /** True when the reported account is a Divine Vine-archive import (a restored OG account). */
  isVineImport: boolean;
  /** vine_username tag value, when the account carries one. */
  vineUsername?: string;
}

export interface ReportNoteInput {
  /** Reported event hash (content reports); null for account-level reports. */
  eventId: string | null;
  /** Reported account pubkey (hex); the subject of the report. */
  authorPubkey: string | null;
  /** Report category, verbatim from the ticket (e.g. "other", "sexualContent"). */
  violationType: string | null;
  /** Worker environment, drives the relay-admin `env` link param. */
  environment?: string;
  /** Configured Keycast base URL (env.KEYCAST_URL); the note's lookup host + link derive from it. */
  keycastUrl?: string;
  /** Reported account's profile (enrichment); null/undefined if the fetch failed. */
  profile?: ReportedProfile | null;
  /** Kind of the reported event (enrichment); null/undefined if unknown. */
  reportedEventKind?: number | null;
}

const RELAY_ADMIN = 'https://relay.admin.divine.video';

/** Human label for a reported event's kind. Always pair with the raw kind number for certainty. */
export function eventKindLabel(kind: number | null | undefined): string {
  switch (kind) {
    case 0:
      return 'profile';
    case 1:
      return 'note';
    case 1111:
      return 'comment';
    case 34235:
    case 34236:
      return 'video';
    default:
      return kind == null ? 'event' : `kind ${kind}`;
  }
}

/**
 * Neutralize attacker-controlled kind-0 text (name / nip05 / vine_username) before it is
 * interpolated into the Markdown note. The reported account fully controls its own kind-0,
 * so strip anything that could forge note structure (newlines / control chars) or inject
 * Markdown links, images, code spans, emphasis, or raw HTML. Underscores, dots, and @ are
 * kept so legitimate nip05 values (e.g. `_@name.divine.video`) survive intact.
 */
function sanitizeInline(value: string | undefined, maxLen = 80): string | undefined {
  if (!value) return undefined;
  const cleaned = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch; // control chars / newlines -> space
  })
    .join('')
    .replace(/[`[\]*<>|]/g, '') // markdown link/image/span/emphasis + html/table
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/**
 * Cap on a captured identity value at rest.
 *
 * Raw mode deliberately skips `sanitizeInline`'s 80-character display
 * truncation, but "unsanitized" must not mean "unbounded": kind-0 content is
 * chosen by the account under review, and the captured values are bound
 * straight into the INSERT that opens the case. Far beyond any real handle, so
 * nothing legitimate is touched; each render path applies its own 80-char cap.
 */
const CAPTURED_VALUE_MAX_LEN = 512;

/**
 * Coerce one kind-0 value for storage: verbatim, but a bounded string or nothing.
 *
 * `JSON.parse` yields whatever the account put in the field, and the declared
 * `string | undefined` is a lie for `{"display_name": {}}` or `["a","b"]`.
 * `sanitizeInline` absorbed that by accident (`Array.from` on a plain object
 * gives `[]`, so it returned undefined); raw mode has no such accident, and a
 * non-string reaches `.bind()` as `D1_TYPE_ERROR: Type 'object' not supported`.
 * That throw propagates out of the case INSERT, so an account could suppress
 * its own age-review case by publishing a kind-0 whose display_name is not a
 * string. Capture is best-effort by contract and must never be able to do that.
 */
function rawForStorage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > CAPTURED_VALUE_MAX_LEN ? value.slice(0, CAPTURED_VALUE_MAX_LEN) : value;
}

/** Parse a raw kind-0 event into the profile facts the note needs. Never throws. */
/**
 * @param options.raw Return the profile's values verbatim instead of running
 *   them through `sanitizeInline`. For callers that **persist** the result:
 *   sanitizeInline is a display transform (strips markdown punctuation,
 *   truncates at 80 with an ellipsis), so applying it on the way in stores a
 *   handle the account never used — and identity capture exists precisely
 *   because the real one is about to become unrecoverable. Raw values must
 *   still be sanitized wherever they are rendered.
 *
 *   Raw is not unchecked: values are still coerced to a bounded string by
 *   `rawForStorage`, because these are persisted and a non-string would fail
 *   the write that creates the case.
 */
export function parseKind0Profile(
  event: { content?: string; tags?: string[][] } | null | undefined,
  options: { raw?: boolean } = {},
): ReportedProfile {
  const tags = event?.tags ?? [];
  const tagValue = (name: string): string | undefined => tags.find((t) => t[0] === name)?.[1];

  // A restored OG account is written by the vine-archive-importer and carries vine origin tags.
  const isVineImport =
    tags.some((t) => t[0] === 'client' && t[1] === 'vine-archive-importer') ||
    tags.some((t) => t[0] === 'i' && (t[1] ?? '').startsWith('vine:')) ||
    tags.some((t) => t[0] === 'origin' && t[1] === 'vine');

  // `unknown`, not `string`: the account writes this JSON and any field can be
  // an object, an array or a number. Both branches of `clean` narrow it.
  let name: unknown;
  let nip05: unknown;
  try {
    const meta = JSON.parse(event?.content ?? '{}') as {
      name?: unknown;
      display_name?: unknown;
      nip05?: unknown;
    };
    name = meta.display_name || meta.name || undefined;
    nip05 = meta.nip05 || undefined;
  } catch {
    // Malformed kind-0 content: fall back to tag-derived facts (e.g. the OG-import flag).
  }

  // Sanitize every attacker-controlled field before it reaches the note, unless
  // the caller is storing rather than rendering (see options.raw).
  const clean = (value: unknown) =>
    options.raw ? rawForStorage(value) : sanitizeInline(typeof value === 'string' ? value : undefined);

  return {
    name: clean(name),
    nip05: clean(nip05),
    isVineImport,
    vineUsername: clean(tagValue('vine_username')),
  };
}

export function toNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

/** Normalize the configured Keycast URL and derive its visible host, so the note's
 *  label and link always agree with the deployed environment. */
function keycastTarget(keycastUrl?: string): { url: string; host: string } {
  const url = (keycastUrl || 'https://login.divine.video').replace(/\/+$/, '');
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not a parseable URL: fall back to showing the raw value.
  }
  return { url, host };
}

/**
 * Build the internal note for a content-report ticket. Self-contained and unambiguous:
 * names the report source, distinguishes the reported subject from the reporter, and
 * surfaces human-legible identity + the restored-OG signal so an agent needs no prior context.
 *
 * The caller guarantees at least one of `eventId` / `authorPubkey` is set.
 */
export function buildReportNote(input: ReportNoteInput): string {
  const { eventId, authorPubkey, violationType, environment, profile, reportedEventKind } = input;
  const envParam = environment ? `&env=${environment}` : '';
  const keycast = keycastTarget(input.keycastUrl);
  const scope = eventId ? 'content (specific event)' : 'account-level (whole profile)';
  const primaryLink = eventId
    ? `${RELAY_ADMIN}/reports?event=${eventId}${envParam}`
    : `${RELAY_ADMIN}/reports?pubkey=${authorPubkey}${envParam}`;

  const lines: string[] = [];
  lines.push('**🛡️ RELAY REPORT — INTERNAL LOOKUP**', '');
  lines.push(
    'Reported on the Divine relay. Full report details (reporter, reason, timeline, prior actions) live in Relay Manager:',
  );
  lines.push(`**→ [Open this report in Relay Manager](${primaryLink})**`, '');
  lines.push(`Reason: **${violationType || 'unspecified'}** · Scope: **${scope}**`, '', '---', '');

  if (eventId) {
    lines.push(`**Reported content (${eventKindLabel(reportedEventKind)}):**`);
    lines.push(`• [View in Relay Manager](${RELAY_ADMIN}/reports?event=${eventId}${envParam})`);
    if (reportedEventKind != null) lines.push(`• Kind: \`${reportedEventKind}\``);
    lines.push(`• Event ID: \`${eventId}\``, '');
  }

  if (authorPubkey) {
    lines.push('**Reported account** — the subject of this report, *not* the person who filed it:');
    if (profile?.name || profile?.nip05) {
      const bits: string[] = [];
      // Code span (not bold) so a name containing a bare URL can't auto-link in Zendesk.
      if (profile.name) bits.push(`\`${profile.name}\``);
      if (profile.nip05) bits.push(`nip05 \`${profile.nip05}\` (claimed, unverified)`);
      lines.push(`• Profile: ${bits.join(' · ')}`);
    }
    if (profile?.isVineImport) {
      const uname = profile.vineUsername ? ` (vine_username \`${profile.vineUsername}\`)` : '';
      lines.push(
        `• 🏷️ **Vine-archive import markers**${uname} — self-reported on the account's own kind-0, so a signal, not proof. Verify the reporter's ownership before resolving; if confirmed, the "Recovered OG account" macro applies.`,
      );
    }
    lines.push(
      `• Look up in ${keycast.host} → [support-admin](${keycast.url}/support-admin?q=${authorPubkey})`,
    );
    lines.push(`• Public profile → https://divine.video/profile/${authorPubkey}`);
    lines.push(`• npub: \`${toNpub(authorPubkey)}\``);
    lines.push(`• hex: \`${authorPubkey}\``, '');
  }

  lines.push('**Filed by:** the ticket requester above.');
  return lines.join('\n');
}

/** The captured identity fields, in the shape the renderers consume. */
export interface AgeReviewIdentityCandidates {
  accountName?: string | null;
  accountNip05?: string | null;
  accountVineUsername?: string | null;
}

export interface AgeReviewIdentityInput extends AgeReviewIdentityCandidates {
  caseId: string;
  pubkey: string;
  ageBand: string;
  originTicketId?: number | null;
  deadlineAt?: string | null;
}

/**
 * Identity block for an age-review case, shared by the case ticket's internal
 * note and the parent contact's `notes` field. Both are agent-only surfaces.
 *
 * Every account-derived value is attacker-chosen, so all of them go through
 * sanitizeInline: newlines fold to spaces, which keeps an injected string from
 * occupying its own line and impersonating a field this block emits.
 *
 * When nothing was captured this says so outright. A blank handle has to read
 * as a known fact -- the account may never have had a profile, or enforcement
 * hid it -- rather than looking like a rendering failure.
 */
/**
 * The single readable identifier for a captured account, in preference order.
 * Sanitized: every candidate is chosen by the account itself.
 */
function resolveHandle(input: AgeReviewIdentityCandidates): string | undefined {
  return (
    sanitizeInline(input.accountName ?? undefined) ??
    sanitizeInline(input.accountVineUsername ?? undefined) ??
    sanitizeInline(input.accountNip05 ?? undefined)
  );
}

/**
 * Zendesk contact name for a parent who has replied about a case.
 *
 * "Claimed" is deliberate. Whether they are the parent is precisely what the
 * review exists to establish, so the name must not assert it as fact.
 *
 * Returns undefined when nothing was captured, so a caller cannot rename a
 * contact after an empty handle. Only ever for a contact known to be a real
 * parent address, and only after they have replied -- Zendesk renders this
 * into the To: header of outbound mail.
 */
export function buildClaimedParentName(input: AgeReviewIdentityCandidates): string | undefined {
  const handle = resolveHandle(input);
  return handle ? `Claimed parent of ${handle}` : undefined;
}

export function buildAgeReviewIdentityBlock(input: AgeReviewIdentityInput): string {
  const handle = resolveHandle(input);

  const lines: string[] = [
    `Age review: ${sanitizeInline(input.ageBand) ?? 'unspecified'}, case ${input.caseId}`,
    `${RELAY_ADMIN}/age-review?case=${input.caseId}`,
    '',
    'Account',
    // Qualified for the same reason buildReportNote qualifies it: the account
    // picks this string and can name itself after Divine staff.
    `  handle   ${handle ? `${handle} (claimed, unverified)` : '(no profile captured - the account may have had none, or its content is hidden by enforcement)'}`,
    `  npub     ${toNpub(input.pubkey)}`,
    `  pubkey   ${input.pubkey}`,
  ];

  if (input.originTicketId) lines.push('', `Origin ticket ${input.originTicketId}`);
  // Always emitted. "No deadline" is a real case state, and an absent line
  // would read as a rendering fault rather than the fact that there is none.
  lines.push(`Deadline ${sanitizeInline(input.deadlineAt ?? undefined) ?? 'not set'}`);

  return lines.join('\n');
}
