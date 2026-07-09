import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb(): never {
  throw new Error('render exploded');
}

function MaybeBomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('render exploded');
  return <div>report body</div>;
}

// Always-throwing child that counts render attempts, so tests can assert
// whether a boundary reset actually re-executed the crashing subtree.
function makeCountingBomb() {
  let attempts = 0;
  function CountingBomb(): never {
    attempts++;
    throw new Error('render exploded');
  }
  return { CountingBomb, attempts: () => attempts };
}

// React logs caught render errors to console.error; silence them so test
// output stays pristine while still letting us assert the boundary's own log.
let consoleError: MockInstance;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('healthy content')).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('shows the default error card with a reload affordance instead of a blank page (app-root shape)', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  // Note: the reload button's window.location.reload() call is not click-tested —
  // jsdom's location.reload is unforgeable (cannot be spied or stubbed), and
  // invoking the real one prints "Not implemented: navigation" noise. Presence is
  // asserted above; the actual reload is a one-line browser API call.

  it('degrades a crashing subtree to the custom fallback while siblings survive (ReportDetail shape)', () => {
    render(
      <div>
        <div>reports list</div>
        <ErrorBoundary fallback={<div>this report failed to render</div>}>
          <Bomb />
        </ErrorBoundary>
      </div>
    );

    expect(screen.getByText('reports list')).toBeInTheDocument();
    expect(screen.getByText('this report failed to render')).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('does not re-execute a crashing child when rerendered with value-equal resetKeys', () => {
    // Reports.tsx passes a fresh array literal every render and re-renders on
    // a 15s poll — a comparator that resets on reference inequality would
    // re-run the hostile crashing render on every tick. Count executions.
    const { CountingBomb, attempts } = makeCountingBomb();

    const { rerender } = render(
      <ErrorBoundary resetKeys={['report-a']} fallback={<div>failed</div>}>
        <CountingBomb />
      </ErrorBoundary>
    );
    const attemptsAfterMount = attempts();

    rerender(
      <ErrorBoundary resetKeys={['report-a']} fallback={<div>failed</div>}>
        <CountingBomb />
      </ErrorBoundary>
    );

    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(attempts()).toBe(attemptsAfterMount);
  });

  it('re-catches and settles on the fallback when reset children still throw (Try again on a still-broken report)', () => {
    const { CountingBomb, attempts } = makeCountingBomb();

    const { rerender } = render(
      <ErrorBoundary resetKeys={[0]} fallback={<div>failed</div>}>
        <CountingBomb />
      </ErrorBoundary>
    );
    const attemptsAfterMount = attempts();

    rerender(
      <ErrorBoundary resetKeys={[1]} fallback={<div>failed</div>}>
        <CountingBomb />
      </ErrorBoundary>
    );

    // The reset re-attempted the children, re-caught the throw, and settled
    // back on the fallback — completing at all proves the reset/rethrow
    // cycle terminates instead of looping to 'Maximum update depth exceeded'.
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(attempts()).toBeGreaterThan(attemptsAfterMount);
  });

  it('passes a reset callback to a function fallback that recovers once the child is fixed', () => {
    const { CountingBomb } = makeCountingBomb();
    const fallback = (reset: () => void) => <button onClick={reset}>retry</button>;

    const { rerender } = render(
      <ErrorBoundary fallback={fallback}>
        <CountingBomb />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();

    // Child fixed, but no resetKeys change — still on the fallback until reset.
    rerender(
      <ErrorBoundary fallback={fallback}>
        <div>healthy now</div>
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByText('healthy now')).toBeInTheDocument();
  });

  it('re-catches when reset is clicked while the child still throws', () => {
    const { CountingBomb, attempts } = makeCountingBomb();

    render(
      <ErrorBoundary fallback={reset => <button onClick={reset}>retry</button>}>
        <CountingBomb />
      </ErrorBoundary>
    );
    const attemptsAfterMount = attempts();

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));

    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
    expect(attempts()).toBeGreaterThan(attemptsAfterMount);
  });

  it('recovers when resetKeys change (selecting a different report)', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['report-a']} fallback={<div>failed</div>}>
        <MaybeBomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('failed')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKeys={['report-b']} fallback={<div>failed</div>}>
        <MaybeBomb shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('report body')).toBeInTheDocument();
  });

  it('stays on the fallback when resetKeys are unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['report-a']} fallback={<div>failed</div>}>
        <MaybeBomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('failed')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKeys={['report-a']} fallback={<div>failed</div>}>
        <MaybeBomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('report body')).not.toBeInTheDocument();
  });

  it('logs the caught error with its component stack (componentDidCatch)', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    // Match the boundary's own log, not React's built-in error logging —
    // React 18 logs the caught Error itself, so a looser assertion would
    // stay green even if componentDidCatch were deleted.
    const boundaryLog = consoleError.mock.calls.find(
      args => args[0] === 'ErrorBoundary caught a render error:'
    );
    expect(boundaryLog).toBeDefined();
    expect(boundaryLog![1]).toBeInstanceOf(Error);
    expect((boundaryLog![1] as Error).message).toBe('render exploded');
    expect(String(boundaryLog![2])).toContain('Bomb');
  });
});
