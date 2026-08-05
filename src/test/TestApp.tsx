import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NostrProvider from '@/components/NostrProvider';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import { DivineSessionProvider } from '@/components/DivineSessionProvider';

interface TestAppProps {
  children: React.ReactNode;
}

export function TestApp({ children }: TestAppProps) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // retryDelay: 0 because components that set their own `retry` opt back
      // into React Query's 1000ms default backoff, which pushes error-state
      // assertions past the 1000ms findBy timeout and flakes under CI load.
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false, retryDelay: 0 },
    },
  });

  const defaultConfig: AppConfig = {
    theme: 'light',
    relayUrl: 'wss://relay.nostr.band',
    apiUrl: 'https://api-relay.divine.video',
  };

  return (
    <BrowserRouter>
      <AppProvider storageKey='test-app-config' defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrProvider>
            <DivineSessionProvider>
              {children}
            </DivineSessionProvider>
          </NostrProvider>
        </QueryClientProvider>
      </AppProvider>
    </BrowserRouter>
  );
}

export default TestApp;