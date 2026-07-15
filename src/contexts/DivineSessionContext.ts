// ABOUTME: Context + types for the divine-login session and resolved moderator
// identity. The provider lives in components/DivineSessionProvider so this
// module exports only the context (react-refresh: no components in context files).
import { createContext } from 'react';
import type { StoredCredentials } from '@divinevideo/login';
import type { NostrSigner } from '@nostrify/nostrify';
import { startLogin as sdkStartLogin } from '@/lib/divineLogin';

export interface DivineSessionValue {
  credentials: StoredCredentials | null;
  /** The moderator's canonical 64-hex pubkey, once resolved. */
  pubkey: string | undefined;
  /** Signer bound to the current session token, or null when signed out. */
  signer: NostrSigner | null;
  /** True until the session (and, with a token, the pubkey) has resolved. */
  isResolving: boolean;
  /**
   * Snapshot the moderator pubkey for an audit write. Captures the signer at
   * call time (call at action START so a later logout/switch can't retarget a
   * long job's attribution) and waits briefly for an in-flight pubkey before
   * falling back to undefined. Never gate a moderation action on this.
   */
  getModeratorPubkey: () => Promise<string | undefined>;
  startLogin: (returnPath?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

// Default value is signed-out so components render logged-out without a
// provider (test ergonomics); the real provider overrides with live state.
export const DivineSessionContext = createContext<DivineSessionValue>({
  credentials: null,
  pubkey: undefined,
  signer: null,
  isResolving: false,
  getModeratorPubkey: async () => undefined,
  startLogin: sdkStartLogin,
  logout: () => {},
  refresh: async () => {},
});
