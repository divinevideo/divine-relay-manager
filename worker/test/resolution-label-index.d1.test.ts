// Real-D1 (Miniflare SQLite) validation of recording published resolution labels.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { runStatements } from '../src/report-index';
import {
  recordResolutionLabel,
  resolutionLabelStatements,
  type SignedLabel,
} from '../src/resolution-label-index';

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
});
afterAll(async () => { await mf?.dispose(); });

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM resolution_labels').run();
});

const hex = (n: number) => n.toString(16).padStart(64, '0');
const SIGNER = 'b'.repeat(64);

function label(n: number, tags?: string[][]): SignedLabel {
  return {
    id: hex(n), pubkey: SIGNER, created_at: 2000 + n, kind: 1985,
    tags: tags ?? [
      ['L', 'moderation/resolution'],
      ['l', 'reviewed', 'moderation/resolution'],
      ['e', hex(n + 100000)],
      ['p', hex(n + 200000)],
    ],
    content: `c${n}`, sig: 'f'.repeat(128),
  };
}

describe('resolution label index', () => {
  it('records a resolution label once, with both targets and its status', async () => {
    const l = label(1);
    await recordResolutionLabel(DB, l, 5000);
    await recordResolutionLabel(DB, l, 6000);

    const rows = (await DB.prepare('SELECT * FROM resolution_labels').all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label_id: hex(1), created_at: 2001, signer_pubkey: SIGNER,
      target_event: hex(100001), target_pubkey: hex(200001),
      status: 'reviewed', source: 'publish', recorded_at: 5000,
    });
    expect(JSON.parse(rows[0].event_json as string)).toEqual(l);
  });

  it('ignores a kind-1985 label outside moderation/resolution', async () => {
    await recordResolutionLabel(DB, label(2, [['L', 'moderation/other'], ['l', 'x', 'moderation/other'], ['e', hex(9)]]), 5000);
    const count = await DB.prepare('SELECT COUNT(*) AS n FROM resolution_labels').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('writes 30 labels within 100 parameters per statement', async () => {
    const labels = Array.from({ length: 30 }, (_, i) => label(i + 10));
    const statements = resolutionLabelStatements(DB, labels, 'backfill', 5000);
    expect(statements).toHaveLength(3); // 11 + 11 + 8
    await runStatements(DB, statements);
    const count = await DB.prepare("SELECT COUNT(*) AS n FROM resolution_labels WHERE source = 'backfill'").first<{ n: number }>();
    expect(count?.n).toBe(30);
  });
});
