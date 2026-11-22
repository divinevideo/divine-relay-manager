// ABOUTME: The live SuspensionIo: fresh relay ban/suspension reads, Keycast status and status
// ABOUTME: changes, the age-review case check, and the Slack alert, over the worker's real env.
import type { AgeReviewEnv } from './age-review';
import { getActiveAgeReviewCase } from './age-review-lookup';
import { errorNameOnly } from './error-name';
import { getUserStatus, suspendUser, unsuspendUser } from './keycast-client';
import { readPubkeyBan, unsuspendPubkey } from './nip86';
import { readSuspensionEntry } from './suspended-content';
import type { KeycastStatusRead, SuspensionIo } from './timed-suspensions';

// getUserStatus has no default timeout (see keycast-client.ts), and the scheduler reads
// Keycast for every due row, so one hung call must not stall the whole tick. A timeout
// reads as 'unknown', which the timer counts as a failed attempt and retries.
export const KEYCAST_STATUS_TIMEOUT_MS = 5_000;
// Same reasoning for the alert: it runs at the end of a tick.
const ALERT_TIMEOUT_MS = 5_000;

export type SuspensionIoEnv = AgeReviewEnv & { ENVIRONMENT?: string };

export function liveSuspensionIo(env: SuspensionIoEnv, notify: SuspensionIo['notify']): SuspensionIo {
  return {
    readBan: (pubkey) => readPubkeyBan(pubkey, env),
    readSuspension: (pubkey) => readSuspensionEntry(pubkey, env),

    async readKeycastStatus(pubkey): Promise<KeycastStatusRead> {
      try {
        const res = await getUserStatus(pubkey, env, { timeoutMs: KEYCAST_STATUS_TIMEOUT_MS });
        if (res.success) {
          return res.status === 'active' || res.status === 'suspended' || res.status === 'banned'
            ? res.status
            : 'unknown';
        }
        // Anything but Keycast's own "no such user", "not configured" included, is unknown.
        return res.notFound ? 'none' : 'unknown';
      } catch (error) {
        // Token resolution (a Secrets Store get) sits outside getUserStatus's own catch.
        console.error('[liveSuspensionIo] Keycast status read threw:', errorNameOnly(error));
        return 'unknown';
      }
    },

    async hasOpenAgeReviewCase(pubkey) {
      // getActiveAgeReviewCase answers null without a DB, which would read as "no case"
      // and let a lift go ahead. Without the binding the answer is unknown: fail closed.
      if (!env.DB) throw new Error('DB not configured: cannot check for an open age-review case');
      return (await getActiveAgeReviewCase(pubkey, env)) !== null;
    },

    async relayUnsuspend(pubkey) {
      try {
        const res = await unsuspendPubkey(pubkey, env);
        return res.success ? { success: true } : { success: false, error: res.error ?? 'relay refused' };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    keycastActivate: (pubkey, actor) => unsuspendUser(pubkey, env, actor),
    keycastSuspend: (pubkey, actor) => suspendUser(pubkey, 'moderation', env, actor),
    notify,

    async alert(text) {
      if (!env.SLACK_WEBHOOK_URL) return false;
      try {
        const res = await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.error(`[liveSuspensionIo] Slack alert returned ${res.status}`);
          return false;
        }
        return true;
      } catch (error) {
        // The webhook URL is a credential, and a fetch error can repeat it.
        console.error('[liveSuspensionIo] Slack alert failed:', errorNameOnly(error));
        return false;
      }
    },
  };
}
