import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TruncationWarning } from './truncation-warning';

describe('TruncationWarning', () => {
  it('renders nothing when count is below limit', () => {
    const { container } = render(
      <TruncationWarning count={50} limit={200} noun="reports" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when count is zero', () => {
    const { container } = render(
      <TruncationWarning count={0} limit={200} noun="reports" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders warning when count equals limit', () => {
    render(<TruncationWarning count={200} limit={200} noun="reports" />);
    expect(screen.getByText(/Showing 200 reports/)).toBeInTheDocument();
    expect(screen.getByText(/limit reached/)).toBeInTheDocument();
  });

  it('renders warning when count exceeds limit', () => {
    render(<TruncationWarning count={500} limit={200} noun="labels" />);
    expect(screen.getByText(/Showing 500 labels/)).toBeInTheDocument();
  });

  it('uses default noun "results" when noun not specified', () => {
    render(<TruncationWarning count={100} limit={100} />);
    expect(screen.getByText(/Showing 100 results/)).toBeInTheDocument();
  });
});
