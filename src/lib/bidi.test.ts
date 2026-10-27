import { describe, expect, it } from 'vitest';
import { balanceIsolates, displaySafe, isolate } from './bidi';

const FSI = '⁨';
const PDI = '⁩';
const RLI = '⁧';
const RLO = '‮';

// Every isolate the text opens is closed inside it, and it never closes one it
// didn't open, so wrapping it in an isolate keeps everything after it in place.
function isBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '⁦' || ch === RLI || ch === FSI) depth++;
    else if (ch === PDI && --depth < 0) return false;
  }
  return depth === 0;
}

describe('balanceIsolates', () => {
  it('leaves ordinary text alone', () => {
    expect(balanceIsolates('Example App')).toBe('Example App');
    expect(balanceIsolates(`Evil${RLO}ppa`)).toBe(`Evil${RLO}ppa`);
  });

  it('pairs a stray isolate terminator instead of letting it close the wrapper', () => {
    const out = balanceIsolates(`Evil${PDI}${RLO}ppa`);
    expect(out).toBe(`Evil${FSI}${PDI}${RLO}ppa`);
    expect(isBalanced(out)).toBe(true);
  });

  it('closes an isolate the text leaves open', () => {
    const out = balanceIsolates(`a${RLI}b`);
    expect(out).toBe(`a${RLI}b${PDI}`);
    expect(isBalanced(out)).toBe(true);
  });

  it('keeps every original character, in order', () => {
    const input = `${PDI}x${FSI}${PDI}${PDI}y${RLI}`;
    const out = balanceIsolates(input);
    expect(isBalanced(out)).toBe(true);
    // Removing only the added marks gives the input back.
    let rest = out;
    for (const ch of input) {
      const at = rest.indexOf(ch);
      expect(at).toBeGreaterThanOrEqual(0);
      rest = rest.slice(at + 1);
    }
  });
});

describe('displaySafe', () => {
  // A paragraph break ends every isolate, so an override after one would reverse
  // the rest of the line. None belongs in an app name or a nip05; show it as ¶.
  it.each([
    ['paragraph separator', '\u2029'],
    ['next line', '\u0085'],
    ['file separator', '\u001C'],
    ['group separator', '\u001D'],
    ['record separator', '\u001E'],
    ['line feed', '\n'],
    ['carriage return', '\r'],
  ])('shows a %s as ¶', (_label, ch) => {
    expect(displaySafe(`Evil${ch}${RLO}ppa`)).toBe(`Evil¶${RLO}ppa`);
  });

  // Only paragraph breaks are marked. Everything else stays as written, including
  // characters that look like breaks but don't end a bidi paragraph.
  it.each([
    ['tab', '\t'],
    ['line separator', '\u2028'],
    ['unit separator', '\u001F'],
    ['zero-width space', '\u200B'],
    ['right-to-left mark', '\u200F'],
  ])('leaves a %s as written', (_label, ch) => {
    expect(displaySafe(`a${ch}b`)).toBe(`a${ch}b`);
  });

  it('still balances isolates after marking breaks', () => {
    expect(displaySafe(`a\u2029${PDI}b`)).toBe(`a¶${FSI}${PDI}b`);
  });

  it('is what isolate() wraps', () => {
    expect(isolate(`a\u2029${RLO}b`)).toBe(`${FSI}a¶${RLO}b${PDI}`);
  });
});
