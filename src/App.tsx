// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { Suspense } from 'react';
import NostrProvider from '@/components/NostrProvider'
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import AppRouter from './AppRouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 60000, // 1 minute
      gcTime: Infinity,
    },
  },
});

const defaultConfig: AppConfig = {
  theme: "light",
  relayUrl: import.meta.env.VITE_RELAY_URL || import.meta.env.VITE_PROD_RELAY_URL || "wss://relay.divine.video",
  apiUrl: import.meta.env.VITE_WORKER_URL || import.meta.env.VITE_PROD_API_URL || "https://api-relay-prod.divine.video",
};

export function App() {
  return (
    <AppProvider storageKey="nostr:app-config-v2" defaultConfig={defaultConfig}>
      <QueryClientProvider client={queryClient}>
        <NostrLoginProvider storageKey='nostr:login'>
          <NostrProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <Suspense>
                <AppRouter />
              </Suspense>
            </TooltipProvider>
          </NostrProvider>
        </NostrLoginProvider>
      </QueryClientProvider>
    </AppProvider>
  );
}

export default App;
