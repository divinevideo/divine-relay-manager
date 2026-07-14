import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { completeLogin, refresh, navigate } = vi.hoisted(() => ({
  completeLogin: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({ completeLogin }));
vi.mock('@/hooks/useDivineSession', () => ({ useDivineSession: () => ({ refresh }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import AuthCallback from './AuthCallback';

beforeEach(() => vi.clearAllMocks());

describe('AuthCallback', () => {
  it('completes login and navigates to the return path', async () => {
    completeLogin.mockResolvedValue({ returnPath: '/age-review' });
    render(<AuthCallback />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/age-review', { replace: true }));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an error and does not navigate on failure', async () => {
    completeLogin.mockRejectedValue(new Error('user cancelled'));
    render(<AuthCallback />);
    await waitFor(() => expect(screen.getByText(/user cancelled/i)).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });
});
