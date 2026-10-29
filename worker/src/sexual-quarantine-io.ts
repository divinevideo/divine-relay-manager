import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { callNip86Rpc, type Nip86Env, type SecretStoreSecret } from './nip86';
import { queryRelay } from './relay-profile';
import { readBlossomSecret, type MediaServerEnv } from './media-server';
import { isLowerHex64 } from './hex';
import { recordSexualQuarantineDecision } from './sexual-quarantine-decision';
import { OutsideVideoScope, type QuarantineIO, type QuarantineSnapshot } from './sexual-quarantine';

export interface SexualQuarantineEnv extends Nip86Env, MediaServerEnv {
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
  if (!event || event.id !== eventId || JSON.stringify(raw).length > 60_000
    || !verifyEvent(event)) throw new Error('Unverified video event');
  if (![21, 22, 34235, 34236].includes(event.kind)) throw new OutsideVideoScope();
  const assets = new Set<string>();
  const paths = new Set<string>();
  const add = (value: string, expectedHash?: string) => {
    const url = new URL(value);
    if (url.origin !== mediaOrigin(env)) return;
    const hash = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+|\/(?:(?:720p|480p)(?:\.mp4)?|hls\/[a-z0-9_.-]+))?$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (!hash || !isLowerHex64(hash) || (expectedHash && expectedHash.toLowerCase() !== hash)) {
      throw new Error('Media URL and hash disagree');
    }
    assets.add(hash);
    paths.add(url.pathname + url.search);
  };
  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      const url = tag.find(p => p.startsWith('url '))?.slice(4);
      const hash = tag.find(p => p.startsWith('x '))?.slice(2);
      if (url) add(url, hash);
      for (const field of tag) {
        if (field.startsWith('image ') || field.startsWith('thumb ')) add(field.slice(field.indexOf(' ') + 1));
      }
    } else if (['url', 'image', 'thumb', 'thumbnail'].includes(tag[0]) && tag[1]) add(tag[1]);
  }
  for (const url of event.content.match(/https?:\/\/[^\s<>"')\]]+/g) || []) add(url.replace(/[.,;!?]+$/, ''));
  if (paths.size > 64) throw new Error('Video URL limit exceeded');
  if (assets.size > 8) throw new Error('Video asset limit exceeded');
  return { event, assets: [...assets], mediaPaths: [...paths] };
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
  return {
    async snapshot(id) {
      const result = await queryRelay({ ids: [id], limit: 1 }, env.RELAY_URL);
      let event = result.events?.find(e => (e as NostrEvent).id === id);
      if (!event) {
        const banned = await callNip86Rpc('getbannedevent', [id], env, 3000);
        if (banned.success) event = banned.result as object;
      }
      return snapshotVideo(id, event, env);
    },
    async eventHold(id, held, version) {
      const result = await callNip86Rpc('seteventhold', [id, `sexual:${id}`, version, held ? 1 : 0], env, 3000);
      const row = result.success ? holds([result.result], false)[0] : undefined;
      if (!result.success || row?.hold_id !== `sexual:${id}` || row.version < version || row.active !== (held ? 1 : 0)) {
        throw new Error('Event hold not confirmed');
      }
    },
    async mediaHold(sha, hold, held, version) {
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
      const row = (await eventHolds((snapshot.event as NostrEvent).id)).find(h => h.hold_id === hold);
      if (!row || row.active !== (held ? 1 : 0)) return false;
      for (const sha of snapshot.assets) {
        const status = await media(sha);
        const own = status.holds.find(h => h.hold_id === hold);
        if (!own || own.active !== held || (held && !status.quarantined)) return false;
        if (held) {
          const paths = new Set([`/${sha}`, `/${sha}.mp4`, `/${sha}.jpg`, `/${sha}.hls`,
            `/${sha}/720p`, `/${sha}/480p`, `/${sha}/720p.mp4`, `/${sha}/480p.mp4`, `/${sha}/hls/master.m3u8`,
            ...['720p', '480p'].flatMap(quality => ['m3u8', 'mp4', 'ts'].map(ext => `/${sha}/hls/stream_${quality}.${ext}`)),
            ...(snapshot.mediaPaths || []).filter(path => path.startsWith(`/${sha}`))]);
          const statuses = await Promise.all([...paths].map(path => publicStatus(path)));
          if (statuses.some(s => s !== 404) || await publicStatus(`/${sha}.mp4`, 'HEAD') !== 404) return false;
        }
      }
      return !held || !await visible(snapshot);
    },
    async restorationStatus(snapshot) {
      const id = (snapshot.event as NostrEvent).id;
      if ((await eventHolds(id)).some(h => h.hold_id !== `sexual:${id}` && h.active === 1)) return 'restricted';
      for (const sha of snapshot.assets) {
        const state = await media(sha);
        if (state.quarantined || ['banned', 'deleted', 'restricted', 'age_restricted'].includes(state.base_status || '')) return 'restricted';
        const status = await publicStatus(`/${sha}.mp4`);
        if (status !== 200 && status !== 206) return 'pending';
      }
      const advertised = await Promise.all((snapshot.mediaPaths || []).map(path => publicStatus(path)));
      if (advertised.some(status => status !== 200 && status !== 206)) return 'pending';
      if (await visible(snapshot)) return 'visible';
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
