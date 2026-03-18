// ABOUTME: Funnelcake REST API proxy helpers
// ABOUTME: Derives API URL from relay WebSocket URL, proxies fetch requests

/**
 * Derive the Funnelcake REST API base URL from the relay WebSocket URL.
 * Funnelcake API runs on the same host as the relay.
 * Optional explicit override for environments where they diverge.
 */
export function deriveFunnelcakeApiUrl(relayUrl: string, explicitOverride?: string): string {
  if (explicitOverride) return explicitOverride;
  return relayUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/$/, '');
}

/**
 * Proxy a request to Funnelcake's REST API.
 * Forwards the response body and cache headers.
 */
export async function proxyFunnelcakeRequest(
  funnelcakeBaseUrl: string,
  path: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const url = `${funnelcakeBaseUrl}${path}`;
  const upstream = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders,
  };
  const cacheControl = upstream.headers.get('Cache-Control');
  if (cacheControl) {
    responseHeaders['Cache-Control'] = cacheControl;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
