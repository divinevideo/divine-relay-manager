import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AccountTypeIndicator } from './AccountTypeIndicator';

describe('AccountTypeIndicator', () => {
  it('renders self-custody as informational with the no-effective-enforcement verdict', () => {
    render(<AccountTypeIndicator accountStatus={{ success: false, not_found: true }} accountStatusError={false} accountStatusLoading={false} contentPresenceKnown={true} postCount={0} ticketLinked={true} />);
    expect(screen.getByText('Self-custody (not in keycast)')).toBeInTheDocument(); // the badge
    expect(screen.getByText(/no effective enforcement available/i)).toBeInTheDocument(); // the verdict
    // Not styled/labelled as an error.
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
  it('renders unknown when the keycast lookup is unavailable', () => {
    render(<AccountTypeIndicator accountStatus={{ success: false, error: '500' }} accountStatusError={false} accountStatusLoading={false} contentPresenceKnown={true} postCount={0} ticketLinked={false} />);
    expect(screen.getByText('Account status unavailable')).toBeInTheDocument(); // the badge
  });
  it('renders a Divine account with a compliance checklist', () => {
    render(<AccountTypeIndicator accountStatus={{ success: true, status: 'active' }} accountStatusError={false} accountStatusLoading={false} contentPresenceKnown={true} postCount={4} ticketLinked={false} />);
    expect(screen.getByText(/divine account/i)).toBeInTheDocument();
    expect(screen.getByText(/Sign-in \(keycast\) suspend/i)).toBeInTheDocument();
  });
  it('shows a checking state while account status loads (no unavailable flash)', () => {
    render(<AccountTypeIndicator accountStatus={undefined} accountStatusError={false} accountStatusLoading={true} contentPresenceKnown={false} postCount={undefined} ticketLinked={false} />);
    expect(screen.getByText(/checking account status/i)).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });
  it('does not conclude unactionable when the content read is unresolved', () => {
    render(<AccountTypeIndicator accountStatus={{ success: false, not_found: true }} accountStatusError={false} accountStatusLoading={false} contentPresenceKnown={false} postCount={undefined} ticketLinked={true} />);
    expect(screen.getByText(/verify content directly/i)).toBeInTheDocument();
    expect(screen.queryByText(/no effective enforcement/i)).not.toBeInTheDocument();
  });
});
