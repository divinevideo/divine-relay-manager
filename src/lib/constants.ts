import { getEnvironmentByApiUrl } from "@/lib/environments";
import { VIDEO_KINDS } from "@/lib/kindNames";
export { AUTO_HIDE_ACTION, AUTO_HIDE_ACTIONS, type AutoHideAction } from "../../shared/autohide";

// ABOUTME: Shared constants for moderation categories and labels
// ABOUTME: DTSP (Digital Trust & Safety Partnership) category mappings

export const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'csam': 'CSAM',
  'NS-csam': 'CSAM',
  // NIP-32 social.nos.ontology labels emitted by divine-mobile and divine-web.
  // Keep both kebab- and camel-case aliases where clients already differ on wire values.
  'NS-spam': 'Spam',
  'NS-harassment': 'Harassment',
  'NS-violence': 'Violence',
  'NS-sexualContent': 'Sexual Content',
  'NS-sexual-content': 'Sexual Content',
  'NS-copyright': 'Copyright',
  'NS-falseInformation': 'Misinformation',
  'NS-false-information': 'Misinformation',
  'NS-aiGenerated': 'AI Generated',
  'NS-other': 'Other',
  'nonconsensual_sexual_content': 'Non-consensual',
  'credible_threats': 'Threats',
  'doxxing_pii': 'Doxxing/PII',
  'terrorism_extremism': 'Terrorism',
  'malware_scam': 'Malware/Scam',
  'illegal_goods': 'Illegal Goods',
  'hate_harassment': 'Hate/Harassment',
  'self_harm_suicide': 'Self-harm',
  'graphic_violence_gore': 'Violence/Gore',
  'bullying_abuse': 'Bullying',
  'adult_nudity': 'Nudity',
  'explicit_sex': 'Explicit',
  'pornography': 'Pornography',
  'spam': 'Spam',
  'Spam': 'Spam',
  'impersonation': 'Impersonation',
  'Impersonation': 'Impersonation',
  'harassment': 'Harassment',
  'nudity': 'Nudity',
  'illegal': 'Illegal',
  'copyright': 'Copyright',
  'aiGenerated': 'AI Generated',
  'ai-generated': 'AI Generated',
  'NS-ai-generated': 'AI Generated',
  'violence': 'Violence',
  'sexual-content': 'Sexual Content',
  'sexualContent': 'Sexual Content',
  'false-info': 'Misinformation',
  'falseInformation': 'Misinformation',
  'other': 'Other',
  'NS-underageUser': 'Under 16',
  'NS-childSafety': 'Child Safety',
};

export const RESOLUTION_STATUSES = ['reviewed', 'dismissed', 'no-action', 'false-positive'] as const;
export type ResolutionStatus = typeof RESOLUTION_STATUSES[number];

// Categories where media should be hidden by default for moderator safety
export const HIGH_PRIORITY_CATEGORIES = [
  'sexual_minors', 'csam', 'NS-csam',
  'nonconsensual_sexual_content', 'terrorism_extremism', 'credible_threats',
  'NS-underageUser', 'NS-childSafety',
];

// The exact report category that opens an age-review case (ReportWatcher gates
// on this same literal). Distinct from HIGH_PRIORITY_CATEGORIES: CSAM /
// child-safety are a separate, non-reversible path, not age review.
export const UNDERAGE_REPORT_CATEGORY = 'NS-underageUser';

// Authored-content kinds surfaced on moderation review cards (report detail's
// useUserStats and BannedUserCard). Video kinds per NIP-71: 21/22/34235/34236.
// 1111 (NIP-22 comments) and 6/16 (reposts) matter for moderation because
// comment-spam accounts often have no other content (#156, #159). One shared
// list so consuming surfaces can't drift. TODO(#162): UserProfilePreview
// (Labels page) still carries its own inline list — aligning it also needs
// the shared rendering pieces, tracked there.
export const RECENT_CONTENT_KINDS = [1, 6, 16, ...VIDEO_KINDS, 20, 1063, 1064, 1111, 30023] as const;

// Helper to get label with fallback
export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

// Extract category from a report event's tags
export function getReportCategory(event: { tags: string[][] }): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

// Divine profile URL base
export const DIVINE_PUBLIC_URL = "https://divine.video";
export const DIVINE_PROFILE_URL = "https://divine.video/profile";
export const NJUMP_PROFILE_URL = "https://njump.me";

// Build a profile URL, preferring divine.video when the user is indexed by Funnelcake
// (i.e., their profile exists on the relay). Falls back to njump.me to avoid empty pages.
export function getProfileUrl(npub: string, isFunnelcakeUser: boolean): string {
  return isFunnelcakeUser
    ? `${DIVINE_PROFILE_URL}/${npub}`
    : `${NJUMP_PROFILE_URL}/${npub}`;
}

// Build a public event URL. Only production routes to divine.video; staging/local
// fall back to njump so moderators never get kicked to production unexpectedly.
export function getPublicEventUrl(encodedRef: string, apiUrl?: string): string {
  const environment = apiUrl ? getEnvironmentByApiUrl(apiUrl) : undefined;
  return environment?.id === 'production'
    ? `${DIVINE_PUBLIC_URL}/${encodedRef}`
    : `${NJUMP_PROFILE_URL}/${encodedRef}`;
}

// Build a reason string for moderation decisions from a category key + optional note
export function buildReasonString(categoryKey: string, note?: string): string {
  const label = getCategoryLabel(categoryKey);
  return note?.trim() ? `${label}: ${note.trim()}` : label;
}

// Nostr event ids, pubkeys, and sha256 hashes are 64 hex chars. NIP-01
// canonical form is lowercase, but user-authored tag values may arrive
// uppercase — accept either and let display sites lowercase for consistency.
// Case-insensitive to match the existing inline checks in UserManagement/
// EventsList; TODO(#160): migrate those inline regexes to this helper.
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// A kind-1984 report's target ids: the first e/p tag values that are
// well-formed 64-hex ids (NIP-56). Tags are reporter-authored, so valueless
// or junk-valued tags (["e"], ["e", ""]) are skipped rather than allowed to
// mask a later valid tag of the same name. Returned ids are validated but
// not case-normalized — lowercase at display sites.
export function getReportTargetIds(event: { tags: string[][] }): { eventId?: string; pubkey?: string } {
  // Runtime guard despite the type: this feeds the crash fallback, which must
  // never crash itself, and raw payload shapes are normalized elsewhere.
  const tags = Array.isArray(event.tags) ? event.tags : [];
  return {
    eventId: tags.find(t => t[0] === 'e' && isHex64(t[1]))?.[1],
    pubkey: tags.find(t => t[0] === 'p' && isHex64(t[1]))?.[1],
  };
}
