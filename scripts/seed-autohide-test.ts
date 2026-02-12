#!/usr/bin/env npx tsx
/**
 * Seed test data for auto-hide feature testing
 * Creates: 30 video events, 8 non-CSAM reports, 2 CSAM reports, resolves 5
 * Usage: RELAY_URL=ws://localhost:4444 npx tsx scripts/seed-autohide-test.ts
 */

import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:4444';
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

// Generate a deterministic sha256 hash from a seed string
function makeHash(seed: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(seed)));
}

// Generate deterministic test users
function createTestUser(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  const pk = getPublicKey(sk);
  return { sk, pk };
}

// Publish event to relay
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

    ws.on('error', (err) => {
      console.error(`  ✗ Error: ${err.message}`);
      if (!resolved) resolve(false);
    });

    ws.on('close', () => {
      if (!resolved) resolve(false);
    });

    setTimeout(() => {
      if (!resolved) {
        ws.close();
        resolve(false);
      }
    }, 5000);
  });
}

// Create a video post (kind 34235 - NIP-71 horizontal video)
function createVideoPost(user: { sk: Uint8Array; pk: string }, title: string, hashSeed: string, createdAt?: number) {
  const mediaHash = makeHash(hashSeed);
  const thumbHash = makeHash(`${hashSeed}-thumb`);
  const dTag = `video-${hashSeed}`;
  const videoUrl = `https://blossom.divine.video/${mediaHash}.mp4`;
  const thumbUrl = `https://blossom.divine.video/${thumbHash}.jpg`;
  const timestamp = createdAt || Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400);

  const event = finalizeEvent({
    kind: 34235,
    created_at: timestamp,
    tags: [
      ['d', dTag],
      ['title', title],
      ['url', videoUrl],
      ['m', 'video/mp4'],
      ['x', mediaHash],
      ['thumb', thumbUrl],
      ['image', thumbUrl],
      ['size', String(Math.floor(Math.random() * 50000000) + 1000000)],
      ['duration', String(Math.floor(Math.random() * 300) + 30)],
      ['imeta', `url ${videoUrl}`, `x ${mediaHash}`, 'm video/mp4', `thumb ${thumbUrl}`],
    ],
    content: title,
  }, user.sk);
  return { event, mediaHash };
}

// Create a report (kind 1984)
// Uses ["report", "<category>"] format that ReportWatcher expects
function createReport(
  user: { sk: Uint8Array; pk: string },
  reportedEventId: string,
  reportedPubkey: string,
  reason: string,
  category: string
) {
  const event = finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', reportedEventId, category],
      ['p', reportedPubkey, category],
      ['report', category],  // ReportWatcher checks this tag for category
    ],
    content: reason,
  }, user.sk);
  return event;
}

// Create a profile (kind 0)
function createProfile(user: { sk: Uint8Array; pk: string }, name: string, about: string) {
  const event = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name,
      about,
      picture: `https://robohash.org/${user.pk.slice(0, 8)}.png`,
    }),
  }, user.sk);
  return event;
}

// Resolve a report via the worker API (dismiss)
async function resolveReport(eventId: string, action: 'dismiss' | 'banned'): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_URL}/api/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'event',
        targetId: eventId,
        action,
        reason: `Test resolution: ${action}`,
      }),
    });
    const ok = response.ok;
    console.log(`  ${ok ? '✓' : '✗'} Resolved ${eventId.slice(0, 12)}... as ${action}`);
    return ok;
  } catch (err) {
    console.error(`  ✗ Failed to resolve: ${err}`);
    return false;
  }
}

const VIDEO_TITLES = [
  'Beautiful sunset timelapse 🌅',
  'My cat being weird again',
  'Morning coffee routine',
  'Quick recipe: pasta carbonara',
  'Urban exploration vlog',
  'Guitar cover of classic rock song',
  'Nature walk through the forest',
  'DIY home improvement tips',
  'Travel diary: weekend getaway',
  'Workout routine for beginners',
  'Book review: latest bestseller',
  'Drone footage of the coastline',
  'Behind the scenes of my work',
  'Art process: painting session',
  'Gaming highlights compilation',
  'Street food tour',
  'Product review: new tech gadget',
  'Dance tutorial for beginners',
  'Podcast episode snippet',
  'Day in my life vlog',
  'Mountain hiking adventure',
  'Cooking challenge with friends',
  'Music production session',
  'Photography tips and tricks',
  'Home garden tour',
  'Skateboarding tricks compilation',
  'Language learning progress',
  'Meditation and mindfulness',
  'Car restoration update',
  'Science experiment at home',
];

const REPORT_CATEGORIES = [
  { category: 'spam', reason: 'This looks like promotional spam content' },
  { category: 'harassment', reason: 'Targeted harassment of another user' },
  { category: 'nudity', reason: 'Contains inappropriate nudity' },
  { category: 'impersonation', reason: 'Impersonating another content creator' },
  { category: 'illegal', reason: 'Potentially illegal content' },
  { category: 'other', reason: 'Violates community guidelines' },
  { category: 'profanity', reason: 'Excessive profanity and offensive language' },
  { category: 'malware', reason: 'Links to suspicious/malicious content' },
];

async function main() {
  console.log(`\n🎬 Auto-Hide Test Data Generator`);
  console.log(`   Relay: ${RELAY_URL}`);
  console.log(`   Worker: ${WORKER_URL}\n`);

  // Create test users
  const users = [
    createTestUser(10),
    createTestUser(11),
    createTestUser(12),
    createTestUser(13),
    createTestUser(14),
  ];
  const reporter = createTestUser(99);

  // Publish profiles
  console.log('📝 Publishing user profiles...');
  await publishEvent(createProfile(users[0], 'VideoCreator1', 'I make cool videos'));
  await publishEvent(createProfile(users[1], 'VideoCreator2', 'Content creator'));
  await publishEvent(createProfile(users[2], 'VideoCreator3', 'Video enthusiast'));
  await publishEvent(createProfile(users[3], 'VideoCreator4', 'Digital artist'));
  await publishEvent(createProfile(users[4], 'VideoCreator5', 'Hobbyist filmmaker'));
  await publishEvent(createProfile(reporter, 'CommunityModerator', 'Keeping things clean'));

  // Create 30 video events
  console.log('\n🎥 Publishing 30 video events...');
  const videos: Array<{ event: ReturnType<typeof finalizeEvent>; user: typeof users[0] }> = [];

  for (let i = 0; i < 30; i++) {
    const user = users[i % users.length];
    const title = VIDEO_TITLES[i];
    const { event } = createVideoPost(user, title, `autohide-test-video-${i}`);
    await publishEvent(event);
    videos.push({ event, user });
    // Small delay to avoid overwhelming the relay
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n   ✓ Created ${videos.length} video events`);

  // Create 8 non-CSAM reports (for videos 0-7)
  console.log('\n⚠️  Creating 8 non-CSAM reports...');
  const reportedEvents: string[] = [];

  for (let i = 0; i < 8; i++) {
    const video = videos[i];
    const reportType = REPORT_CATEGORIES[i];
    const report = createReport(
      reporter,
      video.event.id,
      video.user.pk,
      reportType.reason,
      reportType.category
    );
    await publishEvent(report);
    reportedEvents.push(video.event.id);
    await new Promise(r => setTimeout(r, 100));
  }

  // Create 2 CSAM reports (for videos 8-9) - these should trigger auto-hide
  console.log('\n🚨 Creating 2 CSAM reports (will trigger auto-hide)...');
  const csamReportedEvents: string[] = [];

  for (let i = 8; i < 10; i++) {
    const video = videos[i];
    const report = createReport(
      reporter,
      video.event.id,
      video.user.pk,
      'This content appears to involve minors inappropriately',
      'sexual_minors'  // NIP-56 category that triggers auto-hide
    );
    await publishEvent(report);
    csamReportedEvents.push(video.event.id);
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait a moment for the auto-hide to process
  console.log('\n⏳ Waiting for auto-hide processing...');
  await new Promise(r => setTimeout(r, 2000));

  // Resolve 5 of the non-CSAM reports
  console.log('\n✅ Resolving 5 non-CSAM reports...');
  for (let i = 0; i < 5; i++) {
    const action = i % 2 === 0 ? 'dismiss' : 'banned';
    await resolveReport(reportedEvents[i], action as 'dismiss' | 'banned');
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Summary:');
  console.log('='.repeat(60));
  console.log(`   Videos created:        30`);
  console.log(`   Non-CSAM reports:      8 (5 resolved, 3 pending)`);
  console.log(`   CSAM reports:          2 (unresolved, should be auto-hidden)`);
  console.log('');
  console.log('🔍 CSAM-reported event IDs (check Pending Review):');
  csamReportedEvents.forEach((id, i) => {
    console.log(`   ${i + 1}. ${id}`);
  });
  console.log('');
  console.log('📋 Unresolved non-CSAM reports (event IDs):');
  reportedEvents.slice(5).forEach((id, i) => {
    console.log(`   ${i + 1}. ${id}`);
  });
  console.log('\n✨ Done!\n');
}

main().catch(console.error);
