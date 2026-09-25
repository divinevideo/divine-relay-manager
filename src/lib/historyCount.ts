// ABOUTME: Renders a history count honestly when the read that produced it stopped early.

// A count from a walk that hit its page bound is a floor, not a total. Printing
// it bare is the silent-cap bug this replaced: the pane said 50 when the answer
// was 80.
export function historyCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}
