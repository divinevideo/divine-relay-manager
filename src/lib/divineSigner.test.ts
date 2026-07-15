import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcInstance, DivineRpc } = vi.hoisted(() => {
  const rpcInstance = {
    getPublicKey: vi.fn(),
    signEvent: vi.fn(),
    nip04Encrypt: vi.fn(),
    nip04Decrypt: vi.fn(),
    nip44Encrypt: vi.fn(),
    nip44Decrypt: vi.fn(),
  };
  const DivineRpc = vi.fn(() => rpcInstance);
  return { rpcInstance, DivineRpc };
});
vi.mock('@divinevideo/login', () => ({ DivineRpc }));

import { DivineRpcSigner } from './divineSigner';

const PUBKEY = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  rpcInstance.getPublicKey.mockResolvedValue(PUBKEY);
  rpcInstance.signEvent.mockImplementation(async (e: Record<string, unknown>) => ({
    ...e,
    id: 'id',
    sig: 'sig',
  }));
});

describe('DivineRpcSigner', () => {
  it('builds the RPC with the current access token and /api/nostr endpoint', async () => {
    const signer = new DivineRpcSigner(() => 'tok', 'https://login.test');
    await signer.getPublicKey();
    expect(DivineRpc).toHaveBeenCalledWith(
      expect.objectContaining({ nostrApi: 'https://login.test/api/nostr', accessToken: 'tok' }),
    );
  });

  it('caches the public key after the first resolve', async () => {
    const signer = new DivineRpcSigner(() => 'tok');
    await signer.getPublicKey();
    await signer.getPublicKey();
    expect(rpcInstance.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it('throws when there is no access token', async () => {
    const signer = new DivineRpcSigner(() => undefined);
    await expect(signer.getPublicKey()).rejects.toThrow(/no access token/);
  });

  it('signEvent stamps the pubkey and returns the signed event', async () => {
    const signer = new DivineRpcSigner(() => 'tok');
    const signed = await signer.signEvent({ kind: 1, content: 'hi', tags: [], created_at: 5 });
    expect(rpcInstance.signEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 1, content: 'hi', pubkey: PUBKEY }),
    );
    expect(signed).toMatchObject({ id: 'id', sig: 'sig', pubkey: PUBKEY });
  });

  it('delegates nip44 encrypt/decrypt to the RPC', async () => {
    rpcInstance.nip44Encrypt.mockResolvedValue('ct');
    const signer = new DivineRpcSigner(() => 'tok');
    expect(await signer.nip44.encrypt('peer', 'pt')).toBe('ct');
    expect(rpcInstance.nip44Encrypt).toHaveBeenCalledWith('peer', 'pt');
  });
});
