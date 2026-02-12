#!/usr/bin/env npx tsx
/**
 * Clear all reports from the relay and D1 database
 * This gives us a clean slate for testing
 */

import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:4444';
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

async function queryReports(): Promise<string[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    const eventIds: string[] = [];
    let resolved = false;

    ws.on('open', () => {
      // Query all kind 1984 reports
      ws.send(JSON.stringify(['REQ', 'clear-reports', { kinds: [1984], limit: 500 }]));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'EVENT' && msg[1] === 'clear-reports') {
        eventIds.push(msg[2].id);
      } else if (msg[0] === 'EOSE') {
        resolved = true;
        ws.close();
        resolve(eventIds);
      }
    });

    ws.on('error', () => { if (!resolved) resolve(eventIds); });
    ws.on('close', () => { if (!resolved) resolve(eventIds); });
    setTimeout(() => { if (!resolved) { ws.close(); resolve(eventIds); } }, 10000);
  });
}

async function banEvent(eventId: string): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_URL}/api/relay-rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'banevent',
        params: [eventId, 'Clearing test data'],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function _clearD1(): Promise<boolean> {
  try {
    // We can't directly call D1 from here, but we can delete via the API
    // Actually, let's just use wrangler CLI for this
    console.log('  (D1 will be cleared via wrangler CLI)');
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`\n🧹 Clearing All Reports and Decisions`);
  console.log(`   Relay: ${RELAY_URL}`);
  console.log(`   Worker: ${WORKER_URL}\n`);

  // Query all reports
  console.log('📋 Querying existing reports...');
  const reportIds = await queryReports();
  console.log(`   Found ${reportIds.length} reports\n`);

  if (reportIds.length === 0) {
    console.log('✨ No reports to clear!\n');
    return;
  }

  // Ban each report
  console.log('🗑️  Banning reports from relay...');
  let banned = 0;
  let failed = 0;

  for (const eventId of reportIds) {
    const ok = await banEvent(eventId);
    if (ok) {
      banned++;
      process.stdout.write(`\r   Progress: ${banned}/${reportIds.length} banned`);
    } else {
      failed++;
    }
    // Small delay to avoid overwhelming the relay
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\n   ✓ Banned: ${banned}`);
  if (failed > 0) {
    console.log(`   ✗ Failed: ${failed}`);
  }

  console.log('\n✨ Done! Now run: npx wrangler d1 execute blossom-webhook-events --local --command "DELETE FROM moderation_decisions;"\n');
}

main().catch(console.error);
