// ABOUTME: Request validation for POST /api/internal/private-reports: what moderation-service
// ABOUTME: must send, and that a malformed body is refused before any storage is touched.

import { describe, it, expect, vi } from 'vitest';
import { handlePrivateReport } from './private-reports';

const valid = {
  reportId: '6f1c2b9e-3d4a-4f8b-9c2d-1e5f7a8b9c0d',
  reportedPubkey: 'a1'.repeat(32),
  reporterPubkey: 'b2'.repeat(32),
  reportType: 'csam',
  reportedAt: '2026-11-07T10:00:00.000Z',
  hasExcerpt: false,
  giftWrapId: 'c3'.repeat(32),
};

async function call(body: string, env: Record<string, unknown> = {}) {
  const prepareDb = vi.fn(async () => {});
  const res = await handlePrivateReport(
    new Request('https://api.test/api/internal/private-reports', { method: 'POST', body }),
    env as never, {}, prepareDb,
  );
  return { res, prepareDb };
}

describe('handlePrivateReport request validation', () => {
  it.each([
    ['not JSON', 'not json'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('refuses a body that is %s with 400', async (_label, body) => {
    const { res } = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_body' });
  });

  it.each([
    ['reportId', undefined],
    ['reportId', 'not-a-uuid'],
    ['reportId', 'a1'.repeat(31)],
    ['reportedPubkey', undefined],
    ['reportedPubkey', 'a1'.repeat(31)],
    ['reportedPubkey', `npub1${'q'.repeat(58)}`],
    ['reporterPubkey', 'zz'.repeat(32)],
    ['giftWrapId', undefined],
    ['giftWrapId', 'c3'.repeat(33)],
    ['reportType', undefined],
    ['reportType', ''],
    ['reportType', 'CSAM'],
    ['reportType', 'csam; DROP'],
    ['reportType', 'x'.repeat(65)],
    ['reportedAt', undefined],
    ['reportedAt', 'yesterday'],
    ['reportedAt', 1762509600000],
    ['hasExcerpt', undefined],
    ['hasExcerpt', 'true'],
  ])('refuses %s = %s with 400, before touching storage', async (field, value) => {
    const { res, prepareDb } = await call(JSON.stringify({ ...valid, [field]: value }), { DB: {} });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; code: string; error: string };
    expect(body).toMatchObject({ success: false, code: 'invalid_body' });
    expect(body.error).toContain(field);
    expect(prepareDb).not.toHaveBeenCalled();
  });

  it('accepts a 64-hex reportId, the gift wrap id fallback', async () => {
    // Valid, so it gets as far as storage, which this env does not have.
    const { res } = await call(JSON.stringify({ ...valid, reportId: 'c3'.repeat(32) }));
    expect(res.status).toBe(503);
  });

  it('answers 503 for a valid report when D1 is not bound', async () => {
    const { res } = await call(JSON.stringify(valid));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'db_unavailable' });
  });

  it('answers 503 when the schema cannot be prepared', async () => {
    const res = await handlePrivateReport(
      new Request('https://api.test/api/internal/private-reports', { method: 'POST', body: JSON.stringify(valid) }),
      { DB: {} } as never, {}, async () => { throw new Error('D1 down'); },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'db_unavailable' });
  });
});
