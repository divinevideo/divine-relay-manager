// ABOUTME: Main relay administration interface with tabs for events, users, reports, and labels
// ABOUTME: Integrates all NIP-86 moderation tools into a unified dashboard with URL routing

import { useLocation, useNavigate, useParams } from "react-router-dom";
import { EventsList } from "@/components/EventsList";
import { UserManagement } from "@/components/UserManagement";
import { Reports } from "@/components/Reports";
import { Labels } from "@/components/Labels";
import { DebugPanel } from "@/components/DebugPanel";
import { EnvironmentSelector } from "@/components/EnvironmentSelector";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Server, FileText, Users, Settings, Flag, Tag, Bug } from "lucide-react";
import { useAppContext } from "@/hooks/useAppContext";

// Map URL paths to tab values
function getTabFromPath(pathname: string): string {
  if (pathname.startsWith('/events')) return 'events';
  if (pathname.startsWith('/users')) return 'users';
  if (pathname.startsWith('/reports')) return 'reports';
  if (pathname.startsWith('/labels')) return 'labels';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/debug')) return 'debug';
  return 'reports'; // default
}

export function RelayManager() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { config } = useAppContext();

  const currentTab = getTabFromPath(location.pathname);

  // Handle tab changes - navigate to the new route
  const handleTabChange = (value: string) => {
    navigate(`/${value}`);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      {/* Header */}
      <header className="shrink-0 border-b bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-600 rounded-lg">
                <Server className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Divine Relay Admin</h1>
                <p className="text-sm text-muted-foreground">NIP-86 Moderation Tools</p>
              </div>
            </div>
            <EnvironmentSelector />
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden container mx-auto px-4 py-4">
        <Tabs value={currentTab} onValueChange={handleTabChange} className="h-full flex flex-col">
          <TabsList className="shrink-0 grid w-full grid-cols-6">
            <TabsTrigger value="events" className="flex items-center space-x-2">
              <FileText className="h-4 w-4" />
              <span>Events</span>
            </TabsTrigger>
            <TabsTrigger value="users" className="flex items-center space-x-2">
              <Users className="h-4 w-4" />
              <span>Users</span>
            </TabsTrigger>
            <TabsTrigger value="reports" className="flex items-center space-x-2">
              <Flag className="h-4 w-4" />
              <span>Reports</span>
            </TabsTrigger>
            <TabsTrigger value="labels" className="flex items-center space-x-2">
              <Tag className="h-4 w-4" />
              <span>Labels</span>
            </TabsTrigger>
            <TabsTrigger value="settings" className="flex items-center space-x-2">
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </TabsTrigger>
            <TabsTrigger value="debug" className="flex items-center space-x-2">
              <Bug className="h-4 w-4" />
              <span>Debug</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="events" className="flex-1 min-h-0 overflow-hidden mt-4">
            <EventsList relayUrl={config.relayUrl} />
          </TabsContent>

          <TabsContent value="users" className="flex-1 min-h-0 mt-4">
            <UserManagement selectedPubkey={params.pubkey} />
          </TabsContent>

          <TabsContent value="reports" className="flex-1 min-h-0 mt-4">
            <Reports relayUrl={config.relayUrl} selectedReportId={params.reportId} />
          </TabsContent>

          <TabsContent value="labels" className="flex-1 min-h-0 mt-4">
            <Labels relayUrl={config.relayUrl} />
          </TabsContent>

          <TabsContent value="settings" className="flex-1 min-h-0 mt-4">
            <Card>
              <CardContent className="py-12 text-center">
                <Settings className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-muted-foreground">Relay settings coming soon</p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="debug" className="flex-1 min-h-0 mt-4">
            <Card>
              <DebugPanel />
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}