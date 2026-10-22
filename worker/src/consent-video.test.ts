import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseConsentMultipart as parseAuthenticatedMultipart,
  R2MultipartVideoWriter,
  verifyConsentAccessJwt,
  handleConsentVideo,
  disposeDueConsentVideos,
  ConsentUploadError,
  type ConsentVideoEnv,
} from './consent-video';

// Generate a digest only for parser fixtures that are not testing a supplied digest.
async function parseConsentMultipart(
  body: ReadableStream<Uint8Array>, contentType: string,
  limits: { bodyLimit?: number; videoLimit?: number; payloadHash?: string },
  sink: Parameters<typeof parseAuthenticatedMultipart>[3],
) {
  if (limits.payloadHash) return parseAuthenticatedMultipart(body, contentType, { ...limits, payloadHash: limits.payloadHash }, sink);
  const [input, digestInput] = body.tee();
  const digest = await crypto.subtle.digest('SHA-256', await new Response(digestInput).arrayBuffer());
  const payloadHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return parseAuthenticatedMultipart(input, contentType, { ...limits, payloadHash }, sink);
}

const cors = { 'Access-Control-Allow-Origin': '*' };

function streamOf(chunks: Uint8Array[], chunkSize = 65536): ReadableStream<Uint8Array> {
  const flat = chunks.flatMap((c) => [...c]);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= flat.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(flat.slice(i, i + chunkSize)));
      i += chunkSize;
    },
  });
}

function multipartBody(parts: Array<{ name: string; filename?: string; type?: string; value: string | Uint8Array }>, boundary = 'testb') {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    head += '\r\n';
    chunks.push(enc.encode(head));
    chunks.push(typeof p.value === 'string' ? enc.encode(p.value) : p.value);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return { body: streamOf(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('parseConsentMultipart', () => {
  it('rejects a boundary containing a line break', async () => {
    const data = multipartBody([{ name: 'video', filename: 'clip.mp4', type: 'video/mp4', value: 'clip' }], 'first\r\nsecond');
    await expect(parseConsentMultipart(data.body, 'multipart/form-data; boundary="first\r\nsecond"',
      {}, { onVideoChunk: () => {} })).rejects.toMatchObject({ status: 400 });
  });

  it.each(['first', 'second'])('rejects an ambiguous signed body selected with the %s boundary', async (selected) => {
    const first = multipartBody([
      { name: 'email', value: 'first@example.com' },
      { name: 'video', filename: 'first.mp4', type: 'video/mp4', value: 'first clip' },
    ], 'first-boundary');
    const second = multipartBody([
      { name: 'email', value: 'second@example.com' },
      { name: 'video', filename: 'second.mp4', type: 'video/mp4', value: 'second clip' },
    ], 'second-boundary');
    const a = new Uint8Array(await new Response(first.body).arrayBuffer());
    const b = new Uint8Array(await new Response(second.body).arrayBuffer());
    // The helper signs these same bytes whichever unsigned boundary is selected.
    await expect(parseConsentMultipart(streamOf([a, b], 1), selected === 'first' ? first.contentType : second.contentType,
      {}, { onVideoChunk: () => {} })).rejects.toMatchObject({ status: 400 });
  });

  it('accepts only an optional complete CRLF after the closing boundary', async () => {
    const data = multipartBody([{ name: 'video', filename: 'clip.mp4', type: 'video/mp4', value: 'clip' }]);
    const raw = new Uint8Array(await new Response(data.body).arrayBuffer());
    for (const body of [raw, raw.slice(0, -2)]) {
      const parsed = await parseConsentMultipart(streamOf([body], 1), data.contentType, {}, { onVideoChunk: () => {} });
      expect(parsed.videoSize).toBe(4);
    }
    await expect(parseConsentMultipart(streamOf([raw.slice(0, -1)], 1), data.contentType,
      {}, { onVideoChunk: () => {} })).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed without a canonical signed digest', async () => {
    const sink = { onVideoChunk: vi.fn() };
    await expect(parseAuthenticatedMultipart(streamOf([]), 'multipart/form-data; boundary=test',
      { payloadHash: '' }, sink)).rejects.toMatchObject({ status: 401 });
    expect(sink.onVideoChunk).not.toHaveBeenCalled();
  });

  it('streams video bytes intact across tiny chunks and parses fields after the file', async () => {
    const video = new Uint8Array(Array.from({ length: 500 }, (_, i) => i % 251));
    const { body, contentType } = multipartBody([
      { name: 'video', filename: 'c.mp4', type: 'video/mp4', value: video },
      { name: 'email', value: 'parent@example.com' },
    ]);
    const got: number[] = [];
    let started = '';
    const result = await parseConsentMultipart(body, contentType, {}, {
      onVideoStart: (t) => { started = t; },
      onVideoChunk: (c) => { got.push(...c); },
    });
    expect(started).toBe('video/mp4');
    expect(result.email).toBe('parent@example.com');
    expect(result.videoSize).toBe(video.length);
    expect(new Uint8Array(got)).toEqual(video);
  });

  it('binds binary chunks and rejects data beyond the closing delimiter', async () => {
    const data = multipartBody([
      { name: 'email', value: 'parent@example.com' },
      { name: 'video', filename: 'clip.mp4', type: 'video/mp4', value: new Uint8Array([0, 128, 255]) },
    ]);
    const raw = new Uint8Array(await new Response(data.body).arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), b => b.toString(16).padStart(2, '0')).join('');
    const result = await parseConsentMultipart(streamOf([raw], 1), data.contentType, { payloadHash: digest }, { onVideoChunk: () => {} });
    expect(result.videoSize).toBe(3);
    await expect(parseConsentMultipart(streamOf([raw, new TextEncoder().encode('extra')], 1), data.contentType,
      { payloadHash: digest }, { onVideoChunk: () => {} })).rejects.toMatchObject({ status: 400 });
    await expect(parseConsentMultipart(streamOf([raw], 1), data.contentType,
      { bodyLimit: raw.length - 1, payloadHash: digest }, { onVideoChunk: () => {} })).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a second video before replacing the active multipart writer', async () => {
    const body = multipartBody([
      { name: 'video', filename: 'first.mp4', type: 'video/mp4', value: 'first' },
      { name: 'video', filename: 'second.mp4', type: 'video/mp4', value: 'second' },
    ]);
    const start = vi.fn();
    await expect(parseConsentMultipart(body.body, body.contentType, {}, { onVideoStart: start, onVideoChunk: () => {} }))
      .rejects.toMatchObject({ status: 400 });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-video part with 415 and oversize video with 413', async () => {
    const bad = multipartBody([{ name: 'video', filename: 'x.txt', type: 'text/plain', value: 'hi' }]);
    await expect(parseConsentMultipart(bad.body, bad.contentType, {}, { onVideoChunk: () => {} }))
      .rejects.toMatchObject({ status: 415 });
    const big = multipartBody([{ name: 'video', filename: 'x.mp4', type: 'video/mp4', value: new Uint8Array(100) }]);
    await expect(parseConsentMultipart(big.body, big.contentType, { videoLimit: 10 }, { onVideoChunk: () => {} }))
      .rejects.toBeInstanceOf(ConsentUploadError);
  });
});

describe('R2MultipartVideoWriter', () => {
  it('uploads parts and completes with total size', async () => {
    const parts: Array<{ n: number; size: number }> = [];
    const bucket = {
      createMultipartUpload: vi.fn(async () => ({
        uploadPart: vi.fn(async (n: number, v: Uint8Array) => { parts.push({ n, size: v.byteLength }); return { partNumber: n, etag: `e${n}` }; }),
        complete: vi.fn(async () => ({})),
        abort: vi.fn(async () => {}),
      })),
    };
    const writer = new R2MultipartVideoWriter(bucket as never, 'key1', { partSize: 10 });
    await writer.start('video/mp4');
    await writer.write(new Uint8Array(25));
    const size = await writer.finish();
    expect(size).toBe(25);
    expect(parts.map((p) => p.size)).toEqual([10, 10, 5]);
  });
});

async function makeJwt() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
  const payload = { iss: 'https://team.example.com', aud: 'aud-1', exp: now + 600, iat: now, email: 'rev@example.com' };
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid: 'k1' }] }) }));
  return { token: `${data}.${sigB64}`, fetchFn };
}

describe('large clip streaming', () => {
  it('streams a clip larger than the old 50 MB attachment ceiling in 5 MiB parts', async () => {
    const size = 6 * 1024 * 1024 + 123;
    const video = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) video[i] = i % 251;
    const { body, contentType } = multipartBody([
      { name: 'email', value: 'parent@example.com' },
      { name: 'video', filename: 'c.mp4', type: 'video/mp4', value: video },
    ]);
    const partSizes: number[] = [];
    const bucket = {
      createMultipartUpload: vi.fn(async () => ({
        uploadPart: vi.fn(async (n: number, v: Uint8Array) => { partSizes.push(v.byteLength); return { partNumber: n, etag: `e${n}` }; }),
        complete: vi.fn(async () => ({})),
        abort: vi.fn(async () => {}),
      })),
    };
    const writer = new R2MultipartVideoWriter(bucket as never, 'big');
    const result = await parseConsentMultipart(body, contentType, {}, {
      onVideoStart: (t) => writer.start(t),
      onVideoChunk: (c) => writer.write(c),
    });
    await writer.finish();
    expect(result.videoSize).toBe(size);
    expect(partSizes).toEqual([5 * 1024 * 1024, size - 5 * 1024 * 1024]);
  });
});

describe('verifyConsentAccessJwt + handleConsentVideo', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('accepts a valid Access JWT and rejects a tampered one', async () => {
    const { token, fetchFn } = await makeJwt();
    const env = { CONSENT_ACCESS_TEAM_DOMAIN: 'team.example.com', CONSENT_ACCESS_AUD: 'aud-1' };
    expect(await verifyConsentAccessJwt(token, env, fetchFn as never)).toBe(true);
    expect(await verifyConsentAccessJwt(`${token}x`, env, fetchFn as never)).toBe(false);
  });

  it('fails closed without config, 401 without JWT, serves range with valid JWT', async () => {
    const { token, fetchFn } = await makeJwt();
    vi.stubGlobal('fetch', fetchFn);
    const row = { object_key: 'obj1', content_type: 'video/mp4', size_bytes: 10, status: 'commented' };
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => row) })) })) };
    const data = new Uint8Array(Array.from({ length: 10 }, (_, i) => i));
    const bucket = { get: vi.fn(async (_k: string, opts?: { range?: { offset: number; length: number } }) => {
      if (opts?.range) { const s = data.slice(opts.range.offset, opts.range.offset + opts.range.length); return { body: new ReadableStream({ start(c) { c.enqueue(s); c.close(); } }), size: s.length, httpMetadata: { contentType: 'video/mp4' } }; }
      return { body: new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }), size: data.length, httpMetadata: { contentType: 'video/mp4' } };
    }) };
    const base = { DB: db, CONSENT_VIDEO_BUCKET: bucket } as unknown as ConsentVideoEnv;
    expect((await handleConsentVideo(new Request('https://w/api/age-review/consent-video/r1'), 'r1', base, cors)).status).toBe(503);
    const env = { ...base, CONSENT_ACCESS_TEAM_DOMAIN: 'team.example.com', CONSENT_ACCESS_AUD: 'aud-1' } as ConsentVideoEnv;
    expect((await handleConsentVideo(new Request('https://w/api/age-review/consent-video/r1'), 'r1', env, cors)).status).toBe(401);
    const ok = await handleConsentVideo(new Request('https://w/api/age-review/consent-video/r1', { headers: { 'Cf-Access-Jwt-Assertion': token } }), 'r1', env, cors);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toContain('no-store');
    const ranged = await handleConsentVideo(new Request('https://w/api/age-review/consent-video/r1', { headers: { 'Cf-Access-Jwt-Assertion': token, Range: 'bytes=2-5' } }), 'r1', env, cors);
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
  });
});

describe('disposeDueConsentVideos', () => {
  it('deletes the R2 object before marking the row disposed', async () => {
    const order: string[] = [];
    const rows = [{ case_id: 'c1', object_key: 'obj1' }];
    const db = { prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({
      all: vi.fn(async () => ({ results: sql.includes('SELECT s.case_id') && sql.includes('closed_at') ? rows : [] })),
      run: vi.fn(async () => { order.push('db'); return { meta: { changes: 1 } }; }),
    })) })) };
    const bucket = { delete: vi.fn(async () => { order.push('r2'); }) };
    const count = await disposeDueConsentVideos(db as never, bucket as never);
    expect(count).toBe(1);
    // First 'db' is the disposed-row cleanup; the object delete still
    // precedes the update that marks this row disposed.
    expect(order).toEqual(['db', 'r2', 'db', 'db']);
  });

  it('still disposes due clips when the unreferenced-upload sweep fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [{ case_id: 'c1', object_key: 'obj1' }];
    const db = { prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({
      all: vi.fn(async () => {
        if (sql.includes("SET state = 'deleting'")) throw new Error('D1 unavailable');
        return { results: sql.includes('SELECT s.case_id') && sql.includes('closed_at') ? rows : [] };
      }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })) })) };
    const bucket = { delete: vi.fn(async () => {}) };
    expect(await disposeDueConsentVideos(db as never, bucket as never)).toBe(1);
    expect(bucket.delete).toHaveBeenCalledWith('obj1');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
