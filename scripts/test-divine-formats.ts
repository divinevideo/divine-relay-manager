#!/usr/bin/env npx tsx
/**
 * Test auto-hide with actual Divine client report formats
 * Tests both mobile app and web app formats
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

    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK') {
        console.log(`  ${msg[2] ? '✓' : '✗'} ${(event.id as string).slice(0, 12)}... ${msg[2] ? 'accepted' : msg[3]}`);
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

function createVideoPost(user: { sk: Uint8Array; pk: string }, title: string, hashSeed: string) {
  const mediaHash = makeHash(hashSeed);
  const thumbHash = makeHash(`${hashSeed}-thumb`);
  const videoUrl = `https://blossom.divine.video/${mediaHash}.mp4`;
  const thumbUrl = `https://blossom.divine.video/${thumbHash}.jpg`;

  const event = finalizeEvent({
    kind: 34235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `video-${hashSeed}`],
      ['title', title],
      ['url', videoUrl],
      ['m', 'video/mp4'],
      ['x', mediaHash],
      ['thumb', thumbUrl],
      ['image', thumbUrl],
    ],
    content: title,
  }, user.sk);
  return event;
}

// Divine MOBILE app format (from content_reporting_service.dart)
function createMobileAppReport(
  reporter: { sk: Uint8Array; pk: string },
  eventId: string,
  authorPubkey: string
) {
  // Mobile app uses: ['e', eventId], ['p', authorPubkey], ['report', 'csam']
  const event = finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      ['p', authorPubkey],
      ['report', 'csam'],  // Mobile app format
      ['client', 'diVine'],
    ],
    content: 'CONTENT REPORT - NIP-56\nReason: csam\nDetails: Test CSAM report from mobile format',
  }, reporter.sk);
  return event;
}

// Divine WEB app format (from useModeration.ts)
function createWebAppReport(
  reporter: { sk: Uint8Array; pk: string },
  eventId: string,
  authorPubkey: string
) {
  // Web app uses: ['e', eventId, reason], ['L', namespace], ['l', 'NS-reason', namespace]
  const event = finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId, 'csam'],
      ['p', authorPubkey, 'csam'],
      ['L', 'social.nos.ontology'],
      ['l', 'NS-csam', 'social.nos.ontology'],  // Web app format
    ],
    content: 'Reporting csam',
  }, reporter.sk);
  return event;
}

async function main() {
  console.log(`\n🧪 Testing Divine Client Report Formats`);
  console.log(`   Relay: ${RELAY_URL}\n`);

  const contentCreator = createTestUser(30);
  const mobileReporter = createTestUser(31);
  const webReporter = createTestUser(32);

  // Create 2 test videos
  console.log('📹 Creating test video events...');
  const video1 = createVideoPost(contentCreator, 'Video for mobile app report test', `mobile-test-${Date.now()}`);
  const video2 = createVideoPost(contentCreator, 'Video for web app report test', `web-test-${Date.now()}`);

  await publishEvent(video1);
  await publishEvent(video2);

  await new Promise(r => setTimeout(r, 1000));

  // Create report using Divine MOBILE app format
  console.log('\n📱 Creating report with Divine MOBILE app format...');
  console.log('   Tags: ["report", "csam"]');
  const mobileReport = createMobileAppReport(mobileReporter, video1.id, contentCreator.pk);
  await publishEvent(mobileReport);

  await new Promise(r => setTimeout(r, 500));

  // Create report using Divine WEB app format
  console.log('\n🌐 Creating report with Divine WEB app format...');
  console.log('   Tags: ["l", "NS-csam", "social.nos.ontology"]');
  const webReport = createWebAppReport(webReporter, video2.id, contentCreator.pk);
  await publishEvent(webReport);

  console.log('\n⏳ Waiting for auto-hide processing...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n📊 Events that should be auto-hidden:');
  console.log(`   Mobile format: ${video1.id}`);
  console.log(`   Web format:    ${video2.id}`);
  console.log('\n✨ Check worker logs and D1 for auto_hidden entries!\n');
}

main().catch(console.error);
