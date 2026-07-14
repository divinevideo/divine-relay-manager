// ABOUTME: Current moderator identity, sourced from the divine-login session.
// Builds a DivineRpcSigner from the session token and resolves the pubkey via
// the login RPC. CF Access is the access gate; this is attribution only.
import { useEffect, useMemo, useState } from 'react';
import type { NostrSigner } from '@nostrify/nostrify';

import { useDivineSession } from './useDivineSession';
import { DivineRpcSigner } from '@/lib/divineSigner';
import { useAuthor } from './useAuthor.ts';

const HEX_64 = /^[0-9a-f]{64}$/;

export interface CurrentUser {
  pubkey: string;
  signer: NostrSigner;
}

export function useCurrentUser() {
  const { credentials } = useDivineSession();
  const accessToken = credentials?.accessToken;

  // A new signer per token is correct: token rotation on refresh resets the
  // pubkey cache. Refreshes are infrequent (near expiry) so the re-resolve cost
  // is negligible.
  const signer = useMemo(
    () => (accessToken ? new DivineRpcSigner(() => accessToken) : null),
    [accessToken],
  );

  const [pubkey, setPubkey] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setPubkey(undefined);
      return;
    }
    signer
      .getPublicKey()
      // Keep the prior pubkey on a re-resolve (token refresh) to avoid flapping
      // logged-in -> out -> in. The worker rejects non-canonical pubkeys, so we
      // only accept lowercase 64-hex.
      .then((pk) => {
        if (!cancelled) setPubkey((prev) => (HEX_64.test(pk) ? pk : prev));
      })
      .catch(() => {
        /* attribution degrades to null; never block on identity */
      });
    return () => {
      cancelled = true;
    };
  }, [signer]);

  const user = useMemo<CurrentUser | undefined>(
    () => (signer && pubkey ? { pubkey, signer } : undefined),
    [signer, pubkey],
  );

  const users = useMemo(() => (user ? [user] : []), [user]);

  const author = useAuthor(user?.pubkey);

  return {
    user,
    users,
    ...author.data,
  };
}
