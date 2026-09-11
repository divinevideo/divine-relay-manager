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

  // An account Keycast does not manage answers 404 forever. On this branch that
  // is a normal failure, so the attempt budget is what bounds it: ten ticks and
  // one alert, not unbounded churn. #270 adds the not-found discriminator, after
  // which the re-drive loop settles such a leg on the first tick instead -- the
  // loop already reads the field, so that upgrade needs no change here.
  it('bounds an account Keycast does not manage by the attempt budget', async () => {
    await recordFailedKeycastLeg(DB, PK, 'suspended', 'boom', 'case-1');
    mockKeycast(() => new Response(JSON.stringify({ error: 'user not found' }), { status: 404 }));

    await checkAgeReviewDeadlines(cronEnv);

    const row = await rowFor(PK);
    expect(row!.attempts).toBe(1);
    expect(row!.state).toBe('failed');
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
