// GET /api/check-result/{sha256}: the moderators' screen reads a file's
// moderation state through this proxy.
//
// moderation-service answers "no decision" with a 200 and `status: 'unknown'`
// (handlePublicCheckResult in divine-moderation-service). It answers 404 only
// when it rejects the request itself, such as an unknown host. Passing that on
// as "no decision" made every file read as open, and the screen then offered
// Age Restrict on a blocked file, which weakens it. A status that could not be
// read has to come back as an error, as it already does for the expected-state
// check and for bulk moderation.
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// Full-length 64-char hex hash, never truncated.
const SHA = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';

function env(answer: (request: Request) => Response) {
  return {
    ADMIN_API_KEY: 'k',
    MODERATION_API: { fetch: async (request: Request) => answer(request) },
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function read() {
  return new Request(`https://relay.example/api/check-result/${SHA}`, {
    method: 'GET',
    headers: { 'X-Admin-Key': 'k' },
  });
}

describe('/api/check-result proxy', () => {
  it('passes a recorded decision through', async () => {
    const stored = { sha256: SHA, status: 'permanent_ban', moderated: true, action: 'PERMANENT_BAN' };
    const res = await worker.fetch(read(), env(() => Response.json(stored)), {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(stored);
  });

  it('passes "no decision" through as moderation-service states it', async () => {
    const none = { sha256: SHA, status: 'unknown', moderated: false, blocked: false, age_restricted: false };
    const res = await worker.fetch(read(), env(() => Response.json(none)), {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(none);
  });

  it('reports an upstream 404 as a failed read, never as "no decision"', async () => {
    const res = await worker.fetch(
      read(),
      env(() => new Response('Not Found', { status: 404 })),
      {} as ExecutionContext,
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(expect.objectContaining({ success: false }));
  });
});
