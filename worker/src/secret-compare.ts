// ABOUTME: Constant-time comparison for shared secrets (admin API keys, service
// ABOUTME: bearer tokens), so response timing can't reveal how much of a guess matched.

const encoder = new TextEncoder();

// Every byte of the supplied value is compared, with no early exit, and the
// loop runs over the supplied length only, so timing depends on what the caller
// sent and reveals neither how many leading bytes matched nor the secret's
// length. JavaScript gives no hard constant-time guarantee, so this is best
// effort. Workers' crypto.subtle.timingSafeEqual isn't used: it requires equal
// lengths and doesn't exist under Node, where the worker tests run. Hashing both
// values first would also hide length, but makes the auth check wait on async
// crypto, which this doesn't need. An empty expected secret never matches, so an
// unset secret that resolves to '' can't authorize a request that sends ''.
export function secretsMatch(supplied: string, expected: string): boolean {
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);
  if (b.length === 0) return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i % b.length];
  return difference === 0;
}
