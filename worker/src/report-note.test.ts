import { describe, expect, it } from 'vitest';
import { buildReportNote, eventKindLabel, parseKind0Profile } from './report-note';

// Real Kofi OG-import account (public) — lets us assert the npub encoding end-to-end.
const KOFI_HEX = '9f59c820aa2ad80ce8c0e28a4e640b9cd0487b4a510da95be7cd4bfd3ecda0bd';
const KOFI_NPUB = 'npub1navusg929tvqe6xqu29yueqtnngys7622yx6jkl8e49l60kd5z7syxq58u';

describe('eventKindLabel', () => {
  it('labels known kinds and falls back for the rest', () => {
    expect(eventKindLabel(0)).toBe('profile');
    expect(eventKindLabel(1)).toBe('note');
    expect(eventKindLabel(34236)).toBe('video');
    expect(eventKindLabel(1111)).toBe('kind 1111');
    expect(eventKindLabel(null)).toBe('event');
    expect(eventKindLabel(undefined)).toBe('event');
  });
});

describe('parseKind0Profile', () => {
  it('extracts name/nip05 and flags a vine-archive import', () => {
    const p = parseKind0Profile({
      content: JSON.stringify({ name: 'kofi', display_name: 'kofi', nip05: '_@kofi.divine.video' }),
      tags: [
        ['i', 'vine:1133875566232367104'],
        ['vine_username', 'kofi'],
        ['client', 'vine-archive-importer'],
      ],
    });
    expect(p).toEqual({
      name: 'kofi',
      nip05: '_@kofi.divine.video',
      isVineImport: true,
      vineUsername: 'kofi',
    });
  });

  it('prefers display_name and does not flag a normal account', () => {
    const p = parseKind0Profile({
      content: JSON.stringify({ name: 'raw', display_name: 'Pretty', nip05: 'x@divine.video' }),
      tags: [['client', 'divine-mobile']],
    });
    expect(p.name).toBe('Pretty');
    expect(p.isVineImport).toBe(false);
    expect(p.vineUsername).toBeUndefined();
  });

  it('still detects the OG-import flag when kind-0 content is malformed', () => {
    const p = parseKind0Profile({ content: 'not json', tags: [['i', 'vine:42']] });
    expect(p.name).toBeUndefined();
    expect(p.isVineImport).toBe(true);
  });

  it('handles a missing event without throwing', () => {
    expect(parseKind0Profile(null)).toEqual({
      name: undefined,
      nip05: undefined,
      isVineImport: false,
      vineUsername: undefined,
    });
  });
});

describe('buildReportNote', () => {
  it('account-level report surfaces subject, identity, and the restored-OG flag', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: 'other',
      environment: 'production',
      profile: { name: 'kofi', nip05: '_@kofi.divine.video', isVineImport: true, vineUsername: 'kofi' },
      reportedEventKind: null,
    });

    expect(note).toContain('RELAY REPORT');
    expect(note).toContain('Scope: **account-level (whole profile)**');
    expect(note).toContain('the subject of this report, *not* the person who filed it');
    expect(note).toContain('Profile: **kofi** · nip05 `_@kofi.divine.video`');
    expect(note).toContain('Restored OG Vine account');
    expect(note).toContain('vine_username `kofi`');
    expect(note).toContain(`support-admin](https://login.divine.video/support-admin?q=${KOFI_HEX})`);
    expect(note).toContain(`npub: \`${KOFI_NPUB}\``);
    expect(note).toContain(`hex: \`${KOFI_HEX}\``);
    // No content block for an account-level report.
    expect(note).not.toContain('Reported content');
  });

  it('content report shows the event block with kind label plus the author block', () => {
    const eventId = 'a'.repeat(64);
    const note = buildReportNote({
      eventId,
      authorPubkey: KOFI_HEX,
      violationType: 'sexualContent',
      environment: 'production',
      profile: { name: 'poster', nip05: undefined, isVineImport: false },
      reportedEventKind: 34236,
    });

    expect(note).toContain('Scope: **content (specific event)**');
    expect(note).toContain('**Reported content (video):**');
    expect(note).toContain('• Kind: `34236`');
    expect(note).toContain(`reports?event=${eventId}`);
    // Primary CTA points at the event view for content reports.
    expect(note).toContain(`**→ [Open this report in Relay Manager](https://relay.admin.divine.video/reports?event=${eventId}&env=production)**`);
    // Author block still present.
    expect(note).toContain('**Reported account**');
    expect(note).toContain('Profile: **poster**');
    expect(note).not.toContain('Restored OG Vine account');
  });

  it('degrades gracefully with no enrichment (still shows npub/hex, no Profile/OG lines)', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: null,
      environment: 'production',
      profile: null,
      reportedEventKind: null,
    });

    expect(note).toContain('Reason: **unspecified**');
    expect(note).toContain(`npub: \`${KOFI_NPUB}\``);
    expect(note).not.toContain('• Profile:');
    expect(note).not.toContain('Restored OG Vine account');
  });

  it('uses the staging keycast host and env param on staging', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: 'spam',
      environment: 'staging',
      profile: null,
      reportedEventKind: null,
    });
    expect(note).toContain(`https://login.staging.dvines.org/support-admin?q=${KOFI_HEX}`);
    expect(note).toContain('&env=staging');
  });
});
