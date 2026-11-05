import { QueryClient } from '@tanstack/react-query';

// The app's one QueryClient, built here so its defaults can be tested.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        staleTime: 60000, // 1 minute
        gcTime: Infinity,
      },
      // A moderation action reads its target from the screen when it runs, not
      // at the click. In the default 'online' mode a mutation started offline
      // waits and runs on reconnect, by then against whatever report is open,
      // Delete Event and Delete Media included. 'always' runs it at once, so an
      // action clicked offline fails with its usual error instead.
      mutations: {
        networkMode: 'always',
      },
    },
  });
}
