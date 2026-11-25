// ABOUTME: Write and lookup helpers for Relay Manager's own copy of reports (report_index).
// ABOUTME: Statements are chunked to stay under D1's 100 bound parameters; first write wins.

import { canonicalHex64 } from '../../shared/hex-id';
import { getReportTarget } from '../../shared/report-target';

export type ReportIndexSource = 'live' | 'catchup' | 'incremental' | 'full' | 'backfill';
export type HiddenReason =
  | 'reporter_banned'
  | 'reporter_suspended'
  | 'reporter_deactivated'
  | 'reporter_divine_only'
  | 'unknown';

export interface SignedReport {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 1984;
  tags: string[][];
  content: string;
  sig: string;
}

// D1 allows at most 100 bound parameters per statement. 8 columns x 12 rows = 96;
// 3 columns x 33 rows = 99; one id per placeholder x 100 = 100. Do not raise any of them.
const INDEX_ROWS_PER_STATEMENT = 12;
const REF_ROWS_PER_STATEMENT = 33;
const LOOKUP_IDS_PER_STATEMENT = 100;
// db.batch group size, bounding how many statements one round trip carries.
const BATCH_SIZE = 50;

const lower = (value: string): string => canonicalHex64(value) ?? value;

/**
 * INSERT OR IGNORE: the first write of a report keeps its source and indexed_at,
 * so a later full sweep cannot relabel a report first seen live. One statement per
 * chunk of rows, never one per row.
 */
export function reportIndexStatements(
  db: D1Database,
  reports: readonly SignedReport[],
  source: ReportIndexSource,
  nowSec: number,
): D1PreparedStatement[] {
  return [
    ...reportIndexRowStatements(db, reports, source, nowSec),
    ...reportIndexRefStatements(db, reports),
  ];
}

/**
 * The report_index row statements alone: one per 12 reports, so a single report
 * is always one statement however many tags it carries. A caller that must stay
 * under the batch limit for an attacker-sized report writes these atomically
 * with its other first-seen writes and sends the refs separately.
 */
export function reportIndexRowStatements(
  db: D1Database,
  reports: readonly SignedReport[],
  source: ReportIndexSource,
  nowSec: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < reports.length; i += INDEX_ROWS_PER_STATEMENT) {
    const chunk = reports.slice(i, i + INDEX_ROWS_PER_STATEMENT);
    const params: unknown[] = [];
    for (const r of chunk) {
      const target = getReportTarget(r);
      const eventJson = JSON.stringify({
        id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind,
        tags: r.tags, content: r.content, sig: r.sig,
      });
      params.push(
        lower(r.id), r.created_at, lower(r.pubkey),
        target?.type ?? null, target?.value ?? null,
        eventJson, source, nowSec,
      );
    }
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO report_index
             (report_id, created_at, reporter_pubkey, target_type, target_id, event_json, source, indexed_at)
           VALUES ${values}`,
        )
        .bind(...params),
    );
  }
  return statements;
}

/** The report_index_refs statements alone: 33 refs each, and unbounded in count for a tag-stuffed report. */
export function reportIndexRefStatements(
  db: D1Database,
  reports: readonly SignedReport[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const refs: Array<[string, string, string]> = [];
  for (const r of reports) {
    const reportId = lower(r.id);
    for (const tag of Array.isArray(r.tags) ? r.tags : []) {
      if (!Array.isArray(tag) || (tag[0] !== 'e' && tag[0] !== 'p') || typeof tag[1] !== 'string') continue;
      refs.push([tag[0], lower(tag[1]), reportId]);
    }
  }
  for (let i = 0; i < refs.length; i += REF_ROWS_PER_STATEMENT) {
    const chunk = refs.slice(i, i + REF_ROWS_PER_STATEMENT);
    const values = chunk.map(() => '(?, ?, ?)').join(', ');
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO report_index_refs (ref_type, ref_value, report_id) VALUES ${values}`)
        .bind(...chunk.flat()),
    );
  }

  return statements;
}

/** db.batch in groups of BATCH_SIZE, results concatenated in statement order. */
async function batchInGroups<T = unknown>(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  const results: D1Result<T>[] = [];
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    results.push(...(await db.batch<T>(statements.slice(i, i + BATCH_SIZE))));
  }
  return results;
}

export async function runStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  await batchInGroups(db, statements);
}

export async function indexReports(
  db: D1Database,
  reports: readonly SignedReport[],
  source: ReportIndexSource,
  nowSec: number,
): Promise<void> {
  await runStatements(db, reportIndexStatements(db, reports, source, nowSec));
}

/**
 * Ids in neither report_index nor report_arrivals. Each table gets its own
 * statement per chunk (one IN list of 100 ids each): a single statement naming
 * both lists would bind 200 parameters (D1 rejects that). The statements go
 * out through the shared 50-per-batch grouping.
 *
 * Ids are lowercased here, not left to callers: rows are stored lowercase, and
 * a case mismatch would report a stored report as unseen and let the
 * non-idempotent live handler run twice on it. Returned ids are lowercase.
 */
export async function findUnseenReportIds(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const unseen = new Set(ids.map(lower));
  if (unseen.size === 0) return unseen;
  const canonical = [...unseen];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < canonical.length; i += LOOKUP_IDS_PER_STATEMENT) {
    const chunk = canonical.slice(i, i + LOOKUP_IDS_PER_STATEMENT);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const table of ['report_index', 'report_arrivals']) {
      statements.push(
        db.prepare(`SELECT report_id FROM ${table} WHERE report_id IN (${placeholders})`).bind(...chunk),
      );
    }
  }
  const results = await batchInGroups<{ report_id: string }>(db, statements);
  for (const result of results) {
    for (const row of result.results ?? []) unseen.delete(row.report_id);
  }
  return unseen;
}

export const META_KEYS = [
  'backfill_certified_at', 'last_full_ok_at', 'last_full_attempt_at', 'last_full_seen_count',
  'last_incremental_ok_at', 'watcher_last_alive_at', 'last_shadow_missing', 'last_shadow_extra',
  'labels_certified_at', 'labels_last_attempt_at', 'labels_last_ok_at', 'reconcile_negentropy_disabled',
] as const;
export type MetaKey = typeof META_KEYS[number];

export async function readMeta(db: D1Database): Promise<Partial<Record<MetaKey, number>>> {
  const { results } = await db
    .prepare('SELECT key, value FROM report_index_meta')
    .all<{ key: string; value: number }>();
  const meta: Partial<Record<MetaKey, number>> = {};
  for (const row of results ?? []) {
    if ((META_KEYS as readonly string[]).includes(row.key)) meta[row.key as MetaKey] = row.value;
  }
  return meta;
}

export function metaStatement(db: D1Database, key: MetaKey, value: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO report_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value);
}
