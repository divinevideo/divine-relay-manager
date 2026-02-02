#!/usr/bin/env npx tsx
/**
 * Create a clean baseline for testing auto-hide UI
 *
 * Expected results after running:
 * - Default view (showPendingReview=false): 3 unresolved non-CSAM reports
 * - Pending Review view (showPendingReview=true): 2 auto-hidden CSAM reports
 * - With "Hide resolved" off: +2 resolved reports visible
 */

import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:4444';
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

const timestamp = Date.now();

function makeHash(seed: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(seed)));
}

function createTestUser(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  const pk = getPublicKey(sk);
  return { sk, pk };
}

async function publishEvent(event: Record<string, unknown>, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    let resolved = false;

    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK') {
        const ok = msg[2];
        console.log(`  ${ok ? '✓' : '✗'} ${label}: ${(event.id as string).slice(0, 16)}...`);
        resolved = true;
        ws.close();
        resolve(ok);
      }
    });
    ws.on('error', () => { if (!resolved) resolve(false); });
    ws.on('close', () => { if (!resolved) resolve(false); });
    setTimeout(() => { if (!resolved) { ws.close(); resolve(false); } }, 5000);
  });
}

function createVideoPost(user: { sk: Uint8Array; pk: string }, title: string, seed: string) {
  const mediaHash = makeHash(seed);
  const thumbHash = makeHash(`${seed}-thumb`);
  return finalizeEvent({
    kind: 34235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `video-${seed}`],
      ['title', title],
      ['url', `https://blossom.divine.video/${mediaHash}.mp4`],
      ['m', 'video/mp4'],
      ['x', mediaHash],
      ['thumb', `https://blossom.divine.video/${thumbHash}.jpg`],
      ['image', `https://blossom.divine.video/${thumbHash}.jpg`],
    ],
    content: title,
  }, user.sk);
}

// Divine mobile app format: ['report', 'reason']
function createReport(reporter: { sk: Uint8Array; pk: string }, eventId: string, authorPk: string, reason: string) {
  return finalizeEvent({
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      ['p', authorPk],
      ['report', reason],
      ['client', 'diVine'],
    ],
    content: `Test report: ${reason}`,
  }, reporter.sk);
}

async function resolveReport(eventId: string, action: 'dismiss' | 'banned'): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_URL}/api/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'event',
        targetId: eventId,
        action,
        reason: `Test: ${action}`,
      }),
    });
    console.log(`  ${response.ok ? '✓' : '✗'} Resolved ${eventId.slice(0, 16)}... as ${action}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`\n🧹 Creating Clean Baseline for Auto-Hide Testing`);
  console.log(`   Relay: ${RELAY_URL}`);
  console.log(`   Worker: ${WORKER_URL}`);
  console.log(`   Timestamp: ${timestamp}\n`);

  // Create users
  const creator = createTestUser(100);
  const reporter = createTestUser(101);

  console.log('📹 Creating 10 video events...');
  const videos: ReturnType<typeof createVideoPost>[] = [];
  for (let i = 0; i < 10; i++) {
    const video = createVideoPost(creator, `Test Video ${i + 1}`, `baseline-${timestamp}-${i}`);
    await publishEvent(video, `Video ${i + 1}`);
    videos.push(video);
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n⚠️  Creating 5 non-CSAM reports (videos 0-4)...');
  const nonCsamReasons = ['spam', 'harassment', 'nudity', 'impersonation', 'other'];
  for (let i = 0; i < 5; i++) {
    const report = createReport(reporter, videos[i].id, creator.pk, nonCsamReasons[i]);
    await publishEvent(report, `${nonCsamReasons[i]} report`);
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n🚨 Creating 2 CSAM reports (videos 5-6) - will be auto-hidden...');
  for (let i = 5; i < 7; i++) {
    const report = createReport(reporter, videos[i].id, creator.pk, 'csam');
    await publishEvent(report, `CSAM report for video ${i + 1}`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n⏳ Waiting for auto-hide processing...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n✅ Resolving 2 non-CSAM reports (videos 0-1)...');
  await resolveReport(videos[0].id, 'dismiss');
  await resolveReport(videos[1].id, 'banned');

  console.log('\n' + '='.repeat(70));
  console.log('📊 EXPECTED UI BEHAVIOR:');
  console.log('='.repeat(70));
  console.log('');
  console.log('DEFAULT VIEW (Pending Review toggle OFF):');
  console.log('  • 3 unresolved non-CSAM reports visible (spam, harassment, nudity → wait, only');
  console.log('    impersonation, other since spam/harassment are resolved)');
  console.log('  • Actually: nudity, impersonation, other (3 reports)');
  console.log('  • 2 CSAM reports HIDDEN (moderator does not see CSAM content)');
  console.log('  • 2 resolved reports HIDDEN (with "Hide resolved" ON)');
  console.log('');
  console.log('PENDING REVIEW VIEW (Pending Review toggle ON):');
  console.log('  • ONLY the 2 auto-hidden CSAM reports visible');
  console.log('  • Each shows "Pending Review" banner with Confirm/Restore buttons');
  console.log('');
  console.log('WITH "HIDE RESOLVED" OFF (in default view):');
  console.log('  • +2 resolved reports also visible (spam, harassment)');
  console.log('');
  console.log('='.repeat(70));
  console.log('');
  console.log('📋 Event IDs for reference:');
  console.log('   Non-CSAM (unresolved):');
  console.log(`     nudity:        ${videos[2].id}`);
  console.log(`     impersonation: ${videos[3].id}`);
  console.log(`     other:         ${videos[4].id}`);
  console.log('   CSAM (auto-hidden):');
  console.log(`     csam #1:       ${videos[5].id}`);
  console.log(`     csam #2:       ${videos[6].id}`);
  console.log('   Resolved:');
  console.log(`     spam:          ${videos[0].id}`);
  console.log(`     harassment:    ${videos[1].id}`);
  console.log('\n✨ Done! Refresh the UI at http://localhost:8080\n');
}

main().catch(console.error);
