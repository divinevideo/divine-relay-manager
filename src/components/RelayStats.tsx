import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { callRelayRpc } from "@/lib/adminApi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Users, FileText, Shield, Activity, Clock, Globe } from "lucide-react";

interface RelayStatsProps {
  relayUrl: string;
}


async function fetchRelayInfo(relayUrl: string) {
  const httpUrl = relayUrl.replace(/^wss?:\/\//, 'https://');
  
  const response = await fetch(httpUrl, {
    headers: {
      'Accept': 'application/nostr+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch relay info: ${response.statusText}`);
  }

  return response.json();
}

export function RelayStats({ relayUrl }: RelayStatsProps) {
  const { user } = useCurrentUser();

  // Query for relay info
  const { data: relayInfo, isLoading: loadingInfo } = useQuery({
    queryKey: ['relay-info', relayUrl],
    queryFn: () => fetchRelayInfo(relayUrl),
    enabled: !!relayUrl,
  });

  // Query for banned users count
  const { data: bannedUsers, isLoading: loadingBanned } = useQuery({
    queryKey: ['banned-users', relayUrl],
    queryFn: () => callRelayRpc<string[] | Array<{ pubkey: string; reason?: string }>>('listbannedpubkeys'),
    enabled: !!relayUrl && !!user,
  });

  // Query for allowed users count
  const { data: allowedUsers, isLoading: loadingAllowed } = useQuery({
    queryKey: ['allowed-users', relayUrl],
    queryFn: () => callRelayRpc<string[] | Array<{ pubkey: string; reason?: string }>>('listallowedpubkeys'),
    enabled: !!relayUrl && !!user,
  });

  // Query for banned events count
  const { data: bannedEvents, isLoading: loadingBannedEvents } = useQuery({
    queryKey: ['banned-events', relayUrl],
    queryFn: () => callRelayRpc<Array<{ id: string; reason?: string }>>('listbannedevents'),
    enabled: !!relayUrl && !!user,
  });

  // Query for events needing moderation
  const { data: eventsNeedingModeration, isLoading: loadingPending } = useQuery({
    queryKey: ['events-needing-moderation', relayUrl],
    queryFn: () => callRelayRpc<Array<{ id: string; reason?: string }>>('listeventsneedingmoderation'),
    enabled: !!relayUrl && !!user,
  });

  // Query for allowed kinds
  const { data: allowedKinds, isLoading: loadingKinds } = useQuery({
    queryKey: ['allowed-kinds', relayUrl],
    queryFn: () => callRelayRpc<number[]>('listallowedkinds'),
    enabled: !!relayUrl && !!user,
  });

  const isLoading = loadingInfo || loadingBanned || loadingAllowed || loadingBannedEvents || loadingPending || loadingKinds;

  // Calculate stats
  const bannedUsersCount = Array.isArray(bannedUsers) ? bannedUsers.length : 0;
  const allowedUsersCount = Array.isArray(allowedUsers) ? allowedUsers.length : 0;
  const bannedEventsCount = Array.isArray(bannedEvents) ? bannedEvents.length : 0;
  const pendingModerationCount = Array.isArray(eventsNeedingModeration) ? eventsNeedingModeration.length : 0;

  // Calculate usage percentages (mock data for demonstration)
  const maxConnections = relayInfo?.limitation?.max_subscriptions || 1000;
  const currentConnections = Math.floor(Math.random() * maxConnections * 0.7); // Mock current connections
  const connectionUsage = (currentConnections / maxConnections) * 100;

  const maxStorage = 100; // GB (mock)
  const currentStorage = Math.floor(Math.random() * 60); // Mock current storage
  const storageUsage = (currentStorage / maxStorage) * 100;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Relay Overview</h2>
        <p className="text-muted-foreground">Monitor your relay's status and performance</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Banned Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{bannedUsersCount}</div>
            )}
            <p className="text-xs text-muted-foreground">
              Users blocked from posting
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Allowed Users</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{allowedUsersCount}</div>
            )}
            <p className="text-xs text-muted-foreground">
              Explicitly allowed users
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Banned Events</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{bannedEventsCount}</div>
            )}
            <p className="text-xs text-muted-foreground">
              Events removed from relay
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{pendingModerationCount}</div>
            )}
            <p className="text-xs text-muted-foreground">
              Events awaiting moderation
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Relay Information */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Globe className="h-5 w-5" />
              <span>Relay Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingInfo ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            ) : relayInfo ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Name:</span>
                  <span className="text-sm">{relayInfo.name || 'Unnamed'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Software:</span>
                  <span className="text-sm">{relayInfo.software ? 'Custom' : 'Unknown'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Version:</span>
                  <span className="text-sm">{relayInfo.version || 'Unknown'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Auth Required:</span>
                  <Badge variant={relayInfo.limitation?.auth_required ? "destructive" : "secondary"}>
                    {relayInfo.limitation?.auth_required ? 'Yes' : 'No'}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Payment Required:</span>
                  <Badge variant={relayInfo.limitation?.payment_required ? "destructive" : "secondary"}>
                    {relayInfo.limitation?.payment_required ? 'Yes' : 'No'}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Supported NIPs:</span>
                  <span className="text-sm">{relayInfo.supported_nips?.length || 0}</span>
                </div>
              </div>
            ) : (
              <Alert>
                <AlertDescription>
                  Unable to load relay information
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Activity className="h-5 w-5" />
              <span>Resource Usage</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Connections</span>
                <span>{currentConnections} / {maxConnections}</span>
              </div>
              <Progress value={connectionUsage} className="h-2" />
              <p className="text-xs text-muted-foreground mt-1">
                {connectionUsage.toFixed(1)}% of max connections
              </p>
            </div>
            
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Storage</span>
                <span>{currentStorage}GB / {maxStorage}GB</span>
              </div>
              <Progress value={storageUsage} className="h-2" />
              <p className="text-xs text-muted-foreground mt-1">
                {storageUsage.toFixed(1)}% of storage used
              </p>
            </div>

            {relayInfo?.limitation && (
              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium mb-2">Limits</h4>
                <div className="space-y-1 text-xs">
                  {relayInfo.limitation.max_message_length && (
                    <div className="flex justify-between">
                      <span>Max Message:</span>
                      <span>{(relayInfo.limitation.max_message_length / 1024).toFixed(1)}KB</span>
                    </div>
                  )}
                  {relayInfo.limitation.max_event_tags && (
                    <div className="flex justify-between">
                      <span>Max Tags:</span>
                      <span>{relayInfo.limitation.max_event_tags}</span>
                    </div>
                  )}
                  {relayInfo.limitation.max_limit && (
                    <div className="flex justify-between">
                      <span>Max Query Limit:</span>
                      <span>{relayInfo.limitation.max_limit}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Event Kinds */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <FileText className="h-5 w-5" />
            <span>Allowed Event Kinds</span>
          </CardTitle>
          <CardDescription>
            Event types that are permitted on this relay
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingKinds ? (
            <div className="flex flex-wrap gap-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-6 w-16" />
              ))}
            </div>
          ) : Array.isArray(allowedKinds) && allowedKinds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {allowedKinds.map((kind: number) => (
                <Badge key={kind} variant="secondary">
                  Kind {kind}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>All event kinds are allowed</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      {pendingModerationCount > 0 && (
        <Card className="border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2 text-orange-800 dark:text-orange-200">
              <Clock className="h-5 w-5" />
              <span>Action Required</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-orange-700 dark:text-orange-300">
              You have {pendingModerationCount} event{pendingModerationCount !== 1 ? 's' : ''} waiting for moderation review.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}