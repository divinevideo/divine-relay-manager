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
// element: one with a space is "key value" (an empty value, like 'alt ', still
// counts); a bare one is a key whose value is the next element; an empty one is
// skipped. Keys are lowercased.
function imetaEntries(tag: string[]): Array<[string, string]> {
  const parts = tag.slice(1);
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.trim() === '') continue;
    if (/\s/.test(part)) {
      const [key, ...values] = part.trim().split(/\s+/);
      entries.push([key.toLowerCase(), values.join(' ')]);
    } else {
      entries.push([part.toLowerCase(), parts[i + 1] ?? '']);
      i++;
    }
  }
  return entries;
}

export function extractMediaFiles(content: string, tags: string[][]): MediaFiles {
  const media = new Set<string>();
  const thumbnails = new Set<string>();
  let hasVideo = false;

  hashesIn(content).forEach((hash) => media.add(hash));

  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      const entries = imetaEntries(tag);
      const mime = entries.find(([key]) => key === 'm')?.[1];
      if (mime?.toLowerCase().startsWith('video/')) {
        hasVideo = true;
        for (const [key, value] of entries) {
          if (key === 'url' || key === 'x') hashesIn(value).forEach((hash) => media.add(hash));
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

  // The media server's own {video}.jpg follows the video's status, so it is the
  // video, not a second file.
  return {
    media: Array.from(media),
    thumbnails: Array.from(thumbnails).filter((hash) => !media.has(hash)),
  };
}

export function extractMediaHashes(content: string, tags: string[][]): string[] {
  return extractMediaFiles(content, tags).media;
}
