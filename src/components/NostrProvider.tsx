import React, { useMemo } from 'react';
import { NostrEvent, NostrFilter, NPool, NRelay1 } from '@nostrify/nostrify';
import { NostrContext } from '@nostrify/react';
import { useAppContext } from '@/hooks/useAppContext';

interface NostrProviderProps {
  children: React.ReactNode;
}

/** Indexer relays queried for profile metadata (kind 0) lookups. */
const PROFILE_INDEXER_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://user.kindpag.es',
];

/** Returns true if every filter in the list is a kind-0 (profile) query. */
function isProfileQuery(filters: NostrFilter[]): boolean {
  return filters.length > 0 && filters.every(
    (f) => f.kinds?.length === 1 && f.kinds[0] === 0,
  );
}

const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;
  const { config } = useAppContext();
  const relayUrl = config.relayUrl;

  // Recreate NPool when relay URL changes
  const pool = useMemo(() => {
    return new NPool({
      open(url: string) {
        return new NRelay1(url);
      },
      reqRouter(filters) {
        // For profile (kind 0) queries, fan out to indexer relays in
        // addition to the configured relay. Many users haven't published
        // their kind 0 to the Divine relay, so we need indexers to find
        // usernames, avatars, and display names for moderation.
        if (isProfileQuery(filters)) {
          const relays = new Set([relayUrl, ...PROFILE_INDEXER_RELAYS]);
          return new Map(
            Array.from(relays).map((url) => [url, filters]),
          );
        }
        return new Map([[relayUrl, filters]]);
      },
      eventRouter(_event: NostrEvent) {
        return [relayUrl];
      },
    });
  }, [relayUrl]);

  return (
    <NostrContext.Provider value={{ nostr: pool }}>
      {children}
    </NostrContext.Provider>
  );
};

export default NostrProvider;