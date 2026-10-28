// ABOUTME: An in-memory D1 double for bulk_jobs and bulk_job_notes, shared by the
// ABOUTME: bulk-moderate test files. The real SQL is pinned in test/*.d1.test.ts.

// Functional in-memory D1 mock for the bulk_jobs table: supports the INSERT,
// positional-SET UPDATE, and SELECT-by-job_id statements the async path uses.
// Honors a `status IN (...)` / `status = '...'` guard in the UPDATE WHERE clause
// and reports meta.changes, so the consumer's sticky-status guards are exercised.
// `ageReview` answers the consumer's open-case lookup on age_review_cases: an
// open case exists only for `openCaseFor`, so a lookup bound to the wrong
// pubkey finds nothing. The query itself is pinned against real SQLite in
// test/age-review-lookup.d1.test.ts.
export function makeJobDb(ageReview: { openCaseFor?: string; lookupThrows?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  // Statements passed to DB.batch (the per-chunk decision-log writes).
  const batched: Array<{ sql: string; binds: unknown[] }> = [];
  // bulk_job_notes (#299): unique on (job_id, kind, sha256, detail), read back in
  // insertion order. The real SQL is pinned in test/bulk-job-notes.d1.test.ts.
  const notes: Array<{ id: number; job_id: string; kind: string; sha256: string; owner: string | null; detail: string; restored_at: string | null }> = [];
  const notesControl = { fail: false };
  function insertNotes(binds: unknown[]) {
    if (notesControl.fail) throw new Error('D1 write failed');
    let changes = 0;
    for (let i = 0; i < binds.length; i += 6) {
      const [job_id, kind, sha256, owner, detail] = binds.slice(i, i + 6) as [string, string, string, string | null, string];
      if (notes.some((n) => n.job_id === job_id && n.kind === kind && n.sha256 === sha256 && n.detail === detail)) continue;
      notes.push({ id: notes.length + 1, job_id, kind, sha256, owner, detail, restored_at: null });
      changes++;
    }
    return { success: true, meta: { changes } };
  }
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        sql,
        get binds() { return binds; },
        bind(...args: unknown[]) { binds = args; return stmt; },
        async all() {
          if (/FROM bulk_job_notes/i.test(sql)) {
            const [jobId, after, limit] = binds as [string, number, number];
            const results = notes.filter((n) => n.job_id === jobId && n.id > after).slice(0, limit)
              .map((n) => ({ id: n.id, kind: n.kind, sha256: n.sha256, owner: n.owner, detail: n.detail, restored_at: n.restored_at }));
            return { success: true, results };
          }
          return { success: true, results: [] };
        },
        async run() {
          if (/^\s*INSERT OR IGNORE INTO bulk_job_notes/i.test(sql)) return insertNotes(binds);
          if (/^\s*INSERT INTO bulk_jobs/i.test(sql)) {
            const [job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, version, created_at, updated_at, kind] = binds;
            rows.set(job_id as string, { job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, version, created_at, updated_at, kind: kind ?? null });
            return { success: true, meta: { changes: 1 } };
          }
          if (/^\s*UPDATE bulk_jobs/i.test(sql)) {
            const jobId = binds[binds.length - 1] as string;
            const row = rows.get(jobId);
            let changes = 0;
            if (row) {
              const where = sql.slice(sql.search(/WHERE/i));
              const inMatch = where.match(/status IN \(([^)]+)\)/i);
              const eqMatch = where.match(/status\s*=\s*'(\w+)'/i);
              let statusOk = true;
              if (inMatch) statusOk = inMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).includes(row.status as string);
              else if (eqMatch) statusOk = row.status === eqMatch[1];
              const versionOk = !/version\s*=\s*\?/i.test(where)
                || Number(row.version ?? 0) === Number(binds[binds.length - 2]);
              if (statusOk && versionOk) {
                if (/version\s*=\s*version\s*\+\s*1/i.test(sql)) {
                  row.status = binds[0];
                  row.updated_at = binds[1];
                  row.version = Number(row.version ?? 0) + 1;
                } else {
                  const cols = sql.match(/SET (.+) WHERE/i)![1].split(',').map((c) => c.trim().split('=')[0].trim());
                  cols.forEach((c, i) => { row[c] = binds[i]; });
                }
                changes = 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (/^\s*DELETE FROM bulk_jobs/i.test(sql)) {
            const existed = rows.delete(binds[0] as string);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } }; // CREATE TABLE / ALTER TABLE
        },
        async first() {
          if (/age_review_cases/i.test(sql)) {
            if (ageReview.lookupThrows) throw new Error('D1 unavailable');
            return binds[0] === ageReview.openCaseFor ? { id: 'case-open', pubkey: binds[0], state: 'open_reported' } : null;
          }
          if (/COUNT\(\*\)[\s\S]*FROM bulk_job_notes/i.test(sql)) {
            return { n: notes.filter((n) => n.job_id === binds[0]).length };
          }
          return rows.get(binds[0] as string) ?? null;
        },
      };
      return stmt;
    },
    batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
      const results = [];
      for (const st of stmts) {
        if (/^\s*INSERT OR IGNORE INTO bulk_job_notes/i.test(st.sql)) {
          results.push(insertNotes(st.binds));
        } else {
          batched.push({ sql: st.sql, binds: st.binds });
          results.push({ success: true, meta: { changes: 0 } });
        }
      }
      return results;
    },
  };
  return { db: db as unknown as D1Database, rows, batched, notes, notesControl };
}
