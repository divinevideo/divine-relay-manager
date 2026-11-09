const SHA256_PATTERN = /\b([a-f0-9]{64})\b/gi;

// A video's thumbnail is moderated alongside it, but kept apart from it: #66
// dropped thumbnails because one the media server had no record of failed the
// whole Age Restrict. Callers act on `media` first, and a thumbnail failure never
// fails the action.
export interface MediaFiles {
  media: string[];
  thumbnails: string[];
}

const THUMBNAIL_KEYS = new Set(['image', 'thumb']);

function hashesIn(value: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  SHA256_PATTERN.lastIndex = 0;
  while ((match = SHA256_PATTERN.exec(value)) !== null) {
    found.push(match[1].toLowerCase());
  }
  return found;
}

// imeta comes in two shapes: NIP-92 "key value" entries (divine-mobile), and
// alternating key, value elements (divine-web's publishVideoTags). Read both, so
// a web post's thumbnail is told apart from its video the same way. Element by
// element: each is read as "key value" (an empty value, like 'alt ', still
// counts), and a bare one is also read as a key whose value is the next element.
// Reading a bare one both ways keeps a key with no value, such as a lone
// 'blurhash' among "key value" entries, from swallowing the entry after it. An
// empty element is skipped. Keys are lowercased.
function imetaEntries(tag: string[]): Array<[string, string]> {
  const parts = tag.slice(1);
  const entries: Array<[string, string]> = [];
  parts.forEach((part, i) => {
    if (part.trim() === '') return;
    const [key, ...values] = part.trim().split(/\s+/);
    entries.push([key.toLowerCase(), values.join(' ')]);
    if (!/\s/.test(part) && i + 1 < parts.length) entries.push([key.toLowerCase(), parts[i + 1]]);
  });
  return entries;
}

export function extractMediaFiles(content: string, tags: string[][]): MediaFiles {
  const media = new Set<string>();
  const thumbnails = new Set<string>();
  // The url and x of a video imeta: the video itself, whatever else names it.
  const videoFiles = new Set<string>();
  let hasVideo = false;

  // Read last: a link in the content to a file the tags name as a thumbnail
  // does not make it a second video.
  const fromContent = hashesIn(content);

  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      const entries = imetaEntries(tag);
      if (entries.some(([key, value]) => key === 'm' && value.toLowerCase().startsWith('video/'))) {
        hasVideo = true;
        for (const [key, value] of entries) {
          if (key === 'url' || key === 'x') hashesIn(value).forEach((hash) => { media.add(hash); videoFiles.add(hash); });
          else if (THUMBNAIL_KEYS.has(key)) hashesIn(value).forEach((hash) => thumbnails.add(hash));
        }
      } else {
        hashesIn(tag.join(' ')).forEach((hash) => media.add(hash));
      }
      continue;
    }

    if (tag[0] === 'url' || tag[0] === 'x') {
      hashesIn(tag.join(' ')).forEach((hash) => media.add(hash));
    }
  }

  // Both apps also read a video's thumbnail from separate image/thumb tags. Only
  // on a video post: elsewhere, such as a list, an image tag is a cover image.
  if (hasVideo) {
    for (const tag of tags) {
      if (THUMBNAIL_KEYS.has(tag[0]) && tag[1]) hashesIn(tag[1]).forEach((hash) => thumbnails.add(hash));
    }
  }

  // A file the tags name as a video's thumbnail stays one wherever else it is
  // named, in the content or another imeta: read as media, Unblock Media and
  // Remove Restriction would lift it with the video. The exception is the video
  // itself: the media server's own {video}.jpg follows the video's status, so it
  // is the video, not a second file.
  const tagThumbnails = Array.from(thumbnails).filter((hash) => !videoFiles.has(hash));
  return {
    media: Array.from(new Set([...fromContent, ...media])).filter((hash) => !tagThumbnails.includes(hash)),
    thumbnails: tagThumbnails,
  };
}

export function extractMediaHashes(content: string, tags: string[][]): string[] {
  return extractMediaFiles(content, tags).media;
}
