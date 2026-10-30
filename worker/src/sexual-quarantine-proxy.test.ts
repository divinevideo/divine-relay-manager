import { expect, it } from 'vitest';
import worker from './index';

it('forwards review queue cursors through the authenticated Worker entry point', async () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const cursor = `sexual-review-v3:0:0000000000001000:${first}`;
  const env = {
    ADMIN_API_KEY: 'synthetic-admin-key', ALLOWED_ORIGINS: 'https://app.example.test',
    REPORT_WATCHER: { idFromName: () => 'singleton', get: () => ({ fetch: async (request: Request) => {
      const continued = new URL(request.url).searchParams.get('cursor') === cursor;
      return Response.json({ cases: [{ eventId: continued ? second : first }], ...(!continued && { nextCursor: cursor }) });
    } }) },
  } as never;
  const read = (search = '') => worker.fetch(new Request(`https://api.example.test/api/report-watcher/sexual-quarantine${search}`, {
    headers: { 'X-Admin-Key': 'synthetic-admin-key' },
  }), env, {} as ExecutionContext);
  const page = await read();
  expect(await page.json()).toEqual({ cases: [{ eventId: first }], nextCursor: cursor });
  const next = await read(`?cursor=${encodeURIComponent(cursor)}`);
  expect(await next.json()).toEqual({ cases: [{ eventId: second }] });
  expect(next.headers.get('Cache-Control')).toBe('private, no-store');
});
