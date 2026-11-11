export interface QuarantineReport { id: string; pubkey: string; reason: string; source?: object; sourceRef?: string }
export interface QuarantineSnapshot { event: object; assets: string[]; mediaPaths?: string[]; unmappedMediaPaths?: string[]; mappingIncomplete?: boolean }
export type QuarantineGoal = 'review' | 'hide' | 'restore' | 'remove';
export interface SexualCase {
  eventId: string;
  revision: number;
  goal: QuarantineGoal;
  state: 'review' | 'pending' | 'hidden' | 'restored' | 'restored_restricted' | 'removed' | 'out_of_scope';
  reporters: number;
  threshold: number;
  firstReport: QuarantineReport;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  attempts: number;
  retryAt: number;
  snapshot?: QuarantineSnapshot;
  snapshotRef?: string;
  /**
   * Set by the worker, never stored: the snapshot and the other media
   * identifiers were left out because the author is suspended, or because the
   * worker couldn't tell ('unknown'). A moderator opens it with an audited
   * `?snapshot=1` read.
   */
  snapshotWithheld?: 'suspended' | 'unknown';
  actor?: string;
  decisionAt?: number;
  decisionRecordedAt?: number;
  holdsAppliedAt?: number;
  mediaHoldAssets?: string[];
  deliveryAttempts?: number;
  deliveryRetryAt?: number;
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
