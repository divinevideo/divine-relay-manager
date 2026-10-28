import { describe, expect, it } from 'vitest';
import { getToasts, toast } from './useToast';

describe('getToasts', () => {
  it('reads the toast store as it is now, open and then dismissed', () => {
    const shown = toast({ title: 'Video blocked; thumbnail NOT blocked' });
    expect(getToasts()).toContainEqual(expect.objectContaining({ id: shown.id, open: true }));

    shown.dismiss();
    expect(getToasts()).toContainEqual(expect.objectContaining({ id: shown.id, open: false }));
  });
});
