// ABOUTME: The "+N more reports" line under a list of reports, honest about a read that stopped early.
// ABOUTME: One rule for every report list in the pane: "N+ more" when truncated, singular only for exactly one.

import { historyCount } from "@/lib/historyCount";

// "+3 more reports", or "3+ more reports" on a read that stopped early: a plus on
// both sides ("+3+") would read as a typo, and the trailing one is the floor mark
// every other count here uses. Singular only for an exact count of one: "1+"
// means at least one, so a read that stopped early stays plural. `noun` names a
// group ("user" gives "more user reports").
export function overflowLine(rest: number, truncated: boolean, noun?: string): string {
  const count = truncated ? historyCount(rest, true) : `+${rest}`;
  const reports = rest === 1 && !truncated ? 'report' : 'reports';
  return `${count} more ${noun ? `${noun} ` : ''}${reports}`;
}
