// ABOUTME: Thin NostrSigner adapter over the @divinevideo/login DivineRpc REST
// signer, so a divine-login session plugs into @nostrify's signer abstraction.
// TODO(#178): replace with @divinevideo/divine-signer when it is published --
// that package will be the maintained nostrify adapter. This is the only
// divine-login glue we own; keep it thin and lean on the SDK for session/refresh.
//
// Known phase-1 limitation: DivineRpc is built without an onUnauthorized hook, so
// if the access token expires mid-session (a long focused session that never
// blurs) a signEvent/getPublicKey returns 401 rather than auto-refreshing. The
// session provider refreshes on mount and window focus, which covers the common
// case; signing here is only used for the moderator's own profile edits, not for
// attribution (which needs the pubkey only). Server-side token verification in
// phase 2 is where refresh-on-expiry becomes worth wiring.
import { DivineRpc, type UnsignedEvent } from '@divinevideo/login';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { DIVINE_LOGIN_SERVER_URL } from './divineLogin';

export class DivineRpcSigner implements NostrSigner {
  private cachedPubkey: string | null = null;

  constructor(
    private readonly getAccessToken: () => string | undefined,
    private readonly serverUrl: string = DIVINE_LOGIN_SERVER_URL,
  ) {}

  private rpc(): DivineRpc {
    const token = this.getAccessToken();
    if (!token) throw new Error('divine-login: no access token');
    // No custom fetch: DivineRpc.call already wraps each request in
    // AbortSignal.timeout, which covers headers AND body. An earlier hand-rolled
    // AbortController here cleared its timer once headers arrived, leaving a
    // stalled body read to hang forever -- rely on the SDK's timeout instead.
    return new DivineRpc({
      nostrApi: `${this.serverUrl}/api/nostr`,
      accessToken: token,
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
