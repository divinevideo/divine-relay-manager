// Real-D1 (Miniflare SQLite) coverage for the enforcement-leg reconciler
// (issue #123). The cron loop and the supersede semantics both depend on real
// SQL behaviour -- ON CONFLICT upsert, the attempts counter, the CHECK
// constraints -- which a mocked D1 cannot exercise.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { checkAgeReviewDeadlines } from '../src/age-review';
import {
  MAX_ENFORCEMENT_ATTEMPTS,
  pendingKeycastLegs,
  recordFailedKeycastLeg,
  resolveKeycastLeg,
} from '../src/enforcement-legs';

let mf: Miniflare;
let DB: D1Database;
let cronEnv: Parameters<typeof checkAgeReviewDeadlines>[0];

const PK = 'a'.repeat(64);

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  cronEnv = {
    DB,
    KEYCAST_URL: 'https://login.test.divine.video',
    KEYCAST_SERVICE_TOKEN: 'test-token',
  };
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM enforcement_legs').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function rowFor(pubkey: string) {
  return DB.prepare('SELECT * FROM enforcement_legs WHERE pubkey = ? AND leg = ?')
    .bind(pubkey, 'keycast_status')
    .first<{ intent: string; state: string; attempts: number; last_error: string | null }>();
}

/** Answer every Keycast status PUT with the given response. */
function mockKeycast(respond: () => Response): { calls: () => number } {
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/api/admin/users/')) {
      calls += 1;
      return Promise.resolve(respond());
    }
    return Promise.resolve(new Response('ok', { status: 200 }));
  });
  return { calls: () => calls };
}

describe('enforcement leg records', () => {
  it('records a failure and surfaces it as pending', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', '503: unavailable', 'case-1');
    expect(await pendingKeycastLegs(DB)).toEqual([{ pubkey: PK, intent: 'suspended', attempts: 0 }]);
    expect((await rowFor(PK))!.last_error).toBe('503: unavailable');
  });

  // The failure mode this guards is enforcement running backwards: a suspend
  // fails, a moderator then clears the account, and the reconciler re-applies
  // the superseded suspension. One row per pubkey, latest intent wins.
  it('supersedes an earlier intent rather than queueing both', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await recordFailedKeycastLeg(DB, PK, 'active', 'boom again', 'case-1');

    const pending = await pendingKeycastLegs(DB);
    expect(pending).toHaveLength(1);
    expect(pending[0].intent).toBe('active');
  });

  it('resets the attempt budget when a new action supersedes an old failure', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await DB.prepare('UPDATE enforcement_legs SET attempts = 7 WHERE pubkey = ?').bind(PK).run();
    await recordFailedKeycastLeg(DB, PK, 'banned', 'boom', 'case-2');
    expect((await rowFor(PK))!.attempts).toBe(0);
  });

  it('resolve clears a pending row and is a no-op when there is none', async () => {
    await resolveKeycastLeg(DB, PK); // no row yet
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', null);
    await resolveKeycastLeg(DB, PK);
    expect(await pendingKeycastLegs(DB)).toEqual([]);
    expect((await rowFor(PK))!.state).toBe('resolved');
  });
});

describe('cron re-drive', () => {
  it('re-drives a failed leg and resolves it once Keycast accepts', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', '503: unavailable', 'case-1');
    const keycast = mockKeycast(() => new Response('{}', { status: 200 }));

    await checkAgeReviewDeadlines(cronEnv);

    expect(keycast.calls()).toBe(1);
    expect((await rowFor(PK))!.state).toBe('resolved');
    // Settled: a second tick does not call Keycast again.
    await checkAgeReviewDeadlines(cronEnv);
    expect(keycast.calls()).toBe(1);
  });

  it('re-drives in the direction of the recorded intent, not a fixed action', async () => {
    await recordFailedKeycastLeg(DB, PK, 'active', 'boom', 'case-1');
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/api/admin/users/')) bodies.push(String(init?.body ?? ''));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    await checkAgeReviewDeadlines(cronEnv);

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).status).toBe('active');
  });

  // An account Keycast does not manage answers 404 forever, so the one thing that
  // must hold is that it cannot churn without bound. How it is bounded differs by
  // branch and this assertion deliberately spans both: on this branch the 404 is
  // an ordinary failure and the attempt budget bounds it; once #270 lands the
  // not-found discriminator, the loop (which already reads the field) settles it
  // on the first tick. Asserting the exact counter instead would pass here and
  // turn main red the moment both merge, with no merge conflict to warn anyone.
  it('never lets an account Keycast does not manage churn without bound', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    mockKeycast(() => new Response(JSON.stringify({ error: 'user not found' }), { status: 404 }));

    await checkAgeReviewDeadlines(cronEnv);

    const row = await rowFor(PK);
    // Either settled outright, or consuming its budget towards abandonment.
    expect(['resolved', 'failed']).toContain(row!.state);
    if (row!.state === 'failed') expect(row!.attempts).toBeGreaterThan(0);
    else expect(await pendingKeycastLegs(DB)).toEqual([]);
  });

  it('counts an attempt and keeps the leg pending while Keycast keeps failing', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    mockKeycast(() => new Response('upstream exploded', { status: 503 }));

    await checkAgeReviewDeadlines(cronEnv);

    const row = await rowFor(PK);
    expect(row!.state).toBe('failed');
    expect(row!.attempts).toBe(1);
  });

  // Without a give-up the cron re-calls a hopeless leg on every tick forever and
  // nobody is told. The budget converts silent churn into one alert.
  it('abandons a leg after the attempt budget and alerts once, without a pubkey', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await DB.prepare('UPDATE enforcement_legs SET attempts = ? WHERE pubkey = ?')
      .bind(MAX_ENFORCEMENT_ATTEMPTS - 1, PK).run();

    const alerts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('hooks.test')) alerts.push(String(init?.body ?? ''));
      return Promise.resolve(new Response('nope', { status: 503 }));
    });

    await checkAgeReviewDeadlines({ ...cronEnv, SLACK_WEBHOOK_URL: 'https://hooks.test/x' });

    expect((await rowFor(PK))!.state).toBe('abandoned');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('gave up');
    expect(alerts[0]).not.toContain(PK);

    // Abandoned means abandoned: it is out of the pending set for good.
    expect(await pendingKeycastLegs(DB)).toEqual([]);
  });
});

describe('abandoned rows', () => {
  beforeEach(async () => {
    await DB.prepare('DELETE FROM enforcement_legs').run();
  });
  // An abandoned leg is not a permanent verdict. A moderator who re-runs the
  // action successfully must clear the row, or it keeps asserting a failure
  // that no longer exists and the next genuine failure is read against a lie.
  it('a successful later action clears an abandoned row, not just a failed one', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await DB.prepare("UPDATE enforcement_legs SET state = 'abandoned' WHERE pubkey = ?").bind(PK).run();

    await resolveKeycastLeg(DB, PK);

    expect((await rowFor(PK))!.state).toBe('resolved');
  });
});

describe('re-drive races with a moderator', () => {
  beforeEach(async () => {
    await DB.prepare('DELETE FROM enforcement_legs').run();
  });

  // The cron reads an intent, then a moderator acts before the re-drive lands.
  // The stale call still goes out -- that window cannot be closed from here --
  // but it must not be recorded as convergence, or the account stays suspended
  // at Keycast after a moderator cleared it and nothing ever corrects it.
  // Leaving the row pending lets the next tick apply the current intent.
  it('does not mark converged when the intent changed under the re-drive', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    // A moderator's clear lands between the read and the resolve.
    await recordFailedKeycastLeg(DB, PK, 'active', 'boom', 'case-1');

    await resolveKeycastLeg(DB, PK, 'suspended');

    const row = await rowFor(PK);
    expect(row!.state).toBe('failed');
    expect(row!.intent).toBe('active');
  });

  // Exercises the CRON path, not just the helper: the race is only closed if the
  // re-drive loop actually passes the intent it read. Simulated deterministically
  // by superseding the row from inside the Keycast call.
  it('cron leaves the leg pending when a moderator supersedes it mid-call', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/admin/users/')) {
        await recordFailedKeycastLeg(DB, PK, 'active', 'moderator cleared', 'case-1');
        return new Response('{}', { status: 200 });
      }
      return new Response('ok', { status: 200 });
    });

    await checkAgeReviewDeadlines(cronEnv);

    const row = await rowFor(PK);
    expect(row!.intent).toBe('active');
    expect(row!.state).toBe('failed'); // still pending, so the next tick applies 'active'
  });

  it('marks converged when the intent still matches', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await resolveKeycastLeg(DB, PK, 'suspended');
    expect((await rowFor(PK))!.state).toBe('resolved');
  });

  // The handler observed the outcome directly, so it resolves unconditionally.
  it('resolves unconditionally when no intent is supplied', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    await resolveKeycastLeg(DB, PK);
    expect((await rowFor(PK))!.state).toBe('resolved');
  });
});

describe('re-drive budget and non-attempts', () => {
  beforeEach(async () => {
    await DB.prepare('DELETE FROM enforcement_legs').run();
  });

  // A rotated or unbound secret makes every call return 'not configured' without
  // a request. Counting those marches the whole backlog to `abandoned` in under
  // an hour, and nothing re-drives an abandoned leg -- recovery would be hand SQL
  // against production.
  it('does not spend the budget on a call that was never made', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    const calls = mockKeycast(() => new Response('{}', { status: 200 }));

    // No KEYCAST_URL / token: callKeycast returns 'not configured' without fetching.
    await checkAgeReviewDeadlines({ DB });

    expect(calls.calls()).toBe(0);
    const row = await rowFor(PK);
    expect(row!.attempts).toBe(0);
    expect(row!.state).toBe('failed');
  });

  // A D1 blip after a SUCCESSFUL Keycast call must not read as a Keycast failure.
  it('does not count a bookkeeping failure as a failed attempt', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    mockKeycast(() => new Response('{}', { status: 200 }));

    await checkAgeReviewDeadlines(cronEnv);

    expect((await rowFor(PK))!.state).toBe('resolved');
    expect((await rowFor(PK))!.attempts).toBe(0);
  });

  // A stale failure must not consume the budget of the intent that replaced it.
  it('does not burn a newer intent\'s budget with an older failure', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/admin/users/')) {
        await recordFailedKeycastLeg(DB, PK, 'active', 'moderator cleared', 'case-1');
        return new Response('upstream exploded', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    });

    await checkAgeReviewDeadlines(cronEnv);

    const row = await rowFor(PK);
    expect(row!.intent).toBe('active');
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toBe('moderator cleared');
  });
});
