// ABOUTME: First-seen time per report id (#324).
// ABOUTME: The reporter's client sets created_at, so "which report is newer" is decided by arrival.

// D1 caps bound parameters per statement; stay well under it.
const READ_CHUNK = 100;

/** First arrival wins: a replayed or concurrently delivered report keeps its original time. */
export async function recordReportArrival(db: D1Database, reportId: string, seenAt: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO report_arrivals (report_id, first_seen_at) VALUES (?, ?)')
    .bind(reportId, seenAt)
    .run();
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
