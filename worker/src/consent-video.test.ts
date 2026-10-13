import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseConsentMultipart,
  R2MultipartVideoWriter,
  verifyConsentAccessJwt,
  handleConsentVideo,
  disposeDueConsentVideos,
  ConsentUploadError,
  type ConsentVideoEnv,
} from './consent-video';

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
      onVideoEnd: () => {},
    });
    expect(started).toBe('video/mp4');
    expect(result.email).toBe('parent@example.com');
    expect(result.videoSize).toBe(video.length);
    expect(new Uint8Array(got)).toEqual(video);
  });

  it('rejects a non-video part with 415 and oversize video with 413', async () => {
    const bad = multipartBody([{ name: 'video', filename: 'x.txt', type: 'text/plain', value: 'hi' }]);
    await expect(parseConsentMultipart(bad.body, bad.contentType, {}, { onVideoChunk: () => {} }))
      .rejects.toMatchObject({ status: 415 });
    const big = multipartBody([{ name: 'video', filename: 'x.mp4', type: 'video/mp4', value: new Uint8Array(100) }]);
    await expect(parseConsentMultipart(big.body, big.contentType, { videoLimit: 10 }, { onVideoChunk: () => {} }))
      .rejects.toBeInstanceOf(ConsentUploadError);
  });

  it('rejects a second video part with 400 before starting a second upload', async () => {
    const { body, contentType } = multipartBody([
      { name: 'video', filename: 'a.mp4', type: 'video/mp4', value: 'aaaa' },
      { name: 'video', filename: 'b.mp4', type: 'video/mp4', value: 'bbbbbbbb' },
      { name: 'email', value: 'parent@example.com' },
    ]);
    const onVideoStart = vi.fn();
    await expect(parseConsentMultipart(body, contentType, {}, { onVideoStart, onVideoChunk: () => {} }))
      .rejects.toMatchObject({ status: 400 });
    expect(onVideoStart).toHaveBeenCalledTimes(1);
  });
});

describe('parseConsentMultipart error codes', () => {
  const parse = (parts: Parameters<typeof multipartBody>[0], limits: { videoLimit?: number; bodyLimit?: number } = {}) => {
    const { body, contentType } = multipartBody(parts);
    return parseConsentMultipart(body, contentType, limits, { onVideoChunk: () => {} });
  };
  const video = (value: string | Uint8Array = 'clip', type = 'video/mp4') =>
    ({ name: 'video', filename: 'c.mp4', type, value });

  it.each([
    ['invalid_multipart', () => parseConsentMultipart(new ReadableStream(), 'multipart/form-data', {}, { onVideoChunk: () => {} })],
    ['extra_video_part', () => parse([video(), video()])],
    ['video_type_required', () => parse([video('hi', 'text/plain')])],
    ['video_too_large', () => parse([video(new Uint8Array(100))], { videoLimit: 10 })],
    ['upload_too_large', () => parse([video(new Uint8Array(100))], { bodyLimit: 50 })],
    ['field_too_large', () => parse([{ name: 'email', value: 'x'.repeat(1_000_001) }, video()])],
    ['video_required', () => parse([{ name: 'email', value: 'parent@example.com' }])],
    ['video_empty', () => parse([video('')])],
  ])('rejects with code %s', async (code, run) => {
    await expect(run()).rejects.toMatchObject({ code });
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
      onVideoEnd: () => writer.finish(),
    });
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
      all: vi.fn(async () => ({ results: sql.includes('closed_at') && sql.includes('consent_submissions') ? rows : [] })),
      run: vi.fn(async () => { order.push('db'); return { meta: { changes: 1 } }; }),
    })) })) };
    const bucket = { delete: vi.fn(async () => { order.push('r2'); }) };
    const count = await disposeDueConsentVideos(db as never, bucket as never);
    expect(count).toBe(1);
    // The first two 'db' entries are the disposed-row cleanups for current
    // and earlier rounds; the object delete still precedes the update that
    // marks this row disposed.
    expect(order).toEqual(['db', 'db', 'r2', 'db']);
  });
});
