#!/usr/bin/env npx tsx
/**
 * Seed mock moderation_decisions for staging UX demo
 *
 * This creates D1 entries WITHOUT needing relay access.
 * Events won't be fetchable (expected for auto-hidden content).
 *
 * Usage:
 *   npx tsx scripts/seed-staging-demo.ts          # dry run (shows SQL)
 *   npx tsx scripts/seed-staging-demo.ts --exec   # execute against staging D1
 *
 * Cleanup:
 *   npx tsx scripts/seed-staging-demo.ts --cleanup
 */

import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { execSync } from 'child_process';

const D1_DATABASE = 'divine-moderation-decisions-staging';
const DRY_RUN = !process.argv.includes('--exec');
const CLEANUP = process.argv.includes('--cleanup');

// Generate deterministic values
function makeHash(seed: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(seed)));
}

function createTestUser(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  const pk = getPublicKey(sk);
  return { sk, pk };
}

// Generate fake event IDs (just need to be valid hex)
function fakeEventId(seed: string): string {
  return makeHash(`demo-event-${seed}`);
}

// Demo data
const DEMO_PREFIX = 'staging-demo-'; // For cleanup identification

const reporter = createTestUser(99);
const _creators = [
  createTestUser(10),
  createTestUser(11),
  createTestUser(12),
];

interface DemoEntry {
  target_type: string;
  target_id: string;
  action: string;
  reason: string;
  report_id: string;
  reporter_pubkey: string;
  created_at: string;
}

const demoEntries: DemoEntry[] = [
  // 2 auto-hidden CSAM reports (pending review)
  {
    target_type: 'event',
    target_id: fakeEventId(`${DEMO_PREFIX}csam-1`),
    action: 'auto_hidden',
    reason: 'Auto-hidden: sexual_minors report',
    report_id: fakeEventId(`${DEMO_PREFIX}report-csam-1`),
    reporter_pubkey: reporter.pk,
    created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
  },
  {
    target_type: 'event',
    target_id: fakeEventId(`${DEMO_PREFIX}csam-2`),
    action: 'auto_hidden',
    reason: 'Auto-hidden: sexual_minors report',
    report_id: fakeEventId(`${DEMO_PREFIX}report-csam-2`),
    reporter_pubkey: reporter.pk,
    created_at: new Date(Date.now() - 1800000).toISOString(), // 30 min ago
  },
  // 1 confirmed (already reviewed, stays hidden)
  {
    target_type: 'event',
    target_id: fakeEventId(`${DEMO_PREFIX}confirmed-1`),
    action: 'confirmed',
    reason: 'CSAM confirmed by moderator',
    report_id: fakeEventId(`${DEMO_PREFIX}report-confirmed-1`),
    reporter_pubkey: reporter.pk,
    created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
  },
  // 1 false positive (restored)
  {
    target_type: 'event',
    target_id: fakeEventId(`${DEMO_PREFIX}fp-1`),
    action: 'false_positive',
    reason: 'Restored by moderator - not CSAM',
    report_id: fakeEventId(`${DEMO_PREFIX}report-fp-1`),
    reporter_pubkey: reporter.pk,
    created_at: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
  },
];

function generateInsertSQL(entry: DemoEntry): string {
  return `INSERT INTO moderation_decisions (target_type, target_id, action, reason, report_id, reporter_pubkey, created_at) VALUES ('${entry.target_type}', '${entry.target_id}', '${entry.action}', '${entry.reason}', '${entry.report_id}', '${entry.reporter_pubkey}', '${entry.created_at}');`;
}

function generateCleanupSQL(): string {
  // Delete entries where target_id contains our demo prefix hash pattern
  const demoIds = demoEntries.map(e => `'${e.target_id}'`).join(', ');
  return `DELETE FROM moderation_decisions WHERE target_id IN (${demoIds});`;
}

function executeD1(sql: string): void {
  const cmd = `npx wrangler d1 execute ${D1_DATABASE} --remote --command="${sql.replace(/"/g, '\\"')}"`;
  console.log(`Executing: ${sql.slice(0, 80)}...`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
  } catch (err) {
    console.error('D1 execution failed');
    throw err;
  }
}

async function main() {
  console.log('\n🎬 Staging Demo Data Generator');
  console.log(`   Database: ${D1_DATABASE}`);
  console.log(`   Mode: ${CLEANUP ? 'CLEANUP' : DRY_RUN ? 'DRY RUN (add --exec to execute)' : 'EXECUTE'}\n`);

  if (CLEANUP) {
    const sql = generateCleanupSQL();
    console.log('Cleanup SQL:');
    console.log(sql);
    console.log('');

    if (!DRY_RUN) {
      executeD1(sql);
      console.log('\n✓ Cleanup complete\n');
    } else {
      console.log('Add --exec to run cleanup\n');
    }
    return;
  }

  console.log('Demo entries to create:');
  console.log('─'.repeat(60));

  for (const entry of demoEntries) {
    console.log(`  ${entry.action.padEnd(15)} ${entry.target_id.slice(0, 16)}...`);
  }

  console.log('─'.repeat(60));
  console.log(`  Total: ${demoEntries.length} entries\n`);

  console.log('SQL statements:');
  console.log('─'.repeat(60));

  for (const entry of demoEntries) {
    const sql = generateInsertSQL(entry);
    console.log(sql);
    console.log('');

    if (!DRY_RUN) {
      executeD1(sql);
    }
  }

  if (DRY_RUN) {
    console.log('─'.repeat(60));
    console.log('\n⚠️  DRY RUN - No changes made');
    console.log('   Run with --exec to insert into staging D1\n');
  } else {
    console.log('─'.repeat(60));
    console.log('\n✓ Demo data inserted!\n');
    console.log('To view in UI:');
    console.log('  1. Go to https://relay.admin.divine.video');
    console.log('  2. Select "Staging" environment');
    console.log('  3. Go to Reports tab');
    console.log('  4. Toggle "Pending Review" to see auto-hidden items\n');
    console.log('To cleanup:');
    console.log('  npx tsx scripts/seed-staging-demo.ts --cleanup --exec\n');
  }
}

main().catch(console.error);
