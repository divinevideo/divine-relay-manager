import { describe, it, expect } from 'vitest';
import { deriveFunnelcakeApiUrl, proxyFunnelcakeRequest } from './funnelcake-proxy';

describe('deriveFunnelcakeApiUrl', () => {
  it('converts wss relay URL to https API URL', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video'))
      .toBe('https://relay.divine.video');
  });

  it('converts ws to http (local dev)', () => {
    expect(deriveFunnelcakeApiUrl('ws://localhost:4444'))
      .toBe('http://localhost:4444');
  });

  it('uses explicit override when provided', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video', 'https://custom-api.example.com'))
      .toBe('https://custom-api.example.com');
  });

  it('strips trailing slash from relay URL', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video/'))
      .toBe('https://relay.divine.video');
  });
});

describe('proxyFunnelcakeRequest', () => {
  it('proxies a successful response with cache headers', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://relay.divine.video/api/event/abc123') {
        return new Response(JSON.stringify({ id: 'abc123', kind: 1 }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    try {
      const response = await proxyFunnelcakeRequest(
        'https://relay.divine.video',
        '/api/event/abc123',
        { 'Access-Control-Allow-Origin': '*' },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      const body = await response.json() as { id: string };
      expect(body.id).toBe('abc123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards 404 status from upstream', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'Event not found' }), {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    };

    try {
      const response = await proxyFunnelcakeRequest(
        'https://relay.divine.video',
        '/api/event/nonexistent',
        {},
      );
      expect(response.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
