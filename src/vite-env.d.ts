/// <reference types="vite/client" />

// Environment variables (see .env.example for documentation)
interface ImportMetaEnv {
  readonly VITE_PROD_RELAY_URL?: string;
  readonly VITE_PROD_API_URL?: string;
  readonly VITE_STAGING_RELAY_URL?: string;
  readonly VITE_STAGING_API_URL?: string;
  readonly VITE_LEGACY_RELAY_URL?: string;
  readonly VITE_LEGACY_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// NIP-07 window.nostr interface
interface NostrEvent {
  id?: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey?: string;
  sig?: string;
}

interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: NostrEvent): Promise<NostrEvent>;
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
    nostr?: NostrSigner;
  }
}
