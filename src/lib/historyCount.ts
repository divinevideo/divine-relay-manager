// ABOUTME: Renders a history count honestly when the read that produced it stopped early.

// A count from a walk that hit its page bound is a floor, not a total. Printing
// it bare is the silent-cap bug this replaced: the pane said 50 when the answer
// was 80.
export function historyCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

export function historyStat(
  count: number,
  truncated: boolean,
  incomplete: boolean,
  noun: string,
): string {
  if (incomplete) return `${noun} unavailable`;
  return `${historyCount(count, truncated)} ${noun}`;
}

// For a read capped at `limit` events: reaching the cap means there may be
// more, so the count is printed as a floor rather than an exact total.
export function reportsFiledLabel(count: number, limit: number): string {
  return `${historyCount(count, count >= limit)} report${count === 1 ? '' : 's'} filed`;
}
