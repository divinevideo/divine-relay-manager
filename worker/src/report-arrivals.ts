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

/** Ids with no row (never seen live) are absent from the map. */
export async function readReportArrivals(
  db: D1Database,
  reportIds: readonly string[],
): Promise<Map<string, number>> {
  const arrivals = new Map<string, number>();
  for (let i = 0; i < reportIds.length; i += READ_CHUNK) {
    const chunk = reportIds.slice(i, i + READ_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT report_id, first_seen_at FROM report_arrivals WHERE report_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ report_id: string; first_seen_at: number }>();
    for (const row of results ?? []) arrivals.set(row.report_id, row.first_seen_at);
  }
  return arrivals;
}
