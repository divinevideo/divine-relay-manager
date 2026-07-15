// ABOUTME: Current moderator identity, read from the divine-login session
// context (which resolves the pubkey + signer once). CF Access is the access
// gate; this is attribution only.
import { useMemo } from 'react';
import type { NostrSigner } from '@nostrify/nostrify';

import { useDivineSession } from './useDivineSession';
import { useAuthor } from './useAuthor.ts';

export interface CurrentUser {
  pubkey: string;
  signer: NostrSigner;
}

export function useCurrentUser() {
  const { pubkey, signer, getModeratorPubkey } = useDivineSession();

  const user = useMemo<CurrentUser | undefined>(
    () => (pubkey && signer ? { pubkey, signer } : undefined),
    [pubkey, signer],
  );

  const users = useMemo(() => (user ? [user] : []), [user]);

  const author = useAuthor(user?.pubkey);

  return {
    user,
    users,
    ...author.data,
    // Prefer this over user?.pubkey for AUDIT WRITES: it snapshots identity at
    // action start and survives the boot-resolve window and account switches.
    getModeratorPubkey,
  };
}
