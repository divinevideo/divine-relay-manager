// ABOUTME: First-seen time per report id (#324).
// ABOUTME: The reporter's client sets created_at, so "which report is newer" is decided by arrival.

// D1 allows at most 100 bound parameters per statement, and each chunk binds
// one per id for reads and two per row for writes, so neither exceeds that cap.
const READ_CHUNK = 100;
const WRITE_CHUNK = 50;

/** The first-arrival write statements, chunked within D1's 100-parameter cap. */
export function reportArrivalStatements(
  db: D1Database,
  reportIds: readonly string[],
  seenAt: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < reportIds.length; i += WRITE_CHUNK) {
    const chunk = reportIds.slice(i, i + WRITE_CHUNK);
    const values = chunk.map(() => '(?, ?)').join(', ');
    const params: Array<string | number> = [];
    for (const reportId of chunk) params.push(reportId, seenAt);
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO report_arrivals (report_id, first_seen_at) VALUES ${values}`)
        .bind(...params),
    );
  }
  return statements;
}

/** The first-arrival write as a statement, so a caller can batch it with others. */
export function reportArrivalStatement(db: D1Database, reportId: string, seenAt: number): D1PreparedStatement {
  return reportArrivalStatements(db, [reportId], seenAt)[0];
}

/** First arrival wins: a replayed or concurrently delivered report keeps its original time. */
export async function recordReportArrival(db: D1Database, reportId: string, seenAt: number): Promise<void> {
  await reportArrivalStatement(db, reportId, seenAt).run();
}

/**
 * Ids with no row (never seen live) are absent from the map. One statement per
 * chunk of ids, all sent in a single batch: the feed asks for thousands of ids,
 * and one round trip per chunk would add up to hundreds of serial queries.
 */
export async function readReportArrivals(
  db: D1Database,
  reportIds: readonly string[],
): Promise<Map<string, number>> {
  const arrivals = new Map<string, number>();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < reportIds.length; i += READ_CHUNK) {
    const chunk = reportIds.slice(i, i + READ_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    statements.push(
      db
        .prepare(`SELECT report_id, first_seen_at FROM report_arrivals WHERE report_id IN (${placeholders})`)
        .bind(...chunk),
    );
  }
  if (statements.length === 0) return arrivals;
  const results = await db.batch<{ report_id: string; first_seen_at: number }>(statements);
  for (const result of results) {
    for (const row of result.results ?? []) arrivals.set(row.report_id, row.first_seen_at);
  }
  return arrivals;
}
