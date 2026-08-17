import { describe, it, expect } from 'vitest';
import { renderMediaPage } from './media-page';

const VALID = 'a'.repeat(64);

describe('renderMediaPage', () => {
  it('embeds the media-proxy URL for the given sha', () => {
    const html = renderMediaPage(VALID);
    expect(html).toContain(`/api/media-proxy/${VALID}`);
  });

  it('shows the sha so a moderator can confirm which blob they are viewing', () => {
    expect(renderMediaPage(VALID)).toContain(VALID);
  });

  it('carries the restricted admin-view banner', () => {
    const html = renderMediaPage(VALID).toLowerCase();
    expect(html).toContain('restricted');
    expect(html).toContain('admin');
  });

  it('is a self-contained document, not an SPA shell (no app bundle, no tab nav)', () => {
    const html = renderMediaPage(VALID);
    expect(html).toMatch(/^<!doctype html>/i);
    // The whole point is to NOT drop the moderator into relay-manager's nav.
    expect(html).not.toContain('/reports');
    expect(html).not.toContain('/age-review');
    expect(html).not.toMatch(/<script[^>]+src=/i); // no external app bundle
  });

  it('refuses a non-hex sha and never reflects it into the page (no XSS)', () => {
    const evil = '"><script>alert(1)</script>';
    const html = renderMediaPage(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain(evil);
    expect(html.toLowerCase()).toContain('invalid');
  });

  it('accepts uppercase hex (relay ids and hashes are case-insensitive)', () => {
    const upper = 'A'.repeat(64);
    expect(renderMediaPage(upper)).toContain(`/api/media-proxy/${upper}`);
  });
});
