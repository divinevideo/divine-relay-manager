import { describe, it, expect } from 'vitest';
import { deriveContentVisibility } from './contentVisibility';
import type { AccountStatusResponse } from './adminApi';

const active: AccountStatusResponse = { success: true, status: 'active' };
const suspended: AccountStatusResponse = { success: true, status: 'suspended' };
const banned: AccountStatusResponse = { success: true, status: 'banned' };
const statusUnavailable: AccountStatusResponse = { success: false };

// Account status resolved successfully by default, so the absent-vs-unknown
// distinction is only exercised when a test opts into it.
const base = {
  postCount: 0,
  contentLoading: false,
  contentError: false,
  accountStatus: active,
  accountStatusLoading: false,
  accountStatusFailed: false,
};

describe('deriveContentVisibility', () => {
  it('loading while the content read is in flight', () => {
    expect(deriveContentVisibility({ ...base, postCount: undefined, contentLoading: true }).state).toBe('loading');
  });

  it('has_content when there is visible content', () => {
    expect(deriveContentVisibility({ ...base, postCount: 3 }).state).toBe('has_content');
  });

  it('suspended means hidden by suspension (verified, reversible)', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: suspended });
    expect(r.state).toBe('suspended');
    expect(r.message.toLowerCase()).toContain('suspension');
  });

  it('banned means content removed', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: banned });
    expect(r.state).toBe('banned');
    expect(r.message.toLowerCase()).toContain('banned');
  });

  it('error (non-suspended) surfaces the failure, never masked as absent', () => {
    const r = deriveContentVisibility({ ...base, postCount: undefined, contentError: true, accountStatus: active });
    expect(r.state).toBe('error');
    expect(r.state).not.toBe('absent');
    expect(r.message.toLowerCase()).toContain("couldn't load");
  });

  it('a truncated read is an error, not an absence', () => {
    // NPool.query resolves partial results rather than throwing, so a cut-short
    // read looks exactly like an empty one except for this flag.
    const r = deriveContentVisibility({ ...base, postCount: 0, contentIncomplete: true });
    expect(r.state).toBe('error');
    expect(r.state).not.toBe('absent');
  });

  it('absent only when the read was clean and the account is known not suspended', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: active });
    expect(r.state).toBe('absent');
    expect(r.message.toLowerCase()).toContain('not suspended');
  });

  it('a confirmed suspended state wins over a content-read error (we know it is hidden)', () => {
    expect(deriveContentVisibility({ ...base, postCount: 0, contentError: true, accountStatus: suspended }).state).toBe('suspended');
  });

  it('unknown account status + read error means error (do not claim suspension we cannot confirm)', () => {
    const r = deriveContentVisibility({ ...base, postCount: undefined, contentError: true, accountStatus: undefined });
    expect(r.state).toBe('error');
  });

  it('does not rule out suspension when the status read failed', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: statusUnavailable, accountStatusFailed: true });
    expect(r.state).toBe('unknown');
    expect(r.state).not.toBe('absent');
    expect(r.message.toLowerCase()).toContain('cannot be ruled out');
  });

  it('does not rule out suspension while the status read is still in flight', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: undefined, accountStatusLoading: true });
    expect(r.state).toBe('unknown');
    expect(r.state).not.toBe('absent');
  });

  it('does not rule out suspension when keycast answered without a status', () => {
    // A keycast blip resolves to success:false, which is not evidence of anything.
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: statusUnavailable });
    expect(r.state).toBe('unknown');
  });
});
