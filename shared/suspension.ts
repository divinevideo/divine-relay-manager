// ABOUTME: Shared vocabulary for timed (auto-expiring) suspensions: the duration
// ABOUTME: rules, the decision actions, and the shapes the worker and UI agree on.

export type SuspensionUnit = 'hours' | 'days';
export interface SuspensionDuration { value: number; unit: SuspensionUnit }

export const MAX_SUSPENSION_DAYS = 365;
const MAX_SUSPENSION_HOURS = MAX_SUSPENSION_DAYS * 24;
export const DURATION_ERROR = 'Enter a whole number from 1 hour up to 365 days';

// A whole number of hours or days, from 1 hour up to 365 days. The range is
// checked in hours so both units share one bound.
export function checkSuspensionDuration(input: unknown):
  { ok: true; duration: SuspensionDuration } | { ok: false; error: typeof DURATION_ERROR } {
  const fail = { ok: false, error: DURATION_ERROR } as const;
  if (typeof input !== 'object' || input === null) return fail;
  const { value, unit } = input as { value?: unknown; unit?: unknown };
  if (unit !== 'hours' && unit !== 'days') return fail;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail;
  const hours = unit === 'days' ? value * 24 : value;
  if (hours < 1 || hours > MAX_SUSPENSION_HOURS) return fail;
  return { ok: true, duration: { value, unit } };
}

const MINUTE_MS = 60_000;

// ISO end instant, rounded up to the next whole minute so a suspension never
// ends sooner than asked.
export function suspensionEndsAt(duration: SuspensionDuration, now: Date): string {
  const ms = duration.value * (duration.unit === 'days' ? 24 : 1) * 3_600_000;
  return new Date(Math.ceil((now.getTime() + ms) / MINUTE_MS) * MINUTE_MS).toISOString();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'Tue 24 Nov 2026, 14:00 UTC'. UTC getters, so the local zone never shifts it.
export function formatSuspensionEnd(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export type UnbanSuspensionChoice = 'resume' | 'end_now' | 'open_ended';

export function isUnbanSuspensionChoice(v: unknown): v is UnbanSuspensionChoice {
  return v === 'resume' || v === 'end_now' || v === 'open_ended';
}

export type UnbanSuspensionState =
  'not_suspended' | 'unknown' | 'resumed' | 'open_ended' | 'ended' | 'end_failed';

export const SUSPENSION_ACTIONS = {
  set: 'suspend_user',
  change: 'change_suspension_end',
  unsuspend: 'unsuspend_user',
  autoUnsuspend: 'auto_unsuspend_user',
  cancelTimer: 'cancel_suspension_timer',
  resumeTimer: 'resume_suspension_timer',
} as const;

// Decision rows the timer writes itself, whatever the moderator field holds.
export const TIMER_DECISION_ACTIONS: readonly string[] = [
  SUSPENSION_ACTIONS.autoUnsuspend,
  SUSPENSION_ACTIONS.cancelTimer,
  SUSPENSION_ACTIONS.resumeTimer,
];

export interface TimedSuspensionView {
  pubkey: string;
  endsAt: string | null;
  status: 'active' | 'cancelled_ban';
  setBy: string | null;
  setAt: string;
  changedAt: string | null;
}
