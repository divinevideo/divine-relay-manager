// ABOUTME: Storage and routes for bulk results kept for a person (#299): a job's
// ABOUTME: notes (files to check), and an age-review transition's failure lines.
import {
  ageReviewNotesJobRange,
  ageReviewNotesStep,
  type BulkNote,
} from '../../shared/bulk-moderation';

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// The table is created on demand, once per isolate, like bulk_jobs (see
// ensureBulkJobsTable in bulk-moderate.ts, which also calls this).
let notesSchemaReady = false;
export async function ensureBulkNotesTable(db: D1Database): Promise<void> {
  if (notesSchemaReady) return;
  // A job's notes for a person (#299; see storeBulkNotes). Its own table, so a
  // worker that predates it reads and writes bulk_jobs exactly as before.
  // `detail` holds a kept failure line ('' for a note); `restored_at` is set by
  // a guarded Restore (markStillHiddenRestored), whose lookup by file uses the
  // sha256 index.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS bulk_job_notes (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL DEFAULT '',
      owner TEXT,
      detail TEXT NOT NULL DEFAULT '',
      restored_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (job_id, kind, sha256, detail)
    )`
  ).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS bulk_job_notes_sha256 ON bulk_job_notes (sha256)').run();
  notesSchemaReady = true;
}

// Notes (see BulkNote) live in bulk_job_notes, one row per job, kind, file and
// detail: a queued job's under its job id, apart from its capped `failures`
// list, and an age-review transition's under ageReviewNotesJobId, where its
// failure lines are kept too (kind 'failure', the line in `detail`).
//
// D1 allows 100 bound parameters per statement and 1,000 queries per Worker
// invocation (Workers Paid). Each row binds 6, so a statement stores 16, and
// one write stores at most MAX_NOTES_PER_WRITE rows (313 statements), leaving
// room for the invocation's other queries. Every row up to that bound is kept;
// past it the caller records how many were not.
const NOTE_BINDS = 6;
const NOTES_PER_STATEMENT = Math.floor(100 / NOTE_BINDS);
const NOTES_PAGE_DEFAULT = 500;
const NOTES_PAGE_MAX = 1_000;

// Stores notes for a job, and failure lines (age review only) ahead of them.
// The table's unique key keeps each (kind, file) and each line once, however
// often they are sent. Returns how many rows were new. Throws when D1 refuses
// the write.
export async function storeBulkNotes(db: D1Database, jobId: string, notes: BulkNote[], failures: string[] = []): Promise<number> {
  const rows: Array<[kind: string, sha256: string, owner: string | null, detail: string]> = [
    ...failures.map((line): [string, string, null, string] => ['failure', '', null, line]),
    ...notes.map((note): [string, string, string | null, string] => (
      [note.kind, note.sha256, note.kind === 'not-owned' ? note.owner : null, '']
    )),
  ];
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += NOTES_PER_STATEMENT) {
    const batch = rows.slice(i, i + NOTES_PER_STATEMENT);
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO bulk_job_notes (job_id, kind, sha256, owner, detail, created_at) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`
    ).bind(...batch.flatMap(([kind, sha256, owner, detail]) => [jobId, kind, sha256, owner, detail, now])));
  }
  const results = await db.batch(statements);
  return results.reduce((n, result) => n + (result.meta?.changes ?? 0), 0);
}

// Deletes one failure line a job kept (age review's pending auto-delete line,
// once the delete has run), and nothing else. Returns how many rows went.
// Throws when D1 refuses the delete.
export async function deleteBulkFailure(db: D1Database, jobId: string, line: string): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM bulk_job_notes WHERE job_id = ? AND kind = 'failure' AND detail = ?"
  ).bind(jobId, line).run();
  return result.meta?.changes ?? 0;
}

// GET /api/bulk-moderate/case-notes/:caseId -- the notes key of an age-review
// case's most recent transition that kept any (see ageReviewNotesJobId), with
// its step (`state`) and when it was kept (`keptAt`), or a null key. The case
// screen then pages them from /api/bulk-moderate/notes/:jobId.
// A range scan, not LIKE: D1 caps a LIKE pattern at 50 bytes, and the range
// uses the table's (job_id, ...) index. A worker that predates kept notes
// answers 404 for the route, which the UI reads as none.
export async function handleCaseBulkNotesJob(
  caseId: string, env: { DB?: D1Database }, corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  let range: { start: string; end: string };
  try {
    range = ageReviewNotesJobRange(caseId);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400, corsHeaders);
  }
  await ensureBulkNotesTable(env.DB);
  const latest = await env.DB.prepare(
    'SELECT job_id, created_at FROM bulk_job_notes WHERE job_id >= ? AND job_id < ? ORDER BY rowid DESC LIMIT 1'
  ).bind(range.start, range.end).first<{ job_id: string; created_at: string }>();
  // The step and when it kept them, for the case screen to say so.
  return json(latest
    ? { jobId: latest.job_id, state: ageReviewNotesStep(latest.job_id), keptAt: latest.created_at }
    : { jobId: null }, 200, corsHeaders);
}

// GET /api/bulk-moderate/notes/:jobId?after=&limit= -- one page of a job's
// notes, oldest first, with the cursor for the next page (null after the
// last). A job with none, or one this worker never saw, has an empty page:
// a worker that predates notes answers 404 for the route instead, which the
// UI reads as "no notes".
export async function handleBulkJobNotes(
  jobId: string, after: string | null, limit: string | null, env: { DB?: D1Database }, corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  if (after !== null && !/^\d+$/.test(after)) return json({ error: '`after` must be a cursor from a previous page' }, 400, corsHeaders);
  if (limit !== null && !/^\d+$/.test(limit)) return json({ error: '`limit` must be a whole number' }, 400, corsHeaders);
  const pageSize = Math.min(Math.max(limit === null ? NOTES_PAGE_DEFAULT : Number(limit), 1), NOTES_PAGE_MAX);
  await ensureBulkNotesTable(env.DB);
  // One more row than the page, to know whether another page follows.
  const { results } = await env.DB.prepare(
    'SELECT rowid AS id, kind, sha256, owner, detail FROM bulk_job_notes WHERE job_id = ? AND rowid > ? ORDER BY rowid LIMIT ?'
  ).bind(jobId, after === null ? 0 : Number(after), pageSize + 1).all<{
    id: number; kind: string; sha256: string; owner: string | null; detail?: string | null;
  }>();
  const rows = results ?? [];
  const page = rows.slice(0, pageSize);
  const notes: BulkNote[] = [];
  const failures: string[] = [];
  for (const row of page) {
    if (row.kind === 'still-hidden') notes.push({ kind: 'still-hidden', sha256: row.sha256 });
    else if (row.kind === 'not-owned' && row.owner) notes.push({ kind: 'not-owned', sha256: row.sha256, owner: row.owner });
    else if (row.kind === 'failure' && row.detail) failures.push(row.detail);
  }
  const next = rows.length > pageSize ? String(page[page.length - 1].id) : null;
  // `failures` only when there are any (age review's kept lines).
  return json({ notes, ...(failures.length > 0 ? { failures } : {}), next }, 200, corsHeaders);
}
