import { describe, it, expect } from 'vitest';
import { deriveContentVisibility } from './contentVisibility';
import type { AccountStatusResponse } from './adminApi';

const active: AccountStatusResponse = { success: true, status: 'active' };
const suspended: AccountStatusResponse = { success: true, status: 'suspended' };
const banned: AccountStatusResponse = { success: true, status: 'banned' };

const base = { postCount: 0, contentLoading: false, contentError: false, accountStatus: active };

describe('deriveContentVisibility', () => {
  it('loading while the content read is in flight', () => {
    expect(deriveContentVisibility({ ...base, postCount: undefined, contentLoading: true }).state).toBe('loading');
  });

  it('has_content when there is visible content', () => {
    expect(deriveContentVisibility({ ...base, postCount: 3 }).state).toBe('has_content');
  });

  it('suspended → hidden by suspension (verified, reversible)', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: suspended });
    expect(r.state).toBe('suspended');
    expect(r.message.toLowerCase()).toContain('suspension');
  });

  it('banned → content removed', () => {
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

  it('absent (confirmed empty, not suspended) is stated as such, not blamed on suspension', () => {
    const r = deriveContentVisibility({ ...base, postCount: 0, accountStatus: active });
    expect(r.state).toBe('absent');
    expect(r.message.toLowerCase()).toContain('not attributable to suspension');
  });

  it('a confirmed suspended state wins over a content-read error (we know it is hidden)', () => {
    expect(deriveContentVisibility({ ...base, postCount: 0, contentError: true, accountStatus: suspended }).state).toBe('suspended');
  });

  it('unknown account status + read error → error (do not claim suspension we cannot confirm)', () => {
    const r = deriveContentVisibility({ ...base, postCount: undefined, contentError: true, accountStatus: undefined });
    expect(r.state).toBe('error');
  });
});
