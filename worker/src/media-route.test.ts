import { describe, it, expect } from 'vitest';
import worker from './index';

const ctx = {} as ExecutionContext;
const env = {
  ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
  RELAY_URL: 'wss://relay.divine.video',
  ADMIN_API_KEY: 'test-admin-key',
} as never;

const SHA = 'a'.repeat(64);

function get(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://api-relay-staging.divine.video${path}`, { method: 'GET', headers }),
    env,
    ctx,
  );
}

describe('GET /media/:sha256', () => {
  it('is gated: no admin auth is rejected, never serving the page', async () => {
    const res = await get(`/media/${SHA}`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('/api/media-proxy/'); // page never rendered
  });

  it('serves the standalone page to an authenticated moderator', async () => {
    const res = await get(`/media/${SHA}`, { 'X-Admin-Key': 'test-admin-key' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain(`/api/media-proxy/${SHA}`);
    expect(body).toContain(SHA);
    expect(body.toLowerCase()).toContain('restricted');
  });

  it('400s a non-hex sha rather than serving anything reflective', async () => {
    const res = await get('/media/not-a-real-hash', { 'X-Admin-Key': 'test-admin-key' });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('not-a-real-hash');
  });

  it('tolerates a file extension on the path (…/media/<sha>.mp4)', async () => {
    const res = await get(`/media/${SHA}.mp4`, { 'X-Admin-Key': 'test-admin-key' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/api/media-proxy/${SHA}`);
  });
});
