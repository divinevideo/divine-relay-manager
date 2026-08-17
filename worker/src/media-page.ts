// A minimal, self-contained page for viewing a single piece of restricted media,
// linked from a Coop review card. It deliberately does NOT load the relay-manager
// SPA or its tab navigation: a moderator arrives to check one blob before acting
// in Coop, not to browse relay-manager.
//
// Security: this page and the /api/media-proxy call it makes are both gated by
// CF Access (the whole worker host redirects to Cloudflare Access) and by the
// worker's verifyAdminAccess. The media bytes are streamed through the admin
// bypass, so the page is only ever served to an authenticated moderator.

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Render the standalone media-viewer HTML for a content hash.
 *
 * `sha256` is validated here rather than trusted: a non-hex value returns an
 * error page and is never reflected into the document, so a crafted id cannot
 * inject markup. A valid hash is safe to interpolate because it is hex only.
 */
export function renderMediaPage(sha256: string): string {
  if (!HEX64.test(sha256.toLowerCase())) {
    return [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="robots" content="noindex, nofollow">',
      '<title>Media viewer</title></head>',
      '<body style="font-family:system-ui,sans-serif;padding:16px">',
      '<p>Invalid content id.</p>',
      '</body></html>',
    ].join('\n');
  }

  const proxy = `/api/media-proxy/${sha256}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Restricted media, admin view</title>
<style>
  body { margin:0; font-family:system-ui,sans-serif; background:#111; color:#eee; }
  .banner { background:#7a1f1f; color:#fff; padding:8px 12px; font-size:14px; line-height:1.4; }
  .sha { font-family:ui-monospace,monospace; font-size:12px; color:#9aa; padding:6px 12px; word-break:break-all; }
  .stage { display:flex; align-items:center; justify-content:center; padding:16px; min-height:40vh; }
  .stage video, .stage img { max-width:100%; max-height:80vh; }
  .status { color:#f88; }
</style>
</head>
<body>
<div class="banner">Restricted content, admin view. Shown here because moderation has hidden it from the public. Check it, then act in Coop.</div>
<div class="sha">sha256: ${sha256}</div>
<div class="stage" id="stage"><p class="status" id="status">Loading media...</p></div>
<script>
(function () {
  var url = ${JSON.stringify(proxy)};
  var stage = document.getElementById('stage');
  var status = document.getElementById('status');
  fetch(url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }).then(function (b) {
    var obj = URL.createObjectURL(b);
    var el;
    if (b.type.indexOf('video') === 0) {
      el = document.createElement('video');
      el.controls = true; el.src = obj;
    } else if (b.type.indexOf('image') === 0) {
      el = document.createElement('img'); el.src = obj;
    } else {
      el = document.createElement('a');
      el.href = obj; el.download = ${JSON.stringify(sha256)};
      el.textContent = 'Download (' + (b.type || 'unknown type') + ')';
      el.style.color = '#8cf';
    }
    stage.innerHTML = ''; stage.appendChild(el);
  }).catch(function (e) {
    status.textContent = 'Could not load media: ' + e.message;
  });
})();
</script>
</body>
</html>`;
}
