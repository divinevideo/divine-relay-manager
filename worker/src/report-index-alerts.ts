// ABOUTME: Loud alerts for Relay Manager's own copy of reports: always logged, posted to the webhook when one is set.
// ABOUTME: Never throws, so an alert can never break the catch-up or sync work that raised it.

import { errorNameOnly } from './error-name';

export interface ReportIndexAlertEnv {
  SLACK_WEBHOOK_URL?: string;
  ENVIRONMENT?: string;
}

export async function sendReportIndexAlert(env: ReportIndexAlertEnv, text: string): Promise<void> {
  console.error('[ALERT] [report-index] ' + text);
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: [${env.ENVIRONMENT ?? 'unknown'}] ${text}` }),
    });
    if (!res.ok) console.error(`[report-index] Alert webhook returned ${res.status}`);
  } catch (error) {
    console.error('[report-index] Failed to send alert webhook:', errorNameOnly(error));
  }
}
