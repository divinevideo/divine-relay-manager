// ABOUTME: Private R2 storage for Greenlight parent-consent videos: streaming
// ABOUTME: multipart parsing, Access-gated reviewer playback, and disposal.

import { sha256 } from '@noble/hashes/sha256';
import { RETENTION_DAYS } from '../../shared/retention';
import { verifyAccessJwt, type FetchFn } from './access-jwt';

export const CONSENT_VIDEO_LIMIT = 80_000_000;
export const CONSENT_BODY_LIMIT = 82_000_000;

export interface ConsentVideoEnv {
  DB?: D1Database;
  CONSENT_VIDEO_BUCKET?: R2Bucket;
  CONSENT_ACCESS_TEAM_DOMAIN?: string;
  CONSENT_ACCESS_AUD?: string;
}

export class ConsentUploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ---------------------------------------------------------------------------
// Streaming multipart parser. Never buffers the whole body: the video part is
// handed to the sink chunk by chunk, and only a boundary-length tail is held
// back so a boundary split across chunks is still recognised.
// ---------------------------------------------------------------------------

export interface ConsentMultipartSink {
  onVideoStart?: (contentType: string) => void | Promise<void>;
  onVideoChunk: (chunk: Uint8Array) => void | Promise<void>;
}

export interface ConsentMultipartResult {
  email: string | null;
  videoContentType: string | null;
  videoSize: number;
}

function findSub(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function parseConsentMultipart(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  limits: { bodyLimit?: number; videoLimit?: number; payloadHash: string },
  sink: ConsentMultipartSink,
): Promise<ConsentMultipartResult> {
  if (!/^[0-9a-f]{64}$/.test(limits.payloadHash ?? '')) {
    throw new ConsentUploadError(401, 'A signed consent payload is required');
  }
  const bodyLimit = limits.bodyLimit ?? CONSENT_BODY_LIMIT;
  const videoLimit = limits.videoLimit ?? CONSENT_VIDEO_LIMIT;
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || /[\r\n]/.test(boundary)) throw new ConsentUploadError(400, 'Invalid multipart body');

  const enc = new TextEncoder();
  const marker = enc.encode(`\r\n--${boundary}`);
  const headerSep = enc.encode('\r\n\r\n');
  const reader = body.getReader();
  const digest = sha256.create();

  // The leading CRLF makes the first boundary match the same marker as the rest.
  let buf = enc.encode('\r\n');
  let state: 'preamble' | 'headers' | 'data' | 'done' = 'preamble';
  let partName = '';
  let partIsVideo = false;
  let totalBytes = 0;
  let videoSize = 0;
  let videoContentType: string | null = null;
  let sawVideo = false;
  const fields = new Map<string, string>();
  let fieldChunks: Uint8Array[] = [];
  let closingBytes = 0;
  const consumeClosing = (bytes: Uint8Array): void => {
    for (const byte of bytes) {
      if (closingBytes >= 2 || byte !== (closingBytes === 0 ? 13 : 10)) {
        throw new ConsentUploadError(400, 'Invalid multipart body');
      }
      closingBytes++;
    }
  };

  const emitData = async (data: Uint8Array): Promise<void> => {
    if (data.length === 0) return;
    if (partIsVideo) {
      videoSize += data.length;
      if (videoSize > videoLimit) {
        throw new ConsentUploadError(413, 'Consent video exceeds 80 MB');
      }
      await sink.onVideoChunk(data);
    } else if (partName) {
      fieldChunks.push(data);
      const size = fieldChunks.reduce((n, c) => n + c.length, 0);
      if (size > 1_000_000) throw new ConsentUploadError(400, 'Multipart field too large');
    }
  };

  const finishPart = (): void => {
    if (!partIsVideo && partName) {
      const value = new TextDecoder().decode(concatAll(fieldChunks));
      fields.set(partName, value);
    }
    fieldChunks = [];
    partName = '';
    partIsVideo = false;
  };

  const processBuffer = async (final: boolean): Promise<void> => {
    for (;;) {
      if (state === 'done') return;
      if (state === 'preamble' || state === 'data') {
        const idx = findSub(buf, marker);
        if (idx === -1) {
          if (state === 'data') {
            // Hold back a marker-length tail that may be a split boundary.
            const safe = Math.max(0, buf.length - marker.length);
            if (safe > 0) {
              await emitData(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
          } else if (buf.length > marker.length || buf.some((byte, i) => byte !== marker[i])) {
            throw new ConsentUploadError(400, 'Invalid multipart body');
          }
          if (final) throw new ConsentUploadError(400, 'Invalid multipart body');
          return;
        }
        // The unsigned boundary must describe the very start of the signed
        // body, not select a different multipart message inside a preamble.
        if (state === 'preamble' && idx !== 0) throw new ConsentUploadError(400, 'Invalid multipart body');
        // Need the two bytes after the marker to tell end-of-body from next part.
        if (buf.length < idx + marker.length + 2) {
          if (final) throw new ConsentUploadError(400, 'Invalid multipart body');
          if (state === 'data' && idx > 0) {
            await emitData(buf.slice(0, idx));
            buf = buf.slice(idx);
          }
          return;
        }
        if (state === 'data') await emitData(buf.slice(0, idx));
        const trailer = new TextDecoder().decode(buf.slice(idx + marker.length, idx + marker.length + 2));
        buf = buf.slice(idx + marker.length + 2);
        if (state === 'data') finishPart();
        if (trailer === '--') {
          state = 'done';
          consumeClosing(buf);
          buf = new Uint8Array(0);
          return;
        }
        if (trailer !== '\r\n') throw new ConsentUploadError(400, 'Invalid multipart body');
        state = 'headers';
        continue;
      }
      // headers
      const idx = findSub(buf, headerSep);
      if (idx === -1) {
        if (final) throw new ConsentUploadError(400, 'Invalid multipart body');
        return;
      }
      const headerText = new TextDecoder('latin1').decode(buf.slice(0, idx));
      buf = buf.slice(idx + headerSep.length);
      const disposition = headerText.match(/Content-Disposition:[^\r\n]*\bname="([^"]+)"(?:[^\r\n]*\bfilename="([^"]*)")?/i);
      partName = disposition?.[1] ?? '';
      const filename = disposition?.[2];
      const type = headerText.match(/(?:^|\r\n)Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() ?? '';
      partIsVideo = partName === 'video' && filename !== undefined;
      if (partIsVideo) {
        if (sawVideo) throw new ConsentUploadError(400, 'Exactly one video file part is required');
        if (!type.startsWith('video/')) {
          throw new ConsentUploadError(415, 'video/* content type is required');
        }
        sawVideo = true;
        videoContentType = type;
        await sink.onVideoStart?.(type);
      }
      state = 'data';
    }
  };

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > bodyLimit) {
        throw new ConsentUploadError(413, 'Consent upload exceeds 82 MB');
      }
      digest.update(next.value);
      // Hash the complete canonical body, allowing only an optional CRLF
      // after its closing delimiter. Never buffer an epilogue.
      if ((state as string) !== 'done') {
        buf = concat(buf, next.value);
        await processBuffer(false);
      } else {
        consumeClosing(next.value);
      }
    }
    if ((state as string) !== 'done') await processBuffer(true);
    if (closingBytes === 1) throw new ConsentUploadError(400, 'Invalid multipart body');
    const actual = Array.from(digest.digest(), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== limits.payloadHash) throw new ConsentUploadError(401, 'Invalid consent payload');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!sawVideo) throw new ConsentUploadError(400, 'A video file part is required');
  if (videoSize === 0) throw new ConsentUploadError(400, 'A non-empty video file is required');

  return { email: fields.get('email') ?? null, videoContentType, videoSize };
}

function concatAll(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let out: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  for (const c of chunks) out = concat(out, c);
  return out;
}

// ---------------------------------------------------------------------------
// R2 multipart writer: parts of at least 5 MiB (R2's minimum), assembled from
// the parser's chunks without holding the whole clip.
// ---------------------------------------------------------------------------

const R2_MIN_PART = 5 * 1024 * 1024;

export class R2MultipartVideoWriter {
  private upload: R2MultipartUpload | null = null;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private parts: R2UploadedPart[] = [];
  private size = 0;
  private readonly partSize: number;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    options: { partSize?: number } = {},
  ) {
    this.partSize = options.partSize ?? R2_MIN_PART;
  }

  async start(contentType: string): Promise<void> {
    this.upload = await this.bucket.createMultipartUpload(this.key, {
      httpMetadata: { contentType },
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.upload) throw new Error('Writer not started');
    this.queue.push(chunk);
    this.queued += chunk.byteLength;
    this.size += chunk.byteLength;
    while (this.queued >= this.partSize) {
      await this.uploadPart(await this.take(this.partSize));
    }
  }

  async finish(): Promise<number> {
    if (!this.upload) throw new Error('Writer not started');
    if (this.queued > 0 || this.parts.length === 0) {
      await this.uploadPart(await this.take(this.queued));
    }
    await this.upload.complete(this.parts);
    return this.size;
  }

  async abort(): Promise<void> {
    try {
      await this.upload?.abort();
    } catch {
      // Best effort: an orphaned multipart upload carries no readable object.
    }
  }

  private async take(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.queue[0];
      const need = n - offset;
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        this.queue.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        this.queue[0] = head.subarray(need);
        offset += need;
      }
    }
    this.queued -= n;
    return out;
  }

  private async uploadPart(data: Uint8Array): Promise<void> {
    if (!this.upload) throw new Error('Writer not started');
    const part = await this.upload.uploadPart(this.parts.length + 1, data);
    this.parts.push(part);
  }
}

// ---------------------------------------------------------------------------
// Reviewer access: verify the Cloudflare Access JWT ourselves (signature,
// issuer, audience). The Access application in front of this path restricts
// who can obtain one; the Worker does not trust mere header presence and
// never accepts X-Admin-Key here.
// ---------------------------------------------------------------------------

export async function verifyConsentAccessJwt(
  token: string,
  env: { CONSENT_ACCESS_TEAM_DOMAIN?: string; CONSENT_ACCESS_AUD?: string },
  fetchFn?: FetchFn,
): Promise<boolean> {
  const claims = await verifyAccessJwt(
    token,
    {
      teamDomain: env.CONSENT_ACCESS_TEAM_DOMAIN,
      audience: env.CONSENT_ACCESS_AUD,
      onReject: (reason) => console.warn(`[consent-video] Cf-Access-Jwt-Assertion refused: ${reason}`),
    },
    fetchFn,
  );
  return claims !== null;
}

interface ConsentSubmissionRow {
  object_key: string;
  content_type: string | null;
  size_bytes: number | null;
  status: string;
}

export async function handleConsentVideo(
  request: Request,
  receiptId: string,
  env: ConsentVideoEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB || !env.CONSENT_VIDEO_BUCKET || !env.CONSENT_ACCESS_TEAM_DOMAIN || !env.CONSENT_ACCESS_AUD) {
    return json({ success: false, error: 'Consent video viewer not configured' }, 503, corsHeaders);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !(await verifyConsentAccessJwt(token, env))) {
    return json({ success: false, error: 'Unauthorized' }, 401, corsHeaders);
  }
  const row = await env.DB.prepare(
    `SELECT object_key, content_type, size_bytes, status FROM age_review_parent_consent_submissions
     WHERE receipt_id = ? AND disposed_at IS NULL`,
  ).bind(receiptId).first<ConsentSubmissionRow>();
  if (!row?.object_key) return json({ success: false, error: 'Not found' }, 404, corsHeaders);

  const total = row.size_bytes ?? undefined;
  let range: { offset: number; length: number } | undefined;
  let rangeStart = 0;
  let rangeEnd = total !== undefined ? total - 1 : -1;
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader && total !== undefined) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (match && (match[1] !== '' || match[2] !== '')) {
      if (match[1] === '') {
        const suffix = Number(match[2]);
        rangeStart = Math.max(0, total - suffix);
        rangeEnd = total - 1;
      } else {
        rangeStart = Number(match[1]);
        rangeEnd = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
      }
      if (rangeStart > rangeEnd || rangeStart >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}`, ...corsHeaders },
        });
      }
      range = { offset: rangeStart, length: rangeEnd - rangeStart + 1 };
    }
  }

  const object = range
    ? await env.CONSENT_VIDEO_BUCKET.get(row.object_key, { range })
    : await env.CONSENT_VIDEO_BUCKET.get(row.object_key);
  if (!object?.body) return json({ success: false, error: 'Not found' }, 404, corsHeaders);

  const headers: Record<string, string> = {
    'Content-Type': row.content_type ?? object.httpMetadata?.contentType ?? 'video/mp4',
    'Content-Length': String(object.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...corsHeaders,
  };
  if (range && total !== undefined) {
    headers['Content-Range'] = `bytes ${rangeStart}-${rangeEnd}/${total}`;
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Retention: delete the R2 object 120 days after the case closes (the clock
// starts at closure, not upload), plus abandoned uploads whose case is gone
// or closed. The object is deleted first; the D1 row is marked only after,
// so a failed delete stays retryable on the next run.
// ---------------------------------------------------------------------------

// Register before completion or replacement so even a crash or failed delete
// leaves an object discoverable independently of the single submission row.
export async function trackConsentObject(db: D1Database, caseId: string, objectKey: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO age_review_consent_objects (object_key, case_id, created_at)
    VALUES (?, ?, ?)`).bind(objectKey, caseId, Math.floor(Date.now() / 1000)).run();
}

// An active legal hold pausing consent-video disposal for the case that
// caseIdSql names: a column reference or a bound parameter. Every consent
// delete path checks holds through this one predicate.
function activeConsentVideoHold(caseIdSql: string): string {
  return `EXISTS (SELECT 1 FROM retention_legal_holds h
    WHERE h.record_type = 'age_review_case' AND (h.record_key IS NULL OR h.record_key = ${caseIdSql})
      AND h.disposal_stage IN ('all', 'consent_video')
      AND datetime(h.starts_at) <= datetime('now') AND h.released_at IS NULL
      AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now')))`;
}

export async function deleteConsentObjectUnlessHeld(db: D1Database, bucket: R2Bucket, caseId: string, objectKey: string): Promise<void> {
  const hold = await db.prepare(`SELECT ${activeConsentVideoHold('?')} AS held`)
    .bind(caseId).first<{ held: number }>();
  if (!hold || (hold.held !== 0 && hold.held !== 1)) throw new Error('Could not determine consent video legal hold');
  // Retain both the blob and its inventory entry for a later eligible sweep.
  if (hold.held === 1) return;
  await deleteTrackedConsentObject(db, bucket, objectKey);
}

// Cron callers select hold-eligible rows before reaching this private helper.
async function deleteTrackedConsentObject(db: D1Database, bucket: R2Bucket, objectKey: string): Promise<void> {
  await bucket.delete(objectKey);
  await db.prepare('DELETE FROM age_review_consent_objects WHERE object_key = ?').bind(objectKey).run();
}

export async function disposeDueConsentVideos(db: D1Database, bucket: R2Bucket): Promise<number> {
  let disposed = 0;
  // Claim only unreferenced attempts after a day. Adoption requires 'pending',
  // so a stalled request cannot resurrect a key a sweep has already claimed.
  // Keep failed deletes in 'deleting' for the next cron, including across crashes.
  // A failure here must not skip the retention deletes below for this run.
  try {
    const orphaned = await db.prepare(`UPDATE age_review_consent_objects SET state = 'deleting'
      WHERE object_key IN (
        SELECT o.object_key FROM age_review_consent_objects o
        WHERE o.created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM age_review_parent_consent_submissions s WHERE s.object_key = o.object_key)
          AND NOT ${activeConsentVideoHold('o.case_id')}
        LIMIT 100
      ) RETURNING object_key`).bind(Math.floor(Date.now() / 1000) - 86400).all<{ object_key: string }>();
    for (const row of orphaned.results) {
      try {
        await deleteTrackedConsentObject(db, bucket, row.object_key);
        disposed++;
      } catch (error) {
        console.error('[retention] unreferenced consent video delete failed:', error);
      }
    }
  } catch (error) {
    console.error('[retention] unreferenced consent video sweep failed:', error);
  }
  const due = await db.prepare(
    `SELECT s.case_id, s.object_key FROM age_review_parent_consent_submissions s
     JOIN age_review_cases c ON c.id = s.case_id
     WHERE s.object_key IS NOT NULL AND s.disposed_at IS NULL
       AND c.closed_at IS NOT NULL
       AND datetime(c.closed_at) <= datetime('now', '-${RETENTION_DAYS.consentVideo} days')
       AND NOT ${activeConsentVideoHold('s.case_id')}
     LIMIT 100`,
  ).bind().all<{ case_id: string; object_key: string }>();
  const abandoned = await db.prepare(
    `SELECT s.case_id, s.object_key FROM age_review_parent_consent_submissions s
     WHERE s.object_key IS NOT NULL AND s.disposed_at IS NULL AND s.status = 'processing'
       AND s.created_at <= unixepoch('now', '-7 days')
       AND NOT EXISTS (SELECT 1 FROM age_review_cases c WHERE c.id = s.case_id AND c.closed_at IS NULL)
       AND NOT ${activeConsentVideoHold('s.case_id')}
     LIMIT 100`,
  ).bind().all<{ case_id: string; object_key: string }>();

  // Rows whose clip is disposed and whose case has been deleted carry only
  // an opaque receipt; drop them so the link from case to clip cannot
  // outlive the case itself.
  await db.prepare(
    `DELETE FROM age_review_parent_consent_submissions
     WHERE disposed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM age_review_cases c WHERE c.id = case_id)`,
  ).bind().run();

  const seen = new Set<string>();
  for (const row of [...due.results, ...abandoned.results]) {
    if (seen.has(row.object_key)) continue;
    seen.add(row.object_key);
    try {
      await deleteTrackedConsentObject(db, bucket, row.object_key);
    } catch (error) {
      console.error('[retention] consent video delete failed:', error);
      continue;
    }
    const marked = await db.prepare(
      `UPDATE age_review_parent_consent_submissions SET disposed_at = unixepoch(), status = 'disposed'
       WHERE case_id = ? AND object_key = ? AND disposed_at IS NULL`,
    ).bind(row.case_id, row.object_key).run();
    disposed += marked.meta?.changes ?? 0;
  }
  return disposed;
}
