// ABOUTME: Shared constants for moderation categories and labels
// ABOUTME: DTSP (Digital Trust & Safety Partnership) category mappings

export const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
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
  'impersonation': 'Impersonation',
  'copyright': 'Copyright',
  'aiGenerated': 'AI Generated',
  'ai-generated': 'AI Generated',
  'NS-ai-generated': 'AI Generated',
  'other': 'Other',
};

export const RESOLUTION_STATUSES = ['reviewed', 'dismissed', 'no-action', 'false-positive'] as const;
export type ResolutionStatus = typeof RESOLUTION_STATUSES[number];

// Helper to get label with fallback
export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}
