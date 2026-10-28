// ABOUTME: Keeps self-declared text (app names, nip05 claims) from reordering the words
// ABOUTME: around it. Characters show as written, except paragraph breaks, shown as ¶.

const ISOLATE_OPENERS = new Set(['⁦', '⁧', '⁨']); // LRI, RLI, FSI
const FSI = '⁨';
const PDI = '⁩';

/**
 * Text whose isolate controls are paired, so wrapping it in an isolate (a <bdi>
 * element or FSI ... PDI) holds. Without this, a stray PDI in the text closes
 * the wrapper early and a direction override after it reverses the rest of the
 * line. Nothing is removed: a stray PDI gets an FSI before it, and an isolate
 * the text leaves open gets a PDI after it.
 */
export function balanceIsolates(text: string): string {
  let open = 0;
  let out = '';
  for (const ch of text) {
    if (ISOLATE_OPENERS.has(ch)) open++;
    else if (ch === PDI) {
      if (open === 0) out += FSI;
      else open--;
    }
    out += ch;
  }
  return out + PDI.repeat(open);
}

// Unicode paragraph separators (bidi class B). A paragraph break ends every
// isolate, so an override after one reverses the rest of the line, and none
// belongs in an app name or a nip05.
const PARAGRAPH_BREAKS = new Set(['\n', '\r', '\u001C', '\u001D', '\u001E', '\u0085', '\u2029']);

/**
 * Self-declared text ready to show inside an isolate: each paragraph break is
 * shown as a visible ¶ (so tampering shows rather than hides), then isolate
 * controls are balanced. Every other character is kept as written.
 */
export function displaySafe(text: string): string {
  const marked = Array.from(text, ch => (PARAGRAPH_BREAKS.has(ch) ? '¶' : ch)).join('');
  return balanceIsolates(marked);
}

/** `text` made display-safe and wrapped in FSI ... PDI, for plain-text places such as a hover title. */
export function isolate(text: string): string {
  return `${FSI}${displaySafe(text)}${PDI}`;
}
