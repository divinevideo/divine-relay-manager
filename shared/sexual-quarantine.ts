export interface QuarantineReport { id: string; pubkey: string; reason: string; source?: object }
export interface QuarantineSnapshot { event: object; assets: string[]; mediaPaths?: string[] }
export type QuarantineGoal = 'review' | 'hide' | 'restore' | 'remove';
export interface SexualCase {
  eventId: string;
  revision: number;
  goal: QuarantineGoal;
  state: 'review' | 'pending' | 'hidden' | 'restored' | 'restored_restricted' | 'removed';
  reporters: number;
  threshold: number;
  firstReport: QuarantineReport;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  attempts: number;
  retryAt: number;
  snapshot?: QuarantineSnapshot;
  actor?: string;
  decisionAt?: number;
  firstHiddenAt?: number;
  hideTriggeredAt?: number;
  lastFailureStage?: string;
  reason?: string;
  verifiedAt?: number;
  lastCheckedAt?: number;
  reviewAcceptedAt?: number;
  escalatedAt?: number;
  lastError?: string;
}
