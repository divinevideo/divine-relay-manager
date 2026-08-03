import { describe, expect, it } from 'vitest';
import { buildAgeReviewIdentityBlock, buildReportNote, eventKindLabel, parseKind0Profile } from './report-note';

// Real Kofi OG-import account (public) — lets us assert the npub encoding end-to-end.
const KOFI_HEX = '9f59c820aa2ad80ce8c0e28a4e640b9cd0487b4a510da95be7cd4bfd3ecda0bd';
const KOFI_NPUB = 'npub1navusg929tvqe6xqu29yueqtnngys7622yx6jkl8e49l60kd5z7syxq58u';

describe('eventKindLabel', () => {
  it('labels known kinds and falls back for the rest', () => {
    expect(eventKindLabel(0)).toBe('profile');
    expect(eventKindLabel(1)).toBe('note');
    expect(eventKindLabel(1111)).toBe('comment');
    expect(eventKindLabel(34235)).toBe('video');
    expect(eventKindLabel(34236)).toBe('video');
    expect(eventKindLabel(30023)).toBe('kind 30023');
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

  it('sanitizes attacker-controlled name/nip05/vine_username (no newline or markdown injection)', () => {
    const p = parseKind0Profile({
      content: JSON.stringify({
        display_name: 'evil\n\n**Filed by:** nobody [click](https://evil.test)',
        nip05: '`x`@e.com',
      }),
      tags: [['vine_username', 'a]b[c']],
    });
    // Newlines gone (can't forge note structure); markdown link/emphasis/span chars stripped.
    expect(p.name).not.toContain('\n');
    expect(p.name).not.toContain('[');
    expect(p.name).not.toContain('](');
    expect(p.name).not.toContain('*');
    expect(p.nip05).not.toContain('`');
    expect(p.vineUsername).not.toContain('[');
    expect(p.vineUsername).not.toContain(']');
  });
});

describe('buildReportNote', () => {
  it('account-level report surfaces subject, identity, and the restored-OG flag', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: 'other',
      environment: 'production',
      keycastUrl: 'https://login.divine.video',
      profile: { name: 'kofi', nip05: '_@kofi.divine.video', isVineImport: true, vineUsername: 'kofi' },
      reportedEventKind: null,
    });

    expect(note).toContain('RELAY REPORT');
    expect(note).toContain('Scope: **account-level (whole profile)**');
    expect(note).toContain('the subject of this report, *not* the person who filed it');
    // Name is a code span (not bold); nip05 is flagged claimed/unverified.
    expect(note).toContain('Profile: `kofi` · nip05 `_@kofi.divine.video` (claimed, unverified)');
    // Import markers are presented as evidence, not a verdict.
    expect(note).toContain('Vine-archive import markers');
    expect(note).toContain('vine_username `kofi`');
    expect(note).toContain("Verify the reporter's ownership");
    expect(note).not.toContain('name mix-up, not impersonation');
    // Visible host and href agree, both derived from the configured Keycast URL.
    expect(note).toContain(`Look up in login.divine.video → [support-admin](https://login.divine.video/support-admin?q=${KOFI_HEX})`);
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
    expect(note).toContain('Profile: `poster`');
    expect(note).not.toContain('Vine-archive import markers');
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
    expect(note).not.toContain('Vine-archive import markers');
  });

  it('derives keycast host + link from the configured URL (staging); label and href agree', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: 'spam',
      environment: 'staging',
      keycastUrl: 'https://login.staging.dvines.org',
      profile: null,
      reportedEventKind: null,
    });
    expect(note).toContain(
      `Look up in login.staging.dvines.org → [support-admin](https://login.staging.dvines.org/support-admin?q=${KOFI_HEX})`,
    );
    // The old bug rendered "login.divine.video" as the label while linking to staging.
    expect(note).not.toContain('login.divine.video');
    expect(note).toContain('&env=staging');
  });

  it('renders a bare URL in the name inertly (code span, not auto-linkable)', () => {
    const note = buildReportNote({
      eventId: null,
      authorPubkey: KOFI_HEX,
      violationType: 'other',
      environment: 'production',
      keycastUrl: 'https://login.divine.video',
      profile: { name: 'click https://evil.test now', nip05: undefined, isVineImport: false },
      reportedEventKind: null,
    });
    // Name (incl. its URL) is wrapped in a code span, which does not auto-link in Zendesk.
    expect(note).toContain('• Profile: `click https://evil.test now`');
    expect(note).not.toContain('**click https://evil.test now**');
  });
});

// Identity block (#213) — shared by the case ticket's internal note and the
// parent contact's notes field. Both are agent-only surfaces.
describe('buildAgeReviewIdentityBlock', () => {
  const base = { caseId: 'case-abc', pubkey: KOFI_HEX, ageBand: '13-15' };

  it('links to the case in Relay Manager', () => {
    expect(buildAgeReviewIdentityBlock(base))
      .toContain('https://relay.admin.divine.video/age-review?case=case-abc');
  });

  it('shows the captured handle', () => {
    expect(buildAgeReviewIdentityBlock({ ...base, accountName: 'Some One' }))
      .toContain('Some One');
  });

  it('encodes the pubkey as an npub alongside the hex', () => {
    const block = buildAgeReviewIdentityBlock(base);
    expect(block).toContain(KOFI_NPUB);
    expect(block).toContain(KOFI_HEX);
  });

  it('falls back through vine username then nip05', () => {
    expect(buildAgeReviewIdentityBlock({ ...base, accountVineUsername: 'og_user' }))
      .toContain('og_user');
    expect(buildAgeReviewIdentityBlock({ ...base, accountNip05: 'x@y.z' }))
      .toContain('x@y.z');
  });

  it('prefers the display name over the fallbacks', () => {
    const block = buildAgeReviewIdentityBlock({
      ...base, accountName: 'Some One', accountVineUsername: 'og_user', accountNip05: 'x@y.z',
    });
    expect(block).toContain('Some One');
    expect(block).not.toContain('og_user');
  });

  it('states plainly when no profile was captured', () => {
    // An empty handle must read as a known fact, not as a rendering bug.
    expect(buildAgeReviewIdentityBlock(base)).toContain('no profile captured');
  });

  it('sanitizes an attacker-controlled name so it cannot forge note structure', () => {
    // The account name is chosen by the reported user. sanitizeInline folds
    // newlines to spaces, so the injected text survives as content but can never
    // occupy a line of its own and impersonate a field the note emits.
    const block = buildAgeReviewIdentityBlock({
      ...base, accountName: 'evil\nOrigin ticket 999\nhandle   Divine Support',
    });
    const lines = block.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('Origin ticket 999');
    expect(lines.filter((l) => l.startsWith('handle')).length).toBe(1);
  });

  it('includes the origin ticket and deadline when supplied', () => {
    const block = buildAgeReviewIdentityBlock({ ...base, originTicketId: 4242, deadlineAt: '2026-08-05' });
    expect(block).toContain('4242');
    expect(block).toContain('2026-08-05');
  });

  // A case with no deadline is a real state, not a missing value. Say so, for
  // the same reason an uncaptured handle says so: a silently absent line reads
  // as a rendering fault and invites an agent to go looking for the value.
  it('says the deadline is not set rather than omitting the line', () => {
    expect(buildAgeReviewIdentityBlock(base)).toContain('Deadline not set');
  });
});
