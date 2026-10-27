// ABOUTME: Reads from the media server's (blossom's) admin API: an account's
// ABOUTME: video files, and one file's owner and status (#299).

// The bindings these reads need. BulkModerateEnv and the worker's Env both
// carry them.
export interface MediaServerEnv {
  CDN_DOMAIN?: string;
  BLOSSOM_WEBHOOK_SECRET?: string | { get(): Promise<string> };
}

// 64 hex characters in either case: what another service may send for a hash
// or a pubkey, before this worker lowercases it.
export const SHA256_HEX = /^[a-f0-9]{64}$/i;
// Exactly what this worker writes for a pubkey or a hash, and what it compares
// them against.
export const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

// Strength of a blob's current state, as either status source reports it.
export type MediaLevel = 'open' | 'gated' | 'hidden' | 'blocked' | 'deleted';

// blossom's BlobStatus, from GET /admin/api/blob/{sha256} (divine-blossom
// blossom-core/src/types.rs). This is what viewers are actually served, and the
// only place a status set in blossom's own admin UI shows up: that UI never
// tells moderation-service.
export const BLOSSOM_LEVEL = new Map<string, MediaLevel>([
  ['active', 'open'],
  ['pending', 'open'],
  ['age_restricted', 'gated'],
  ['restricted', 'hidden'],
  ['banned', 'blocked'],
  ['deleted', 'deleted'],
]);

export const STATUS_READ_TIMEOUT_MS = 10000;
const ACCOUNT_FILES_TIMEOUT_MS = 30000;

// The media server's admin key, or why it cannot be had: unbound, empty, or a
// Secrets Store read that threw. Returned rather than thrown, so a caller that
// reads it before a batch fails each file, not the whole run.
export async function readBlossomSecret(env: MediaServerEnv): Promise<string | Error> {
  try {
    const secret = typeof env.BLOSSOM_WEBHOOK_SECRET === 'string'
      ? env.BLOSSOM_WEBHOOK_SECRET
      : await env.BLOSSOM_WEBHOOK_SECRET?.get();
    return secret || new Error('BLOSSOM_WEBHOOK_SECRET not configured');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export interface MediaStatus { raw: string; level: MediaLevel }
export interface BlossomBlob extends MediaStatus { owner: string }

// What the media server records for a file: its owner (lowercase hex) and its
// status, as served to viewers. For /api/moderate-media's account check, which
// needs the owner, and for its already-public refusal, which needs the status.
// Throws when it cannot be read: no key, a failed request, or no usable owner
// or status.
export async function readMediaRecord(sha256: string, env: MediaServerEnv): Promise<BlossomBlob> {
  const secret = await readBlossomSecret(env);
  if (secret instanceof Error) throw secret;
  return readBlossomStatus(sha256, env, secret);
}

export async function readBlossomStatus(sha256: string, env: MediaServerEnv, secret: string): Promise<BlossomBlob> {
  const response = await fetch(`https://${env.CDN_DOMAIN || 'media.divine.video'}/admin/api/blob/${sha256}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`blossom returned ${response.status}`);
  const { status, owner } = await response.json() as { status?: unknown; owner?: unknown };
  const level = typeof status === 'string' ? BLOSSOM_LEVEL.get(status) : undefined;
  if (!level) throw new Error(`blossom returned unrecognised status ${JSON.stringify(status)}`);
  if (typeof owner !== 'string' || !SHA256_HEX.test(owner)) {
    throw new Error(`blossom returned no usable owner (${JSON.stringify(owner)})`);
  }
  return { raw: status as string, level, owner: owner.toLowerCase() };
}

// One video file from the uploader list, with the owner and status the row
// carries: null when either is missing or not one this worker knows. The walks
// still read each file's record afresh before changing it; these two only pick
// files for the end-of-walk check and Un-age-restrict All's report.
// A row with a null owner, or this account's row with a null status, is still
// read file by file: by the walk, and by the end-of-walk check, which takes
// such rows. Blossom serves the list and the record from the same metadata,
// so that read (readBlossomStatus) fails and names the file, or acts on it as
// usual if the record reads cleanly. Only Un-age-restrict All's report skips
// one, which is fail-safe: a file it misses stays hidden. Blossom's record
// type requires an owner (documented as hex) and a status from a fixed set
// that BLOSSOM_LEVEL covers today.
export interface AccountVideo {
  sha256: string;
  owner: string | null;
  level: MediaLevel | null;
}

// Every video file blossom lists under the account as its uploader, sorted by
// hash, each hash once and lowercase (#299). This is the list bulk media
// actions rely on: funnelcake's video list hides a banned event at once and
// every video of a banned or suspended account, so after Delete All bans the
// events, or once the account is banned or suspended, it is empty. Blossom's
// list does not depend on what the relay shows. It holds every status except
// deleted (a soft delete takes the file off it), and it is keyed by who
// uploaded, so it can include a file another account owns; mayChangeMedia only
// changes the account's own.
//
// Videos only: a row whose `type` starts with "video/", in any case. The same
// list holds avatars, banners, sounds and subtitles. Blossom's record always
// has a type, so a row without one, like a row without a hash, means the
// answer's shape changed: dropping it could quietly leave the account's files
// in place, so it fails the read instead.
//
// Known limit: some files the media server holds are outside this videos-only
// filter and are not changed. Tracked privately.
//
// Throws, naming why, when the whole list cannot be read: a failed request, a
// timeout, or an answer that is not the expected list. The secret is resolved
// inside the same try: a Secrets Store read can throw too. A list that answers
// but leaves files out is not caught here: blossom leaves out a row whose
// record read errors and still answers 200 (divinevideo/divine-blossom#308),
// and an imported file blossom never recorded is in no list. The end-of-walk
// check finds the first kind on a later read; nothing on this side can see the
// second.
//
// Not paged (divinevideo/divine-blossom#309): blossom answers with the whole
// list, reading each file's record in one request. How large an account it can
// answer for in time is bounded by its own platform limits, not known from
// here; past that this times out.
export async function listAccountVideos(pubkey: string, env: MediaServerEnv): Promise<AccountVideo[]> {
  try {
    const secret = await readBlossomSecret(env);
    if (secret instanceof Error) throw secret;
    const response = await fetch(`https://${env.CDN_DOMAIN || 'media.divine.video'}/admin/api/user/${pubkey}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(ACCOUNT_FILES_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`media server returned ${response.status}`);
    const body = await response.json() as unknown;
    if (!Array.isArray(body)) throw new Error('media server answered with something that is not a list');
    const videos = new Map<string, AccountVideo>();
    for (const blob of body as Array<{ sha256?: unknown; type?: unknown; owner?: unknown; status?: unknown } | null>) {
      const sha256 = blob?.sha256;
      if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
        throw new Error(`media server listed a file with no valid sha256 (${JSON.stringify(sha256)})`);
      }
      const type = blob?.type;
      if (typeof type !== 'string') throw new Error(`media server listed ${sha256.toLowerCase()} with no type`);
      if (!type.toLowerCase().startsWith('video/')) continue;
      const owner = blob?.owner;
      const status = blob?.status;
      videos.set(sha256.toLowerCase(), {
        sha256: sha256.toLowerCase(),
        owner: typeof owner === 'string' && SHA256_HEX.test(owner) ? owner.toLowerCase() : null,
        level: (typeof status === 'string' && BLOSSOM_LEVEL.get(status)) || null,
      });
    }
    return [...videos.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  } catch (error) {
    throw new Error(`could not list this account's files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
