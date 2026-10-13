// ABOUTME: The single SQL rule for "no active legal hold covers this record at
// ABOUTME: this disposal stage", shared by every retention and consent sweep.

/**
 * A `NOT EXISTS` clause that holds when no active legal hold covers the record.
 * A hold covers it when its type matches, its key is the record's or NULL (a
 * hold on every record of that type), and its stage is `all` or `stage`.
 * Active means started, not released, and not expired.
 *
 * `recordKey` is a SQL expression for the record's key, such as a column.
 */
export const noLegalHold = (recordType: string, recordKey: string, stage: string): string => `NOT EXISTS (
  SELECT 1 FROM retention_legal_holds h
  WHERE h.record_type = '${recordType}'
    AND (h.record_key IS NULL OR h.record_key = ${recordKey})
    AND (h.disposal_stage = 'all' OR h.disposal_stage = '${stage}')
    AND datetime(h.starts_at) <= datetime('now')
    AND h.released_at IS NULL
    AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now'))
)`;
