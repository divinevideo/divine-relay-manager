// ABOUTME: Bulk media actions find an account's files through the media server's
// ABOUTME: uploader list (#299): the walks, owner checks, notes and fallbacks.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBulkModeration,
  handleBulkModerateEnqueue,
  processBulkJob,
  handleBulkJobStatus,
  VIDEO_MAX_PAGES,
  type BulkModerateEnv,
} from './bulk-moderate';
import { handleBulkJobNotes } from './bulk-notes';
import type { BulkAction, BulkJob, BulkJobMessage, BulkEnqueueResponse, BulkNote, BulkNotesPage } from '../../shared/bulk-moderation';
import { banEvent, getAdminPubkey } from './nip86';
import { createBulkWorld, fakeHash, type BulkWorld, type BlobStatus } from './test-helpers/bulk-world';
import { makeJobDb } from './test-helpers/bulk-job-db';

vi.mock('./nip86', () => ({
  getAdminPubkey: vi.fn().mockResolvedValue('moderator-pubkey'),
  banEvent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('./zendesk-sync', () => ({
  syncZendeskAfterAction: vi.fn().mockResolvedValue(undefined),
}));

// The bindings every test here starts from; each replaces MODERATION_API and DB
// with the world's and the job table's.
function baseEnv(): BulkModerateEnv {
  return {
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.test',
    BLOSSOM_WEBHOOK_SECRET: 'test-blossom-secret',
    CDN_DOMAIN: 'media.test',
  };
}

// #299: funnelcake's public video list hides a banned event at once, and every
// video of a banned or suspended account. Bulk media actions used it as their
// only list of files, so Delete All (which bans the events first), Ban followed
// by Delete All, and age review's restrict and deny steps (which suspend or ban
// the account first) found nothing and still finished clean. Files now come
// from the media server's per-uploader list as well, which does not depend on
// what the relay shows, and only files the account owns are touched.
describe('bulk media actions find the account\'s files through the media server (#299)', () => {
  const ACCOUNT = 'a1'.repeat(32);
  const OTHER = 'b2'.repeat(32);
  const LEGACY_MESSAGE_KEYS = ['jobId', 'pubkey', 'action', 'reason', 'phase', 'cursor', 'mediaPage', 'eventIds', 'version'];
  let world: BulkWorld;
  let jobDb: ReturnType<typeof makeJobDb>;
  let sent: BulkJobMessage[];
  let env: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    world = createBulkWorld();
    world.install();
    vi.mocked(getAdminPubkey).mockResolvedValue('moderator-pubkey');
    vi.mocked(banEvent).mockReset();
    vi.mocked(banEvent).mockImplementation((eventId: string) => world.banEvent(eventId));
    jobDb = makeJobDb();
    sent = [];
    env = {
      ...baseEnv(),
      MODERATION_API: world.moderationApi,
      DB: jobDb.db,
      BULK_QUEUE: { send: vi.fn(async (m: BulkJobMessage) => { sent.push(m); }) } as unknown as Queue<BulkJobMessage>,
    };
  });

  async function enqueue(action: BulkAction): Promise<{ jobId: string; first: BulkJobMessage }> {
    const res = await handleBulkModerateEnqueue(
      new Request('https://test/api/bulk-moderate', { method: 'POST', body: JSON.stringify({ pubkey: ACCOUNT, action }) }), env, {},
    );
    const { jobId } = await res.json() as BulkEnqueueResponse;
    return { jobId, first: sent.shift()! };
  }

  // Runs a job to the end, one message per invocation as the queue does, and
  // returns every message it sent and the writes each invocation made.
  async function drain(first: BulkJobMessage) {
    const messages: BulkJobMessage[] = [];
    const writesPerMessage: number[] = [];
    let msg: BulkJobMessage | undefined = first;
    for (let i = 0; msg && i < 1000; i++) {
      sent.length = 0;
      const before = world.writes.length;
      await processBulkJob(msg, env);
      writesPerMessage.push(world.writes.length - before);
      expect(sent.length).toBeLessThanOrEqual(1);
      msg = sent[0];
      if (msg) messages.push(msg);
    }
    return { messages, writesPerMessage };
  }

  // Every note a job stored, read back through the notes route in small pages,
  // as the UI pages it.
  async function readNotes(jobId: string, limit = 2): Promise<BulkNote[]> {
    const notes: BulkNote[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      const res = await handleBulkJobNotes(jobId, after, String(limit), env, {});
      expect(res.status).toBe(200);
      const page = await res.json() as BulkNotesPage;
      expect(page.notes.length).toBeLessThanOrEqual(limit);
      notes.push(...page.notes);
      if (page.next === null) return notes;
      after = page.next;
    }
    throw new Error('notes never ended');
  }

  async function runQueued(action: BulkAction) {
    const { jobId, first } = await enqueue(action);
    const { messages, writesPerMessage } = await drain(first);
    const row = jobDb.rows.get(jobId)!;
    const status = await (await handleBulkJobStatus(jobId, env, {})).json() as BulkJob;
    return {
      jobId, row, messages, writesPerMessage, failures: JSON.parse(row.failures as string) as string[],
      noteCount: status.noteCount, notes: () => readNotes(jobId),
    };
  }

  const stillHidden = (hashes: string[]): BulkNote[] => hashes.map((sha256) => ({ kind: 'still-hidden', sha256 }));
  const ownedBy = (owner: string, hashes: string[]): BulkNote[] => hashes.map((sha256) => ({ kind: 'not-owned', sha256, owner }));
  const byHash = (notes: BulkNote[]) => [...notes].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));

  function statuses(hashes: string[]): Array<BlobStatus | undefined> {
    return hashes.map((h) => world.statusOf(h));
  }

  describe('the cases that found nothing before', () => {
    it('queued Delete All deletes the files of the videos whose events it deleted', async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      const { row } = await runQueued('delete-all');
      expect(statuses(files)).toEqual(['deleted', 'deleted', 'deleted']);
      expect(row).toMatchObject({ status: 'done', events_processed: 3, media_processed: 3, media_skipped: 0, failures: '[]' });
    });

    it('Delete All on a banned account deletes its files', async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      const { row } = await runQueued('delete-all');
      expect(statuses(files)).toEqual(['deleted', 'deleted', 'deleted']);
      expect(row).toMatchObject({ status: 'done', events_processed: 0, media_processed: 3, failures: '[]' });
    });

    it("age review's restrict step (suspend the account, then withhold) hides its files", async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.suspendedPubkeys.add(ACCOUNT);
      const result = await runBulkModeration(env, ACCOUNT, 'age-restrict-all', 'Age review restriction');
      expect(statuses(files)).toEqual(['restricted', 'restricted', 'restricted']);
      expect(result).toMatchObject({ success: true, mediaProcessed: 3, mediaSkipped: 0, failures: [] });
    });

    it("age review's deny step with auto-delete (ban the account, then Delete All) deletes its files", async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      const result = await runBulkModeration(env, ACCOUNT, 'delete-all', 'Age review denied');
      expect(statuses(files)).toEqual(['deleted', 'deleted', 'deleted']);
      expect(result).toMatchObject({ success: true, mediaProcessed: 3, failures: [] });
    });

    // Every bulk media action that tightens or deletes, on both paths, for an
    // account the relay hides. Un-age-restrict All is not one of them: it does
    // not use the media server's list to choose files (see its own block).
    const EVERY_TIGHTENING_ACTION = [
      ['age-restrict-all', 'active', 'unknown', 'restricted'],
      ['age-gate-all', 'active', 'unknown', 'age_restricted'],
      ['delete-all', 'active', 'unknown', 'deleted'],
    ] as const;

    it.each(EVERY_TIGHTENING_ACTION)("synchronous %s acts on a suspended account's files", async (action, before, record, after) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      for (const h of files) { world.blobs.get(h)!.status = before; world.records.set(h, record); }
      world.suspendedPubkeys.add(ACCOUNT);
      const result = await runBulkModeration(env, ACCOUNT, action, 'r');
      expect(statuses(files)).toEqual([after, after]);
      expect(result).toMatchObject({ success: true, mediaProcessed: 2 });
    });

    it.each(EVERY_TIGHTENING_ACTION)("queued %s acts on a suspended account's files", async (action, before, record, after) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      for (const h of files) { world.blobs.get(h)!.status = before; world.records.set(h, record); }
      world.suspendedPubkeys.add(ACCOUNT);
      const { row } = await runQueued(action);
      expect(statuses(files)).toEqual([after, after]);
      expect(row).toMatchObject({ status: 'done', media_processed: 2, failures: '[]' });
    });
  });

  describe('which files are touched', () => {
    // The uploader list is keyed by who uploaded: a re-upload of someone else's
    // file is listed under the re-uploader but owned by the first uploader, and
    // a DELETE removes the file for everyone. An account's event can also point
    // at a file someone else uploaded.
    function addOthersFiles() {
      const reupload = fakeHash('c', 1);
      world.addBlob({ sha256: reupload, owner: OTHER }, [OTHER, ACCOUNT]);
      const reposted = fakeHash('c', 2);
      world.addBlob({ sha256: reposted, owner: OTHER }, [OTHER]);
      world.addVideo(ACCOUNT, 'repost-event', reposted, 2_000_000);
      return [reupload, reposted];
    }

    // Each one is a note naming its owner, so the moderator has a lead to the
    // account that holds it. A note, not a failure: the action did what it
    // should. And none is counted as "left as they were (already blocked or
    // deleted)", which would not be true of them.
    it('queued: only files the account owns, wherever they are listed; each of the rest is a note naming its owner', async () => {
      const own = world.addAccountVideos(ACCOUNT, 2);
      const others = addOthersFiles();
      const { row, noteCount, notes } = await runQueued('age-gate-all');
      expect(statuses(own)).toEqual(['age_restricted', 'age_restricted']);
      expect(statuses(others)).toEqual(['active', 'active']);
      expect(others.flatMap((h) => world.writesFor(h))).toEqual([]);
      expect(row).toMatchObject({ status: 'done', media_processed: 2, media_skipped: 0, failures: '[]' });
      expect(noteCount).toBe(2);
      expect(byHash(await notes())).toEqual(byHash(ownedBy(OTHER, others)));
    });

    it('synchronous: only files the account owns, wherever they are listed; each of the rest is a note naming its owner', async () => {
      const own = world.addAccountVideos(ACCOUNT, 2);
      const others = addOthersFiles();
      const result = await runBulkModeration(env, ACCOUNT, 'delete-all', 'r');
      expect(statuses(own)).toEqual(['deleted', 'deleted']);
      expect(statuses(others)).toEqual(['active', 'active']);
      expect(others.flatMap((h) => world.writesFor(h))).toEqual([]);
      expect(result).toMatchObject({ success: true, mediaProcessed: 2, mediaSkipped: 0, failures: [] });
      expect(byHash(result.notes)).toEqual(byHash(ownedBy(OTHER, others)));
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])("%s: another account's file is judged by its owner before its recorded decision is read", async (_label, path) => {
      // Its recorded decision cannot be read. That must not fail this
      // account's run as "could not read current status": the file is not
      // this action's to change whatever its status.
      const [, reposted] = addOthersFiles();
      world.recordReadFailures.set(reposted, 503);
      let failures: string[];
      let notes: BulkNote[];
      if (path === 'q') {
        const run = await runQueued('age-restrict-all');
        failures = run.failures;
        notes = await run.notes();
      } else {
        ({ failures, notes } = await runBulkModeration(env, ACCOUNT, 'age-restrict-all', 'r'));
      }
      expect(notes).toContainEqual({ kind: 'not-owned', sha256: reposted, owner: OTHER });
      expect(failures).toEqual([]);
      const recordReads = vi.mocked(world.moderationApi.fetch).mock.calls
        .filter(([input]) => String(input).includes(`/check-result/${reposted}`));
      expect(recordReads).toEqual([]);
    });

    it('compares the owner as lowercase hex', async () => {
      const file = fakeHash('d', 1);
      world.addBlob({ sha256: file, owner: ACCOUNT.toUpperCase() }, [ACCOUNT]);
      world.bannedPubkeys.add(ACCOUNT);
      const { row } = await runQueued('delete-all');
      expect(world.statusOf(file)).toBe('deleted');
      expect(row).toMatchObject({ media_processed: 1, media_skipped: 0 });
    });

    it('leaves a file alone, and reports it, when its owner cannot be read', async () => {
      const [unreadable, readable] = world.addAccountVideos(ACCOUNT, 2);
      world.ownerless.add(unreadable);
      world.bannedPubkeys.add(ACCOUNT);
      const { row, failures } = await runQueued('delete-all');
      expect(world.writesFor(unreadable)).toEqual([]);
      expect(world.statusOf(readable)).toBe('deleted');
      expect(failures).toEqual([expect.stringMatching(new RegExp(`^media:${unreadable}:.*owner`))]);
      expect(row).toMatchObject({ status: 'done', media_processed: 1, media_skipped: 0 });
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s Delete All on a banned account leaves a blocked file alone and counts it', async (_label, path) => {
      const own = world.addAccountVideos(ACCOUNT, 2);
      const blocked = fakeHash('d', 2);
      world.addBlob({ sha256: blocked, owner: ACCOUNT, status: 'banned' });
      world.records.set(blocked, 'permanent_ban');
      world.bannedPubkeys.add(ACCOUNT);
      if (path === 'q') {
        const { row } = await runQueued('delete-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 2, media_skipped: 1, failures: '[]' });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'delete-all', 'r'))
          .toMatchObject({ success: true, mediaProcessed: 2, mediaSkipped: 1, failures: [] });
      }
      expect(world.statusOf(blocked)).toBe('banned');
      expect(world.writesFor(blocked)).toEqual([]);
      expect(statuses(own)).toEqual(['deleted', 'deleted']);
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: also acts on an owned file the uploader list missed, and changes and counts a file both lists show once', async (_label, path) => {
      const indexed = world.addAccountVideos(ACCOUNT, 2);
      const unindexed = fakeHash('e', 1);
      world.addBlob({ sha256: unindexed, owner: ACCOUNT }, []);
      world.addVideo(ACCOUNT, 'unindexed-event', unindexed, 3_000_000);
      if (path === 'q') {
        const { row } = await runQueued('age-gate-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 3, media_skipped: 0, failures: '[]' });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'age-gate-all', 'r'))
          .toMatchObject({ success: true, mediaProcessed: 3, mediaSkipped: 0 });
      }
      for (const h of [...indexed, unindexed]) expect(world.writesFor(h)).toEqual(['AGE_RESTRICTED']);
    });
  });

  // The job falls back to funnelcake's list, says so, and cannot end clean.
  describe('when the file list cannot be read', () => {
    const FAILURES: ReadonlyArray<readonly [string, () => void, RegExp]> = [
      ['answers 500', () => world.failList(500), /media server returned 500/],
      ['answers with something that is not JSON', () => world.failList('not-json'), /JSON/],
      ['answers with something that is not a list', () => world.failList('not-array'), /not a list/],
      ['lists a file with no valid hash', () => world.failList('bad-row'), /no valid sha256/],
      ['does not answer in time', () => {
        world.failList('hang');
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')));
      }, /timed out/],
      ['secret is not bound', () => { env.BLOSSOM_WEBHOOK_SECRET = undefined; }, /BLOSSOM_WEBHOOK_SECRET not configured/],
      ['secret is empty', () => { env.BLOSSOM_WEBHOOK_SECRET = ''; }, /BLOSSOM_WEBHOOK_SECRET not configured/],
      ['secret cannot be read from the Secrets Store', () => {
        env.BLOSSOM_WEBHOOK_SECRET = { get: async () => { throw new Error('secrets store unavailable'); } };
      }, /secrets store unavailable/],
    ];
    // The synchronous path and a funnelcake-walk read choose every file from
    // the relay's list; a failed blossom-walk read chooses the rest from it.
    // Only a queued job's line says its count may be off: the synchronous
    // path's count is exact (MediaPass).
    const FALLBACK = new RegExp(`^enumeration:${ACCOUNT}:could not list this account's files: .*; (files|the rest) were chosen from the relay's list only, so the count of files left as they were may be off$`);
    const SYNC_FALLBACK = new RegExp(`^enumeration:${ACCOUNT}:could not list this account's files: .*; files were chosen from the relay's list only$`);

    it.each(FAILURES)('a queued job falls back to the relay\'s list, and says so, when the list %s', async (_label, arrange, reason) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      world.bannedPubkeys.add(ACCOUNT);
      arrange();
      const { row, failures } = await runQueued('delete-all');
      expect(row.status).toBe('done');
      const fallback = failures.filter((f) => FALLBACK.test(f));
      expect(fallback.length).toBeGreaterThan(0);
      expect(fallback[0]).toMatch(reason);
      expect(failures.every((f) => f.startsWith(`enumeration:${ACCOUNT}:could not list this account's files: `))).toBe(true);
      // The relay hides a banned account's videos, so nothing was found.
      expect(world.writes).toEqual([]);
      expect(statuses(files)).toEqual(['active', 'active']);
    });

    it.each(FAILURES)('the synchronous path falls back to the relay\'s list, and says so, when the list %s', async (_label, arrange, reason) => {
      world.addAccountVideos(ACCOUNT, 2);
      arrange();
      const result = await runBulkModeration(env, ACCOUNT, 'delete-all', 'r');
      expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(false);
      expect(result.failures[0]).toMatch(SYNC_FALLBACK);
      expect(result.failures[0]).toMatch(reason);
    });

    // A read that fails once, in one walk, is named for that walk; the reads
    // around it still work.
    it.each([
      ['the blossom walk', 0, 'delete-all', true],
      ["the funnelcake walk's", 1, 'age-gate-all', false],
    ] as const)('a queued job says so when only %s read of the list fails', async (_label, failingRead, action, banned) => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      if (banned) world.bannedPubkeys.add(ACCOUNT);
      world.onListRead((readsBefore) => { world.failList(readsBefore === failingRead ? 500 : null); });
      const { row, failures } = await runQueued(action);
      expect(failures).toEqual([expect.stringMatching(FALLBACK)]);
      // The end-of-walk check reaches what the failed read hid.
      expect(row).toMatchObject({ status: 'done', media_processed: 3, media_skipped: 0 });
      expect(statuses(files).every((s) => s === (banned ? 'deleted' : 'age_restricted'))).toBe(true);
    });

    // More files than the end-of-walk check's one chunk, so only the
    // funnelcake walk can reach them: after a failed blossom-walk read it must
    // not exclude what the uploader list shows, on any of its pages.
    it.each([
      ['first', 0],
      ['second', 1],
    ] as const)('a queued job changes every file when the %s blossom-walk read of the list fails', async (_label, failingRead) => {
      const files = world.addAccountVideos(ACCOUNT, 250);
      world.onListRead((readsBefore) => { world.failList(readsBefore === failingRead ? 500 : null); });
      const { row, failures, messages } = await runQueued('age-gate-all');
      expect(statuses(files).filter((s) => s === 'age_restricted')).toHaveLength(250);
      expect(row).toMatchObject({ status: 'done', media_processed: 250, media_skipped: 0 });
      expect(failures).toEqual([
        expect.stringMatching(new RegExp(`^enumeration:${ACCOUNT}:could not list this account's files: media server returned 500; the rest were chosen from the relay's list only, so the count of files left as they were may be off$`)),
      ]);
      const funnelcake = messages.filter((m) => m.mediaWalk === 'funnelcake');
      expect(funnelcake.length).toBeGreaterThan(1);
      expect(funnelcake.every((m) => m.mediaFallback === true)).toBe(true);
    });

    it('a funnelcake-walk message without the fallback mark still excludes what the uploader list shows', async () => {
      // What the exclusion is for: a visible account's blocked video is
      // counted as left once, by the blossom walk, not again by funnelcake's.
      const own = world.addAccountVideos(ACCOUNT, 2);
      const blocked = fakeHash('d', 3);
      world.addBlob({ sha256: blocked, owner: ACCOUNT, status: 'banned' });
      world.records.set(blocked, 'permanent_ban');
      world.addVideo(ACCOUNT, 'blocked-event', blocked, 2_500_000);
      const { row, messages } = await runQueued('age-gate-all');
      expect(statuses(own)).toEqual(['age_restricted', 'age_restricted']);
      // The exclusion leaves the funnelcake walk no file, but its events are
      // still counted from funnelcake's page (one video == one event).
      expect(row).toMatchObject({ status: 'done', events_processed: 3, media_processed: 2, media_skipped: 1, failures: '[]' });
      expect(messages.some((m) => 'mediaFallback' in m)).toBe(false);
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])("%s: the relay's list is still acted on when the media server's cannot be read", async (_label, path) => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.failList(500);
      if (path === 'q') {
        const { row, failures } = await runQueued('age-gate-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 3 });
        expect(failures.some((f) => FALLBACK.test(f))).toBe(true);
      } else {
        const result = await runBulkModeration(env, ACCOUNT, 'age-gate-all', 'r');
        expect(result).toMatchObject({ success: false, mediaProcessed: 3 });
        expect(result.failures).toEqual([expect.stringMatching(SYNC_FALLBACK)]);
      }
      expect(statuses(files)).toEqual(['age_restricted', 'age_restricted', 'age_restricted']);
    });
  });

  describe('only video files', () => {
    // The same list holds the account's avatars, sounds and subtitles.
    function addOtherMedia() {
      const files = {
        avatar: fakeHash('7', 1), sound: fakeHash('7', 2), subtitles: fakeHash('7', 3), document: fakeHash('7', 4),
      };
      world.addBlob({ sha256: files.avatar, owner: ACCOUNT, type: 'image/jpeg' });
      world.addBlob({ sha256: files.sound, owner: ACCOUNT, type: 'audio/aac' });
      world.addBlob({ sha256: files.subtitles, owner: ACCOUNT, type: 'text/vtt' });
      world.addBlob({ sha256: files.document, owner: ACCOUNT, type: 'application/pdf' });
      return Object.values(files);
    }

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: only files whose type is video/*, in any case, are changed', async (_label, path) => {
      const videos = world.addAccountVideos(ACCOUNT, 2);
      const upper = fakeHash('6', 1);
      world.addBlob({ sha256: upper, owner: ACCOUNT, type: 'Video/QuickTime' });
      const others = addOtherMedia();
      world.suspendedPubkeys.add(ACCOUNT);
      if (path === 'q') {
        const { row } = await runQueued('age-restrict-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 3, media_skipped: 0, failures: '[]' });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'age-restrict-all', 'r'))
          .toMatchObject({ success: true, mediaProcessed: 3, mediaSkipped: 0, failures: [] });
      }
      expect(statuses([...videos, upper])).toEqual(['restricted', 'restricted', 'restricted']);
      expect(others.flatMap((h) => world.writesFor(h))).toEqual([]);
    });

    it('treats a listed file with no type as a list it cannot read', async () => {
      // divine-blossom's record always carries a type, so a row without one
      // means the answer's shape changed, as a row without a hash does.
      world.addAccountVideos(ACCOUNT, 1);
      world.addBlob({ sha256: fakeHash('6', 2), owner: ACCOUNT, type: null });
      const result = await runBulkModeration(env, ACCOUNT, 'age-gate-all', 'r');
      expect(result.failures).toEqual([
        expect.stringMatching(new RegExp(`^enumeration:${ACCOUNT}:could not list this account's files: .*no type.*; files were chosen from the relay's list only$`)),
      ]);
    });
  });

  describe("Un-age-restrict All chooses files from the relay's list only", () => {
    // A file the moderation pipeline quarantined on its own (pending review,
    // say): hidden on the media server, and its event hidden by funnelcake's
    // quarantine set. Nothing age review did, so not age review's to undo.
    function addPipelineQuarantined(index: number) {
      const sha256 = fakeHash('5', index);
      world.addBlob({ sha256, owner: ACCOUNT });
      world.addVideo(ACCOUNT, `pipeline-${index}`, sha256, 4_000_000 + index);
      world.moderate(sha256, 'QUARANTINE');
      world.writes.length = 0;
      return sha256;
    }

    // Hidden with a recorded quarantine, but its event still listed: the
    // relay was never told. The one kind of hidden file the relay's list
    // still offers, as it did before #299.
    function addListedHidden(index: number) {
      const sha256 = fakeHash('4', index);
      world.addBlob({ sha256, owner: ACCOUNT, status: 'restricted' });
      world.records.set(sha256, 'quarantine');
      world.addVideo(ACCOUNT, `listed-hidden-${index}`, sha256, 3_000_000 + index);
      return sha256;
    }

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: leaves a file the pipeline quarantined hidden, and names it for a person', async (_label, path) => {
      const quarantined = addPipelineQuarantined(1);
      const listed = addListedHidden(1);
      if (path === 'q') {
        const { row, notes } = await runQueued('un-age-restrict-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 1, failures: '[]' });
        expect(await notes()).toEqual(stillHidden([quarantined]));
      } else {
        const result = await runBulkModeration(env, ACCOUNT, 'un-age-restrict-all', 'r');
        expect(result).toMatchObject({ success: true, mediaProcessed: 1, failures: [], notes: stillHidden([quarantined]) });
      }
      expect(world.statusOf(quarantined)).toBe('restricted');
      expect(world.writesFor(quarantined)).toEqual([]);
      expect(world.statusOf(listed)).toBe('active');
    });

    it("a cleared age review leaves the files its own withhold hid, and names each one", async () => {
      // The withhold's QUARANTINE hides each event from funnelcake too, so the
      // clear's list is empty: each file needs restoring by hand (#295).
      const files = world.addAccountVideos(ACCOUNT, 3);
      expect(await runBulkModeration(env, ACCOUNT, 'age-restrict-all', 'Age review restriction'))
        .toMatchObject({ success: true, mediaProcessed: 3 });
      world.writes.length = 0;
      const result = await runBulkModeration(env, ACCOUNT, 'un-age-restrict-all', 'Age review cleared');
      expect(statuses(files)).toEqual(['restricted', 'restricted', 'restricted']);
      expect(world.writes).toEqual([]);
      expect(byHash(result.notes)).toEqual(byHash(stillHidden(files)));
      // Notes for a person, not a failed clear.
      expect(result).toMatchObject({ success: true, failures: [] });
    });

    it('on a suspended account, changes nothing and names every hidden file', async () => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      for (const h of files) { world.blobs.get(h)!.status = 'restricted'; world.records.set(h, 'quarantine'); }
      world.suspendedPubkeys.add(ACCOUNT);
      const { row, notes, noteCount } = await runQueued('un-age-restrict-all');
      expect(statuses(files)).toEqual(['restricted', 'restricted']);
      expect(world.writes).toEqual([]);
      expect(noteCount).toBe(2);
      expect(byHash(await notes())).toEqual(byHash(stillHidden(files)));
      expect(row).toMatchObject({ status: 'done', media_processed: 0, failures: '[]' });
    });

    it('names only hidden video files the account owns', async () => {
      const listed = addListedHidden(1);
      const othersHidden = fakeHash('c', 9);
      world.addBlob({ sha256: othersHidden, owner: OTHER, status: 'restricted' }, [OTHER, ACCOUNT]);
      const hiddenImage = fakeHash('7', 9);
      world.addBlob({ sha256: hiddenImage, owner: ACCOUNT, status: 'restricted', type: 'image/png' });
      const gated = fakeHash('3', 1);
      world.addBlob({ sha256: gated, owner: ACCOUNT, status: 'age_restricted' });
      const { row, noteCount } = await runQueued('un-age-restrict-all');
      expect(world.statusOf(listed)).toBe('active');
      expect(row).toMatchObject({ status: 'done', media_processed: 1, failures: '[]' });
      expect(noteCount).toBe(0);
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: says so when it cannot list the files still hidden', async (_label, path) => {
      const listed = addListedHidden(1);
      world.failList(500);
      const line = new RegExp(`^enumeration:${ACCOUNT}:could not list this account's files: media server returned 500; the files still hidden could not be listed$`);
      // A failure, not a note: no one can tell what is still hidden.
      if (path === 'q') {
        const { row, failures, noteCount } = await runQueued('un-age-restrict-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 1 });
        expect(failures).toEqual([expect.stringMatching(line)]);
        expect(noteCount).toBe(0);
      } else {
        const result = await runBulkModeration(env, ACCOUNT, 'un-age-restrict-all', 'r');
        expect(result).toMatchObject({ success: false, mediaProcessed: 1, failures: [expect.stringMatching(line)], notes: [] });
      }
      expect(world.statusOf(listed)).toBe('active');
    });

    it("continues a media message from the worker before this change from its cursor, as that worker would", async () => {
      // That worker walked funnelcake's list for this action too, so there is
      // nothing to restart. Funnelcake lists newest first: its first page of
      // 100 is files 149 down to 50, which that worker already restored.
      const files = Array.from({ length: 150 }, (_, i) => addListedHidden(i));
      for (const h of files.slice(50)) { world.blobs.get(h)!.status = 'active'; world.records.set(h, 'safe'); }
      const jobId = 'job-299-safe-legacy';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'un-age-restrict-all', status: 'running', events_processed: 100, media_processed: 100, media_skipped: 0, failures: '[]', failures_dropped: 0, version: 2, created_at: 't', updated_at: 't' });
      await drain({ jobId, pubkey: ACCOUNT, action: 'un-age-restrict-all', reason: 'r', phase: 'media', cursor: 'o:100', mediaPage: 1, version: 2 });
      expect(statuses(files).every((s) => s === 'active')).toBe(true);
      expect(world.writes).toHaveLength(50);
      // A restart would have read the first page again: 100 more events, and
      // 100 files counted as left as they were.
      expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', events_processed: 150, media_processed: 150, media_skipped: 0, failures: '[]' });
    });
  });

  describe('the check at the end of the walk', () => {
    it.each([
      ['a banned account', 'delete-all', 'deleted', true],
      ['a visible account, whose late file funnelcake also lists', 'age-gate-all', 'age_restricted', false],
    ] as const)('changes an owned file that appeared behind the walk, on %s', async (_label, action, after, banned) => {
      const files = Array.from({ length: 150 }, (_, i) => fakeHash('9', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT });
      if (banned) world.bannedPubkeys.add(ACCOUNT);
      // Uploaded after the first chunk, with a hash below the walk's position.
      const late = fakeHash('0', 1);
      world.onListRead((readsBefore) => {
        if (readsBefore !== 1) return;
        world.addBlob({ sha256: late, owner: ACCOUNT });
        if (!banned) world.addVideo(ACCOUNT, 'late-event', late, 9_000_000);
      });
      const { row } = await runQueued(action);
      expect(world.statusOf(late)).toBe(after);
      expect(row).toMatchObject({ status: 'done', media_processed: 151, failures: '[]' });
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: changes an owned file one list read left out', async (_label, path) => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      world.listOmits.add(files[1]);
      world.onListRead((readsBefore) => { if (readsBefore === 1) world.listOmits.clear(); });
      if (path === 'q') {
        const { row } = await runQueued('delete-all');
        expect(row).toMatchObject({ status: 'done', media_processed: 3, failures: '[]' });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'delete-all', 'r'))
          .toMatchObject({ success: true, mediaProcessed: 3, failures: [] });
      }
      expect(statuses(files)).toEqual(['deleted', 'deleted', 'deleted']);
    });

    it('reports an owned file it still could not change, so the job never ends clean', async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      world.listOmits.add(files[1]);
      world.writeFailures.add(files[1]);
      world.onListRead((readsBefore) => { if (readsBefore === 1) world.listOmits.clear(); });
      const { row, failures } = await runQueued('delete-all');
      expect(world.statusOf(files[1])).toBe('active');
      expect(failures).toEqual([`media:${files[1]}:Moderation service returned 500`]);
      expect(row).toMatchObject({ status: 'done', media_processed: 2 });
    });

    it.each([
      ['queued', 'q'],
      ['synchronous', 's'],
    ])('%s: records a file the walk could not change once, though the check tries it again', async (_label, path) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      world.bannedPubkeys.add(ACCOUNT);
      world.writeFailures.add(files[0]);
      const failures = path === 'q'
        ? (await runQueued('delete-all')).failures
        : (await runBulkModeration(env, ACCOUNT, 'delete-all', 'r')).failures;
      expect(failures).toEqual([`media:${files[0]}:Moderation service returned 500`]);
      // Two writes were sent for it, the walk's and the check's, and both failed.
      expect(world.writeAttemptsFor(files[0])).toEqual(['DELETE', 'DELETE']);
    });

    // A row with no usable owner, or this account's row with a status this
    // worker does not know. For a file the walk passed over, the check's read
    // is the only one that lists it, so the check does not drop such a row: it
    // gives it the same per-file read as the walk, which fails on the same
    // record and names the file. Not counted as changed or left.
    const MALFORMED = [
      ['no usable owner', (sha256: string) => {
        world.listOwner.set(sha256, 'not-a-pubkey');
        world.ownerless.add(sha256);
      }, 'blossom returned no usable owner (undefined)'],
      ['an unknown status', (sha256: string) => {
        world.staleStatus.set(sha256, 'archived' as BlobStatus);
      }, 'blossom returned unrecognised status "archived"'],
    ] as const;
    const PATHS = [['queued', 'q'], ['synchronous', 's']] as const;
    const CASES = PATHS.flatMap(([pathLabel, path]) => MALFORMED.map(([label, arrange, cause]) =>
      [pathLabel, label, path, arrange, cause] as const));

    it.each(CASES)('%s: names a file only its read lists when its row has %s', async (_p, _l, path, arrange, cause) => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      world.listOmits.add(files[1]);
      world.onListRead((readsBefore) => { if (readsBefore === 1) world.listOmits.clear(); });
      arrange(files[1]);
      const line = `media:${files[1]}:could not read current status, left unchanged: ${cause}`;
      if (path === 'q') {
        const { row, failures } = await runQueued('delete-all');
        expect(failures).toEqual([line]);
        expect(row).toMatchObject({ status: 'done', media_processed: 2, media_skipped: 0 });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'delete-all', 'r'))
          .toMatchObject({ success: false, mediaProcessed: 2, mediaSkipped: 0, failures: [line] });
      }
      expect(statuses(files)).toEqual(['deleted', 'active', 'deleted']);
    });

    it.each(CASES)('%s: names a file the walk already named once, when its row has %s', async (_p, _l, path, arrange, cause) => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      world.bannedPubkeys.add(ACCOUNT);
      arrange(files[1]);
      const line = `media:${files[1]}:could not read current status, left unchanged: ${cause}`;
      const failures = path === 'q'
        ? (await runQueued('delete-all')).failures
        : (await runBulkModeration(env, ACCOUNT, 'delete-all', 'r')).failures;
      expect(failures).toEqual([line]);
    });

    it.each(PATHS)("%s: still skips another account's row, whatever its status", async (_label, path) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      world.bannedPubkeys.add(ACCOUNT);
      const theirs = fakeHash('1', 7);
      world.addBlob({ sha256: theirs, owner: OTHER }, [OTHER, ACCOUNT]);
      world.staleStatus.set(theirs, 'archived' as BlobStatus);
      // The walk passes over it; only the check's read lists it.
      world.listOmits.add(theirs);
      world.onListRead((readsBefore) => { if (readsBefore === 1) world.listOmits.clear(); });
      if (path === 'q') {
        const { row, failures } = await runQueued('delete-all');
        expect(failures).toEqual([]);
        expect(row).toMatchObject({ status: 'done', media_processed: 2 });
      } else {
        expect(await runBulkModeration(env, ACCOUNT, 'delete-all', 'r'))
          .toMatchObject({ success: true, mediaProcessed: 2, failures: [] });
      }
      expect(statuses(files)).toEqual(['deleted', 'deleted']);
    });

    it('changes at most one chunk itself, and names how many owned files it left', async () => {
      const files = Array.from({ length: 150 }, (_, i) => fakeHash('9', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      // Neither is the action's to change, so neither is counted as left: the
      // account's blocked files, and files another account owns.
      for (let i = 0; i < 3; i++) world.addBlob({ sha256: fakeHash('2', i), owner: ACCOUNT, status: 'banned' });
      for (let i = 0; i < 3; i++) world.addBlob({ sha256: fakeHash('1', i), owner: OTHER }, [OTHER, ACCOUNT]);
      // Every read before the check leaves the 150 out.
      files.forEach((h) => world.listOmits.add(h));
      world.onListRead((readsBefore) => { if (readsBefore === 2) world.listOmits.clear(); });
      const { row, failures, writesPerMessage } = await runQueued('delete-all');
      expect(Math.max(...writesPerMessage)).toBeLessThanOrEqual(100);
      expect(row).toMatchObject({ status: 'done', media_processed: 100 });
      expect(failures).toContain(`enumeration:${ACCOUNT}:50 more owned video files still listed unchanged after the walk`);
      expect(failures.filter((f) => f.startsWith('enumeration:'))).toHaveLength(1);
    });

    it('says so when it cannot list the files to check them', async () => {
      world.addAccountVideos(ACCOUNT, 2);
      world.bannedPubkeys.add(ACCOUNT);
      world.onListRead((readsBefore) => { if (readsBefore === 2) world.failList(500); });
      const { row, failures } = await runQueued('delete-all');
      expect(row).toMatchObject({ status: 'done', media_processed: 2 });
      expect(failures).toEqual([
        `enumeration:${ACCOUNT}:could not list this account's files: media server returned 500; could not check for files left unchanged`,
      ]);
    });

    it.each([
      // blossom caches a file's status per POP for up to 5 minutes, so the
      // check can see a file this job already changed as unchanged. Sending the
      // change again is harmless; counting it again is not.
      ['the media server still serves its old status', 'staleStatus'],
      // The list answered from before the change and the file's own read from
      // after it: the check leaves it alone, and does not count it as left.
      ['only the list still shows its old status', 'listLag'],
    ] as const)('does not count a file twice when %s', async (_label, lag) => {
      const files = world.addAccountVideos(ACCOUNT, 2);
      world.onListRead((readsBefore) => {
        if (readsBefore === 2) files.forEach((h) => world[lag].set(h, 'active'));
      });
      const { row } = await runQueued('age-gate-all');
      expect(row).toMatchObject({ status: 'done', media_processed: 2, media_skipped: 0, failures: '[]' });
    });
  });

  describe('counting', () => {
    it("Delete All does not count a file it deleted again when funnelcake still lists the file's event", async () => {
      // The event's ban failed, so funnelcake still lists it, and the file is
      // no longer on the uploader list to exclude it.
      const [file] = world.addAccountVideos(ACCOUNT, 1);
      vi.mocked(banEvent).mockImplementation(async () => ({ success: false, error: 'relay refused' }));
      const { row, failures } = await runQueued('delete-all');
      expect(world.statusOf(file)).toBe('deleted');
      expect(failures).toEqual(['event:f-event-0:relay refused']);
      expect(row).toMatchObject({ media_processed: 1, media_skipped: 0 });
    });
  });

  describe('message fields this worker does not trust', () => {
    it.each(['zz', 'F'.repeat(64), 'f'.repeat(63), ''])('restarts the file walk when mediaAfter is %j', async (mediaAfter) => {
      const files = Array.from({ length: 150 }, (_, i) => fakeHash('9', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const jobId = 'job-299-bad-after';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'delete-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 3, created_at: 't', updated_at: 't' });
      await drain({ jobId, pubkey: ACCOUNT, action: 'delete-all', reason: 'r', phase: 'media', mediaWalk: 'blossom', mediaAfter, mediaPage: 1, version: 3 });
      expect(statuses(files).every((s) => s === 'deleted')).toBe(true);
      expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', media_processed: 150, failures: '[]' });
    });

    it.each([ACCOUNT.toUpperCase(), ` ${ACCOUNT}`, 'npub1notahexkey'])('the synchronous path refuses the pubkey %j and changes nothing', async (pubkey) => {
      world.addAccountVideos(ACCOUNT, 2);
      await expect(runBulkModeration(env, pubkey, 'age-restrict-all', 'r')).rejects.toThrow(/not a lowercase hex pubkey/);
      expect(world.writes).toEqual([]);
      expect(vi.mocked(banEvent)).not.toHaveBeenCalled();
    });

    it('a queued job for a pubkey that is not lowercase hex fails and changes nothing', async () => {
      world.addAccountVideos(ACCOUNT, 2);
      const pubkey = ACCOUNT.toUpperCase();
      const jobId = 'job-299-upper';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey, action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });
      await drain({ jobId, pubkey, action: 'age-restrict-all', reason: 'r' });
      const row = jobDb.rows.get(jobId)!;
      expect(row.status).toBe('failed');
      expect(String(row.failures)).toMatch(/not a lowercase hex pubkey/);
      expect(world.writes).toEqual([]);
    });
  });

  describe('large accounts', () => {
    it('works through the files in bounded chunks across messages, re-reading the list for each', async () => {
      const files = Array.from({ length: 250 }, (_, i) => fakeHash('9', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const { row, writesPerMessage } = await runQueued('delete-all');
      // Each DELETE takes the file off the list, so a walk by position would
      // skip files; the walk is by hash.
      expect(statuses(files).every((s) => s === 'deleted')).toBe(true);
      expect(row).toMatchObject({ status: 'done', media_processed: 250, failures: '[]' });
      expect(Math.max(...writesPerMessage)).toBeLessThanOrEqual(100);
      expect(writesPerMessage.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
      // One read per media chunk, never one read for the whole job.
      expect(world.listReads.length).toBeGreaterThanOrEqual(3);
    });

    // Blossom keeps an uploader list in upload order (add_to_user_list pushes
    // each new hash on the end). The walk's position is a hash, so it relies on
    // the list being sorted by hash first. Pin from round 3's review (ATK9).
    it('works through a list in upload order, not hash order, without passing files over', async () => {
      const files: string[] = [];
      for (let i = 249; i >= 0; i--) {
        const sha256 = fakeHash('f', i);
        world.addBlob({ sha256, owner: ACCOUNT });
        files.push(sha256);
      }
      world.bannedPubkeys.add(ACCOUNT);
      const { row, failures } = await runQueued('delete-all');
      expect(statuses(files).filter((s) => s === 'deleted')).toHaveLength(250);
      expect(failures).toEqual([]);
      expect(row).toMatchObject({ status: 'done', media_processed: 250 });
    });

    it('a walk that keeps going stops at the page bound', async () => {
      for (let i = 0; i < 150; i++) world.addBlob({ sha256: fakeHash('9', i), owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const jobId = 'job-299-bound';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'delete-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 4, created_at: 't', updated_at: 't' });
      await processBulkJob({ jobId, pubkey: ACCOUNT, action: 'delete-all', reason: 'r', phase: 'media', mediaPage: VIDEO_MAX_PAGES - 1, version: 4 }, env);
      const row = jobDb.rows.get(jobId)!;
      expect(row.status).toBe('failed');
      expect(String(row.failures)).toMatch(/exceeded .* pages/);
      expect(sent).toEqual([]);
    });
  });

  describe('notes for a person', () => {
    it('never crowd a real failure out of the stored list, and are all kept', async () => {
      world.bannedPubkeys.add(ACCOUNT);
      const others = Array.from({ length: 60 }, (_, i) => fakeHash('1', i));
      for (const h of others) world.addBlob({ sha256: h, owner: OTHER }, [OTHER, ACCOUNT]);
      const failing = fakeHash('9', 1);
      world.addBlob({ sha256: failing, owner: ACCOUNT });
      world.writeFailures.add(failing);
      const { row, failures, noteCount, notes } = await runQueued('delete-all');
      expect(failures).toEqual([`media:${failing}:Moderation service returned 500`]);
      expect(row).toMatchObject({ status: 'done', failures_dropped: 0 });
      expect(noteCount).toBe(60);
      expect(byHash(await notes())).toEqual(byHash(ownedBy(OTHER, others)));
    });

    it('are stored across chunks, once each, and read back in full a page at a time', async () => {
      // 150 re-uploads span two blossom-walk chunks; the end-of-walk check and
      // funnelcake's walk meet some of them again.
      world.bannedPubkeys.add(ACCOUNT);
      const others = Array.from({ length: 150 }, (_, i) => fakeHash('1', i));
      for (const h of others) world.addBlob({ sha256: h, owner: OTHER }, [OTHER, ACCOUNT]);
      const { jobId, noteCount } = await runQueued('delete-all');
      expect(noteCount).toBe(150);
      expect(byHash(await readNotes(jobId, 7))).toEqual(byHash(ownedBy(OTHER, others)));
    });

    it('a job that cannot store its notes says so, and still finishes its work', async () => {
      const own = world.addAccountVideos(ACCOUNT, 2);
      const others = Array.from({ length: 3 }, (_, i) => fakeHash('1', i));
      for (const h of others) world.addBlob({ sha256: h, owner: OTHER }, [OTHER, ACCOUNT]);
      world.bannedPubkeys.add(ACCOUNT);
      jobDb.notesControl.fail = true;
      const { row, failures } = await runQueued('delete-all');
      expect(statuses(own)).toEqual(['deleted', 'deleted']);
      expect(row).toMatchObject({ status: 'done', media_processed: 2 });
      expect(failures).toEqual([`enumeration:${ACCOUNT}:could not store 3 note(s) for a person: D1 write failed`]);
    });

    it('past what one chunk may store, names how many were not stored', async () => {
      // Un-age-restrict All's report names every hidden video in one chunk.
      // Each stored note costs D1 work in that one invocation, so a chunk stores
      // at most 5,000 and counts the rest in a failure line.
      const files = Array.from({ length: 5_003 }, (_, i) => fakeHash('4', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT, status: 'restricted' });
      world.suspendedPubkeys.add(ACCOUNT);
      const { noteCount, failures } = await runQueued('un-age-restrict-all');
      expect(noteCount).toBe(5_000);
      expect(failures).toEqual([
        `enumeration:${ACCOUNT}:3 more note(s) than one run can store; act on these, then run it again to list the rest`,
      ]);
    });

    it('are counted on the job once it ends, not while it runs', async () => {
      world.addBlob({ sha256: fakeHash('1', 1), owner: OTHER }, [OTHER, ACCOUNT]);
      for (let i = 0; i < 150; i++) world.addBlob({ sha256: fakeHash('9', i), owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const { jobId, first } = await enqueue('delete-all');
      sent.length = 0;
      await processBulkJob(first, env);
      const running = await (await handleBulkJobStatus(jobId, env, {})).json() as BulkJob;
      expect(running.status).toBe('running');
      expect('noteCount' in running).toBe(false);
      await drain(sent[0]);
      const done = await (await handleBulkJobStatus(jobId, env, {})).json() as BulkJob;
      expect(done).toMatchObject({ status: 'done', noteCount: 1 });
    });

    it('read back as none for a job that stored none, or that this worker never saw', async () => {
      const res = await handleBulkJobNotes('no-such-job', null, null, env, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notes: [], next: null });
    });

    it('refuse a page cursor that is not a number', async () => {
      const res = await handleBulkJobNotes('job', 'abc', null, env, {});
      expect(res.status).toBe(400);
    });

    it('synchronous: name a file once when the end-of-walk check meets it again', async () => {
      // The list's row says the account owns it; the file's own read says
      // another account does. The walk names it, and so does the check.
      const theirs = fakeHash('1', 1);
      world.addBlob({ sha256: theirs, owner: OTHER }, [OTHER, ACCOUNT]);
      world.listOwner.set(theirs, ACCOUNT);
      const result = await runBulkModeration(env, ACCOUNT, 'age-gate-all', 'r');
      expect(result.notes).toEqual(ownedBy(OTHER, [theirs]));
      expect(world.writesFor(theirs)).toEqual([]);
    });

    it('queued: send a file to storage once when the end-of-walk check meets it again in the same chunk', async () => {
      // The blossom walk's read fails, so the funnelcake walk takes every file
      // funnelcake lists and names this one; the check at its end reads the
      // list, whose row says the account owns it, and names it again. The
      // table would drop the repeat, but it would still count toward the
      // chunk's MAX_NOTES_PER_WRITE.
      const theirs = fakeHash('1', 1);
      world.addBlob({ sha256: theirs, owner: OTHER }, [OTHER, ACCOUNT]);
      world.listOwner.set(theirs, ACCOUNT);
      world.addVideo(ACCOUNT, 'theirs-event', theirs, 2_000_000);
      world.onListRead((readsBefore) => { world.failList(readsBefore === 0 ? 500 : null); });
      const batch = vi.spyOn(jobDb.db, 'batch');
      const { notes } = await runQueued('age-gate-all');
      const sentRows = batch.mock.calls.flatMap(([stmts]) => stmts as unknown as Array<{ sql: string; binds: unknown[] }>)
        .filter((st) => /INSERT OR IGNORE INTO bulk_job_notes/.test(st.sql))
        .reduce((n, st) => n + st.binds.length / 6, 0);
      expect(sentRows).toBe(1);
      expect(await notes()).toEqual(ownedBy(OTHER, [theirs]));
      expect(world.writesFor(theirs)).toEqual([]);
    });

    it('synchronous: are returned once each, with the failures untouched', async () => {
      world.bannedPubkeys.add(ACCOUNT);
      const others = Array.from({ length: 60 }, (_, i) => fakeHash('1', i));
      for (const h of others) world.addBlob({ sha256: h, owner: OTHER }, [OTHER, ACCOUNT]);
      const failing = fakeHash('9', 1);
      world.addBlob({ sha256: failing, owner: ACCOUNT });
      world.writeFailures.add(failing);
      const result = await runBulkModeration(env, ACCOUNT, 'delete-all', 'r');
      expect(result.failures).toEqual([`media:${failing}:Moderation service returned 500`]);
      expect(byHash(result.notes)).toEqual(byHash(ownedBy(OTHER, others)));
    });
  });

  // A deploy or a rollback can leave a job's next message to be read by the
  // other version. The worker before this change routes any phase other than
  // `events` to its media walk over funnelcake's list, reads `cursor` as
  // funnelcake's cursor and `mediaPage` as the page count, and ignores fields
  // it does not know.
  describe('jobs that span this change', () => {
    it('a media continuation from the worker before this change restarts the file walk from the start', async () => {
      const files = Array.from({ length: 150 }, (_, i) => fakeHash('9', i));
      for (const h of files) world.addBlob({ sha256: h, owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const jobId = 'job-299-legacy-media';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'delete-all', status: 'running', events_processed: 3, media_processed: 0, failures: '[]', failures_dropped: 0, version: 5, created_at: 't', updated_at: 't' });
      await drain({ jobId, pubkey: ACCOUNT, action: 'delete-all', reason: 'r', phase: 'media', cursor: 'o:100', mediaPage: 1, version: 5 });
      expect(statuses(files).every((s) => s === 'deleted')).toBe(true);
      expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', events_processed: 3, media_processed: 150, failures: '[]' });
    });

    it('a restarted walk keeps counting pages, so it cannot outrun the page bound', async () => {
      for (let i = 0; i < 150; i++) world.addBlob({ sha256: fakeHash('9', i), owner: ACCOUNT });
      world.bannedPubkeys.add(ACCOUNT);
      const jobId = 'job-299-legacy-bound';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'delete-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 5, created_at: 't', updated_at: 't' });
      await processBulkJob({ jobId, pubkey: ACCOUNT, action: 'delete-all', reason: 'r', phase: 'media', cursor: 'o:100', mediaPage: VIDEO_MAX_PAGES - 1, version: 5 }, env);
      expect(jobDb.rows.get(jobId)!.status).toBe('failed');
      expect(sent).toEqual([]);
    });

    it('an events continuation from the worker before this change still ends with the files deleted', async () => {
      const files = world.addAccountVideos(ACCOUNT, 3);
      const jobId = 'job-299-legacy-events';
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: ACCOUNT, action: 'delete-all', status: 'running', events_processed: 1, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: 't' });
      await drain({ jobId, pubkey: ACCOUNT, action: 'delete-all', reason: 'r', phase: 'events', eventIds: ['f-event-1', 'f-event-2'], version: 1 });
      expect(statuses(files)).toEqual(['deleted', 'deleted', 'deleted']);
      expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', media_processed: 3 });
    });

    it('every message this worker sends reads correctly to the worker before it', async () => {
      // Both walks span several messages: 250 files only the media server
      // lists, and 150 videos only funnelcake lists.
      for (let i = 0; i < 250; i++) world.addBlob({ sha256: fakeHash('9', i), owner: ACCOUNT });
      for (let i = 0; i < 150; i++) {
        world.addBlob({ sha256: fakeHash('8', i), owner: ACCOUNT }, []);
        world.addVideo(ACCOUNT, `unlisted-${i}`, fakeHash('8', i), 5_000_000 + i);
      }
      const gate = await runQueued('age-gate-all');
      expect(gate.row).toMatchObject({ status: 'done', media_processed: 400, media_skipped: 0 });

      // Three blossom chunks (the start message runs the first) and two
      // funnelcake chunks: four continuations.
      const media = gate.messages.filter((m) => m.phase === 'media');
      expect(media).toHaveLength(4);
      media.forEach((m, i) => {
        // The page count an old consumer bounds the walk by only ever rises.
        expect(m.mediaPage).toBe(i + 1);
        // `cursor` is only ever one funnelcake issued, so an old consumer
        // continues funnelcake's list from it. A message without one makes an
        // old consumer walk funnelcake's list from the start: today's
        // behaviour, never a skipped phase.
        if (m.cursor !== undefined) expect(m.cursor).toMatch(/^o:\d+$/);
      });
      expect(media.some((m) => m.cursor !== undefined)).toBe(true);

      // Events messages keep their old shape, and every later message names
      // its phase (an old consumer defaults a missing phase to events).
      const deleteAll = await runQueued('delete-all');
      for (const m of deleteAll.messages) {
        expect(m.phase).toBeDefined();
        if (m.phase === 'events') expect(Object.keys(m).every((k) => LEGACY_MESSAGE_KEYS.includes(k))).toBe(true);
      }
      expect(deleteAll.row).toMatchObject({ status: 'done', events_processed: 150 });
    });
  });
});
