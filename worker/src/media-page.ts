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

const ERROR_PAGE = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="robots" content="noindex, nofollow">',
  '<title>Media viewer</title></head>',
  '<body style="font-family:system-ui,sans-serif;padding:16px">',
  '<p>Invalid content id.</p>',
  '</body></html>',
].join('\n');

/**
 * Render the standalone media-viewer page for a content hash.
 *
 * Returns the HTTP status alongside the HTML so a single validity check drives
 * both: the route never has to re-decide whether the sha is valid, so the two
 * cannot drift out of agreement. The sha is normalised to lowercase once and,
 * with the strictly-validated extension hint, is the only value interpolated
 * into the document, so a crafted id cannot inject markup (a non-hex value
 * returns the static error page and is never reflected; a non-alphanumeric
 * extension hint is dropped, since JSON.stringify does not escape "<" or "/").
 */
export function renderMediaPage(sha256: string, extHint?: string): { status: number; html: string } {
  const id = sha256.toLowerCase();
  if (!HEX64.test(id)) {
    return { status: 400, html: ERROR_PAGE };
  }

  const proxy = `/api/media-proxy/${id}`;
  // Optional extension from the /media/<sha>.<ext> URL, used only when the
  // proxy's Content-Type is not an image/* or video/* (e.g. octet-stream).
  // Lists mirror the SPA's MediaPreview URL-hint lists. Strictly validated
  // because it is interpolated into the document: JSON.stringify escapes
  // quotes but not "<" or "/", so only a short alphanumeric token may pass.
  const rawExt = (extHint || '').toLowerCase();
  const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : '';
  const html = `<!doctype html>
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
<div class="sha">sha256: ${id}</div>
<div class="stage" id="stage"><p class="status" id="status">Loading media...</p></div>
<script>
(function () {
  var url = ${JSON.stringify(proxy)};
  var ext = ${JSON.stringify(ext)};
  var VIDEO_EXTS = ${JSON.stringify(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'])};
  var IMAGE_EXTS = ${JSON.stringify(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])};
  var stage = document.getElementById('stage');
  function fail(message) {
    // Rebuild from the stage so an error still shows even if it is thrown after
    // the loading placeholder has been cleared (a detached node swallows writes).
    stage.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'status';
    p.textContent = 'Could not load media: ' + message;
    stage.appendChild(p);
  }
  function makeVideo(obj) {
    var el = document.createElement('video');
    el.controls = true; el.src = obj;
    // The unknown-type branch refuses downloads; keep the video branch from
    // re-offering one through browser chrome, and keep restricted media off
    // Cast/external displays and Picture-in-Picture. (Right-click save remains
    // possible; this narrows the offered paths, it does not close them.)
    el.setAttribute('controlsList', 'nodownload');
    el.disablePictureInPicture = true;
    el.disableRemotePlayback = true;
    el.onerror = function () { fail('could not decode the video'); };
    return el;
  }
  fetch(url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }).then(function (b) {
    var obj = URL.createObjectURL(b);
    // The blob URL must outlive playback (video seeks re-read it), so release it
    // on unload rather than on load.
    window.addEventListener('pagehide', function () {
      try { URL.revokeObjectURL(obj); } catch (e) { /* already gone */ }
    });
    var el;
    if (b.type.indexOf('video') === 0) {
      el = makeVideo(obj);
    } else if (b.type.indexOf('image') === 0) {
      el = document.createElement('img'); el.src = obj;
      el.onerror = function () { fail('could not decode the image'); };
    } else if (ext && VIDEO_EXTS.indexOf(ext) !== -1) {
      // The proxy stored the blob's type as something unhelpful (octet-stream
      // and the like); the URL extension says it is still viewable media.
      el = makeVideo(obj);
    } else if (ext && IMAGE_EXTS.indexOf(ext) !== -1) {
      el = document.createElement('img'); el.src = obj;
      el.onerror = function () { fail('could not decode the image'); };
    } else {
      // Never write unknown bytes to the moderator's disk: this may be CSAM, which
      // is one-way and NCMEC-bound. Show the type and send them back to Coop rather
      // than offering a download.
      el = document.createElement('p');
      el.className = 'status';
      el.textContent = 'Unsupported type (' + (b.type || 'unknown') + '). Act in Coop.';
    }
    stage.innerHTML = ''; stage.appendChild(el);
  }).catch(function (e) {
    fail(e.message);
  });
})();
</script>
</body>
</html>`;
  return { status: 200, html };
}
