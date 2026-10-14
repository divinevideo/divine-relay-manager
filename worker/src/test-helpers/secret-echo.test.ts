// ABOUTME: Self-tests for the secret-echo test helper
// ABOUTME: Proves it finds a secret wherever a log argument can carry one

import { describe, expect, it } from 'vitest';
import { echoedFragments } from './secret-echo';

const SECRET = 'synthetic-secret-value-for-helper-tests';

function urlError(): Error {
  return new TypeError(`Invalid URL: ${SECRET}`);
}

describe('echoedFragments', () => {
  it('finds nothing when the secret is absent', () => {
    const absent = [
      'plain text',
      new Error('generic'),
      { a: [1, 'b'] },
      new Headers({ 'X-Other': 'unrelated' }),
      new Map([['k', 'v']]),
      new Set(['s']),
    ];
    expect(echoedFragments(absent, SECRET)).toEqual([]);
  });

  it('finds the secret in a string and in an Error message', () => {
    expect(echoedFragments([`x ${SECRET}`], SECRET)).not.toEqual([]);
    expect(echoedFragments([urlError()], SECRET)).not.toEqual([]);
  });

  it('finds the secret only in an Error message', () => {
    const error = urlError();
    error.stack = 'TypeError: generic';
    expect(echoedFragments([error], SECRET)).not.toEqual([]);
  });

  it('finds the secret only in an Error stack', () => {
    const error = new Error('generic');
    error.stack = `Error: generic\n    at ${SECRET}`;
    expect(echoedFragments([error], SECRET)).not.toEqual([]);
  });

  it('finds a numeric secret passed as a number', () => {
    expect(echoedFragments([12345678901234], '12345678901234')).not.toEqual([]);
  });

  // Function.prototype's caller and arguments getters throw; the helper skips them.
  it('walks a function value without throwing', () => {
    expect(echoedFragments([() => {}], SECRET)).toEqual([]);
  });

  // The shape of console.error(message, { error }).
  it('finds the secret in an Error nested in a plain object', () => {
    expect(echoedFragments(['[test] send failed:', { error: urlError() }], SECRET)).not.toEqual([]);
  });

  it('finds the secret in an Error nested in an array', () => {
    expect(echoedFragments([[urlError()]], SECRET)).not.toEqual([]);
  });

  it("finds the secret in an Error's own enumerable property", () => {
    const error = Object.assign(new TypeError('Invalid URL'), { input: SECRET });
    expect(echoedFragments([error], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a cause that is a plain object', () => {
    const error = new TypeError('Invalid URL', { cause: { input: SECRET } });
    expect(echoedFragments([error], SECRET)).not.toEqual([]);
  });

  it('finds the secret used as a plain object key', () => {
    expect(echoedFragments([{ [SECRET]: true }], SECRET)).not.toEqual([]);
  });

  // The shape of console.log(message, request.headers).
  it('finds the secret in a Headers value', () => {
    expect(echoedFragments([new Headers({ 'X-Webhook-Key': SECRET })], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a Map value and in a Map key', () => {
    expect(echoedFragments([new Map([['key', SECRET]])], SECRET)).not.toEqual([]);
    expect(echoedFragments([new Map([[SECRET, 'value']])], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a Set', () => {
    expect(echoedFragments([new Set([SECRET])], SECRET)).not.toEqual([]);
  });

  // The shape of console.log(message, request).
  it('finds the secret in a Request header', () => {
    const request = new Request('https://example.test/', { headers: { 'X-Webhook-Key': SECRET } });
    expect(echoedFragments([request], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a Request URL', () => {
    expect(echoedFragments([new Request(`https://example.test/${SECRET}`)], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a Response header', () => {
    const response = new Response(null, { headers: { 'X-Token': SECRET } });
    expect(echoedFragments([response], SECRET)).not.toEqual([]);
  });

  it('finds the secret in a URL', () => {
    expect(echoedFragments([new URL(`https://example.test/${SECRET}`)], SECRET)).not.toEqual([]);
  });

  it("finds the secret in an AggregateError's errors", () => {
    expect(echoedFragments([new AggregateError([urlError()])], SECRET)).not.toEqual([]);
  });

  it('finds nothing in a Request, Response or URL without the secret', () => {
    const clean = [
      new Request('https://example.test/path', { headers: { 'X-Other': 'unrelated' } }),
      new Response(null, { headers: { 'X-Other': 'unrelated' } }),
      new URL('https://example.test/path'),
      new AggregateError([new Error('generic')]),
    ];
    expect(echoedFragments(clean, SECRET)).toEqual([]);
  });

  it('terminates on cyclic values', () => {
    const cyclic: Record<string, unknown> = { note: 'no secret here' };
    cyclic.self = cyclic;
    const error = new Error('generic') as Error & { self?: unknown };
    error.self = error;
    const map = new Map<string, unknown>();
    map.set('self', map);
    expect(echoedFragments([cyclic, error, map], SECRET)).toEqual([]);

    cyclic.inner = { value: SECRET };
    expect(echoedFragments([cyclic], SECRET)).not.toEqual([]);
  });
});
