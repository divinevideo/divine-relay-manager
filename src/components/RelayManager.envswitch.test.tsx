// ABOUTME: An open report must not survive an environment switch, or its actions would run
// ABOUTME: against the new environment's relay and API. Reports is remounted on the switch.

import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import TestApp from '@/test/TestApp';
import { useAppContext } from '@/hooks/useAppContext';
import { RelayManager } from './RelayManager';

// Stands in for the Reports screen: its own state, which an environment switch
// must not carry (the real one holds the selected report).
vi.mock('@/components/Reports', () => ({
  Reports: ({ relayUrl }: { relayUrl: string }) => {
    const [opened, setOpened] = useState(false);
    return (
      <div data-testid="reports" data-relay={relayUrl} data-opened={String(opened)}>
        <button onClick={() => setOpened(true)}>open a report</button>
      </div>
    );
  },
}));
vi.mock('@/components/EventsList', () => ({ EventsList: () => null }));
vi.mock('@/components/UserManagement', () => ({ UserManagement: () => null }));
vi.mock('@/components/Labels', () => ({ Labels: () => null }));
vi.mock('@/components/DebugPanel', () => ({ DebugPanel: () => null }));
vi.mock('@/components/SettingsDashboard', () => ({ SettingsDashboard: () => null }));
vi.mock('@/components/AgeReview', () => ({ AgeReview: () => null }));
vi.mock('@/components/EnvironmentSelector', () => ({ EnvironmentSelector: () => null }));
vi.mock('@/components/AdminBar', () => ({ default: () => null }));
vi.mock('@/components/auth/DivineLoginButton', () => ({ DivineLoginButton: () => null }));
vi.mock('@/components/auth/AttributionNotice', () => ({ AttributionNotice: () => null }));

let switchTo: (relayUrl: string, apiUrl: string) => void = () => {};
function Switcher() {
  const { updateConfig } = useAppContext();
  switchTo = (relayUrl, apiUrl) => updateConfig(c => ({ ...c, relayUrl, apiUrl }));
  return null;
}

function renderManager() {
  window.history.pushState({}, '', '/reports');
  return render(<TestApp><Switcher /><RelayManager /></TestApp>);
}

describe('RelayManager environment switch', () => {
  it('remounts the Reports screen, so the open report is gone and nothing can act on it', async () => {
    renderManager();
    await act(async () => { screen.getByText('open a report').click(); });
    expect(screen.getByTestId('reports').dataset.opened).toBe('true');

    await act(async () => { switchTo('wss://other-relay.example', 'https://other-api.example'); });

    expect(screen.getByTestId('reports').dataset.relay).toBe('wss://other-relay.example');
    expect(screen.getByTestId('reports').dataset.opened).toBe('false');
  });

  it('remounts when only the API changes', async () => {
    renderManager();
    const relay = screen.getByTestId('reports').dataset.relay as string;
    await act(async () => { screen.getByText('open a report').click(); });

    await act(async () => { switchTo(relay, 'https://another-api.example'); });

    expect(screen.getByTestId('reports').dataset.opened).toBe('false');
  });

  it('remounts when only the relay changes', async () => {
    renderManager();
    await act(async () => { screen.getByText('open a report').click(); });

    await act(async () => { switchTo('wss://only-relay-changed.example', 'https://api-relay.divine.video'); });

    expect(screen.getByTestId('reports').dataset.opened).toBe('false');
  });

  it('keeps the open report when nothing about the environment changed', async () => {
    renderManager();
    await act(async () => { screen.getByText('open a report').click(); });
    const relay = screen.getByTestId('reports').dataset.relay as string;

    await act(async () => { switchTo(relay, 'https://api-relay.divine.video'); });

    expect(screen.getByTestId('reports').dataset.opened).toBe('true');
  });
});
