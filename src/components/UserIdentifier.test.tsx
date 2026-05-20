import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { UserIdentifier } from './UserIdentifier';

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

describe('UserIdentifier', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
  });

  it('does not copy by default in compact mode', () => {
    render(
      <UserIdentifier
        pubkey={'a'.repeat(64)}
        variant="compact"
        showAvatar={false}
        linkToProfile={false}
      />
    );

    fireEvent.click(screen.getByText(/npub/i));

    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies npub in compact mode when explicitly enabled', async () => {
    render(
      <UserIdentifier
        pubkey={'a'.repeat(64)}
        variant="compact"
        showAvatar={false}
        linkToProfile={false}
        copyOnClick
      />
    );

    fireEvent.click(screen.getByText(/npub/i));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toMatch(/^npub1/);
    });
  });
});
