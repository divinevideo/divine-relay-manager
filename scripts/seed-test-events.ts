#!/usr/bin/env npx tsx
/**
 * Seed test events for moderation testing
 * Usage: npx tsx scripts/seed-test-events.ts
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'wss://relay.dvines.org';

// Generate deterministic test users (so we can allowlist them)
function createTestUser(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  const pk = getPublicKey(sk);
  return { sk, pk };
}

// Publish event to relay
async function publishEvent(event: any): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    let resolved = false;

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK') {
        console.log(`  ✓ Published: ${event.id.slice(0, 16)}... (${msg[2] ? 'accepted' : 'rejected: ' + msg[3]})`);
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
function createVideoPost(user: { sk: Uint8Array; pk: string }, title: string, videoUrl: string) {
  const sha256 = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); // 64 char fake hash
  const dTag = `video-${Date.now()}`;
  const event = finalizeEvent({
    kind: 34235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', dTag],
      ['title', title],
      ['url', videoUrl],
      ['m', 'video/mp4'],
      ['x', sha256],
      ['size', '1024000'],
      ['duration', '120'],
    ],
    content: title,
  }, user.sk);
  return event;
}

// Create a comment (kind 1111 - NIP-22 comment on video)
function createComment(user: { sk: Uint8Array; pk: string }, content: string, replyToId: string, replyToPubkey: string, replyToKind: number = 34235) {
  const event = finalizeEvent({
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', replyToId],
      ['p', replyToPubkey],
      ['k', replyToKind.toString()],
    ],
    content,
  }, user.sk);
  return event;
}

// Create a report (kind 1984)
function createReport(user: { sk: Uint8Array; pk: string }, reportedEventId: string, reportedPubkey: string, reason: string, category: string) {
  const event = finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', reportedEventId, category],
      ['p', reportedPubkey, category],
    ],
    content: reason,
  }, user.sk);
  return event;
}

// Create a profile (kind 0)
function createProfile(user: { sk: Uint8Array; pk: string }, name: string) {
  const event = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name,
      about: `Test user for moderation testing`,
      picture: `https://robohash.org/${user.pk.slice(0, 8)}.png`,
    }),
  }, user.sk);
  return event;
}

async function main() {
  console.log(`\n🎬 Seeding test events to ${RELAY_URL}\n`);

  // Create test users (deterministic keys - already allowlisted)
  const alice = createTestUser(1);
  const bob = createTestUser(2);
  const charlie = createTestUser(3); // The reporter

  console.log('Test users created:');
  console.log(`  Alice:   ${alice.pk.slice(0, 16)}...`);
  console.log(`  Bob:     ${bob.pk.slice(0, 16)}...`);
  console.log(`  Charlie: ${charlie.pk.slice(0, 16)}... (reporter)\n`);

  // Publish profiles
  console.log('Publishing profiles...');
  await publishEvent(createProfile(alice, 'Alice TestUser'));
  await publishEvent(createProfile(bob, 'Bob TestUser'));
  await publishEvent(createProfile(charlie, 'Charlie Reporter'));

  // Publish video posts
  console.log('\nPublishing video posts...');

  const video1 = createVideoPost(
    alice,
    'Check out this cool video! #nostr #test',
    'https://divine.video/test/sample1.mp4'
  );
  await publishEvent(video1);

  const video2 = createVideoPost(
    bob,
    'Another test video for moderation',
    'https://divine.video/test/sample2.mp4'
  );
  await publishEvent(video2);

  const video3 = createVideoPost(
    alice,
    'This one might need review',
    'https://divine.video/test/flagged-content.mp4'
  );
  await publishEvent(video3);

  // Publish comments
  console.log('\nPublishing comments...');

  const comment1 = createComment(bob, 'Great video Alice!', video1.id, alice.pk);
  await publishEvent(comment1);

  const comment2 = createComment(alice, 'Thanks Bob! Check out my other one too', comment1.id, bob.pk);
  await publishEvent(comment2);

  const spamComment = createComment(bob, 'BUY CRYPTO NOW!!! Visit scam.example.com for FREE MONEY!!!', video1.id, alice.pk);
  await publishEvent(spamComment);

  // Publish reports
  console.log('\nPublishing reports...');

  await publishEvent(createReport(
    charlie,
    video3.id,
    alice.pk,
    'This video contains inappropriate content',
    'nudity'
  ));

  await publishEvent(createReport(
    charlie,
    spamComment.id,
    bob.pk,
    'This is obvious spam/scam content',
    'spam'
  ));

  await publishEvent(createReport(
    alice,
    spamComment.id,
    bob.pk,
    'Spam in my comments',
    'spam'
  ));

  console.log('\n✅ Done! Test events published to relay.\n');
  console.log('Event IDs for testing:');
  console.log(`  Video 1 (Alice):    ${video1.id}`);
  console.log(`  Video 2 (Bob):      ${video2.id}`);
  console.log(`  Video 3 (Flagged):  ${video3.id}`);
  console.log(`  Spam comment:       ${spamComment.id}`);
  console.log('');
}

main().catch(console.error);
