import { describe, it, expect } from 'vitest';
import { extractMediaFiles, extractMediaHashes } from './media-hashes';

// Full-length 64-char hex hashes, never truncated.
const VIDEO = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
const THUMB = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';
const OTHER_THUMB = 'c3d0f1a2b4e5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9';

describe('extractMediaFiles', () => {
  it('separates a mobile-format video thumbnail from the video', () => {
    // divine-mobile writes NIP-92 "key value" entries (video_imeta_builder.dart).
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
      `image https://media.divine.video/${THUMB}`,
      `x ${VIDEO}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('separates a web-format video thumbnail from the video', () => {
    // divine-web writes alternating key, value elements (publishVideoTags.ts).
    const tags = [[
      'imeta',
      'url', `https://media.divine.video/${VIDEO}`,
      'm', 'video/mp4',
      'image', `https://media.divine.video/${THUMB}`,
      'x', VIDEO,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('takes a thumb entry inside the video imeta as a thumbnail', () => {
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
      `thumb https://media.divine.video/${THUMB}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('takes separate thumb and image tags on a video post as thumbnails', () => {
    const tags = [
      ['imeta', `url https://media.divine.video/${VIDEO}`, 'm video/mp4'],
      ['thumb', `https://media.divine.video/${THUMB}`],
      ['image', `https://media.divine.video/${OTHER_THUMB}`],
    ];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB, OTHER_THUMB] });
  });

  it('ignores separate image and thumb tags when the post has no video', () => {
    // On a list or other non-video event, a top-level image is a cover image, not
    // a video's thumbnail, so the single-post video buttons leave it alone.
    const tags = [
      ['image', `https://media.divine.video/${THUMB}`],
      ['thumb', `https://media.divine.video/${OTHER_THUMB}`],
    ];

    expect(extractMediaFiles('', tags)).toEqual({ media: [], thumbnails: [] });
  });

  it('does not list a server thumbnail of the video twice', () => {
    // The media server derives {video}.jpg from the video itself; it follows the
    // video's status, so it is the video, not a separate file.
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
      `image https://media.divine.video/${VIDEO}.jpg`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [] });
  });

  it('lists a thumbnail named twice only once', () => {
    const tags = [
      ['imeta', `url https://media.divine.video/${VIDEO}`, 'm video/mp4', `image https://media.divine.video/${THUMB}`],
      ['thumb', `https://media.divine.video/${THUMB}`],
    ];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('keeps a video with no thumbnail unchanged', () => {
    const tags = [['imeta', `url https://media.divine.video/${VIDEO}`, 'm video/mp4', `x ${VIDEO}`]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [] });
    expect(extractMediaHashes('', tags)).toEqual([VIDEO]);
  });

  it('keeps extractMediaHashes to the video files, so a thumbnail never comes first', () => {
    // EventDetail's AI-check panels use the first hash, and must get the video.
    const tags = [[
      'imeta',
      `image https://media.divine.video/${THUMB}`,
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
    ]];

    expect(extractMediaHashes('', tags)).toEqual([VIDEO]);
  });

  it('reads a video imeta that mixes a bare key with key value entries', () => {
    // Read element by element: one bare entry must not flip the whole tag to the
    // alternating reading and hide that it is a video.
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
      'alt', 'A skateboard trick',
      `image https://media.divine.video/${THUMB}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('never pairs two "key value" entries, so a thumbnail before the mime entry stays a thumbnail', () => {
    // A "key value" entry has a space; only a bare key takes the next element as
    // its value. Paired anyway, 'image …' would be read as the url's value and
    // the thumbnail would join the video files.
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      `image https://media.divine.video/${THUMB}`,
      'm video/mp4',
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('reads keys and the mime type in any case, in both formats', () => {
    const mobile = [['imeta', `URL https://media.divine.video/${VIDEO}`, 'm Video/MP4', `Image https://media.divine.video/${THUMB}`]];
    const web = [['imeta', 'URL', `https://media.divine.video/${VIDEO}`, 'M', 'video/MP4', 'IMAGE', `https://media.divine.video/${THUMB}`]];

    expect(extractMediaFiles('', mobile)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
    expect(extractMediaFiles('', web)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('reads past an empty entry and a key with an empty value', () => {
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'alt ',
      'm video/mp4',
      '',
      `image https://media.divine.video/${THUMB}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('does not let a bare key with no value swallow the mime entry', () => {
    // Read as alternating, 'blurhash' would take 'm video/mp4' as its value, the
    // tag would not read as a video, and the thumbnail would join the video files.
    const tags = [[
      'imeta',
      `url https://media.divine.video/${VIDEO}`,
      'blurhash',
      'm video/mp4',
      `image https://media.divine.video/${THUMB}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('does not let a bare key with no value swallow the video url', () => {
    const tags = [[
      'imeta',
      'blurhash',
      `url https://media.divine.video/${VIDEO}`,
      'm video/mp4',
      `image https://media.divine.video/${THUMB}`,
    ]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('reads the mime key in any case', () => {
    const tags = [['imeta', `url https://media.divine.video/${VIDEO}`, 'M video/mp4', `image https://media.divine.video/${THUMB}`]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [THUMB] });
  });

  it('keeps every hash of a web-format non-video imeta in the media list, as before', () => {
    const tags = [['imeta', 'url', `https://media.divine.video/${VIDEO}`, 'm', 'image/jpeg', 'x', VIDEO]];

    expect(extractMediaFiles('', tags)).toEqual({ media: [VIDEO], thumbnails: [] });
  });
});
