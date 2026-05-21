import type { SecretStoreSecret } from './nip86';

export interface ZendeskSyncEnv {
  DB?: D1Database;
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_API_TOKEN?: string;
  ZENDESK_EMAIL?: string;
  ZENDESK_FIELD_CATEGORY?: string;
  ZENDESK_FIELD_ISSUE?: string;
  NOSTR_NSEC: string | SecretStoreSecret;
  RELAY_URL: string;
}

function buildResolutionCustomFields(env: ZendeskSyncEnv): Array<{ id: number; value: string }> | undefined {
  if (!env.ZENDESK_FIELD_CATEGORY || !env.ZENDESK_FIELD_ISSUE) {
    return undefined;
  }

  return [
    { id: Number.parseInt(env.ZENDESK_FIELD_CATEGORY, 10), value: 'trust___safety' },
    { id: Number.parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'other_content_report' },
  ];
}

export async function ensureZendeskTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS zendesk_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL UNIQUE,
      event_id TEXT,
      author_pubkey TEXT,
      violation_type TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolution_action TEXT,
      resolution_moderator TEXT
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_event ON zendesk_tickets(event_id)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_pubkey ON zendesk_tickets(author_pubkey)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_status ON zendesk_tickets(status)`).run();
  } catch {
    // Index might already exist
  }
}

export async function addZendeskInternalNote(
  ticketId: number,
  note: string,
  env: ZendeskSyncEnv,
  solve: boolean = false
): Promise<void> {
  if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_API_TOKEN || !env.ZENDESK_EMAIL) {
    console.warn('[addZendeskInternalNote] Missing Zendesk credentials, skipping');
    return;
  }

  try {
    const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
    const url = `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}`;

    const payload: {
      ticket: {
        comment: { body: string; public: boolean };
        status?: string;
        assignee_email?: string;
        custom_fields?: Array<{ id: number; value: string }>;
      };
    } = {
      ticket: {
        comment: {
          body: note,
          public: false,
        },
      },
    };

    if (solve) {
      payload.ticket.status = 'solved';
      payload.ticket.assignee_email = env.ZENDESK_EMAIL;
      payload.ticket.custom_fields = buildResolutionCustomFields(env);
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[addZendeskInternalNote] Failed: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error('[addZendeskInternalNote] Error:', error);
  }
}

export async function syncZendeskAfterAction(
  env: ZendeskSyncEnv,
  action: string,
  targetType: 'event' | 'pubkey' | 'media',
  targetId: string,
  moderator: string
): Promise<void> {
  console.log('[syncZendeskAfterAction] Called with:', { action, targetType, targetId, moderator });

  if (!env.DB) {
    console.log('[syncZendeskAfterAction] No DB configured, skipping');
    return;
  }

  try {
    await ensureZendeskTable(env.DB);

    let linked: { ticket_id: number } | null = null;

    if (targetType === 'event') {
      console.log('[syncZendeskAfterAction] Querying for event_id:', targetId);
      linked = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE event_id = ? AND status = 'open'`
      ).bind(targetId).first();
    } else if (targetType === 'pubkey') {
      console.log('[syncZendeskAfterAction] Querying for author_pubkey:', targetId);
      linked = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE author_pubkey = ? AND status = 'open'`
      ).bind(targetId).first();
    }

    console.log('[syncZendeskAfterAction] Query result:', linked);

    if (!linked?.ticket_id) {
      console.log('[syncZendeskAfterAction] No linked open ticket found, skipping');
      return;
    }

    // suspend_user / unsuspend_user deliberately excluded — suspension is a
    // holding action, not a final resolution, so tickets stay open for follow-up.
    const resolutionActions = [
      'reviewed',
      'dismissed',
      'no-action',
      'false-positive',
      'delete_event',
      'ban_pubkey',
      'ban_user',
      'auto_hide_confirmed',
      'auto_hide_restored',
    ];
    const isResolution = resolutionActions.includes(action);

    const actionDisplay = action.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
    const timestamp = new Date().toISOString();

    const note = [
      '📋 **Moderation Action Taken**',
      '',
      `**Action:** ${actionDisplay}`,
      `**Target:** \`${targetId}\``,
      `**Moderator:** ${moderator}`,
      `**Time:** ${timestamp}`,
    ].join('\n');

    await addZendeskInternalNote(linked.ticket_id, note, env, isResolution);

    if (isResolution) {
      await env.DB.prepare(`
        UPDATE zendesk_tickets
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            resolution_action = ?,
            resolution_moderator = ?
        WHERE ticket_id = ?
      `).bind(action, moderator, linked.ticket_id).run();
    }

    console.log(`[syncZendeskAfterAction] Updated ticket #${linked.ticket_id} with action: ${action}`);
  } catch (error) {
    console.error('[syncZendeskAfterAction] Error:', error);
  }
}
