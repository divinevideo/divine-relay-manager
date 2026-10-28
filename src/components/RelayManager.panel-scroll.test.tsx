// ABOUTME: Tabs with natural-height content must own a scroll region inside the fixed-height shell.
// ABOUTME: Without it, long Users, Labels and Debug content is clipped with no way to scroll.
//
// RelayManager is an `h-screen overflow-hidden` shell, and each TabsContent is a
// `flex-1 min-h-0` flex child, so its height is bounded by the window. Events,
// Reports, Age Review and Settings scroll inside their own `h-full` panes; Users,
// Labels and Debug are natural-height content, so the panel holding each has to
// scroll or its content runs past the shell's `overflow-hidden` and is
// unreachable. jsdom does no layout, so this pins the structural contract; the
// real scroll was checked in a browser against stubbed data.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RelayManager } from './RelayManager';

vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example.test', apiUrl: 'https://api.example.test' } }),
}));
vi.mock('@/components/EventsList', () => ({ EventsList: () => null }));
vi.mock('@/components/UserManagement', () => ({
  UserManagement: () => <div data-testid="tab-body-users" />,
}));
vi.mock('@/components/Reports', () => ({ Reports: () => null }));
vi.mock('@/components/Labels', () => ({ Labels: () => <div data-testid="tab-body-labels" /> }));
vi.mock('@/components/DebugPanel', () => ({ DebugPanel: () => <div data-testid="tab-body-debug" /> }));
vi.mock('@/components/SettingsDashboard', () => ({ SettingsDashboard: () => null }));
vi.mock('@/components/AgeReview', () => ({ AgeReview: () => null }));
vi.mock('@/components/EnvironmentSelector', () => ({ EnvironmentSelector: () => null }));
vi.mock('@/components/AdminBar', () => ({ default: () => null }));
vi.mock('@/components/auth/DivineLoginButton', () => ({ DivineLoginButton: () => null }));
vi.mock('@/components/auth/AttributionNotice', () => ({ AttributionNotice: () => null }));

describe('RelayManager natural-height tab panels', () => {
  it.each(['users', 'labels', 'debug'])('renders the %s tab inside a bounded, vertically scrollable panel', (tab) => {
    render(
      <MemoryRouter initialEntries={[`/${tab}`]}>
        <Routes>
          <Route path={`/${tab}`} element={<RelayManager />} />
        </Routes>
      </MemoryRouter>,
    );

    const panel = screen.getByTestId(`tab-body-${tab}`).closest('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    // Bounded by the shell (flex-1 min-h-0) AND scrolls its own overflow.
    expect(panel).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto');
  });
});
