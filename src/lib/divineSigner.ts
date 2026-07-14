// ABOUTME: Thin NostrSigner adapter over the @divinevideo/login DivineRpc REST
// signer, so a divine-login session plugs into @nostrify's signer abstraction.
// TODO(#178): replace with @divinevideo/divine-signer when it is published --
// that package will be the maintained nostrify adapter. This is the only
// divine-login glue we own; keep it thin and lean on the SDK for session/refresh.
import { DivineRpc, type UnsignedEvent } from '@divinevideo/login';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { DIVINE_LOGIN_SERVER_URL } from './divineLogin';

export class DivineRpcSigner implements NostrSigner {
  private cachedPubkey: string | null = null;

  constructor(
    private readonly getAccessToken: () => string | undefined,
    private readonly serverUrl: string = DIVINE_LOGIN_SERVER_URL,
    private readonly timeoutMs = 10_000,
  ) {}

  private readonly fetchWithTimeout: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  private rpc(): DivineRpc {
    const token = this.getAccessToken();
    if (!token) throw new Error('divine-login: no access token');
    return new DivineRpc({
      nostrApi: `${this.serverUrl}/api/nostr`,
      accessToken: token,
      fetch: this.fetchWithTimeout,
    });
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const pubkey = await this.rpc().getPublicKey();
    this.cachedPubkey = pubkey;
    return pubkey;
  }

  async signEvent(event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();
    const unsigned: UnsignedEvent = { ...event, pubkey };
    const signed = await this.rpc().signEvent(unsigned);
    return signed as NostrEvent;
  }

  async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    return {};
  }

  readonly nip04 = {
    encrypt: (pubkey: string, plaintext: string) => this.rpc().nip04Encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.rpc().nip04Decrypt(pubkey, ciphertext),
  };

  readonly nip44 = {
    encrypt: (pubkey: string, plaintext: string) => this.rpc().nip44Encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.rpc().nip44Decrypt(pubkey, ciphertext),
  };
}
