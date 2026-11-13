// ABOUTME: When a report counts as handled: only if a person handled its target
// ABOUTME: after the report arrived. Shared so the worker feed and the queue agree.

import { AUTO_HIDE_ACTIONS } from './autohide';
import { isAutomatedDecision } from './automated-decision';

// Written when a moderator reopens a target. It ends the handling before it, so
// reports that arrived earlier stop reading as handled.
export const REOPENED_ACTION = 'reopened';

// Stands in for a resolution label in a target's history.
const LABEL_ACTION = 'resolution_label';

export interface HandlingRow {
  target_type: string;
  target_id: string;
  action: string;
  moderator_pubkey?: string | null;
  // Unix seconds; null for a row written before decisions were timestamped.
  at: number | null;
}

export interface HandlingLabel {
  type: 'event' | 'pubkey';
  value: string;
  at: number;
}

export interface HandlingEntry {
  // Unix seconds of the latest handling that counts. null: handled only by a
  // row with no date. It can't be compared with a report's time, so every
  // report on the target reads as handled, as it did before the dated rule
  // (#324), until a dated handling replaces it or a reopen ends it.
  handledAt: number | null;
  // Newest first, undated last. Human decisions, labels and reopens only.
  history: { action: string; at: number | null }[];
}

export type ReportStatus = 'new' | 'handled' | 'handled_before';

// A decision a person made. Reversals (unban, restore) count: undoing an action
// is a person's judgment about the target, so reports before it are answered.
// Automatic entries do not (issue #332): the system acting on a target says
// nothing about whether a person has read its reports. Auto-hide actions are
// excluded here even when the fallback marker is missing from the row.
export function isHumanHandling(row: { action: string; moderator_pubkey?: string | null }): boolean {
  if (row.action === REOPENED_ACTION) return false;
  if ((AUTO_HIDE_ACTIONS as readonly string[]).includes(row.action)) return false;
  return !isAutomatedDecision(row);
}

interface Pending {
  humanDated: number[];
  hasUndatedHuman: boolean;
  reopenDated: number[];
  hasReopen: boolean;
  // Rows in the order they were written, and the label apart from them.
  rowHistory: { action: string; at: number | null }[];
  labelHistory: { action: string; at: number | null }[];
}

// Keys are `${type}:${value}` exactly as stored (see reportTargetKey): a record
// in another spelling must not be re-cased into matching a report. A target
// with nothing that counts is absent, so its reports are 'new'.
export function handlingByTarget(
  rows: readonly HandlingRow[],
  labels: readonly HandlingLabel[],
): Map<string, HandlingEntry> {
  const pending = new Map<string, Pending>();
  const slot = (key: string): Pending => {
    let p = pending.get(key);
    if (!p) {
      p = { humanDated: [], hasUndatedHuman: false, reopenDated: [], hasReopen: false, rowHistory: [], labelHistory: [] };
      pending.set(key, p);
    }
    return p;
  };

  for (const row of rows) {
    if (row.target_type !== 'event' && row.target_type !== 'pubkey') continue;
    const key = `${row.target_type}:${row.target_id}`;
    if (row.action === REOPENED_ACTION) {
      const p = slot(key);
      p.hasReopen = true;
      if (row.at !== null) p.reopenDated.push(row.at);
      p.rowHistory.push({ action: row.action, at: row.at });
    } else if (isHumanHandling(row)) {
      const p = slot(key);
      if (row.at === null) p.hasUndatedHuman = true;
      else p.humanDated.push(row.at);
      p.rowHistory.push({ action: row.action, at: row.at });
    }
  }
  for (const label of labels) {
    const p = slot(`${label.type}:${label.value}`);
    p.humanDated.push(label.at);
    p.labelHistory.push({ action: LABEL_ACTION, at: label.at });
  }

  const result = new Map<string, HandlingEntry>();
  for (const [key, p] of pending) {
    // Only handling after the latest reopen counts. A reopen also supersedes
    // undated rows, which predate every dated row.
    const reopenedAt = p.reopenDated.length ? Math.max(...p.reopenDated) : -Infinity;
    const after = p.humanDated.filter(at => at > reopenedAt);
    let handledAt: number | null;
    if (after.length) handledAt = Math.max(...after);
    else if (p.hasUndatedHuman && !p.hasReopen) handledAt = null;
    else continue;

    // Rows arrive in the order they were written, and decisions are dated to
    // the second, so within one second the later row is the newer: reversed
    // first, the stable sort lists them newest first. A label goes after the
    // rows, so in the same second it lists as the older entry: dismissing a
    // report publishes its label first, then logs the decision.
    const history = [...p.rowHistory].reverse().concat(p.labelHistory).sort((a, b) => {
      if (a.at === null) return b.at === null ? 0 : 1;
      if (b.at === null) return -1;
      return b.at - a.at;
    });
    result.set(key, { handledAt, history });
  }
  return result;
}

// When a report reached us: the relay arrival time if known, else the time its
// author stamped on it, which can be set to anything.
export function reportTime(
  report: { id: string; created_at: number },
  arrivals: ReadonlyMap<string, number>,
): number {
  return arrivals.get(report.id) ?? report.created_at;
}

// Handled only if handling came strictly after the report. The same second is
// 'handled_before': a person can't have been answering a report that landed in
// the second they acted, so it is shown rather than presumed covered.
export function reportStatus(time: number, entry: HandlingEntry | undefined): ReportStatus {
  if (!entry) return 'new';
  if (entry.handledAt === null) return 'handled';
  return entry.handledAt > time ? 'handled' : 'handled_before';
}
