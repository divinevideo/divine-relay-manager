#!/usr/bin/env node

// Bulk delete video events from the relay for specified pubkeys.
//
// Usage:
//   node scripts/bulk-delete-videos.mjs --pubkeys <hex1,hex2,...> [options]
//   node scripts/bulk-delete-videos.mjs --pubkeys-file <path> [options]
//
// Options:
//   --pubkeys       Comma-separated hex pubkeys
//   --pubkeys-file  File with one hex pubkey per line (blank lines and # comments ignored)
//   --before        Only delete events created before this ISO date (e.g. 2026-01-28)
//   --relay         Relay WebSocket URL   (default: wss://relay.divine.video)
//   --api           Worker API URL         (default: https://api-relay-prod.divine.video)
//   --kinds         Comma-separated kinds  (default: 20,34235,34236)
//   --dry-run       List events without deleting
//   --reason        Reason string sent with each deletion
//
// Examples:
//   node scripts/bulk-delete-videos.mjs --pubkeys abc123,def456 --dry-run
//   node scripts/bulk-delete-videos.mjs --pubkeys-file test-pubkeys.txt --before 2026-01-28 --reason "QA cleanup"

import { readFileSync } from 'fs';
import { WebSocket } from 'ws';
import readline from 'readline';

// ── Parse args ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    pubkeys: [],
    relay: 'wss://relay.divine.video',
    api: 'https://api-relay-prod.divine.video',
    kinds: [20, 34235, 34236],
    before: null,
    dryRun: false,
    reason: 'QA/test content cleanup',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pubkeys':
        opts.pubkeys = args[++i].split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--pubkeys-file': {
        const content = readFileSync(args[++i], 'utf-8');
        opts.pubkeys = content
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));
        break;
      }
      case '--relay':
        opts.relay = args[++i];
        break;
      case '--api':
        opts.api = args[++i];
        break;
      case '--kinds':
        opts.kinds = args[++i].split(',').map(Number);
        break;
      case '--before':
        opts.before = Math.floor(new Date(args[++i]).getTime() / 1000);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--reason':
        opts.reason = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (opts.pubkeys.length === 0) {
    console.error('Error: provide --pubkeys or --pubkeys-file');
    process.exit(1);
  }

  return opts;
}

// ── Query relay for events ──

function queryRelay(relayUrl, filter) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(relayUrl);
    const subId = `bulk-${Date.now()}`;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Relay query timed out after 30s'));
    }, 30000);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          events.push(msg[2]);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timeout);
          ws.close();
          resolve(events);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Delete event via worker API ──

async function deleteEvent(apiUrl, eventId, reason) {
  const res = await fetch(`${apiUrl}/api/moderate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'delete_event',
      eventId,
      reason,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ── Confirm prompt ──

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// ── Kind name helper ──

const KIND_NAMES = {
  20: 'Video Event',
  34235: 'Horizontal Video',
  34236: 'Vertical Video',
  34237: 'Video Chapters',
  1: 'Short Text Note',
  1063: 'File Metadata',
  1064: 'File Header',
};

function kindLabel(kind) {
  return KIND_NAMES[kind] ? `${kind} (${KIND_NAMES[kind]})` : `${kind}`;
}

// ── Main ──

async function main() {
  const opts = parseArgs();

  console.log(`Relay:   ${opts.relay}`);
  console.log(`API:     ${opts.api}`);
  console.log(`Pubkeys: ${opts.pubkeys.length}`);
  console.log(`Kinds:   ${opts.kinds.map(kindLabel).join(', ')}`);
  if (opts.before) console.log(`Before:  ${new Date(opts.before * 1000).toISOString()}`);
  if (opts.dryRun) console.log(`Mode:    DRY RUN`);
  console.log();

  // Build filter
  const filter = {
    authors: opts.pubkeys,
    kinds: opts.kinds,
    limit: 5000,
  };
  if (opts.before) {
    filter.until = opts.before;
  }

  // Query
  console.log('Querying relay for matching events...');
  const events = await queryRelay(opts.relay, filter);

  if (events.length === 0) {
    console.log('No matching events found.');
    return;
  }

  // Summary
  const byPubkey = {};
  const byKind = {};
  for (const e of events) {
    byPubkey[e.pubkey] = (byPubkey[e.pubkey] || 0) + 1;
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  }

  console.log(`Found ${events.length} events:\n`);
  console.log('  By pubkey:');
  for (const [pk, count] of Object.entries(byPubkey)) {
    console.log(`    ${pk.slice(0, 16)}... — ${count} events`);
  }
  console.log('\n  By kind:');
  for (const [kind, count] of Object.entries(byKind)) {
    console.log(`    ${kindLabel(Number(kind))} — ${count}`);
  }

  // Date range
  const timestamps = events.map(e => e.created_at);
  const oldest = new Date(Math.min(...timestamps) * 1000).toISOString();
  const newest = new Date(Math.max(...timestamps) * 1000).toISOString();
  console.log(`\n  Date range: ${oldest} → ${newest}`);

  if (opts.dryRun) {
    console.log('\nDry run — no events deleted.');
    // Print all event IDs for review
    console.log('\nEvent IDs:');
    for (const e of events) {
      console.log(`  ${e.id}  kind=${kindLabel(e.kind)}  ${new Date(e.created_at * 1000).toISOString()}`);
    }
    return;
  }

  // Confirm
  console.log();
  const proceed = await confirm(`Delete all ${events.length} events? (y/N) `);
  if (!proceed) {
    console.log('Aborted.');
    return;
  }

  // Delete
  let deleted = 0;
  let failed = 0;
  for (const e of events) {
    try {
      await deleteEvent(opts.api, e.id, opts.reason);
      deleted++;
      process.stdout.write(`\rDeleted ${deleted}/${events.length}`);
    } catch (err) {
      failed++;
      console.error(`\nFailed to delete ${e.id}: ${err.message}`);
    }
  }

  console.log(`\n\nDone. Deleted: ${deleted}, Failed: ${failed}`);
  if (failed > 0) {
    console.log('Re-run to retry failed deletions.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
