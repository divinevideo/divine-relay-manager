// ABOUTME: Read-only settings dashboard showing relay configuration, NIP-11 metadata, and NIP-86 status
// ABOUTME: Environment-aware — re-fetches all data when the environment selector changes

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyableId } from "@/components/CopyableId";
import { useAppContext } from "@/hooks/useAppContext";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getCurrentEnvironment } from "@/lib/environments";
import {
  Globe, Shield, Clock, Zap, FileText, ExternalLink,
  Server, Wifi, WifiOff, List, ShieldBan, Users,
  AlertTriangle, Mail, Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── NIP-11 type (replicated from RelayInfo.tsx to keep this component self-contained) ──

interface RelayInfoData {
  name?: string;
  description?: string;
  banner?: string;
  icon?: string;
  pubkey?: string;
  contact?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  privacy_policy?: string;
  terms_of_service?: string;
  relay_countries?: string[];
  language_tags?: string[];
  tags?: string[];
  posting_policy?: string;
  payments_url?: string;
  fees?: {
    admission?: Array<{ amount: number; unit: string }>;
    subscription?: Array<{ amount: number; unit: string; period?: number }>;
    publication?: Array<{ kinds?: number[]; amount: number; unit: string }>;
  };
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_limit?: number;
    max_subid_length?: number;
    max_event_tags?: number;
    max_content_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    created_at_lower_limit?: number;
    created_at_upper_limit?: number;
    default_limit?: number;
  };
}

// ── NIP-11 fetch (same pattern as RelayInfo.tsx) ──

async function fetchRelayInfo(relayUrl: string): Promise<RelayInfoData> {
  const httpUrl = relayUrl.replace(/^wss?:\/\//, 'https://');
  const response = await fetch(httpUrl, {
    headers: { 'Accept': 'application/nostr+json' },
    mode: 'cors',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

// ── Kind names lookup ──

const KIND_NAMES: Record<number, string> = {
  0: "Metadata",
  1: "Short Text Note",
  2: "Recommend Relay",
  3: "Follows",
  4: "Encrypted Direct Messages",
  5: "Event Deletion",
  6: "Repost",
  7: "Reaction",
  8: "Badge Award",
  9: "Group Chat Message",
  10: "Group Chat Threaded Reply",
  16: "Generic Repost",
  40: "Channel Creation",
  41: "Channel Metadata",
  42: "Channel Message",
  43: "Channel Hide Message",
  44: "Channel Mute User",
  1021: "Bid",
  1022: "Bid Confirmation",
  1040: "OpenTimestamps",
  1059: "Gift Wrap",
  1063: "File Metadata",
  1064: "File Header",
  1311: "Live Chat Message",
  1984: "Reporting",
  1985: "Label",
  4550: "Community Post Approval",
  7000: "Job Feedback",
  9041: "Zap Goal",
  9734: "Zap Request",
  9735: "Zap",
  10000: "Mute List",
  10001: "Pin List",
  10002: "Relay List Metadata",
  13194: "Wallet Info",
  20: "Video Event",
  22242: "Client Authentication",
  23194: "Wallet Request",
  23195: "Wallet Response",
  24133: "Nostr Connect",
  27235: "HTTP Auth",
  30000: "Follow Sets",
  30001: "Generic Lists",
  30008: "Profile Badges",
  30009: "Badge Definition",
  30017: "Create or Update Stall",
  30018: "Create or Update Product",
  30023: "Long-form Content",
  30024: "Draft Long-form Content",
  30078: "Application-specific Data",
  30311: "Live Event",
  30402: "Classified Listing",
  31922: "Date-Based Calendar Event",
  31923: "Time-Based Calendar Event",
  31924: "Calendar",
  31925: "Calendar Event RSVP",
};

// ── Helpers ──

function envBorderColor(envId: string | undefined): string {
  switch (envId) {
    case 'production': return 'border-l-red-500';
    case 'staging': return 'border-l-blue-500';
    case 'legacy': return 'border-l-gray-400';
    default: return 'border-l-purple-500';
  }
}

function envBadgeVariant(envId: string | undefined): "default" | "secondary" | "destructive" | "outline" {
  if (envId === 'production') return 'destructive';
  if (envId === 'legacy') return 'outline';
  return 'secondary';
}

function envBadgeLabel(envId: string | undefined): string {
  if (envId === 'production') return 'PROD';
  if (envId === 'staging') return 'STG';
  if (envId === 'legacy') return 'LEGACY';
  return 'CUSTOM';
}

// ── Component ──

export function SettingsDashboard() {
  const { config } = useAppContext();
  const { relayUrl, apiUrl } = config;
  const { callRelayRpc, getWorkerInfo } = useAdminApi();
  const { user } = useCurrentUser();

  const env = getCurrentEnvironment(relayUrl, apiUrl);

  // ── NIP-11 ──
  const {
    data: relayInfo,
    isLoading: relayInfoLoading,
    error: relayInfoError,
  } = useQuery({
    queryKey: ['relay-info', relayUrl],
    queryFn: () => fetchRelayInfo(relayUrl),
    enabled: !!relayUrl,
  });

  // ── Worker info ──
  const {
    data: workerInfo,
    isLoading: workerInfoLoading,
    error: workerInfoError,
  } = useQuery({
    queryKey: ['worker-info', apiUrl],
    queryFn: () => getWorkerInfo(),
    enabled: !!apiUrl,
  });

  // ── NIP-86 queries (auth-gated) ──
  const {
    data: allowedKinds,
    isLoading: kindsLoading,
  } = useQuery({
    queryKey: ['allowed-kinds', relayUrl],
    queryFn: () => callRelayRpc<number[]>('listallowedkinds'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: blockedIps,
    isLoading: ipsLoading,
  } = useQuery({
    queryKey: ['blocked-ips', relayUrl],
    queryFn: () => callRelayRpc<Array<{ ip: string; reason?: string }>>('listblockedips'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: bannedUsers,
    isLoading: bannedUsersLoading,
  } = useQuery({
    queryKey: ['banned-users', relayUrl],
    queryFn: () => callRelayRpc<Array<string | { pubkey: string; reason?: string }>>('listbannedpubkeys'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: allowedUsers,
    isLoading: allowedUsersLoading,
  } = useQuery({
    queryKey: ['allowed-users', relayUrl],
    queryFn: () => callRelayRpc<string[]>('listallowedpubkeys'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: bannedEvents,
    isLoading: bannedEventsLoading,
  } = useQuery({
    queryKey: ['banned-events', relayUrl],
    queryFn: () => callRelayRpc<Array<{ id: string; reason?: string }>>('listbannedevents'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: pendingModeration,
    isLoading: pendingLoading,
  } = useQuery({
    queryKey: ['events-needing-moderation', relayUrl],
    queryFn: () => callRelayRpc<unknown[]>('listeventsneedingmoderation'),
    enabled: !!user && !!relayUrl,
  });

  const {
    data: supportedMethods,
    isLoading: methodsLoading,
  } = useQuery({
    queryKey: ['supported-methods', relayUrl],
    queryFn: () => callRelayRpc<string[]>('supportedmethods'),
    enabled: !!user && !!relayUrl,
  });

  // ── Connection status derived from query states ──
  const connectionStatus: 'connected' | 'error' | 'checking' =
    relayInfoLoading || workerInfoLoading
      ? 'checking'
      : relayInfoError || workerInfoError
        ? 'error'
        : 'connected';

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 pb-8">

        <Alert>
          <AlertDescription className="text-sm text-muted-foreground">
            Preview — this dashboard is read-only for now.
          </AlertDescription>
        </Alert>

        {/* ── 1. Environment & Connection Banner ── */}
        <Card className={cn("border-l-4", envBorderColor(env?.id))}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Server className="h-5 w-5" />
                <CardTitle className="text-lg">
                  {env?.name || 'Custom Environment'}
                </CardTitle>
                <Badge variant={envBadgeVariant(env?.id)}>
                  {envBadgeLabel(env?.id)}
                </Badge>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  connectionStatus === 'connected' && "border-green-500 text-green-600",
                  connectionStatus === 'error' && "border-red-500 text-red-600",
                  connectionStatus === 'checking' && "border-gray-400 text-gray-500",
                )}
              >
                {connectionStatus === 'connected' && <Wifi className="h-3 w-3 mr-1" />}
                {connectionStatus === 'error' && <WifiOff className="h-3 w-3 mr-1" />}
                {connectionStatus === 'checking' ? 'Checking...' : connectionStatus === 'connected' ? 'Connected' : 'Error'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Relay</span>
                <p className="font-mono text-xs mt-0.5">{relayUrl}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Worker API</span>
                <p className="font-mono text-xs mt-0.5">{apiUrl}</p>
              </div>
            </div>
            {workerInfoLoading ? (
              <Skeleton className="h-4 w-64" />
            ) : workerInfo?.pubkey ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Admin</span>
                <CopyableId value={workerInfo.pubkey} type="npub" size="xs" />
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 2. Relay Identity (NIP-11) ── */}
        {relayInfoLoading ? (
          <Card>
            <CardHeader><Skeleton className="h-6 w-48" /></CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        ) : relayInfoError ? (
          <Alert>
            <AlertDescription>
              Failed to load relay information (NIP-11). Check that the relay URL is correct.
            </AlertDescription>
          </Alert>
        ) : relayInfo ? (
          <>
            <Card>
              <CardHeader>
                <div className="flex items-start gap-4">
                  {relayInfo.icon && (
                    <img src={relayInfo.icon} alt="Relay icon" className="w-14 h-14 rounded-lg object-cover" />
                  )}
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <Globe className="h-5 w-5 shrink-0" />
                      {relayInfo.name || 'Unnamed Relay'}
                    </CardTitle>
                    {relayInfo.description && (
                      <p className="text-sm text-muted-foreground mt-1">{relayInfo.description}</p>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {relayInfo.banner && (
                  <img src={relayInfo.banner} alt="Relay banner" className="w-full h-40 rounded-lg object-cover" />
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  {relayInfo.software && (
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">Software:</span>
                      <span className="font-mono text-xs truncate">{relayInfo.software}</span>
                    </div>
                  )}
                  {relayInfo.version && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Version:</span>
                      <Badge variant="outline">{relayInfo.version}</Badge>
                    </div>
                  )}
                  {relayInfo.contact && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">Contact:</span>
                      <span className="font-mono text-xs">{relayInfo.contact}</span>
                    </div>
                  )}
                  {relayInfo.pubkey && (
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">Pubkey:</span>
                      <CopyableId value={relayInfo.pubkey} type="npub" size="xs" />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ── 3. Supported NIPs ── */}
            {relayInfo.supported_nips && relayInfo.supported_nips.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Shield className="h-5 w-5" />
                    Supported NIPs
                    <Badge variant="outline" className="ml-1">{relayInfo.supported_nips.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {relayInfo.supported_nips.map((nip) => (
                      <Badge key={nip} variant="secondary">
                        NIP-{nip.toString().padStart(2, '0')}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── 4. Server Limitations ── */}
            {relayInfo.limitation && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clock className="h-5 w-5" />
                    Server Limitations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {relayInfo.limitation.max_message_length != null && (
                      <div>
                        <span className="text-sm font-medium">Max Message Length</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_message_length.toLocaleString()} bytes</p>
                      </div>
                    )}
                    {relayInfo.limitation.max_subscriptions != null && (
                      <div>
                        <span className="text-sm font-medium">Max Subscriptions</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_subscriptions.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.max_limit != null && (
                      <div>
                        <span className="text-sm font-medium">Max Query Limit</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_limit.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.max_subid_length != null && (
                      <div>
                        <span className="text-sm font-medium">Max Sub ID Length</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_subid_length.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.max_event_tags != null && (
                      <div>
                        <span className="text-sm font-medium">Max Event Tags</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_event_tags.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.max_content_length != null && (
                      <div>
                        <span className="text-sm font-medium">Max Content Length</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.max_content_length.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.min_pow_difficulty != null && (
                      <div>
                        <span className="text-sm font-medium">Min PoW Difficulty</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.min_pow_difficulty}</p>
                      </div>
                    )}
                    {relayInfo.limitation.default_limit != null && (
                      <div>
                        <span className="text-sm font-medium">Default Limit</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.default_limit.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.created_at_lower_limit != null && (
                      <div>
                        <span className="text-sm font-medium">Created-at Lower Limit</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.created_at_lower_limit.toLocaleString()}</p>
                      </div>
                    )}
                    {relayInfo.limitation.created_at_upper_limit != null && (
                      <div>
                        <span className="text-sm font-medium">Created-at Upper Limit</span>
                        <p className="text-sm text-muted-foreground">{relayInfo.limitation.created_at_upper_limit.toLocaleString()}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-sm font-medium">Auth Required</span>
                      <div className="mt-0.5">
                        <Badge variant={relayInfo.limitation.auth_required ? "destructive" : "secondary"}>
                          {relayInfo.limitation.auth_required ? 'Yes' : 'No'}
                        </Badge>
                      </div>
                    </div>
                    <div>
                      <span className="text-sm font-medium">Payment Required</span>
                      <div className="mt-0.5">
                        <Badge variant={relayInfo.limitation.payment_required ? "destructive" : "secondary"}>
                          {relayInfo.limitation.payment_required ? 'Yes' : 'No'}
                        </Badge>
                      </div>
                    </div>
                    <div>
                      <span className="text-sm font-medium">Restricted Writes</span>
                      <div className="mt-0.5">
                        <Badge variant={relayInfo.limitation.restricted_writes ? "default" : "secondary"}>
                          {relayInfo.limitation.restricted_writes ? 'Yes' : 'No'}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── 5. Fee Schedule ── */}
            {relayInfo.fees && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Zap className="h-5 w-5" />
                    Fee Schedule
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {relayInfo.fees.admission && (
                    <div>
                      <h4 className="font-medium mb-2">Admission</h4>
                      <div className="flex flex-wrap gap-2">
                        {relayInfo.fees.admission.map((fee, i) => (
                          <Badge key={i} variant="outline">
                            {fee.amount.toLocaleString()} {fee.unit}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {relayInfo.fees.subscription && (
                    <div>
                      <h4 className="font-medium mb-2">Subscription</h4>
                      <div className="flex flex-wrap gap-2">
                        {relayInfo.fees.subscription.map((fee, i) => (
                          <Badge key={i} variant="outline">
                            {fee.amount.toLocaleString()} {fee.unit}
                            {fee.period && ` / ${Math.floor(fee.period / 86400)} days`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {relayInfo.fees.publication && (
                    <div>
                      <h4 className="font-medium mb-2">Publication</h4>
                      <div className="flex flex-wrap gap-2">
                        {relayInfo.fees.publication.map((fee, i) => (
                          <Badge key={i} variant="outline">
                            {fee.amount.toLocaleString()} {fee.unit}
                            {fee.kinds && ` (kinds: ${fee.kinds.join(', ')})`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ── 6. Policies ── */}
            {(relayInfo.privacy_policy || relayInfo.terms_of_service || relayInfo.posting_policy) && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-5 w-5" />
                    Policies
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {relayInfo.privacy_policy && (
                    <a
                      href={relayInfo.privacy_policy}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline flex items-center gap-1 text-sm"
                    >
                      Privacy Policy
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {relayInfo.terms_of_service && (
                    <a
                      href={relayInfo.terms_of_service}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline flex items-center gap-1 text-sm"
                    >
                      Terms of Service
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {relayInfo.posting_policy && (
                    <a
                      href={relayInfo.posting_policy}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline flex items-center gap-1 text-sm"
                    >
                      Posting Policy
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ── 10. Community Info ── */}
            {(relayInfo.relay_countries || relayInfo.language_tags || relayInfo.tags) && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Tag className="h-5 w-5" />
                    Community
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {relayInfo.relay_countries && relayInfo.relay_countries.length > 0 && (
                    <div>
                      <span className="text-sm font-medium">Countries</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {relayInfo.relay_countries.map((c) => (
                          <Badge key={c} variant="outline">{c}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {relayInfo.language_tags && relayInfo.language_tags.length > 0 && (
                    <div>
                      <span className="text-sm font-medium">Languages</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {relayInfo.language_tags.map((l) => (
                          <Badge key={l} variant="outline">{l}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {relayInfo.tags && relayInfo.tags.length > 0 && (
                    <div>
                      <span className="text-sm font-medium">Tags</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {relayInfo.tags.map((t) => (
                          <Badge key={t} variant="outline">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        ) : null}

        {/* ── NIP-86 Sections (auth-gated) ── */}
        {!user ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">Log in to view relay management data</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ── 7. Event Kind Configuration ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <List className="h-5 w-5" />
                  Event Kind Configuration
                </CardTitle>
              </CardHeader>
              <CardContent>
                {kindsLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ) : allowedKinds && allowedKinds.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {allowedKinds.map((kind) => (
                      <Badge key={kind} variant="secondary">
                        Kind {kind}
                        {KIND_NAMES[kind] ? ` — ${KIND_NAMES[kind]}` : ''}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">All event kinds are allowed</p>
                )}
              </CardContent>
            </Card>

            {/* ── 8. Blocked IPs ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldBan className="h-5 w-5" />
                  Blocked IPs
                  {blockedIps && (
                    <Badge variant="outline" className="ml-1">{blockedIps.length}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {ipsLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-36" />
                  </div>
                ) : blockedIps && blockedIps.length > 0 ? (
                  <div className="space-y-1.5">
                    {blockedIps.map((entry, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="font-mono">{entry.ip}</span>
                        {entry.reason && (
                          <span className="text-muted-foreground">— {entry.reason}</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No blocked IP addresses</p>
                )}
              </CardContent>
            </Card>

            {/* ── 9. Moderation Overview ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-5 w-5" />
                  Moderation Overview
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center">
                    <p className="text-2xl font-bold">
                      {bannedUsersLoading ? <Skeleton className="h-8 w-12 mx-auto" /> : (Array.isArray(bannedUsers) ? bannedUsers.length : 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Banned Users</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">
                      {allowedUsersLoading ? <Skeleton className="h-8 w-12 mx-auto" /> : (Array.isArray(allowedUsers) ? allowedUsers.length : 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Allowed Users</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">
                      {bannedEventsLoading ? <Skeleton className="h-8 w-12 mx-auto" /> : (Array.isArray(bannedEvents) ? bannedEvents.length : 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Banned Events</p>
                  </div>
                  <div className="text-center">
                    <p className={cn(
                      "text-2xl font-bold",
                      Array.isArray(pendingModeration) && pendingModeration.length > 0 && "text-orange-500"
                    )}>
                      {pendingLoading ? <Skeleton className="h-8 w-12 mx-auto" /> : (Array.isArray(pendingModeration) ? pendingModeration.length : 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Pending Moderation</p>
                  </div>
                </div>

                {/* Supported NIP-86 methods */}
                {methodsLoading ? (
                  <Skeleton className="h-4 w-64" />
                ) : supportedMethods && supportedMethods.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium mb-2">Supported NIP-86 Methods</p>
                    <div className="flex flex-wrap gap-1.5">
                      {supportedMethods.map((method) => (
                        <Badge key={method} variant="outline" className="font-mono text-xs">
                          {method}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </>
        )}

      </div>
    </ScrollArea>
  );
}
