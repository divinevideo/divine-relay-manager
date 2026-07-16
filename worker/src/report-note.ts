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
  /** Worker environment, drives link env params + keycast host. */
  environment?: string;
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

/** Parse a raw kind-0 event into the profile facts the note needs. Never throws. */
export function parseKind0Profile(
  event: { content?: string; tags?: string[][] } | null | undefined,
): ReportedProfile {
  const tags = event?.tags ?? [];
  const tagValue = (name: string): string | undefined => tags.find((t) => t[0] === name)?.[1];

  // A restored OG account is written by the vine-archive-importer and carries vine origin tags.
  const isVineImport =
    tags.some((t) => t[0] === 'client' && t[1] === 'vine-archive-importer') ||
    tags.some((t) => t[0] === 'i' && (t[1] ?? '').startsWith('vine:')) ||
    tags.some((t) => t[0] === 'origin' && t[1] === 'vine');

  let name: string | undefined;
  let nip05: string | undefined;
  try {
    const meta = JSON.parse(event?.content ?? '{}') as {
      name?: string;
      display_name?: string;
      nip05?: string;
    };
    name = meta.display_name || meta.name || undefined;
    nip05 = meta.nip05 || undefined;
  } catch {
    // Malformed kind-0 content: fall back to tag-derived facts (e.g. the OG-import flag).
  }

  // Sanitize every attacker-controlled field before it reaches the note.
  return {
    name: sanitizeInline(name),
    nip05: sanitizeInline(nip05),
    isVineImport,
    vineUsername: sanitizeInline(tagValue('vine_username')),
  };
}

function toNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

function keycastBase(environment?: string): string {
  return environment === 'staging'
    ? 'https://login.staging.dvines.org'
    : 'https://login.divine.video';
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
      if (profile.name) bits.push(`**${profile.name}**`);
      if (profile.nip05) bits.push(`nip05 \`${profile.nip05}\``);
      lines.push(`• Profile: ${bits.join(' · ')}`);
    }
    if (profile?.isVineImport) {
      const uname = profile.vineUsername ? ` (vine_username \`${profile.vineUsername}\`)` : '';
      lines.push(
        `• ⚠️ **Restored OG Vine account**${uname} — self-reported import markers; likely a name mix-up, not impersonation, but confirm in Relay Manager before applying the "Recovered OG account" macro`,
      );
    }
    lines.push(
      `• Look up in login.divine.video → [support-admin](${keycastBase(environment)}/support-admin?q=${authorPubkey})`,
    );
    lines.push(`• Public profile → https://divine.video/profile/${authorPubkey}`);
    lines.push(`• npub: \`${toNpub(authorPubkey)}\``);
    lines.push(`• hex: \`${authorPubkey}\``, '');
  }

  lines.push('**Filed by:** the ticket requester above.');
  return lines.join('\n');
}
