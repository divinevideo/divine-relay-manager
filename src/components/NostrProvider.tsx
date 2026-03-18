import React, { useMemo } from 'react';
import { NostrEvent, NPool, NRelay1 } from '@nostrify/nostrify';
import { NostrContext } from '@nostrify/react';
import { useAppContext } from '@/hooks/useAppContext';

interface NostrProviderProps {
  children: React.ReactNode;
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