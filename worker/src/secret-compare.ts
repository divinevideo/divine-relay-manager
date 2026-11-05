// ABOUTME: Constant-time comparison for shared secrets (admin API keys, service bearer
// ABOUTME: tokens, Zendesk webhook keys and signatures), so timing can't reveal how much of a guess matched.

const encoder = new TextEncoder();

// Every byte of the supplied value is compared, with no early exit, and the
// loop runs over the supplied length only. So how long a guess takes doesn't
// depend on how many of its leading bytes matched, or on its length relative
// to the secret. Encoding the secret costs the same for every guess, so it
// gives nothing to measure. JavaScript gives no hard constant-time guarantee,
// so this is best effort. Workers' crypto.subtle.timingSafeEqual isn't used: it
// requires equal lengths and doesn't exist under Node, where the worker tests
// run. Hashing both values first would also work, but makes the auth check wait
// on async crypto, which this doesn't need.
//
// Only two non-empty strings can match. An unset secret that resolves to ''
// can't authorize a request that sends '', and a value that isn't a string,
// such as an unresolved Secrets Store binding, can't match its stringified form
// ('[object Object]'), which TextEncoder would otherwise produce.
export function secretsMatch(supplied: string, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i % b.length];
  return difference === 0;
}
