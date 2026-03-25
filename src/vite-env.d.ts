/// <reference types="vite/client" />

// Environment variables (see .env.example for documentation)
interface ImportMetaEnv {
  readonly VITE_PROD_RELAY_URL?: string;
  readonly VITE_PROD_API_URL?: string;
  readonly VITE_STAGING_RELAY_URL?: string;
  readonly VITE_STAGING_API_URL?: string;
  readonly VITE_LEGACY_RELAY_URL?: string;
  readonly VITE_LEGACY_API_URL?: string;
  readonly VITE_CF_ACCESS_CLIENT_ID?: string;
  readonly VITE_CF_ACCESS_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// NIP-07 window.nostr signer interface
// Uses NostrEvent from @nostrify/nostrify — do not redeclare here
interface Nip07Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: Nip07Signer;
  }
}
