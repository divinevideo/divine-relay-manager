#!/usr/bin/env npx tsx
/**
 * Create CSAM reports to trigger auto-hide
 * Usage: RELAY_URL=ws://localhost:4444 npx tsx scripts/trigger-autohide.ts
 */

import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:4444';

function makeHash(seed: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(seed)));
}

function createTestUser(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  const pk = getPublicKey(sk);
  return { sk, pk };
}

async function publishEvent(event: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    let resolved = false;

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK') {
        const status = msg[2] ? '✓' : '✗';
        const detail = msg[2] ? 'accepted' : `rejected: ${msg[3]}`;
        console.log(`  ${status} ${(event.id as string).slice(0, 12)}... ${detail}`);
        resolved = true;
        ws.close();
        resolve(msg[2]);
      }
    });

    ws.on('error', () => { if (!resolved) resolve(false); });
    ws.on('close', () => { if (!resolved) resolve(false); });
    setTimeout(() => { if (!resolved) { ws.close(); resolve(false); } }, 5000);
  });
}

// Create a video post (kind 34235)
function createVideoPost(user: { sk: Uint8Array; pk: string }, title: string, hashSeed: string) {
  const mediaHash = makeHash(hashSeed);
  const thumbHash = makeHash(`${hashSeed}-thumb`);
  const dTag = `video-${hashSeed}`;
  const videoUrl = `https://blossom.divine.video/${mediaHash}.mp4`;
  const thumbUrl = `https://blossom.divine.video/${thumbHash}.jpg`;

  const event = finalizeEvent({
    kind: 34235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', dTag],
      ['title', title],
      ['url', videoUrl],
      ['m', 'video/mp4'],
      ['x', mediaHash],
      ['thumb', thumbUrl],
      ['image', thumbUrl],
    ],
    content: title,
  }, user.sk);
  return { event, mediaHash };
}

// Create a CSAM report (kind 1984 with sexual_minors category)
// Uses ["report", "<category>"] format that ReportWatcher expects
function createCSAMReport(
  reporter: { sk: Uint8Array; pk: string },
  eventId: string,
  eventPubkey: string
) {
  const event = finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId, 'sexual_minors'],
      ['p', eventPubkey, 'sexual_minors'],
      ['report', 'sexual_minors'],  // ReportWatcher checks this tag
    ],
    content: 'This content appears to involve minors - auto-hide test',
  }, reporter.sk);
  return event;
}

async function main() {
  console.log(`\n🚨 Creating CSAM reports to trigger auto-hide`);
  console.log(`   Relay: ${RELAY_URL}\n`);

  // Create test users
  const contentCreator = createTestUser(20);
  const reporter = createTestUser(99);

  // Create 2 new video events
  console.log('📹 Creating target video events...');
  const videos: Array<{ event: ReturnType<typeof finalizeEvent>; user: typeof contentCreator }> = [];

  for (let i = 0; i < 2; i++) {
    const { event } = createVideoPost(
      contentCreator,
      `Test video for auto-hide ${Date.now()}-${i}`,
      `autohide-trigger-${Date.now()}-${i}`
    );
    await publishEvent(event);
    videos.push({ event, user: contentCreator });
    await new Promise(r => setTimeout(r, 500));
  }

  // Wait a moment for events to propagate
  await new Promise(r => setTimeout(r, 1000));

  // Create CSAM reports for these videos
  console.log('\n🚨 Creating CSAM reports (sexual_minors)...');
  for (const video of videos) {
    const report = createCSAMReport(reporter, video.event.id, video.user.pk);
    await publishEvent(report);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n⏳ Waiting for auto-hide processing...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n📊 Videos that should be auto-hidden:');
  videos.forEach((v, i) => {
    console.log(`   ${i + 1}. ${v.event.id}`);
  });

  console.log('\n✨ Check the UI for "Pending Review" items!\n');
}

main().catch(console.error);
