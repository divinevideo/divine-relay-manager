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

  it('does not offer a download for unknown blob types; sends the moderator back to Coop', () => {
    // Writing unknown bytes to the moderator's disk is a CSAM footgun (one-way,
    // NCMEC-bound). The unknown-type branch must show the type, not download it.
    const { html } = renderMediaPage(VALID);
    expect(html).not.toMatch(/\.download\s*=/);
    expect(html).not.toMatch(/createElement\(['"]a['"]\)/);
    expect(html).toContain('Unsupported type (');
  });

  it('suppresses the video controls\' download, PiP, and Cast affordances', () => {
    // The browser\'s default video chrome offers a download menu item and a Cast
    // target; the page\'s own rule is that these bytes are never offered as a
    // download and stay off external displays.
    const { html } = renderMediaPage(VALID);
    expect(html).toContain("controlsList', 'nodownload'");
    expect(html).toContain('disablePictureInPicture');
    expect(html).toContain('disableRemotePlayback');
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

  it('embeds the URL extension as a fallback type hint when given one', () => {
    // Used only when the proxy Content-Type is not image/* or video/*, so an
    // octet-stream blob whose URL says .mp4 still renders instead of showing
    // "Unsupported type" for viewable media.
    const { html } = renderMediaPage(VALID, 'mp4');
    expect(html).toContain('var ext = "mp4"');
  });

  it('embeds an empty hint when the URL has no extension', () => {
    expect(renderMediaPage(VALID).html).toContain('var ext = ""');
  });

  it('drops an extension hint that is not a short alphanumeric token', () => {
    // The hint is interpolated into the document, and JSON.stringify does not
    // escape "<" or "/", so anything that could close the script element (or is
    // merely garbage) must never be embedded. The URL parser blocks such values
    // today; this makes the guarantee independent of the caller.
    const { html } = renderMediaPage(VALID, '</script><script>alert(1)</script>');
    expect(html).toContain('var ext = ""');
    expect(html).not.toContain('</script><script>');
    expect(renderMediaPage(VALID, 'not a token!').html).toContain('var ext = ""');
  });

  it('lowercases the extension hint before embedding it', () => {
    expect(renderMediaPage(VALID, 'MP4').html).toContain('var ext = "mp4"');
  });

  it('builds both video paths through one hardened constructor with decode errors surfaced', () => {
    // Both the content-type branch and the extension-fallback branch must share
    // makeVideo, so a future hardening cannot apply to one and not the other.
    const { html } = renderMediaPage(VALID, 'mp4');
    expect(html).toContain('function makeVideo(');
    expect(html).toContain('could not decode the video');
    expect(html).toContain('could not decode the image');
    // Exactly one constructor for exactly two video call sites.
    expect(html.match(/createElement\('video'\)/g)).toEqual(['createElement(\'video\')']);
    expect(html.match(/= makeVideo\(obj\)/g)?.length).toBe(2);
  });
});
