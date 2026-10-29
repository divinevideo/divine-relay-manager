import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { callNip86Rpc, type Nip86Env, type SecretStoreSecret } from './nip86';
import { queryRelay } from './relay-profile';
import { readBlossomSecret, type MediaServerEnv } from './media-server';
import { isLowerHex64 } from './hex';
import { recordSexualQuarantineDecision } from './sexual-quarantine-decision';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import { OutsideVideoScope, ConfirmedAbsentTarget, TargetEvidenceLimit, type QuarantineIO, type QuarantineSnapshot } from './sexual-quarantine';

export interface SexualQuarantineEnv extends Nip86Env, MediaServerEnv, ZendeskSyncEnv {
  DB?: D1Database;
  SEXUAL_QUARANTINE_ENABLED?: string;
  COOP_URL?: string;
  COOP_API_KEY?: string | SecretStoreSecret;
  REVIEWER_BASE_URL?: string;
}
type Hold = { hold_id: string; version: number; active: boolean | number };
type MediaHolds = { quarantined: boolean; base_status?: string; holds: Hold[] };

function holds(value: unknown, media: boolean): Hold[] {
  if (!Array.isArray(value) || value.length > 128 || value.some(row => !row
    || typeof row.hold_id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(row.hold_id)
    || !Number.isSafeInteger(row.version) || row.version < 1
    || (media ? typeof row.active !== 'boolean' : row.active !== 0 && row.active !== 1))) {
    throw new Error('Invalid hold status');
  }
  if (new Set(value.map(row => row.hold_id)).size !== value.length) throw new Error('Duplicate hold status');
  return value as Hold[];
}

const mediaOrigin = (env: MediaServerEnv) => `https://${env.CDN_DOMAIN || 'media.divine.video'}`;

export function snapshotVideo(eventId: string, raw: unknown, env: MediaServerEnv): QuarantineSnapshot {
  // nostr-tools memoizes verification on a symbol. Copy only wire data so a
  // previously verified, subsequently changed object cannot reuse that result.
  const event = JSON.parse(JSON.stringify(raw ?? null)) as NostrEvent;
  if (!event || event.id !== eventId || !verifyEvent(event)) throw new Error('Unverified video event');
  if (![21, 22, 34235, 34236].includes(event.kind)) throw new OutsideVideoScope();
  // Chunked evidence covers the relay's default 512 KiB message envelope. A
  // larger configured relay limit requires explicit capture qualification.
  // Apply this only after signature and scope classification.
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 512 * 1024) throw new TargetEvidenceLimit();
  const assets = new Set<string>();
  const paths = new Set<string>();
  const unmapped = new Set<string>();
  let mappingIncomplete = false;
  const recordPath = (set: Set<string>, value: string) => {
    if (paths.size + unmapped.size < 64 || set.has(value)) set.add(value);
    else mappingIncomplete = true;
  };
  const candidate = (hash: string) => {
    if (!isLowerHex64(hash)) { mappingIncomplete = true; return; }
    if (assets.has(hash) || assets.size < 8) assets.add(hash);
    else mappingIncomplete = true;
  };
  const add = (value: string, expectedHash?: string) => {
    // Ancillary metadata and prose are not proof of a usable media URL. Keep
    // their signed source, but do not let them veto verified video admission.
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (url.origin !== mediaOrigin(env)) return;
    const path = url.pathname + url.search;
    const hash = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+|\/(?:(?:720p|480p)(?:\.mp4)?|hls\/[a-z0-9_.-]+))?$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (!hash || !isLowerHex64(hash)) { recordPath(unmapped, path); return; }
    if ((expectedHash && expectedHash.toLowerCase() !== hash) || (!assets.has(hash) && assets.size >= 8)) {
      // Do not act on a disputed mapping or exceed the bounded IO budget.
      // Safely mapped assets/event can still be held; full verification stays pending.
      mappingIncomplete = true;
      recordPath(unmapped, path);
      return;
    }
    assets.add(hash);
    recordPath(paths, path);
  };
  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      const url = tag.find(p => p.startsWith('url '))?.slice(4);
      const hash = tag.find(p => p.startsWith('x '))?.slice(2);
      if (url) add(url, hash);
      if (hash && (!url || !url.startsWith(mediaOrigin(env) + '/'))) candidate(hash.toLowerCase());
      for (const field of tag) {
        if (field.startsWith('image ') || field.startsWith('thumb ')) add(field.slice(field.indexOf(' ') + 1));
      }
    } else if (['url', 'image', 'thumb', 'thumbnail'].includes(tag[0]) && tag[1]) add(tag[1]);
    else if (tag[0] === 'x' && tag[1]) candidate(tag[1].toLowerCase());
  }
  for (const url of event.content.match(/https?:\/\/[^\s<>"')\]]+/g) || []) add(url.replace(/[.,;!?]+$/, ''));
  return { event, assets: [...assets], mediaPaths: [...paths],
    ...(unmapped.size ? { unmappedMediaPaths: [...unmapped] } : {}), ...(mappingIncomplete ? { mappingIncomplete: true } : {}) };
}

async function serviceRequest(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(3000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Service request failed'); }
  return response;
}

async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  return (await serviceRequest(url, init)).json();
}

export function createQuarantineIO(env: SexualQuarantineEnv): QuarantineIO {
  const readSnapshot = async (id: string): Promise<QuarantineSnapshot> => {
    const result = await queryRelay({ ids: [id], limit: 1 }, env.RELAY_URL);
    let event = result.events?.find(e => (e as NostrEvent).id === id);
    if (!event) {
      const banned = await callNip86Rpc('getbannedevent', [id], env, 3000);
      if (banned.success) event = banned.result as object;
      else if (result.success && banned.error === 'Event not found or not banned') throw new ConfirmedAbsentTarget();
      else throw new Error('Target lookup incomplete');
    }
    return snapshotVideo(id, event, env);
  };
  const eligible = async (sha: string, pubkey: string): Promise<boolean> => {
    const secret = await readBlossomSecret(env);
    if (secret instanceof Error) throw new Error('Media credentials unavailable');
    const metadata = await jsonRequest(`${mediaOrigin(env)}/admin/api/blob/${sha}`, {
      headers: { Authorization: `Bearer ${secret}` },
    }) as { sha256?: unknown; owner?: unknown };
    return metadata?.sha256 === sha && isLowerHex64(metadata.owner) && metadata.owner === pubkey;
  };
  const media = async (sha: string): Promise<MediaHolds> => {
    const secret = await readBlossomSecret(env);
    if (secret instanceof Error) throw new Error('Media credentials unavailable');
    const body = await jsonRequest(`${mediaOrigin(env)}/admin/api/quarantine/${sha}`, {
      headers: { Authorization: `Bearer ${secret}` },
    }) as MediaHolds;
    if (typeof body?.quarantined !== 'boolean') throw new Error('Invalid hold status');
    holds(body.holds, true);
    return body;
  };
  const eventHolds = async (id: string): Promise<Hold[]> => {
    const result = await callNip86Rpc('geteventholds', [id], env, 3000);
    if (!result.success) throw new Error('Event holds unavailable');
    return holds(result.result, false);
  };
  const visible = async (snapshot: QuarantineSnapshot) => {
    const id = (snapshot.event as NostrEvent).id;
    const result = await queryRelay({ ids: [id], limit: 1 }, env.RELAY_URL);
    if (!result.success) throw new Error('Relay read incomplete');
    return result.events?.some(event => (event as NostrEvent).id === id) === true;
  };
  const publicStatus = async (path: string, method = 'GET') => {
    const response = await fetch(`${mediaOrigin(env)}${path}`, {
      method, redirect: 'manual', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    return response.status;
  };
  const authorDeleted = async (snapshot: QuarantineSnapshot): Promise<boolean> => {
    const event = snapshot.event as NostrEvent;
    const address = `${event.kind}:${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] || ''}`;
    const targets = [['e', event.id], ...([34235, 34236].includes(event.kind) ? [['a', address]] : [])];
    for (const [tag, target] of targets) {
      const result = await queryRelay({ kinds: [5], authors: [event.pubkey], [`#${tag}`]: [target], limit: 1 }, env.RELAY_URL);
      if (!result.success) continue;
      for (const raw of result.events || []) {
        const deletion = JSON.parse(JSON.stringify(raw)) as NostrEvent;
        if (deletion.kind === 5 && deletion.pubkey === event.pubkey && verifyEvent(deletion)
          && deletion.created_at >= event.created_at && deletion.created_at <= Math.floor(Date.now() / 1000)
          && deletion.tags.some(t => t[0] === tag && t[1] === target)) return true;
      }
    }
    return false;
  };
  return {
    async snapshot(id) {
      return readSnapshot(id);
    },
    async resolveAssets(snapshot) {
      const assets: string[] = [];
      let incomplete = false;
      for (const sha of snapshot.assets) {
        try {
          if (await eligible(sha, (snapshot.event as NostrEvent).pubkey)) { assets.push(sha); continue; }
        } catch { /* Eligibility uncertainty remains reviewable and cannot authorize a hold. */ }
        incomplete = true;
      }
      return { assets, incomplete };
    },
    async eventHold(id, held, version) {
      const result = await callNip86Rpc('seteventhold', [id, `sexual:${id}`, version, held ? 1 : 0], env, 3000);
      const row = result.success ? holds([result.result], false)[0] : undefined;
      if (!result.success || row?.hold_id !== `sexual:${id}` || row.version < version || row.active !== (held ? 1 : 0)) {
        throw new Error('Event hold not confirmed');
      }
    },
    async mediaHold(sha, hold, held, version) {
      if (held) {
        const id = hold.startsWith('sexual:') ? hold.slice('sexual:'.length) : '';
        if (!isLowerHex64(id)) throw new Error('Invalid media hold identity');
        const snapshot = await readSnapshot(id);
        if (!snapshot.assets.includes(sha) || !await eligible(sha, (snapshot.event as NostrEvent).pubkey)) {
          throw new Error('Media eligibility not confirmed');
        }
      }
      const secret = await readBlossomSecret(env);
      if (secret instanceof Error) throw new Error('Media credentials unavailable');
      const body = await jsonRequest(`${mediaOrigin(env)}/admin/api/quarantine`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: sha, hold_id: hold, version, action: held ? 'hold' : 'release' }),
      }) as MediaHolds;
      const row = holds(body?.holds, true).find(h => h.hold_id === hold);
      if (!row || row.version < version || row.active !== held) throw new Error('Media hold not confirmed');
    },
    async verify(snapshot, hold, held) {
      if (held && snapshot.mappingIncomplete) return false;
      const row = (await eventHolds((snapshot.event as NostrEvent).id)).find(h => h.hold_id === hold);
      if (!row || row.active !== (held ? 1 : 0)) return false;
      for (const sha of snapshot.assets) {
        const status = await media(sha);
        const own = status.holds.find(h => h.hold_id === hold);
        if (held ? !own || own.active !== true || !status.quarantined : own && own.active !== false) return false;
        if (held) {
          const paths = new Set([`/${sha}`, `/${sha}.mp4`, `/${sha}.jpg`, `/${sha}.hls`,
            `/${sha}/720p`, `/${sha}/480p`, `/${sha}/720p.mp4`, `/${sha}/480p.mp4`, `/${sha}/hls/master.m3u8`,
            ...['720p', '480p'].flatMap(quality => ['m3u8', 'mp4', 'ts'].map(ext => `/${sha}/hls/stream_${quality}.${ext}`)),
            ...(snapshot.mediaPaths || []).filter(path => path.startsWith(`/${sha}`))]);
          const statuses = await Promise.all([...paths].map(path => publicStatus(path)));
          if (statuses.some(s => s !== 404) || await publicStatus(`/${sha}.mp4`, 'HEAD') !== 404) return false;
        }
      }
      if (held) {
        const unknown = await Promise.all((snapshot.unmappedMediaPaths || []).flatMap(path => [publicStatus(path), publicStatus(path, 'HEAD')]));
        if (unknown.some(status => status !== 404)) return false;
      }
      return !held || !await visible(snapshot);
    },
    async restorationStatus(snapshot) {
      const id = (snapshot.event as NostrEvent).id;
      if ((await eventHolds(id)).some(h => h.hold_id !== `sexual:${id}` && h.active === 1)) return 'restricted';
      const publicVisible = await visible(snapshot);
      if (!publicVisible && await authorDeleted(snapshot)) return 'restricted';
      for (const sha of snapshot.assets) {
        const state = await media(sha);
        if (state.quarantined || ['banned', 'deleted', 'restricted', 'age_restricted'].includes(state.base_status || '')) return 'restricted';
        const status = await publicStatus(`/${sha}.mp4`);
        if (status !== 200 && status !== 206) return 'pending';
      }
      const advertised = await Promise.all((snapshot.mediaPaths || []).map(path => publicStatus(path)));
      if (advertised.some(status => status !== 200 && status !== 206)) return 'pending';
      if (publicVisible) return 'visible';
      // getbannedevent returns retained event data only when an independent base
      // ban or active hold remains. An unsuccessful RPC is never proof of either.
      const banned = await callNip86Rpc('getbannedevent', [id], env, 3000);
      if (banned.success) {
        snapshotVideo(id, banned.result, env);
        return 'restricted';
      }
      return 'pending';
    },
    async recordDecision(c) {
      if (!env.DB) throw new Error('Moderation database unavailable');
      await recordSexualQuarantineDecision(env.DB, c);
      // Resolves the human review ticket. Enforcement remains independently
      // pending/escalated until all public verification succeeds.
      await syncZendeskAfterAction(env, `sexual_quarantine_${c.goal}`, 'event', c.eventId, c.actor!, AbortSignal.timeout(3000));
    },
    async review(c) {
      if (!env.COOP_URL || !env.COOP_API_KEY || !env.REVIEWER_BASE_URL) throw new Error('Review delivery not configured');
      const key = typeof env.COOP_API_KEY === 'string' ? env.COOP_API_KEY : await env.COOP_API_KEY.get();
      if (!key) throw new Error('Review credentials unavailable');
      const event = c.snapshot?.event as NostrEvent | undefined;
      const response = await serviceRequest(`${env.COOP_URL.replace(/\/$/, '')}/api/v1/content`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ contentId: c.eventId, contentType: 'nostr_event', userId: event?.pubkey, sync: false,
          content: { event_id: c.eventId, pubkey: event?.pubkey, kind: event?.kind, content: event?.content,
            report_reason: 'nudity', verdict: c.goal === 'review' ? 'flag_for_review' : 'auto_hide',
            media_sha256: c.snapshot?.assets[0],
            relay_manager_url: `${env.REVIEWER_BASE_URL.replace(/\/$/, '')}/sexual-quarantine/${c.eventId}?sourceRelay=${encodeURIComponent(env.RELAY_URL)}`,
            text: `Sexual-content report case: ${c.eventId}\nState: ${c.state}\nDistinct reporters: ${c.reporters}\nFirst report: ${c.firstReport.id}\nReason: ${c.firstReport.reason}\nReview deadline: ${new Date(c.deadlineAt).toISOString()}`,
          },
        }),
      });
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('Review handoff not accepted');
    },
  };
}
