// ABOUTME: Thin wrapper over the @divinevideo/login SDK (OAuth2 + PKCE against
// login.divine.video). The SDK owns PKCE, token storage, refresh and signing;
// this module only configures the client and exposes the flow relay-admin uses.
import { createDivineClient, type StoredCredentials } from '@divinevideo/login';

export const DIVINE_LOGIN_SERVER_URL =
  import.meta.env.VITE_DIVINE_LOGIN_URL || 'https://login.divine.video';
export const DIVINE_LOGIN_CLIENT_ID = 'divine-relay-admin';

const RETURN_PATH_KEY = 'divine-login:return-path';

function callbackUrl(): string {
  return new URL('/auth/callback', window.location.origin).toString();
}

let client: ReturnType<typeof createDivineClient> | null = null;
function getClient() {
  if (!client) {
    client = createDivineClient({
      serverUrl: DIVINE_LOGIN_SERVER_URL,
      clientId: DIVINE_LOGIN_CLIENT_ID,
      redirectUri: callbackUrl(),
      storage: localStorage,
    });
  }
  return client;
}

/** Begin the OAuth flow: stash where to return, then redirect to the authorize URL. */
export async function startLogin(returnPath?: string): Promise<void> {
  const { url } = await getClient().oauth.getAuthorizationUrl({});
  if (returnPath) localStorage.setItem(RETURN_PATH_KEY, returnPath);
  window.location.assign(url);
}

/** Finish the OAuth flow at the callback. The SDK persists the session to storage. */
export async function completeLogin(callbackHref: string): Promise<{ returnPath: string }> {
  const parsed = getClient().oauth.parseCallback(callbackHref);
  if ('error' in parsed) throw new Error(parsed.description || parsed.error);
  await getClient().oauth.exchangeCode(parsed.code); // verifier is pulled from SDK storage
  const returnPath = localStorage.getItem(RETURN_PATH_KEY) || '/reports';
  localStorage.removeItem(RETURN_PATH_KEY);
  return { returnPath };
}

/** Current session with automatic refresh (SDK-managed). Null when signed out. */
export function getSession(): Promise<StoredCredentials | null> {
  return getClient().oauth.getSessionWithRefresh();
}

/** Clear all session data (SDK-managed). */
export function logout(): void {
  getClient().oauth.logout();
}
