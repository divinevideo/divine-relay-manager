// ABOUTME: Records each resolution label (kind 1985, moderation/resolution) in D1's resolution_labels.
// ABOUTME: Later reads take resolution state from this table instead of walking every label on the relay.

import { canonicalHex64 } from '../../shared/hex-id';
import { runStatements } from './report-index';

export interface SignedLabel {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type ResolutionLabelSource = 'publish' | 'backfill' | 'reconcile';

const NAMESPACE = 'moderation/resolution';
// D1 allows at most 100 bound parameters per statement. 9 columns x 11 rows = 99. Do not raise it.
const ROWS_PER_STATEMENT = 11;

const lower = (value: string): string => canonicalHex64(value) ?? value;

export function isResolutionLabel(event: { kind: number; tags: string[][] }): boolean {
  return event.kind === 1985 && event.tags.some(t => t[0] === 'L' && t[1] === NAMESPACE);
}

/**
 * INSERT OR IGNORE: a label is immutable, so the first write keeps its source and
 * recorded_at. One statement per 11 labels. Labels outside moderation/resolution are
 * skipped. target_event and target_pubkey come from the first e and p tag.
 */
export function resolutionLabelStatements(
  db: D1Database,
  labels: readonly SignedLabel[],
  source: ResolutionLabelSource,
  nowSec: number,
): D1PreparedStatement[] {
  const resolutions = labels.filter(isResolutionLabel);
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < resolutions.length; i += ROWS_PER_STATEMENT) {
    const chunk = resolutions.slice(i, i + ROWS_PER_STATEMENT);
    const params: unknown[] = [];
    for (const l of chunk) {
      const targetEvent = l.tags.find(t => t[0] === 'e')?.[1];
      const targetPubkey = l.tags.find(t => t[0] === 'p')?.[1];
      const status = l.tags.find(t => t[0] === 'l' && t[2] === NAMESPACE)?.[1];
      const eventJson = JSON.stringify({
        id: l.id, pubkey: l.pubkey, created_at: l.created_at, kind: l.kind,
        tags: l.tags, content: l.content, sig: l.sig,
      });
      params.push(
        lower(l.id), l.created_at, lower(l.pubkey),
        targetEvent ? lower(targetEvent) : null,
        targetPubkey ? lower(targetPubkey) : null,
        status ?? null, eventJson, source, nowSec,
      );
    }
    const rows = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO resolution_labels
         (label_id, created_at, signer_pubkey, target_event, target_pubkey, status, event_json, source, recorded_at)
       VALUES ${rows}`,
    ).bind(...params));
  }
  return statements;
}

export async function recordResolutionLabel(db: D1Database, event: SignedLabel, nowSec: number): Promise<void> {
  await runStatements(db, resolutionLabelStatements(db, [event], 'publish', nowSec));
}
