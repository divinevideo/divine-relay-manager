// ABOUTME: A moderator's saved tab order must survive a release that adds a tab.
// ABOUTME: New tabs are appended; unknown or repeated saved IDs are dropped.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RelayManager } from './RelayManager';

vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example.test', apiUrl: 'https://api.example.test' } }),
}));
vi.mock('@/components/EventsList', () => ({ EventsList: () => null }));
vi.mock('@/components/UserManagement', () => ({ UserManagement: () => null }));
vi.mock('@/components/Reports', () => ({ Reports: () => null }));
vi.mock('@/components/Labels', () => ({ Labels: () => null }));
vi.mock('@/components/DebugPanel', () => ({ DebugPanel: () => null }));
vi.mock('@/components/SettingsDashboard', () => ({ SettingsDashboard: () => null }));
vi.mock('@/components/AgeReview', () => ({ AgeReview: () => null }));
vi.mock('@/components/SexualQuarantine', () => ({ SexualQuarantine: () => null }));
vi.mock('@/components/EnvironmentSelector', () => ({ EnvironmentSelector: () => null }));
vi.mock('@/components/AdminBar', () => ({ default: () => null }));
vi.mock('@/components/auth/DivineLoginButton', () => ({ DivineLoginButton: () => null }));
vi.mock('@/components/auth/AttributionNotice', () => ({ AttributionNotice: () => null }));

const STORAGE_KEY = 'divine-relay-manager:tab-order';

// src/test/setup.ts replaces localStorage with stubs whose getItem returns null.
function renderedTabs(saved: string[]): string[] {
  vi.mocked(localStorage.getItem).mockImplementation(key => key === STORAGE_KEY ? JSON.stringify(saved) : null);
  render(
    <MemoryRouter initialEntries={['/reports']}>
      <Routes>
        <Route path="/reports" element={<RelayManager />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getAllByRole('tab').map(tab => tab.textContent?.trim() ?? '');
}

describe('RelayManager saved tab order', () => {
  afterEach(() => { vi.mocked(localStorage.getItem).mockReset().mockReturnValue(null); });

  it('keeps a saved order from before a tab was added and appends the new tab', () => {
    expect(renderedTabs(['debug', 'reports', 'age-review', 'events', 'users', 'labels', 'settings'])).toEqual(
      ['Debug', 'Reports', 'Age Review', 'Events', 'Users', 'Labels', 'Settings', 'Sexual Quarantine'],
    );
  });

  it('drops unknown and repeated saved tab IDs', () => {
    expect(renderedTabs(['settings', 'removed-tab', 'settings', 'reports'])).toEqual(
      ['Settings', 'Reports', 'Age Review', 'Sexual Quarantine', 'Events', 'Users', 'Labels', 'Debug'],
    );
  });
});
