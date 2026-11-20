import { describe, expect, it } from 'vitest';
import { suspensionAfterRestore } from './suspensionAfterRestore';

describe('suspensionAfterRestore', () => {
  // The suspended list's re-read after this tab's Unsuspend failed and kept its
  // copy from before it. The window opens only after a confirmed Unsuspend.
  it('counts a suspension only a stale list reports as none while the window is open', () => {
    expect(suspensionAfterRestore(true, true, true)).toBe(false);
  });

  // Another moderator suspended the account again since the Unsuspend.
  it('keeps a suspension the list confirmed since the unsuspend', () => {
    expect(suspensionAfterRestore(true, false, true)).toBe(true);
  });

  it('keeps a stale suspension once the window has closed', () => {
    expect(suspensionAfterRestore(true, true, false)).toBe(true);
  });

  it('keeps an unknown suspension unknown whatever the stale flag says', () => {
    expect(suspensionAfterRestore(null, true, true)).toBeNull();
    expect(suspensionAfterRestore(null, false, true)).toBeNull();
  });

  it('keeps a confirmed absence', () => {
    expect(suspensionAfterRestore(false, false, true)).toBe(false);
    expect(suspensionAfterRestore(false, false, false)).toBe(false);
  });
});
