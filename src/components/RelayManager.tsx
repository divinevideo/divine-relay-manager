// ABOUTME: Main relay administration interface with tabs for events, users, reports, and labels
// ABOUTME: Integrates all NIP-86 moderation tools into a unified dashboard with URL routing

import { useState, useEffect, useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { EventsList } from "@/components/EventsList";
import { UserManagement } from "@/components/UserManagement";
import { Reports } from "@/components/Reports";
import { Labels } from "@/components/Labels";
import { DebugPanel } from "@/components/DebugPanel";
import { SettingsDashboard } from "@/components/SettingsDashboard";
import { EnvironmentSelector } from "@/components/EnvironmentSelector";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Server, FileText, Users, Settings, Flag, Tag, Bug, GripVertical } from "lucide-react";
import { useAppContext } from "@/hooks/useAppContext";

// Tab definitions in default order (Reports first for moderation workflow)
const TAB_DEFINITIONS = [
  { id: 'reports', label: 'Reports', icon: Flag },
  { id: 'events', label: 'Events', icon: FileText },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'labels', label: 'Labels', icon: Tag },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'debug', label: 'Debug', icon: Bug },
] as const;

type TabId = typeof TAB_DEFINITIONS[number]['id'];

const DEFAULT_TAB_ORDER: TabId[] = TAB_DEFINITIONS.map(t => t.id);
const STORAGE_KEY = 'divine-relay-manager:tab-order';

function loadTabOrder(): TabId[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as TabId[];
      // Validate: must contain all tab IDs exactly once
      if (
        parsed.length === DEFAULT_TAB_ORDER.length &&
        DEFAULT_TAB_ORDER.every(id => parsed.includes(id))
      ) {
        return parsed;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_TAB_ORDER;
}

function saveTabOrder(order: TabId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage errors
  }
}

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

  // Tab order state with localStorage persistence
  const [tabOrder, setTabOrder] = useState<TabId[]>(loadTabOrder);
  const [draggedTab, setDraggedTab] = useState<TabId | null>(null);
  const [dragOverTab, setDragOverTab] = useState<TabId | null>(null);

  // Save tab order when it changes
  useEffect(() => {
    saveTabOrder(tabOrder);
  }, [tabOrder]);

  // Handle tab changes - navigate to the new route
  const handleTabChange = (value: string) => {
    navigate(`/${value}`);
  };

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, tabId: TabId) => {
    setDraggedTab(tabId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
    // Add a slight delay to show the drag styling
    requestAnimationFrame(() => {
      (e.target as HTMLElement).style.opacity = '0.5';
    });
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = '1';
    setDraggedTab(null);
    setDragOverTab(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, tabId: TabId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedTab && tabId !== draggedTab) {
      setDragOverTab(tabId);
    }
  }, [draggedTab]);

  const handleDragLeave = useCallback(() => {
    setDragOverTab(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetTabId: TabId) => {
    e.preventDefault();
    if (!draggedTab || draggedTab === targetTabId) return;

    setTabOrder(prevOrder => {
      const newOrder = [...prevOrder];
      const draggedIndex = newOrder.indexOf(draggedTab);
      const targetIndex = newOrder.indexOf(targetTabId);

      // Remove dragged item and insert at target position
      newOrder.splice(draggedIndex, 1);
      newOrder.splice(targetIndex, 0, draggedTab);

      return newOrder;
    });

    setDraggedTab(null);
    setDragOverTab(null);
  }, [draggedTab]);

  // Get ordered tabs
  const orderedTabs = tabOrder.map(id => TAB_DEFINITIONS.find(t => t.id === id)!);

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
            {orderedTabs.map((tab) => {
              const Icon = tab.icon;
              const isDragOver = dragOverTab === tab.id;
              return (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className={`flex items-center space-x-1 cursor-grab active:cursor-grabbing transition-all ${
                    isDragOver ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                  }`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, tab.id)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(e, tab.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, tab.id)}
                >
                  <GripVertical className="h-3 w-3 opacity-40 shrink-0" />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </TabsTrigger>
              );
            })}
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
            <SettingsDashboard />
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