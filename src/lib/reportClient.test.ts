import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { describeReportClients, getReportClientName } from './reportClient';

function report(tags: string[][]): NostrEvent {
  return {
    id: '1'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: 1984,
    content: '',
    tags,
    created_at: 1_750_000_000,
    sig: 'f'.repeat(128),
  };
}

describe('getReportClientName', () => {
  it('reads the app name from a NIP-89 client tag', () => {
    const r = report([
      ['e', 'b'.repeat(64)],
      ['client', 'Example App', `31990:${'c'.repeat(64)}:example-app`, 'wss://relay.example'],
    ]);
    expect(getReportClientName(r)).toBe('Example App');
  });

  it('reads a bare client tag with only a name', () => {
    expect(getReportClientName(report([['client', 'web.example']]))).toBe('web.example');
  });

  it('trims surrounding whitespace', () => {
    expect(getReportClientName(report([['client', '  Example App \n']]))).toBe('Example App');
  });

  it('returns undefined when there is no client tag', () => {
    expect(getReportClientName(report([['e', 'b'.repeat(64)]]))).toBeUndefined();
  });

  it('returns undefined when the client tag has no name', () => {
    expect(getReportClientName(report([['client']]))).toBeUndefined();
    expect(getReportClientName(report([['client', '   ']]))).toBeUndefined();
  });

  // ReportWatcher's trusted-client gate reads only the first client tag, so the
  // moderator must see that same value, not a later tag that the gate ignored.
  it('uses only the first client tag, as the auto-hide gate does', () => {
    expect(getReportClientName(report([['client', 'First App'], ['client', 'Second App']]))).toBe('First App');
    expect(getReportClientName(report([['client', ''], ['client', 'Second App']]))).toBeUndefined();
  });
});

describe('describeReportClients', () => {
  it('says which app a single report names', () => {
    expect(describeReportClients([report([['client', 'Example App']])])).toBe('Filed via Example App');
  });

  it('says so neutrally when a single report names no app', () => {
    expect(describeReportClients([report([])])).toBe('No app named');
  });

  it('lists each named app once, in the order first seen', () => {
    const reports = [
      report([['client', 'Example App']]),
      report([['client', 'Other App']]),
      report([['client', 'Example App']]),
    ];
    expect(describeReportClients(reports)).toBe('Filed via Example App, Other App');
  });

  it('counts the reports that name no app alongside the named ones', () => {
    const reports = [report([['client', 'Example App']]), report([]), report([['client', ' ']])];
    expect(describeReportClients(reports)).toBe('Filed via Example App · 2 with no app named');
  });

  it('says no app is named when none of the reports name one', () => {
    expect(describeReportClients([report([]), report([['client']])])).toBe('No app named');
  });
});
