const SHA256_PATTERN = /\b([a-f0-9]{64})\b/gi;

export function extractMediaHashes(content: string, tags: string[][]): string[] {
  const hashes = new Set<string>();

  const addHashesFromText = (value: string) => {
    let match: RegExpExecArray | null;
    SHA256_PATTERN.lastIndex = 0;
    while ((match = SHA256_PATTERN.exec(value)) !== null) {
      hashes.add(match[1].toLowerCase());
    }
  };

  addHashesFromText(content);

  for (const tag of tags) {
    if (tag[0] === 'imeta') {
      const mime = tag.find((part) => part.toLowerCase().startsWith('m '))?.split(/\s+/)[1];
      if (mime?.toLowerCase().startsWith('video/')) {
        for (const part of tag.slice(1)) {
          const [key, ...values] = part.split(/\s+/);
          if (key === 'url' || key === 'x') {
            addHashesFromText(values.join(' '));
          }
        }
      } else {
        addHashesFromText(tag.join(' '));
      }
      continue;
    }

    if (tag[0] === 'url' || tag[0] === 'x') {
      addHashesFromText(tag.join(' '));
    }

    if (tag[0] === 'x' && tag[1] && /^[a-f0-9]{64}$/i.test(tag[1])) {
      hashes.add(tag[1].toLowerCase());
    }
  }

  return Array.from(hashes);
}
