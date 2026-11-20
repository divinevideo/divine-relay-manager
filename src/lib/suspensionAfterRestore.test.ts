import { describe, expect, it } from 'vitest';
import { suspensionAfterRestore } from './suspensionAfterRestore';

describe('suspensionAfterRestore', () => {
  it('ignores a positive from a request already started when Unsuspend succeeded', () => {
    expect(suspensionAfterRestore(true, 2, 3)).toBe(false);
    expect(suspensionAfterRestore(true, 3, 3)).toBe(false);
  });

  // Another moderator suspended the account again since the Unsuspend.
  it('keeps a suspension the list confirmed since the unsuspend', () => {
    expect(suspensionAfterRestore(true, 4, 3)).toBe(true);
  });

  it('keeps a stale suspension once the window has closed', () => {
    expect(suspensionAfterRestore(true, 2, undefined)).toBe(true);
  });

  it('keeps an unknown suspension unknown', () => {
    expect(suspensionAfterRestore(null, 2, 3)).toBeNull();
    expect(suspensionAfterRestore(null, undefined, 3)).toBeNull();
  });

  it('keeps a confirmed absence', () => {
    expect(suspensionAfterRestore(false, 2, 3)).toBe(false);
    expect(suspensionAfterRestore(false, 2, undefined)).toBe(false);
  });
});
