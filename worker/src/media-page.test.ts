import { describe, it, expect } from 'vitest';
import { renderMediaPage } from './media-page';

const VALID = 'a'.repeat(64);

describe('renderMediaPage', () => {
  it('embeds the media-proxy URL for the given sha and returns 200', () => {
    const { status, html } = renderMediaPage(VALID);
    expect(status).toBe(200);
    expect(html).toContain(`/api/media-proxy/${VALID}`);
  });

  it('shows the sha so a moderator can confirm which blob they are viewing', () => {
    expect(renderMediaPage(VALID).html).toContain(VALID);
  });

  it('carries the restricted admin-view banner', () => {
    const html = renderMediaPage(VALID).html.toLowerCase();
    expect(html).toContain('restricted');
    expect(html).toContain('admin');
  });

  it('is a self-contained document, not an SPA shell (no app bundle, no tab nav)', () => {
    const { html } = renderMediaPage(VALID);
    expect(html).toMatch(/^<!doctype html>/i);
    // The whole point is to NOT drop the moderator into relay-manager's nav.
    expect(html).not.toContain('/reports');
    expect(html).not.toContain('/age-review');
    expect(html).not.toMatch(/<script[^>]+src=/i); // no external app bundle
  });

  it('refuses a non-hex sha with 400 and never reflects it into the page (no XSS)', () => {
    const evil = '"><script>alert(1)</script>';
    const { status, html } = renderMediaPage(evil);
    expect(status).toBe(400);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain(evil);
    expect(html.toLowerCase()).toContain('invalid');
  });

  it('refuses an empty id with 400', () => {
    expect(renderMediaPage('').status).toBe(400);
  });

  it('normalises uppercase hex to lowercase (the form the proxy and Blossom expect)', () => {
    // relay ids and hashes are case-insensitive; the canonical on-wire form is lowercase.
    const { status, html } = renderMediaPage('A'.repeat(64));
    expect(status).toBe(200);
    expect(html).toContain(`/api/media-proxy/${'a'.repeat(64)}`);
    expect(html).not.toContain('A'.repeat(64));
  });
});
