// ABOUTME: React error boundary so a render exception (e.g. from hostile event
// ABOUTME: data) degrades to an error card instead of white-screening the app

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Scoped fallback UI; omit to get the default full-page error card. The
   * function form receives a reset callback for a "try again" affordance
   * that re-attempts the children (and re-catches if they still throw).
   */
  fallback?: ReactNode | ((reset: () => void) => ReactNode);
  /**
   * When any value here changes (compared by Object.is), a caught error is
   * cleared and children render again — e.g. pass the selected report id so
   * picking a different report recovers from a crashed one.
   */
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  // Boolean rather than the thrown value: render code can throw anything,
  // including null/undefined, which a `error !== null` check would miss.
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught a render error:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.hasError && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false });
    }
  }

  /** Clear a caught error and re-attempt the children. Safe to call when
   * healthy (no-op), so consumers can invoke it on generic gestures like
   * re-selecting the current item. */
  reset = () => {
    if (this.state.hasError) {
      this.setState({ hasError: false });
    }
  };

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.reset);
      }
      // Default fallback inline (not a sibling component: react-refresh wants
      // component-only files, and a class boundary can't fast-refresh anyway).
      // Kept dependency-light so the fallback itself cannot throw: no context,
      // no providers — it must render even when the crash was in a provider.
      return (
        this.props.fallback ?? (
          <div className="min-h-screen flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-lg border p-6 text-center space-y-3">
              <AlertTriangle className="h-8 w-8 mx-auto text-destructive" />
              <h1 className="text-lg font-semibold">Something went wrong</h1>
              <p className="text-sm text-muted-foreground">
                The admin UI hit an unexpected error while rendering. Reload
                the page to recover; details are in the browser console.
              </p>
              <Button onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

function resetKeysChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (prev === next) return false;
  if (!prev || !next || prev.length !== next.length) return true;
  return prev.some((value, i) => !Object.is(value, next[i]));
}
