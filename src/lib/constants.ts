// ABOUTME: Shared constants for moderation categories and labels
// ABOUTME: DTSP (Digital Trust & Safety Partnership) category mappings

export const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'csam': 'CSAM',
  'NS-csam': 'CSAM',
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
};

export const RESOLUTION_STATUSES = ['reviewed', 'dismissed', 'no-action', 'false-positive'] as const;
export type ResolutionStatus = typeof RESOLUTION_STATUSES[number];

// Categories where media should be hidden by default for moderator safety
export const HIGH_PRIORITY_CATEGORIES = [
  'sexual_minors', 'csam', 'NS-csam',
  'nonconsensual_sexual_content', 'terrorism_extremism', 'credible_threats',
];

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
export const DIVINE_PROFILE_URL = "https://divine.video/profile";

// Build a full profile URL from an npub
export function getDivineProfileUrl(npub: string): string {
  return `${DIVINE_PROFILE_URL}/${npub}`;
}

// Build a reason string for moderation decisions from a category key + optional note
export function buildReasonString(categoryKey: string, note?: string): string {
  const label = CATEGORY_LABELS[categoryKey] || categoryKey;
  return note?.trim() ? `${label}: ${note.trim()}` : label;
}
